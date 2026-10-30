'use strict';

/**
 * Cálculo de costo real, CAT implícito y alternativa de ahorro (sección 9 del documento).
 *
 * Entrada: el objeto `datos` que devuelve validarExtraccion() cuando estado === 'listo'
 *          (tipo_entrada, modo_pago, producto, credito) y opciones { tasaCetesPct }.
 * Salida:  { estado, motivo, tipo, modo, metricas, cat, ahorro, advertencias }
 *          o { estado: 'error', motivo, campos, advertencias } si los datos no sirven.
 *
 * Determinístico: sin red, sin LLM, sin estado. No modifica la entrada.
 * El CAT es una ESTIMACIÓN informativa, sin IVA, que puede diferir del CAT oficial.
 *
 * Tratamiento de cargos (tabla de la sección 9.2):
 *   tienda      enganche e iniciales restan del principal; periódicos suman al pago;
 *               finales entran al costo total pero NO al CAT.
 *   préstamo    el monto depositado ya refleja lo descontado; periódicos suman al pago;
 *               en pago único el total declarado ya incluye los cargos.
 */

const R_MIN = 0; // tasa periódica mínima (0%)
const R_MAX = 10; // tasa periódica máxima (1,000% por periodo)
const ITER = 200;
const EPS = 1e-12;
const MAX_PERIODOS_AHORRO = 1000;
const UMBRAL_MAS_DE_1000 = 10; // CAT > 10 equivale a más de 1,000%

const PERIODOS_POR_ANIO = { semanal: 52, quincenal: 24, mensual: 12, diario: 365 };
const DIAS_POR_PERIODO = { semanal: 7, quincenal: 15, mensual: 30, diario: 1 };
const MOMENTOS = ['inicial', 'periodico', 'final'];

function redondear(n, decimales = 2) {
  const f = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Valor presente de una anualidad; protege el caso r -> 0. */
function vpAnualidad(r, pago, n) {
  if (Math.abs(r) < EPS) return pago * n;
  return (pago * (1 - Math.pow(1 + r, -n))) / r;
}

/** Tasa periódica r que iguala el principal con el valor presente de n pagos iguales. */
function tasaPeriodica(principal, pago, n) {
  if (!(principal > 0) || !(pago > 0) || !(n >= 1)) return { r: null, motivo: 'datos_invalidos' };
  const total = pago * n;
  if (Math.abs(total - principal) < 0.005) return { r: 0, motivo: 'sin_costo' };
  if (total < principal) return { r: null, motivo: 'pagos_menores_al_principal' };
  if (vpAnualidad(R_MAX, pago, n) > principal) return { r: R_MAX, motivo: 'fuera_de_rango' };
  let lo = R_MIN;
  let hi = R_MAX;
  for (let i = 0; i < ITER; i++) {
    const m = (lo + hi) / 2;
    if (vpAnualidad(m, pago, n) > principal) lo = m;
    else hi = m;
  }
  return { r: (lo + hi) / 2, motivo: 'ok' };
}

function catImplicito(principal, pago, n, periodosPorAnio) {
  const { r, motivo } = tasaPeriodica(principal, pago, n);
  if (r === null) return { cat: null, r: null, motivo };
  if (motivo === 'fuera_de_rango') return { cat: null, r, motivo };
  return { cat: Math.pow(1 + r, periodosPorAnio) - 1, r, motivo };
}

function catPagoUnico(depositado, totalPagar, plazoDias) {
  if (!(depositado > 0) || !(totalPagar > 0) || !(plazoDias >= 1)) {
    return { cat: null, r: null, motivo: 'datos_invalidos' };
  }
  if (totalPagar < depositado) return { cat: null, r: null, motivo: 'pagos_menores_al_principal' };
  const r = totalPagar / depositado - 1;
  return { cat: Math.pow(1 + r, 365 / plazoDias) - 1, r, motivo: r === 0 ? 'sin_costo' : 'ok' };
}

/** Texto para el usuario: arriba de 1,000% se dice "más de 1,000%". */
function formatoCAT(cat) {
  if (cat === null || cat === undefined) return null;
  if (cat > UMBRAL_MAS_DE_1000) return 'más de 1,000%';
  return (cat * 100).toFixed(1) + '%';
}

function resumenCAT({ cat, r, motivo }) {
  if (motivo === 'fuera_de_rango') {
    return { valor: null, porcentaje: null, texto: 'más de 1,000%', tasa_periodica: null, motivo };
  }
  return {
    valor: cat,
    porcentaje: cat === null ? null : redondear(cat * 100, 2),
    texto: formatoCAT(cat),
    tasa_periodica: r,
    motivo,
  };
}

/**
 * Cuántos periodos hacen falta para juntar el precio de contado apartando el abono.
 * Con tasa 0 el resultado es un TOPE: con cualquier rendimiento positivo bajan los periodos.
 */
function ahorroParaContado({ precio, abono, periodicidad, tasaAnualPct }) {
  if (!(precio > 0) || !(abono > 0) || !DIAS_POR_PERIODO[periodicidad]) return null;
  const tasa = esNumero(tasaAnualPct) && tasaAnualPct > 0 ? tasaAnualPct / 100 : 0;
  const dias = DIAS_POR_PERIODO[periodicidad];
  const tasaPeriodo = Math.pow(1 + (tasa * 28) / 360, dias / 28) - 1;
  let saldo = 0;
  let k = 0;
  while (saldo < precio && k < MAX_PERIODOS_AHORRO) {
    saldo = saldo * (1 + tasaPeriodo) + abono;
    k++;
  }
  if (saldo < precio) return null;
  return {
    periodos: k,
    periodicidad,
    aportado: redondear(abono * k, 2),
    saldo: redondear(saldo, 2),
    con_rendimiento: tasa > 0,
    tasa_anual_usada_pct: tasa > 0 ? tasaAnualPct : 0,
  };
}

function sumarCargos(lista, nombre, invalidos) {
  const suma = { inicial: 0, periodico: 0, final: 0 };
  if (lista === undefined || lista === null) return suma;
  if (!Array.isArray(lista)) {
    invalidos.push(nombre);
    return suma;
  }
  for (const c of lista) {
    const ok = c && esNumero(c.monto) && c.monto >= 0 && MOMENTOS.includes(c.momento);
    if (!ok) {
      invalidos.push(nombre);
      continue;
    }
    suma[c.momento] += c.monto;
  }
  return suma;
}

function error(motivo, campos = [], advertencias = []) {
  return { estado: 'error', motivo, campos, advertencias };
}

function calcular(datos, opciones = {}) {
  if (!datos || typeof datos !== 'object' || !datos.credito || typeof datos.credito !== 'object') {
    return error('datos_invalidos', ['datos']);
  }
  const tipo =
    datos.tipo_entrada === 'etiqueta_tienda' ? 'tienda' : datos.tipo_entrada === 'oferta_credito' ? 'prestamo' : null;
  if (!tipo) return error('tipo_entrada_no_soportado', ['tipo_entrada']);
  const modo = datos.modo_pago;
  if (modo !== 'periodico' && modo !== 'unico') return error('modo_pago_ausente', ['modo_pago']);
  if (tipo === 'tienda' && modo !== 'periodico') return error('modo_pago_no_valido_para_tienda', ['modo_pago']);

  const c = datos.credito;
  const p = datos.producto && typeof datos.producto === 'object' ? datos.producto : {};
  const advertencias = [];
  const invalidos = [];
  const comisiones = sumarCargos(c.comisiones, 'comisiones', invalidos);
  const seguros = sumarCargos(c.seguros, 'seguros', invalidos);
  const inicial = comisiones.inicial + seguros.inicial;
  const periodico = comisiones.periodico + seguros.periodico;
  const final = comisiones.final + seguros.final;

  const tasaCetesPct = esNumero(opciones.tasaCetesPct) ? opciones.tasaCetesPct : null;

  if (tipo === 'tienda') {
    const precio = p.precio_contado;
    const abono = c.abono;
    const n = c.numero_pagos;
    const periodicidad = c.periodicidad;
    const enganche = c.enganche === undefined || c.enganche === null ? 0 : c.enganche;

    const malos = [];
    if (!(esNumero(precio) && precio > 0)) malos.push('precio_contado');
    if (!(esNumero(abono) && abono > 0)) malos.push('abono');
    if (!(Number.isInteger(n) && n >= 1)) malos.push('numero_pagos');
    if (!PERIODOS_POR_ANIO[periodicidad]) malos.push('periodicidad');
    if (!(esNumero(enganche) && enganche >= 0)) malos.push('enganche');
    if (invalidos.length) malos.push('cargos');
    if (malos.length) return error('datos_invalidos', malos);

    const costoTotal = enganche + abono * n + inicial + final + periodico * n;
    const principalNeto = precio - enganche - inicial;
    const pago = abono + periodico;
    const cat = resumenCAT(catImplicito(principalNeto, pago, n, PERIODOS_POR_ANIO[periodicidad]));
    if (final > 0) advertencias.push('cargo_final_fuera_del_cat');

    const sobrecosto = costoTotal - precio;
    const ahorro = ahorroParaContado({ precio, abono, periodicidad, tasaAnualPct: tasaCetesPct });
    return {
      estado: 'ok',
      motivo: 'ok',
      tipo,
      modo,
      metricas: {
        precio_contado: precio,
        costo_total: redondear(costoTotal, 2),
        sobrecosto_pesos: redondear(sobrecosto, 2),
        sobrecosto_pct: redondear((sobrecosto / precio) * 100, 2),
        principal_neto: redondear(principalNeto, 2),
        pago_por_periodo: redondear(pago, 2),
        abono,
        numero_pagos: n,
        periodicidad,
        plazo_dias: null,
      },
      cat,
      ahorro: ahorro
        ? {
            ...ahorro,
            es_tope: !ahorro.con_rendimiento,
            periodos_del_credito: n,
            ahorro_vs_credito: redondear(costoTotal - ahorro.aportado, 2),
          }
        : null,
      advertencias,
    };
  }

  // préstamo
  const depositado = c.monto_depositado;
  const ofrecido = esNumero(c.monto_ofrecido) ? c.monto_ofrecido : null;
  const malos = [];
  if (!(esNumero(depositado) && depositado > 0)) malos.push('monto_depositado');

  let pagas;
  let cat;
  let numeroPagos = null;
  let periodicidadSalida = null;
  let plazoDias = null;
  if (modo === 'unico') {
    const total = c.monto_total_a_pagar;
    const plazo = c.plazo_dias;
    if (!(esNumero(total) && total > 0)) malos.push('monto_total_a_pagar');
    if (!(Number.isInteger(plazo) && plazo >= 1)) malos.push('plazo_dias');
    if (invalidos.length) malos.push('cargos');
    if (malos.length) return error('datos_invalidos', malos);
    pagas = total;
    plazoDias = plazo;
    cat = resumenCAT(catPagoUnico(depositado, total, plazo));
    if (inicial + periodico + final > 0) advertencias.push('cargos_incluidos_en_el_total_declarado');
  } else {
    const abono = c.abono;
    const n = c.numero_pagos;
    const periodicidad = c.periodicidad;
    if (!(esNumero(abono) && abono > 0)) malos.push('abono');
    if (!(Number.isInteger(n) && n >= 1)) malos.push('numero_pagos');
    if (!PERIODOS_POR_ANIO[periodicidad]) malos.push('periodicidad');
    if (invalidos.length) malos.push('cargos');
    if (malos.length) return error('datos_invalidos', malos);
    const pago = abono + periodico;
    pagas = pago * n + final;
    numeroPagos = n;
    periodicidadSalida = periodicidad;
    cat = resumenCAT(catImplicito(depositado, pago, n, PERIODOS_POR_ANIO[periodicidad]));
    if (inicial > 0) advertencias.push('cargos_iniciales_ya_reflejados_en_el_deposito');
    if (final > 0) advertencias.push('cargo_final_fuera_del_cat');
    if (esNumero(c.monto_total_a_pagar) && Math.abs(c.monto_total_a_pagar - pagas) > 1) {
      advertencias.push('total_declarado_distinto_a_pagos');
    }
  }

  const costoCredito = pagas - depositado;
  return {
    estado: 'ok',
    motivo: 'ok',
    tipo,
    modo,
    metricas: {
      recibes: redondear(depositado, 2),
      pagas: redondear(pagas, 2),
      costo_credito_pesos: redondear(costoCredito, 2),
      costo_pct_sobre_recibido: redondear((costoCredito / depositado) * 100, 2),
      monto_ofrecido: ofrecido,
      diferencia_ofrecido_depositado: ofrecido === null ? null : redondear(Math.max(0, ofrecido - depositado), 2),
      cargos_iniciales_declarados: redondear(inicial, 2),
      numero_pagos: numeroPagos,
      periodicidad: periodicidadSalida,
      plazo_dias: plazoDias,
    },
    cat,
    ahorro: null,
    advertencias,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcular,
    ahorroParaContado,
    tasaPeriodica,
    catImplicito,
    catPagoUnico,
    formatoCAT,
    redondear,
  };
}

// En n8n (nodo Code, "Run Once for All Items"): pegar este archivo completo y añadir al final
// (ajusta el origen de `datos` y de la tasa según tus nodos anteriores, POR VERIFICAR):
//
//   const validado = $('Validar extracción').first().json;
//   const tasa = $('Leer CETES').first().json.tasa_pct ?? null;
//   return [{ json: calcular(validado.datos, { tasaCetesPct: tasa }) }];
