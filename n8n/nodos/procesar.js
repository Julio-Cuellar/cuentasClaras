// GENERADO por scripts/empaquetar.js. No lo edites aquí: cambia el módulo y vuelve a generar.
// Nodo Code de n8n: "Procesar". Modo "Run Once for All Items", lenguaje JavaScript.

const __modulos = {};
__modulos["validar-extraccion"] = (() => {
const module = { exports: {} };
'use strict';

/**
 * Validación y normalización de la extracción (paso A3 del documento).
 *
 * Recibe lo que devolvió el LLM (objeto o texto JSON) y responde SIEMPRE con:
 *   { estado, motivo, datos_faltantes, preguntas, advertencias, datos }
 *
 * estado:
 *   'listo'         datos completos y coherentes -> pasar al motor de cálculo
 *   'preguntar'     faltan datos o no cuadran -> enviar `preguntas` al usuario
 *   'cobranza'      Módulo C (plantilla fija), no se calcula nada
 *   'desconocido'   no se entendió qué es -> pedir aclaración
 *   'error_formato' el LLM no devolvió un JSON utilizable -> reintentar
 *
 * Determinístico: no llama al LLM ni a ninguna API. No modifica la entrada.
 * Las señales numéricas (depósito menor al ofrecido, plazo corto) las calcula
 * este código; las de texto (anticipo, permisos, presión) solo se aceptan con
 * evidencia literal.
 */

const TIPOS = ['etiqueta_tienda', 'oferta_credito', 'cobranza', 'desconocido'];
const PERIODOS_POR_ANIO = { semanal: 52, quincenal: 24, mensual: 12, diario: 365 };
const MOMENTOS = ['inicial', 'periodico', 'final'];
const UMBRAL_CONFIANZA = 0.7;
const PLAZO_CORTO_DIAS = 15;

const SINONIMOS_PERIODICIDAD = {
  semanal: 'semanal', semanales: 'semanal', semana: 'semanal',
  quincenal: 'quincenal', quincenales: 'quincenal', quincena: 'quincenal',
  mensual: 'mensual', mensuales: 'mensual', mes: 'mensual',
  diario: 'diario', diarios: 'diario', dia: 'diario',
  unico: 'unico', 'un solo pago': 'unico',
};

const PREGUNTAS = {
  precio_contado: '¿Cuál es el precio de contado del producto?',
  abono: '¿De cuánto es cada pago (abono)?',
  numero_pagos: '¿Cuántos pagos son en total?',
  periodicidad: '¿Cada cuánto se paga: cada semana, cada quincena o cada mes?',
  monto_depositado: '¿Cuánto dinero te depositan realmente?',
  monto_total_a_pagar: '¿Cuánto tendrías que pagar en total?',
  plazo_dias: '¿En cuántos días tienes que pagar?',
  forma_de_pago: '¿Se paga en un solo pago (y en cuántos días) o en pagos periódicos (de cuánto y cuántos)?',
  comision_momento: '¿Esa comisión o seguro se cobra una sola vez al inicio, en cada pago o al final?',
  comision_monto: '¿De cuánto es esa comisión o seguro?',
};

const PREGUNTA_FOTO_CLARA =
  'No pude leer bien la información. ¿Me mandas una foto más clara o me escribes los datos (precio, pagos y plazo)?';
const PREGUNTA_TIPO =
  '¿Me mandas la foto de la etiqueta o los datos de la oferta de crédito que quieres revisar?';
const PREGUNTA_PAGOS_MENORES_PRECIO =
  'Los pagos suman menos que el precio de contado. ¿Me confirmas el precio, el abono y el número de pagos?';
const PREGUNTA_PAGO_MENOR_DEPOSITO =
  'Lo que pagarías suma menos de lo que te depositan. ¿Me confirmas cuánto te depositan y cuánto pagarías en total?';

function respuesta(estado, motivo, extra = {}) {
  return {
    estado,
    motivo,
    datos_faltantes: [],
    preguntas: [],
    advertencias: [],
    datos: null,
    ...extra,
  };
}

function parsearJSON(entrada) {
  if (entrada && typeof entrada === 'object' && !Array.isArray(entrada)) return entrada;
  if (typeof entrada !== 'string') return null;
  const t = entrada.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i === -1 || j <= i) return null;
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function sinAcentos(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** { valor, invalido }: null/vacío = ausente; texto con $ y comas se limpia. */
function leerNumero(v) {
  if (v === null || v === undefined || v === '') return { valor: null, invalido: false };
  if (typeof v === 'number') {
    return Number.isFinite(v) ? { valor: v, invalido: false } : { valor: null, invalido: true };
  }
  if (typeof v === 'string') {
    const limpio = v.replace(/mxn|pesos|\$|\s/gi, '').replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(limpio)) return { valor: Number(limpio), invalido: false };
  }
  return { valor: null, invalido: true };
}

function texto(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function validarExtraccion(entrada, opciones = {}) {
  const umbral = typeof opciones.umbralConfianza === 'number' ? opciones.umbralConfianza : UMBRAL_CONFIANZA;

  const raw = parsearJSON(entrada);
  if (raw === null) return respuesta('error_formato', 'json_invalido');

  const advertencias = [];

  const tipo = TIPOS.includes(raw.tipo_entrada) ? raw.tipo_entrada : 'desconocido';
  if (tipo !== raw.tipo_entrada) advertencias.push('tipo_entrada_invalido');

  const conf = leerNumero(raw.confianza_extraccion);
  const confianzaValida = conf.valor !== null && conf.valor >= 0 && conf.valor <= 1;
  const confianza = confianzaValida ? conf.valor : 0;
  if (!confianzaValida) advertencias.push('confianza_ausente_o_invalida');

  if (tipo === 'cobranza') {
    return respuesta('cobranza', 'plantilla_modulo_c', {
      advertencias,
      datos: { tipo_entrada: 'cobranza', confianza_extraccion: confianza },
    });
  }
  if (tipo === 'desconocido') {
    return respuesta('desconocido', 'tipo_no_identificado', { preguntas: [PREGUNTA_TIPO], advertencias });
  }
  if (confianza < umbral) {
    return respuesta('preguntar', 'confianza_baja', { preguntas: [PREGUNTA_FOTO_CLARA], advertencias });
  }

  const faltantes = [];
  const preguntas = [];
  const pedir = (campo) => {
    if (!faltantes.includes(campo)) {
      faltantes.push(campo);
      preguntas.push(PREGUNTAS[campo]);
    }
  };

  const numero = (v, campo) => {
    const r = leerNumero(v);
    if (r.invalido) advertencias.push(`valor_invalido:${campo}`);
    return r.valor;
  };
  const positivo = (v, campo) => {
    const n = numero(v, campo);
    if (n !== null && n <= 0) {
      advertencias.push(`valor_no_positivo:${campo}`);
      return null;
    }
    return n;
  };
  const noNegativo = (v, campo) => {
    const n = numero(v, campo);
    if (n !== null && n < 0) {
      advertencias.push(`valor_negativo:${campo}`);
      return null;
    }
    return n;
  };
  const entero = (v, campo) => {
    const n = numero(v, campo);
    if (n !== null && (!Number.isInteger(n) || n < 1)) {
      advertencias.push(`valor_no_entero_positivo:${campo}`);
      return null;
    }
    return n;
  };

  const p = raw.producto && typeof raw.producto === 'object' ? raw.producto : {};
  const c = raw.credito && typeof raw.credito === 'object' ? raw.credito : {};

  let periodicidad = null;
  if (c.periodicidad !== null && c.periodicidad !== undefined && c.periodicidad !== '') {
    const clave = typeof c.periodicidad === 'string' ? sinAcentos(c.periodicidad.trim().toLowerCase()) : null;
    if (clave && SINONIMOS_PERIODICIDAD[clave]) periodicidad = SINONIMOS_PERIODICIDAD[clave];
    else advertencias.push('valor_invalido:periodicidad');
  }

  const normalizarCargos = (lista) => {
    if (!Array.isArray(lista)) return [];
    return lista.map((item) => {
      const it = item && typeof item === 'object' ? item : {};
      const m = leerNumero(it.monto);
      const montoOk = !m.invalido && m.valor !== null && m.valor >= 0;
      if (!montoOk) pedir('comision_monto');
      const momento = MOMENTOS.includes(it.momento) ? it.momento : null;
      if (momento === null) pedir('comision_momento');
      return { concepto: texto(it.concepto) || 'cargo', monto: montoOk ? m.valor : null, momento };
    });
  };

  const credito = {
    otorgante_nombre_comercial: texto(c.otorgante_nombre_comercial),
    otorgante_razon_social: texto(c.otorgante_razon_social),
    monto_ofrecido: positivo(c.monto_ofrecido, 'monto_ofrecido'),
    monto_depositado: positivo(c.monto_depositado, 'monto_depositado'),
    enganche: noNegativo(c.enganche, 'enganche'),
    abono: positivo(c.abono, 'abono'),
    periodicidad,
    periodos_por_anio: PERIODOS_POR_ANIO[periodicidad] ?? null,
    numero_pagos: entero(c.numero_pagos, 'numero_pagos'),
    plazo_dias: entero(c.plazo_dias, 'plazo_dias'),
    monto_total_a_pagar: positivo(c.monto_total_a_pagar, 'monto_total_a_pagar'),
    comisiones: normalizarCargos(c.comisiones),
    seguros: normalizarCargos(c.seguros),
    cat_publicado: numero(c.cat_publicado, 'cat_publicado'),
  };
  const producto = {
    descripcion: texto(p.descripcion),
    precio_contado: positivo(p.precio_contado, 'precio_contado'),
    tienda: texto(p.tienda),
  };

  // Señales: las de texto exigen evidencia literal; las numéricas las calcula el código.
  const s = raw.senales_riesgo && typeof raw.senales_riesgo === 'object' ? raw.senales_riesgo : {};
  const evidencia = Array.isArray(s.texto_evidencia)
    ? s.texto_evidencia.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  const conEvidencia = (campo) => {
    if (s[campo] === true && evidencia.length === 0) {
      advertencias.push(`senal_sin_evidencia:${campo}`);
      return false;
    }
    return s[campo] === true;
  };
  const senales = {
    pide_anticipo: conEvidencia('pide_anticipo'),
    pide_permiso_contactos: conEvidencia('pide_permiso_contactos'),
    pide_permiso_fotos_archivos: conEvidencia('pide_permiso_fotos_archivos'),
    presion_urgencia: conEvidencia('presion_urgencia'),
    deposito_menor_a_ofrecido:
      credito.monto_depositado !== null && credito.monto_ofrecido !== null &&
      credito.monto_depositado < credito.monto_ofrecido,
    plazo_menor_a_15_dias: credito.plazo_dias !== null && credito.plazo_dias < PLAZO_CORTO_DIAS,
    texto_evidencia: evidencia,
  };

  let modo = null;
  let motivoCoherencia = null;
  let preguntaCoherencia = null;

  if (tipo === 'etiqueta_tienda') {
    modo = 'periodico';
    if (producto.precio_contado === null) pedir('precio_contado');
    if (credito.abono === null) pedir('abono');
    if (credito.numero_pagos === null) pedir('numero_pagos');
    if (credito.periodicidad === null || credito.periodicidad === 'unico') pedir('periodicidad');
    if (credito.enganche === null) {
      credito.enganche = 0;
      advertencias.push('enganche_no_indicado_se_asume_0');
    }
    if (faltantes.length === 0) {
      const pagos = credito.enganche + credito.abono * credito.numero_pagos;
      if (pagos < producto.precio_contado) {
        motivoCoherencia = 'pagos_menores_al_precio';
        preguntaCoherencia = PREGUNTA_PAGOS_MENORES_PRECIO;
      }
    }
  } else {
    // oferta_credito
    if (credito.monto_depositado === null) pedir('monto_depositado');
    const unico =
      credito.periodicidad === 'unico' ||
      (credito.abono === null && credito.numero_pagos === null && credito.periodicidad === null &&
        credito.plazo_dias !== null);
    const algoPeriodico =
      credito.abono !== null || credito.numero_pagos !== null ||
      (credito.periodicidad !== null && credito.periodicidad !== 'unico');
    if (unico) {
      modo = 'unico';
      if (credito.monto_total_a_pagar === null) pedir('monto_total_a_pagar');
      if (credito.plazo_dias === null) pedir('plazo_dias');
    } else if (algoPeriodico) {
      modo = 'periodico';
      if (credito.abono === null) pedir('abono');
      if (credito.numero_pagos === null) pedir('numero_pagos');
      if (credito.periodicidad === null) pedir('periodicidad');
    } else {
      pedir('forma_de_pago');
    }
    if (faltantes.length === 0) {
      const totalPagos =
        modo === 'unico' ? credito.monto_total_a_pagar : credito.abono * credito.numero_pagos;
      if (totalPagos < credito.monto_depositado) {
        motivoCoherencia = 'pago_menor_al_deposito';
        preguntaCoherencia = PREGUNTA_PAGO_MENOR_DEPOSITO;
      }
    }
  }

  if (faltantes.length > 0) {
    return respuesta('preguntar', 'datos_faltantes', {
      datos_faltantes: faltantes,
      preguntas,
      advertencias,
    });
  }
  if (motivoCoherencia) {
    return respuesta('preguntar', motivoCoherencia, { preguntas: [preguntaCoherencia], advertencias });
  }

  return respuesta('listo', 'ok', {
    advertencias,
    datos: {
      tipo_entrada: tipo,
      confianza_extraccion: confianza,
      modo_pago: modo,
      producto,
      credito,
      senales_riesgo: senales,
    },
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validarExtraccion, leerNumero, parsearJSON, UMBRAL_CONFIANZA };
}

// En n8n (nodo Code, "Run Once for All Items"): pegar este archivo completo y añadir al final
// las dos líneas siguientes. El nombre del campo de salida depende del nodo LLM (POR VERIFICAR
// con la primera ejecución real; puede ser `output`, `text` o `message.content`):
//
//   const salida = $input.first().json.output ?? $input.first().json.text ?? $input.first().json;
//   return [{ json: validarExtraccion(salida) }];
return module.exports;
})();

__modulos["calculo"] = (() => {
const module = { exports: {} };
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
return module.exports;
})();

__modulos["semaforo"] = (() => {
const module = { exports: {} };
'use strict';

/**
 * Semáforo (sección 10 del documento, con las correcciones acordadas).
 *
 * Entrada:  { calculo, senales, sipres } y opciones { umbrales }
 *   calculo  salida de calcular() (estado 'ok')
 *   senales  datos.senales_riesgo que entrega validarExtraccion() (solo préstamo)
 *   sipres   { estado, fecha_consulta, terminos_buscados } o null (solo préstamo)
 *            estado: 'registrada' | 'no_registrada_confirmada' | 'sin_verificar'
 * Salida:   { color, leyenda, razones, resumen, estado_sipres, advertencias }
 *   color    'verde' | 'amarillo' | 'rojo' | 'gris'
 *   razones  [{ codigo, nivel, hecho, evidencia, datos }]: hechos verificables, nunca juicios
 *
 * Reglas de fondo:
 *  - Cualquier razón roja manda y se listan todas.
 *  - 'sin_verificar' por sí solo NUNCA produce rojo: da gris.
 *  - Las señales de texto (anticipo, permisos, presión) solo cuentan con evidencia literal.
 *  - Las señales numéricas (plazo corto) las calculó el validador; el depósito se evalúa aquí
 *    con los montos del cálculo.
 *  - Verde significa "no detectamos riesgos con la información consultada", no "contrátalo".
 *  - La referencia del RIB NO entra en las reglas (decisión: solo contexto).
 *
 * Los umbrales amarillos del préstamo son PROPUESTAS a ajustar con el equipo.
 */

const UMBRALES = {
  tienda: { rojo_desde_pct: 50, amarillo_desde_pct: 15 },
  prestamo: { costo_amarillo_desde_pct: 50, tolerancia_deposito_pesos: 1 },
};

const ESTADOS_SIPRES = ['registrada', 'no_registrada_confirmada', 'sin_verificar'];

const LEYENDAS = {
  verde: 'No detectamos riesgos con la información consultada. Esto no es una recomendación de contratar.',
  amarillo: 'Hay puntos que conviene revisar antes de decidir.',
  rojo: 'Encontramos señales de riesgo. Revisa estos hechos antes de dar tus datos o firmar.',
  gris: 'No pudimos verificar todo con la información disponible.',
};

const ORDEN_NIVEL = { rojo: 0, amarillo: 1, gris: 2, verde: 3, info: 4 };

function pesos(n) {
  const entero = Number.isInteger(n);
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function razon(codigo, nivel, hecho, evidencia = [], datos = {}) {
  return { codigo, nivel, hecho, evidencia, datos };
}

function resultado(color, razones, advertencias, estadoSipres = null) {
  const ordenadas = razones
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDEN_NIVEL[a.r.nivel] - ORDEN_NIVEL[b.r.nivel] || a.i - b.i)
    .map((x) => x.r);
  return {
    color,
    leyenda: LEYENDAS[color],
    razones: ordenadas,
    resumen: {
      rojas: ordenadas.filter((r) => r.nivel === 'rojo').length,
      amarillas: ordenadas.filter((r) => r.nivel === 'amarillo').length,
    },
    estado_sipres: estadoSipres,
    advertencias,
  };
}

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function semaforoTienda(calculo, umbral, advertencias) {
  const m = calculo.metricas || {};
  const pct = m.sobrecosto_pct;
  if (!esNumero(pct) || pct < 0 || !esNumero(m.costo_total) || !esNumero(m.precio_contado)) {
    return resultado(
      'gris',
      [razon('datos_incoherentes', 'gris', 'Los datos de la etiqueta no cuadran; conviene revisarlos.')],
      advertencias
    );
  }
  const nivel = pct >= umbral.rojo_desde_pct ? 'rojo' : pct >= umbral.amarillo_desde_pct ? 'amarillo' : 'verde';
  const hecho =
    `En abonos pagas ${pesos(m.costo_total)} y de contado cuesta ${pesos(m.precio_contado)}: ` +
    `${pesos(m.sobrecosto_pesos)} más (${pct}%).`;
  return resultado(
    nivel,
    [
      razon('sobrecosto', nivel, hecho, [], {
        costo_total: m.costo_total,
        precio_contado: m.precio_contado,
        sobrecosto_pesos: m.sobrecosto_pesos,
        sobrecosto_pct: pct,
        umbral_rojo_pct: umbral.rojo_desde_pct,
        umbral_amarillo_pct: umbral.amarillo_desde_pct,
      }),
    ],
    advertencias
  );
}

function semaforoPrestamo(calculo, senales, sipres, umbral, advertencias) {
  const m = calculo.metricas || {};
  const sig = senales && typeof senales === 'object' ? senales : {};
  const evidencia = Array.isArray(sig.texto_evidencia)
    ? sig.texto_evidencia.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  const conEvidencia = (campo) => {
    if (sig[campo] === true && evidencia.length === 0) {
      advertencias.push(`senal_sin_evidencia:${campo}`);
      return false;
    }
    return sig[campo] === true;
  };

  // SIPRES: tres estados. Todo lo que no sea uno de ellos se trata como sin verificar.
  let estado = 'sin_verificar';
  if (sipres && typeof sipres === 'object') {
    if (ESTADOS_SIPRES.includes(sipres.estado)) estado = sipres.estado;
    else advertencias.push('estado_sipres_invalido');
  }
  const fecha =
    sipres && typeof sipres.fecha_consulta === 'string' && sipres.fecha_consulta.trim()
      ? sipres.fecha_consulta.trim()
      : null;
  if (estado !== 'sin_verificar' && !fecha) advertencias.push('sipres_sin_fecha');
  const terminos =
    sipres && Array.isArray(sipres.terminos_buscados)
      ? sipres.terminos_buscados.filter((t) => typeof t === 'string' && t.trim())
      : [];

  const razones = [];

  if (estado === 'no_registrada_confirmada') {
    razones.push(
      razon(
        'sipres_no_registrada_confirmada',
        'rojo',
        `No la encontramos en el SIPRES de Condusef (búsqueda manual${fecha ? ' del ' + fecha : ''}).`,
        terminos.length ? [`Términos buscados: ${terminos.join(', ')}`] : [],
        { fecha_consulta: fecha }
      )
    );
  } else if (estado === 'registrada') {
    razones.push(
      razon(
        'sipres_registrada',
        'verde',
        `Aparece registrada en el SIPRES de Condusef (consulta${fecha ? ' del ' + fecha : ''}).`,
        [],
        { fecha_consulta: fecha }
      )
    );
  } else {
    razones.push(
      razon('sipres_sin_verificar', 'gris', 'No la tenemos en nuestra base; hay que verificarla en el SIPRES.')
    );
  }

  if (conEvidencia('pide_anticipo')) {
    razones.push(razon('pide_anticipo', 'rojo', 'Pide un pago por adelantado para liberar el crédito.', evidencia));
  }
  if (conEvidencia('pide_permiso_contactos')) {
    razones.push(razon('pide_permiso_contactos', 'rojo', 'Pide acceso a tus contactos.', evidencia));
  }
  if (conEvidencia('pide_permiso_fotos_archivos')) {
    razones.push(razon('pide_permiso_fotos_archivos', 'rojo', 'Pide acceso a tus fotos o archivos.', evidencia));
  }

  const dif = m.diferencia_ofrecido_depositado;
  if (esNumero(dif) && dif > 0) {
    const cargos = esNumero(m.cargos_iniciales_declarados) ? m.cargos_iniciales_declarados : 0;
    if (dif - cargos > umbral.tolerancia_deposito_pesos) {
      razones.push(
        razon(
          'deposito_menor_sin_explicacion',
          'rojo',
          `Ofrece ${pesos(m.monto_ofrecido)} pero deposita ${pesos(m.recibes)}: ${pesos(dif)} menos, ` +
            'y no declara cargos que lo expliquen.',
          [],
          { monto_ofrecido: m.monto_ofrecido, recibes: m.recibes, diferencia: dif, cargos_iniciales: cargos }
        )
      );
    } else {
      razones.push(
        razon(
          'deposito_menor_con_cargos',
          'info',
          `Deposita ${pesos(dif)} menos de lo ofrecido, que corresponde a cargos iniciales declarados (${pesos(cargos)}).`,
          [],
          { diferencia: dif, cargos_iniciales: cargos }
        )
      );
    }
  }

  const pct = m.costo_pct_sobre_recibido;
  if (esNumero(pct) && pct >= umbral.costo_amarillo_desde_pct) {
    razones.push(
      razon(
        'costo_alto',
        'amarillo',
        `Pagarías ${pesos(m.pagas)} por recibir ${pesos(m.recibes)}: ${pesos(m.costo_credito_pesos)} de costo ` +
          `(${pct}% de lo que recibes).`,
        [],
        {
          pagas: m.pagas,
          recibes: m.recibes,
          costo_credito_pesos: m.costo_credito_pesos,
          costo_pct_sobre_recibido: pct,
          cat_texto: calculo.cat ? calculo.cat.texto : null,
          umbral_pct: umbral.costo_amarillo_desde_pct,
        }
      )
    );
  }
  if (sig.plazo_menor_a_15_dias === true) {
    razones.push(razon('plazo_muy_corto', 'amarillo', 'El plazo para pagar es menor a 15 días.'));
  }
  if (conEvidencia('presion_urgencia')) {
    razones.push(razon('presion_urgencia', 'amarillo', 'Usa frases de presión o urgencia.', evidencia));
  }

  let color;
  if (razones.some((r) => r.nivel === 'rojo')) color = 'rojo';
  else if (estado === 'sin_verificar') color = 'gris';
  else color = razones.some((r) => r.nivel === 'amarillo') ? 'amarillo' : 'verde';

  if (color === 'verde') {
    razones.push(razon('sin_senales_de_riesgo', 'verde', 'No se detectaron señales de riesgo en lo que enviaste.'));
  }
  return resultado(color, razones, advertencias, estado);
}

function semaforo(entrada = {}, opciones = {}) {
  const { calculo, senales, sipres } = entrada || {};
  const u = opciones && opciones.umbrales ? opciones.umbrales : {};
  const umbrales = {
    tienda: { ...UMBRALES.tienda, ...(u.tienda || {}) },
    prestamo: { ...UMBRALES.prestamo, ...(u.prestamo || {}) },
  };
  const advertencias = [];

  if (!calculo || calculo.estado !== 'ok' || (calculo.tipo !== 'tienda' && calculo.tipo !== 'prestamo')) {
    return resultado(
      'gris',
      [razon('sin_calculo', 'gris', 'No hay datos suficientes para calcular el costo.')],
      advertencias
    );
  }
  if (calculo.tipo === 'tienda') return semaforoTienda(calculo, umbrales.tienda, advertencias);
  return semaforoPrestamo(calculo, senales, sipres, umbrales.prestamo, advertencias);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { semaforo, UMBRALES, LEYENDAS, ESTADOS_SIPRES };
}

// En n8n (nodo Code, "Run Once for All Items"): pegar este archivo completo y añadir al final
// (los nombres de los nodos anteriores son POR VERIFICAR con tu flujo):
//
//   const validado = $('Validar extracción').first().json;
//   const calculo = $('Calcular').first().json;
//   const sipres = $('Buscar SIPRES').first().json ?? null;
//   return [{ json: semaforo({ calculo, senales: validado.datos.senales_riesgo, sipres }) }];
return module.exports;
})();

__modulos["respuesta"] = (() => {
const module = { exports: {} };
'use strict';

/**
 * Respuesta al usuario: contexto para la IA, plantillas deterministas, verificador y elección.
 * Un solo archivo, sin dependencias, para pegarlo en un nodo Code de n8n.
 *
 * Flujo:
 *   armarContexto({ calculo, semaforo, fuentes, config })   -> ctx (JSON para el LLM de redacción)
 *   [nodo LLM de redacción con prompt-redaccion.md recibe ctx y devuelve texto]
 *   elegirRespuesta(textoLLM, ctx)                          -> { texto, origen, motivo, fallas }
 *       origen 'llm' si el texto pasa verificarRespuesta(); si no, 'plantilla' (sin IA, mismas cifras).
 *
 * Principios: la IA solo redacta; cada cifra sale del cálculo; solo hechos con fuente y fecha;
 * nunca se recomienda contratar ni se califica a una empresa; no se inventan enlaces.
 *
 * fuentes: { cetes: { fecha, descripcion?, respaldo? }, sipres: { fecha } }
 * config:  { enlaceHackathon?, enlaceSipres?, canalesCobranza? }  (enlaceSipres POR VERIFICAR: si no
 *          se configura, el mensaje no incluye enlace)
 */

const ENLACE_HACKATHON = 'https://hackathon.clara.com/';
const AVISO_CAT = 'CAT estimado con fines informativos, sin IVA; puede diferir del CAT oficial.';
const MAX_LINEAS = 10;
const MAX_CARACTERES = 3500;
const MAX_HECHOS = 3;

const EMOJI = { verde: '🟢', amarillo: '🟡', rojo: '🔴', gris: '⚪' };
const EMOJI_NIVEL = { rojo: '❌', amarillo: '⚠️', gris: '❔', verde: '✅', info: 'ℹ️' };
const UNIDADES = {
  semanal: { singular: 'semana', plural: 'semanas', cada: 'cada semana' },
  quincenal: { singular: 'quincena', plural: 'quincenas', cada: 'cada quincena' },
  mensual: { singular: 'mes', plural: 'meses', cada: 'cada mes' },
  diario: { singular: 'día', plural: 'días', cada: 'cada día' },
};
const CODIGOS_TEXTO = ['pide_anticipo', 'pide_permiso_contactos', 'pide_permiso_fotos_archivos', 'presion_urgencia'];

// Normalizadas (minúsculas y sin acentos). El verificador las busca en el texto normalizado.
const PROHIBIDAS = [
  /\bfraud\w*/,
  /\bestaf\w*/,
  /\bmontadeud\w*/,
  /\bilegal\w*/,
  /\bdelincuen\w*/,
  /\bladron\w*/,
  /\bno uses\b/,
  /\brecomend(amos|arias?|are|iendo|able|ado|ada)\b[^.\n]{0,30}\b(contrat|acept|pedir|tomar)/,
  /\brecomiend(o|a|an)\b[^.\n]{0,30}\b(contrat|acept|pedir|tomar)/,
];

const RE_PESOS = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const RE_PCT = /(\d[\d,]*(?:\.\d+)?)\s?%/g;
const RE_CONTEO = /(\d[\d,]*)\s+(?:semanas?|quincenas?|meses|mes|d[ií]as?|pagos?)\b/gi;
const RE_NUMERO = /\d[\d,]*(?:\.\d+)?/g;

// ---------- utilidades ----------

function pesos(n) {
  const entero = Number.isInteger(n);
  return (
    '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: entero ? 0 : 2, maximumFractionDigits: 2 })
  );
}

function unDecimal(n) {
  return String(Math.round(n * 10) / 10);
}

function plural(n, unidad) {
  return `${n} ${n === 1 ? unidad.singular : unidad.plural}`;
}

function unir(lineas) {
  return lineas.filter((l) => typeof l === 'string' && l.length > 0).join('\n');
}

function normalizar(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function aNumero(cadena) {
  return Number(cadena.replace(/,/g, ''));
}

function recolectarNumeros(valor, salida) {
  if (typeof valor === 'number' && Number.isFinite(valor)) salida.add(valor);
  else if (Array.isArray(valor)) valor.forEach((v) => recolectarNumeros(v, salida));
  else if (valor && typeof valor === 'object') Object.values(valor).forEach((v) => recolectarNumeros(v, salida));
}

function numerosEnTexto(texto, salida) {
  for (const m of String(texto).matchAll(RE_NUMERO)) salida.add(aNumero(m[0]));
}

/** Cifras que aparecen en un texto, con su tipo y decimales, para compararlas con las permitidas. */
function extraerCifras(texto) {
  const cifras = [];
  const registrar = (regex, tipo) => {
    for (const m of texto.matchAll(regex)) {
      const cadena = m[1];
      cifras.push({ tipo, original: m[0].trim(), valor: aNumero(cadena), decimales: (cadena.split('.')[1] || '').length });
    }
  };
  registrar(RE_PESOS, 'pesos');
  registrar(RE_PCT, 'porcentaje');
  registrar(RE_CONTEO, 'conteo');
  return cifras;
}

/** Una cifra del texto es válida si coincide con una permitida hasta la mitad de su último decimal. */
function esPermitida(valor, decimales, permitidas) {
  const tolerancia = 0.5 * Math.pow(10, -decimales) + 1e-9;
  return permitidas.some((n) => Math.abs(n - valor) <= tolerancia);
}

// ---------- contexto para el LLM ----------

function armarContexto({ calculo, semaforo, fuentes = {}, config = {} } = {}) {
  if (!calculo || calculo.estado !== 'ok' || !semaforo || !EMOJI[semaforo.color]) return null;
  const cfg = { enlaceHackathon: ENLACE_HACKATHON, enlaceSipres: null, ...config };
  const tipo = calculo.tipo;
  const m = calculo.metricas || {};
  const ahorro = calculo.ahorro || null;
  const advertencias = [];

  const razones = (semaforo.razones || []).map((r) => ({
    codigo: r.codigo,
    nivel: r.nivel,
    hecho: r.hecho,
    evidencia: Array.isArray(r.evidencia) ? r.evidencia.slice() : [],
  }));

  const requeridas = [];
  const cetes = fuentes && fuentes.cetes;
  if (tipo === 'tienda' && ahorro && ahorro.con_rendimiento) {
    if (cetes && cetes.fecha) {
      requeridas.push({
        nombre: 'Banxico',
        detalle: cetes.descripcion || 'CETES 28 días, subasta semanal',
        fecha: cetes.fecha,
        respaldo: Boolean(cetes.respaldo),
      });
    } else {
      advertencias.push('falta_fuente_cetes');
    }
  }
  const sipresFecha = fuentes && fuentes.sipres && fuentes.sipres.fecha;
  if (
    tipo === 'prestamo' &&
    (semaforo.estado_sipres === 'registrada' || semaforo.estado_sipres === 'no_registrada_confirmada')
  ) {
    if (sipresFecha) requeridas.push({ nombre: 'SIPRES, Condusef', detalle: null, fecha: sipresFecha, respaldo: false });
    else advertencias.push('falta_fecha_sipres');
  }

  const numeros = new Set([1000]);
  recolectarNumeros(m, numeros);
  recolectarNumeros(ahorro, numeros);
  recolectarNumeros(calculo.cat && calculo.cat.porcentaje, numeros);
  requeridas.forEach((f) => numerosEnTexto(f.detalle || '', numeros)); // p. ej. "28" de CETES 28 días
  (semaforo.razones || []).forEach((r) => {
    recolectarNumeros(r.datos, numeros);
    numerosEnTexto(r.hecho, numeros);
  });

  const cat = calculo.cat || null;
  return {
    tipo,
    color: semaforo.color,
    leyenda: semaforo.leyenda,
    estado_sipres: semaforo.estado_sipres || null,
    razones,
    metricas: m,
    cat: cat ? { texto: cat.texto, porcentaje: cat.porcentaje, motivo: cat.motivo } : null,
    ahorro: ahorro
      ? {
          periodos: ahorro.periodos,
          periodicidad: ahorro.periodicidad,
          es_tope: ahorro.es_tope,
          con_rendimiento: ahorro.con_rendimiento,
          aportado: ahorro.aportado,
          ahorro_vs_credito: ahorro.ahorro_vs_credito,
          tasa_anual_usada_pct: ahorro.tasa_anual_usada_pct,
        }
      : null,
    fuente_calculo:
      tipo === 'tienda' ? 'cálculo propio con los datos de la etiqueta' : 'cálculo propio con los datos de la captura',
    fuentes_a_citar: requeridas,
    mostrar_cat: Boolean(cat && cat.texto),
    aviso_cat: AVISO_CAT,
    enlaces: { hackathon: cfg.enlaceHackathon, sipres: cfg.enlaceSipres },
    cifras_permitidas: Array.from(numeros).sort((a, b) => a - b),
    advertencias,
  };
}

// ---------- plantillas deterministas ----------

function lineaFuentes(ctx) {
  const citadas = ctx.fuentes_a_citar.map((f) => {
    if (f.nombre === 'Banxico') return `Banxico, ${f.detalle} (${f.fecha}${f.respaldo ? ', dato de respaldo' : ''})`;
    return `${f.nombre} (${f.fecha})`;
  });
  const partes =
    ctx.tipo === 'prestamo' ? [...citadas, ctx.fuente_calculo] : [ctx.fuente_calculo, ...citadas];
  return `📊 Fuentes: ${partes.join('; ')}.`;
}

function lineaHackathon(ctx) {
  return `Hecho en el AI Hackathon por México: ${ctx.enlaces.hackathon}`;
}

function lineaCAT(ctx) {
  if (!ctx.mostrar_cat) return null;
  const texto = ctx.cat.texto;
  const anual = texto.endsWith('%') && !texto.startsWith('más') ? ' anual' : '';
  return `CAT implícito estimado: ${texto}${anual} (informativo, sin IVA; puede diferir del CAT oficial).`;
}

function plantillaTienda(ctx) {
  const m = ctx.metricas;
  const e = EMOJI[ctx.color];
  if (ctx.color === 'gris') {
    return unir([
      `${e} No pudimos validar los datos de la etiqueta.`,
      'Mándame una foto más clara o escribe el precio de contado, el abono y cuántos pagos son.',
      lineaFuentes(ctx),
      lineaHackathon(ctx),
    ]);
  }
  const unidad = UNIDADES[m.periodicidad];
  const reparto = unidad && m.numero_pagos ? ` repartidos en ${plural(m.numero_pagos, unidad)}` : '';
  const a = ctx.ahorro;
  let alternativa = null;
  if (a) {
    const u = UNIDADES[a.periodicidad] || unidad;
    const abono = typeof m.abono === 'number' ? m.abono : a.aportado / a.periodos;
    const tope = a.es_tope ? ' o menos' : '';
    const evita = a.ahorro_vs_credito > 0 ? ` y evitas pagar ≈${pesos(a.ahorro_vs_credito)} de más` : '';
    alternativa =
      `💡 Si apartas ${pesos(abono)} ${u.cada}, juntas el precio de contado en ${plural(a.periodos, u)}` +
      `${tope}${evita}.`;
  }
  return unir([
    `${e} En abonos pagas ${pesos(m.costo_total)}. De contado cuesta ${pesos(m.precio_contado)}.`,
    `Son ${pesos(m.sobrecosto_pesos)} de más (${unDecimal(m.sobrecosto_pct)}%)${reparto}.`,
    lineaCAT(ctx),
    alternativa,
    ctx.color === 'verde' ? ctx.leyenda : null,
    lineaFuentes(ctx),
    lineaHackathon(ctx),
  ]);
}

const TITULOS_PRESTAMO = {
  rojo: 'Encontramos señales de riesgo en esta oferta',
  amarillo: 'Hay puntos que conviene revisar en esta oferta',
  verde: 'No detectamos señales de riesgo en lo que enviaste',
  gris: 'No pudimos verificar esta oferta en nuestra base',
};

function recortar(texto, max) {
  return texto.length > max ? texto.slice(0, max - 1) + '…' : texto;
}

function plantillaPrestamo(ctx) {
  const m = ctx.metricas;
  const sipresR = ctx.razones.find((r) => r.codigo.startsWith('sipres_')) || null;
  // "costo_alto" no se repite como viñeta: lo dice la línea de costo, con su porcentaje.
  const candidatas = ctx.razones.filter(
    (r) =>
      r !== sipresR &&
      r.codigo !== 'costo_alto' &&
      (r.nivel === 'rojo' || r.nivel === 'amarillo' || r.nivel === 'gris')
  );
  const cupo = MAX_HECHOS - (sipresR ? 1 : 0);
  const elegidas = new Set(candidatas.slice(0, cupo));
  if (sipresR) elegidas.add(sipresR);
  const mostradas = ctx.razones.filter((r) => elegidas.has(r));
  const restantes = candidatas.length - cupo;

  const conTexto = mostradas.find((r) => CODIGOS_TEXTO.includes(r.codigo) && r.evidencia.length > 0);
  const evidencia = conTexto
    ? `Lo que dice la oferta: ${conTexto.evidencia
        .slice(0, 2)
        .map((t) => `«${recortar(t, 80)}»`)
        .join(' ')}`
    : null;

  const costo = m.pagas - m.recibes;
  const costoAlto = ctx.razones.some((r) => r.codigo === 'costo_alto');
  const detalleCosto =
    costo > 0
      ? ` (${pesos(costo)} de costo${costoAlto ? `, ${unDecimal(m.costo_pct_sobre_recibido)}% de lo que recibes` : ''})`
      : '';
  const lineaCosto = `Pagarías ${pesos(m.pagas)} por recibir ${pesos(m.recibes)}${detalleCosto}.`;
  const cat = lineaCAT(ctx);

  const permisos = ctx.razones.some(
    (r) => r.codigo === 'pide_permiso_contactos' || r.codigo === 'pide_permiso_fotos_archivos'
  );
  const enlace = ctx.enlaces.sipres ? `: ${ctx.enlaces.sipres}` : '.';
  let accion;
  if (ctx.color === 'gris') {
    accion = `👉 Verifícala tú en el SIPRES de Condusef${enlace}`;
  } else if (ctx.color === 'rojo') {
    const base =
      ctx.estado_sipres === 'registrada'
        ? '✅ Antes de dar tus datos, revisa bien estos puntos.'
        : `✅ Antes de dar tus datos, verifica el registro en el SIPRES de Condusef${enlace}`;
    accion = base + (permisos ? ' Si ya instalaste la app, revisa y retira sus permisos.' : '');
  } else {
    accion = '💡 Registrada no significa conveniente: compara antes de aceptar.';
  }

  return unir([
    `${EMOJI[ctx.color]} ${TITULOS_PRESTAMO[ctx.color]}`,
    ...mostradas.map((r) => `${EMOJI_NIVEL[r.nivel]} ${r.hecho}`),
    restantes > 0 ? `… y ${restantes} ${restantes === 1 ? 'hecho más' : 'hechos más'}.` : null,
    evidencia,
    cat ? `${lineaCosto} ${cat}` : lineaCosto,
    accion,
    ctx.color === 'verde' ? ctx.leyenda : null,
    lineaFuentes(ctx),
    lineaHackathon(ctx),
  ]);
}

function plantillaDesdeContexto(ctx) {
  if (!ctx) return mensajes.error();
  return ctx.tipo === 'tienda' ? plantillaTienda(ctx) : plantillaPrestamo(ctx);
}

function plantillaCobranza(config = {}) {
  const enlace = config.enlaceHackathon || ENLACE_HACKATHON;
  const canales =
    typeof config.canalesCobranza === 'string' && config.canalesCobranza.trim() ? ' ' + config.canalesCobranza.trim() : '';
  return unir([
    '🫂 Lamento lo que estás viviendo. Estos pasos pueden ayudarte:',
    '1. Revisa y retira los permisos de la app (contactos, fotos y archivos).',
    '2. Evita pagar bajo amenazas y guarda la evidencia: mensajes, capturas y condiciones.',
    `3. Acude a la Condusef y a la Policía Cibernética de tu estado.${canales}`,
    'Esto es solo orientación, no asesoría legal.',
    `Hecho en el AI Hackathon por México: ${enlace}`,
  ]);
}

const mensajes = {
  bienvenida(config = {}) {
    const enlace = config.enlaceHackathon || ENLACE_HACKATHON;
    return unir([
      'Hola, soy Cuentas Claras 👋',
      'Mándame una foto de una etiqueta de abonos o de la oferta de un préstamo, o escríbeme los datos (precio, pagos y plazo), y te digo cuánto cuesta de verdad.',
      'No guardo fotos ni datos personales.',
      `Hecho en el AI Hackathon por México: ${enlace}`,
    ]);
  },
  noEntendido(config = {}) {
    const enlace = config.enlaceHackathon || ENLACE_HACKATHON;
    return unir([
      'No pude entender ese mensaje. Mándame una foto o escribe los datos (precio, pagos y plazo).',
      `Hecho en el AI Hackathon por México: ${enlace}`,
    ]);
  },
  error(config = {}) {
    const enlace = config.enlaceHackathon || ENLACE_HACKATHON;
    return unir([
      'Algo falló de nuestro lado. ¿Puedes intentar de nuevo en un momento?',
      `Hecho en el AI Hackathon por México: ${enlace}`,
    ]);
  },
  aclaracion(preguntas = [], config = {}) {
    const enlace = config.enlaceHackathon || ENLACE_HACKATHON;
    const lista = preguntas.filter((p) => typeof p === 'string' && p.trim());
    return unir([
      lista.length > 1 ? 'Para calcularlo necesito saber:' : null,
      ...(lista.length > 1 ? lista.map((p) => `• ${p}`) : lista),
      `Hecho en el AI Hackathon por México: ${enlace}`,
    ]);
  },
};

// ---------- verificador ----------

/**
 * Las citas «...» que coinciden con la evidencia literal de la oferta no se revisan como cifras
 * (son texto de la oferta, no cálculos nuestros). Una cita que no esté en la evidencia sí se revisa.
 */
function quitarCitasVerificadas(texto, ctx) {
  const evidencias = ctx.razones.flatMap((r) => r.evidencia || []);
  return texto.replace(/«([^»]*)»/g, (cita, contenido) => {
    const limpio = contenido.replace(/…$/, '').trim();
    return limpio && evidencias.some((e) => e.startsWith(limpio)) ? ' ' : cita;
  });
}

function urlsEnTexto(texto) {
  return (texto.match(/https?:\/\/[^\s]+/g) || []).map((u) => u.replace(/[.,;:)»"]+$/, ''));
}

function verificarRespuesta(texto, ctx, opciones = {}) {
  if (typeof texto !== 'string' || !texto.trim()) return { ok: false, fallas: [{ codigo: 'texto_vacio' }] };
  if (!ctx) return { ok: false, fallas: [{ codigo: 'sin_contexto' }] };
  const fallas = [];
  const falla = (codigo, detalle) => fallas.push(detalle === undefined ? { codigo } : { codigo, detalle });
  const maxLineas = typeof opciones.maxLineas === 'number' ? opciones.maxLineas : MAX_LINEAS;
  const maxCaracteres = typeof opciones.maxCaracteres === 'number' ? opciones.maxCaracteres : MAX_CARACTERES;

  const lineas = texto.split('\n').filter((l) => l.trim());
  if (lineas.length > maxLineas) falla('demasiadas_lineas', `${lineas.length} líneas`);
  if (texto.length > maxCaracteres) falla('demasiado_largo', `${texto.length} caracteres`);

  if (!texto.includes(ctx.enlaces.hackathon)) falla('falta_enlace_hackathon');
  if (!/fuentes?:/i.test(texto)) falla('falta_fuentes');
  for (const f of ctx.fuentes_a_citar) {
    if (!texto.includes(f.fecha)) falla('falta_fecha_fuente', f.nombre);
  }
  if (!lineas[0] || !lineas[0].includes(EMOJI[ctx.color])) falla('semaforo_incorrecto', `se esperaba ${EMOJI[ctx.color]}`);

  const norm = normalizar(texto);
  for (const patron of PROHIBIDAS) {
    const hallazgo = norm.match(patron);
    if (hallazgo) falla('palabra_prohibida', hallazgo[0]);
  }

  // Cada cifra del texto debe venir del cálculo.
  const cifras = extraerCifras(quitarCitasVerificadas(texto, ctx));
  for (const c of cifras) {
    if (!esPermitida(c.valor, c.decimales, ctx.cifras_permitidas)) falla('cifra_no_respaldada', c.original);
  }
  const m = ctx.metricas || {};
  const clave = ctx.tipo === 'tienda' ? [m.costo_total, m.precio_contado] : [m.recibes, m.pagas];
  if (!(ctx.tipo === 'tienda' && ctx.color === 'gris')) {
    for (const esperado of clave) {
      if (typeof esperado !== 'number') continue;
      const hay = cifras.some((c) => c.tipo === 'pesos' && esPermitida(c.valor, c.decimales, [esperado]));
      if (!hay) falla('falta_cifra_clave', pesos(esperado));
    }
  }

  if (ctx.mostrar_cat && /\bCAT\b/.test(texto) && /%/.test(texto)) {
    if (!/informativ/i.test(texto) || !/sin iva/i.test(texto)) falla('falta_aviso_cat');
  }

  if (ctx.estado_sipres === 'sin_verificar' && /\bno (esta|aparece|figura|se encuentra) registrad/.test(norm)) {
    falla('afirma_no_registrada_sin_verificar');
  }
  if (
    ctx.estado_sipres === 'registrada' &&
    (/no la encontramos en el sipres/.test(norm) || /\bno (esta|aparece) registrad/.test(norm))
  ) {
    falla('contradice_estado_sipres');
  }

  const permitidas = [ctx.enlaces.hackathon, ctx.enlaces.sipres]
    .filter(Boolean)
    .map((u) => u.replace(/[.,;:)»"]+$/, ''));
  for (const u of urlsEnTexto(texto)) {
    if (!permitidas.includes(u)) falla('enlace_no_permitido', u);
  }

  return { ok: fallas.length === 0, fallas };
}

/**
 * Saca el texto de lo que devuelve un nodo LLM de n8n, sea cual sea su formato.
 * Los nombres de campo cambian según el nodo y la versión: POR VERIFICAR con la primera ejecución real.
 */
function textoDeSalidaLLM(salida) {
  const comoTexto = (v) => {
    if (typeof v === 'string') return v.trim() ? v : null;
    if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
    return null;
  };
  if (typeof salida === 'string') return salida;
  if (!salida || typeof salida !== 'object') return '';
  for (const k of ['output', 'text', 'response', 'content']) {
    const t = comoTexto(salida[k]);
    if (t) return t;
  }
  if (salida.message && typeof salida.message.content === 'string') return salida.message.content;
  if (Array.isArray(salida.choices) && salida.choices[0]) {
    const c = salida.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (Array.isArray(salida.content)) {
    const bloque = salida.content.find((b) => b && typeof b.text === 'string');
    if (bloque) return bloque.text;
  }
  if (salida.tipo_entrada) return JSON.stringify(salida);
  return '';
}

function elegirRespuesta(textoLLM, ctx, opciones = {}) {
  if (!ctx) return { texto: mensajes.error(), origen: 'mensaje_fijo', motivo: 'sin_contexto', fallas: [] };
  const plantilla = plantillaDesdeContexto(ctx);
  if (typeof textoLLM !== 'string' || !textoLLM.trim()) {
    return { texto: plantilla, origen: 'plantilla', motivo: 'sin_texto_llm', fallas: [] };
  }
  const limpio = textoLLM.trim();
  const v = verificarRespuesta(limpio, ctx, opciones);
  if (v.ok) return { texto: limpio, origen: 'llm', motivo: 'ok', fallas: [] };
  return { texto: plantilla, origen: 'plantilla', motivo: 'verificacion_fallida', fallas: v.fallas };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    armarContexto,
    plantillaDesdeContexto,
    plantillaTienda,
    plantillaPrestamo,
    plantillaCobranza,
    mensajes,
    verificarRespuesta,
    elegirRespuesta,
    textoDeSalidaLLM,
    extraerCifras,
    ENLACE_HACKATHON,
    AVISO_CAT,
    MAX_LINEAS,
  };
}

// En n8n (dos nodos Code; los nombres de los nodos anteriores son POR VERIFICAR con tu flujo):
//
//   Nodo "Armar contexto" (pegar este archivo y añadir al final):
//     const calculo = $('Calcular').first().json;
//     const semaforo = $('Semáforo').first().json;
//     const fuentes = { cetes: $('Leer CETES').first().json.fuente ?? null, sipres: { fecha: '30/10/2026' } };
//     return [{ json: armarContexto({ calculo, semaforo, fuentes, config: { enlaceSipres: null } }) }];
//
//   Nodo "Elegir respuesta" (pegar este archivo y añadir al final):
//     const ctx = $('Armar contexto').first().json;
//     const textoLLM = $input.first().json.output ?? $input.first().json.text ?? '';
//     return [{ json: elegirRespuesta(textoLLM, ctx) }];
return module.exports;
})();

__modulos["banxico"] = (() => {
const module = { exports: {} };
'use strict';

/**
 * Tasa de CETES 28 días a partir de la respuesta de la API SIE de Banxico, con respaldo local.
 *
 * Serie SF43936: "Valores gubernamentales, resultados de la subasta semanal, tasa de rendimiento
 * Cetes a 28 días" (verificada con la API el 30/10/2026). POR VERIFICAR: el título no dice "anual".
 * La tasa de rendimiento de una subasta de CETES es anual, pero no está confirmado con la API.
 *
 * Entrada: el JSON de GET /series/SF43936/datos/oportuno (objeto o texto), o el error del nodo HTTP.
 * Salida:  { tasa_pct, fuente: { fecha, descripcion, respaldo }, motivo }
 *
 * Si la API falla, responde otra cosa o trae un dato inválido, se usa el respaldo y se marca
 * `respaldo: true` para que la respuesta lo diga. Nunca lanza excepciones.
 *
 * Detalle real de la API: con varias series en una llamada el ORDEN de la respuesta no es el de la
 * petición, así que la serie se busca por `idSerie`, nunca por posición.
 */

const ID_SERIE = 'SF43936';
const DESCRIPCION = 'CETES 28 días, subasta semanal';
// Instantánea guardada el 30/10/2026 (datos/crudo/banxico_sie/series_candidatas_2026-10-30.json).
const RESPALDO = { tasa_pct: 6.22, fecha: '29/10/2026' };
const RE_FECHA = /^\d{2}\/\d{2}\/\d{4}$/;

function aObjeto(respuesta) {
  if (respuesta && typeof respuesta === 'object') return respuesta;
  if (typeof respuesta === 'string' && respuesta.trim()) {
    try {
      const o = JSON.parse(respuesta);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}

function tasaCetes(respuesta, opciones = {}) {
  const idSerie = opciones.idSerie || ID_SERIE;
  const respaldo = { ...RESPALDO, ...(opciones.respaldo || {}) };
  const conRespaldo = (motivo) => ({
    tasa_pct: respaldo.tasa_pct,
    fuente: { fecha: respaldo.fecha, descripcion: DESCRIPCION, respaldo: true },
    motivo,
  });

  const r = aObjeto(respuesta);
  if (!r) return conRespaldo('sin_respuesta');
  if (r.error || (!r.bmx && (r.message || r.statusCode || r.code))) return conRespaldo('error_api');
  const series = r.bmx && Array.isArray(r.bmx.series) ? r.bmx.series : null;
  if (!series) return conRespaldo('respuesta_sin_series');
  const serie = series.find((s) => s && s.idSerie === idSerie);
  if (!serie) return conRespaldo('serie_ausente');
  const dato = Array.isArray(serie.datos) ? serie.datos[0] : null;
  if (!dato) return conRespaldo('sin_datos');

  const tasa = Number(String(dato.dato).replace(/,/g, ''));
  if (!Number.isFinite(tasa) || tasa <= 0 || tasa >= 100 || typeof dato.fecha !== 'string' || !RE_FECHA.test(dato.fecha)) {
    return conRespaldo('dato_invalido');
  }
  return { tasa_pct: tasa, fuente: { fecha: dato.fecha, descripcion: DESCRIPCION, respaldo: false }, motivo: 'ok' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tasaCetes, ID_SERIE, DESCRIPCION, RESPALDO };
}
return module.exports;
})();

__modulos["sipres"] = (() => {
const module = { exports: {} };
'use strict';

/**
 * Búsqueda en la tabla manual de SIPRES (Condusef), con los tres estados del documento.
 *
 * La tabla se captura a mano al llegar al evento. Cada fila:
 *   { nombre_comercial, razon_social, estado: 'registrada' | 'no_registrada_confirmada',
 *     terminos_buscados: [..], fecha_consulta: 'DD/MM/AAAA', alerta_publica_condusef?, verificado_por? }
 *
 * buscarEntidad(tabla, { nombre_comercial, razon_social }) devuelve SIEMPRE un objeto:
 *   { estado, fecha_consulta, terminos_buscados, entidad, motivo, advertencias }
 *   estado: 'registrada' | 'no_registrada_confirmada' | 'sin_verificar'
 *
 * Reglas para no acusar sin base:
 *  - Lo que no está en la tabla es 'sin_verificar', NUNCA "no registrada".
 *  - 'no_registrada_confirmada' exige fecha y al menos 2 términos buscados; si no, baja a
 *    'sin_verificar' (la búsqueda manual pudo fallar por usar solo un nombre).
 *  - Si varias filas coinciden con estados contradictorios, no se adivina: 'sin_verificar'.
 *  - Los nombres genéricos ("Financiera Digital") no coinciden con nada.
 */

const ESTADOS = ['registrada', 'no_registrada_confirmada'];
const MIN_TERMINOS_CONFIRMACION = 2;
const MIN_CARACTERES_SUBCONJUNTO = 5;

// Sufijos legales y palabras demasiado comunes: no identifican a una empresa.
const IGNORAR = new Set([
  'sa', 'de', 'cv', 'sapi', 'sofom', 'enr', 'er', 'sofipo', 'sas', 'rl', 'sociedad', 'anonima', 'capital',
  'variable', 'promotora', 'inversion', 'institucion', 'banca', 'multiple', 'la', 'el', 'los', 'las', 'del',
  'app', 'mx', 'mexico', 'credito', 'creditos', 'prestamo', 'prestamos', 'financiera', 'financiero', 'pay',
  'dinero', 'efectivo', 'rapido', 'movil', 'digital', 'servicios', 'grupo', 'soluciones',
]);

function tokens(texto) {
  if (typeof texto !== 'string') return [];
  const limpio = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!limpio) return [];
  return Array.from(new Set(limpio.split(' ').filter((p) => p.length >= 2 && !IGNORAR.has(p))));
}

/** Coinciden si tienen los mismos términos, o si el nombre más corto está completo dentro del más largo. */
function coincide(a, b) {
  if (!a.length || !b.length) return false;
  const [chico, grande] = a.length <= b.length ? [a, b] : [b, a];
  const conjunto = new Set(grande);
  if (!chico.every((t) => conjunto.has(t))) return false;
  if (chico.length === grande.length) return true;
  return chico.join('').length >= MIN_CARACTERES_SUBCONJUNTO;
}

function sinVerificar(motivo, extra = {}) {
  return {
    estado: 'sin_verificar',
    fecha_consulta: null,
    terminos_buscados: [],
    entidad: null,
    motivo,
    advertencias: [],
    ...extra,
  };
}

function buscarEntidad(tabla, consulta = {}) {
  const nombres = [consulta && consulta.nombre_comercial, consulta && consulta.razon_social]
    .map(tokens)
    .filter((t) => t.length > 0);
  if (nombres.length === 0) return sinVerificar('sin_nombre_utilizable');
  if (!Array.isArray(tabla)) return sinVerificar('tabla_invalida');

  const coincidencias = tabla.filter((fila) => {
    if (!fila || typeof fila !== 'object') return false;
    const propios = [fila.nombre_comercial, fila.razon_social].map(tokens);
    return propios.some((p) => nombres.some((n) => coincide(n, p)));
  });
  if (coincidencias.length === 0) return sinVerificar('no_esta_en_tabla');

  const estados = new Set(coincidencias.map((f) => f.estado));
  if (estados.size !== 1 || !ESTADOS.includes(Array.from(estados)[0])) {
    return sinVerificar('coincidencias_contradictorias', { advertencias: ['coincidencias_ambiguas'] });
  }

  const fila = coincidencias[0];
  const fecha = typeof fila.fecha_consulta === 'string' && fila.fecha_consulta.trim() ? fila.fecha_consulta.trim() : null;
  const terminos = Array.isArray(fila.terminos_buscados)
    ? fila.terminos_buscados.filter((t) => typeof t === 'string' && t.trim())
    : [];
  const entidad = fila.nombre_comercial || fila.razon_social || null;
  const advertencias = [];

  if (fila.estado === 'no_registrada_confirmada' && (!fecha || terminos.length < MIN_TERMINOS_CONFIRMACION)) {
    return sinVerificar('confirmacion_insuficiente', { entidad, advertencias: ['confirmacion_insuficiente'] });
  }
  if (!fecha) advertencias.push('sin_fecha');
  return {
    estado: fila.estado,
    fecha_consulta: fecha,
    terminos_buscados: terminos,
    entidad,
    motivo: 'ok',
    advertencias,
  };
}

/** Revisa la tabla capturada y lista los problemas, para correrlo una vez al terminar la captura. */
function validarTabla(tabla) {
  if (!Array.isArray(tabla)) return ['La tabla no es una lista.'];
  const problemas = [];
  tabla.forEach((fila, i) => {
    const n = `Fila ${i + 1}`;
    if (!fila || typeof fila !== 'object') return problemas.push(`${n}: no es un objeto.`);
    if (!tokens(fila.nombre_comercial).length && !tokens(fila.razon_social).length) {
      problemas.push(`${n}: sin nombre comercial ni razón social utilizable.`);
    }
    if (!ESTADOS.includes(fila.estado)) problemas.push(`${n}: estado inválido (${fila.estado}).`);
    if (!(typeof fila.fecha_consulta === 'string' && fila.fecha_consulta.trim())) {
      problemas.push(`${n}: falta la fecha de consulta.`);
    }
    if (fila.estado === 'no_registrada_confirmada') {
      const t = Array.isArray(fila.terminos_buscados) ? fila.terminos_buscados.filter(Boolean) : [];
      if (t.length < MIN_TERMINOS_CONFIRMACION) problemas.push(`${n}: confirmar "no registrada" exige al menos 2 términos buscados.`);
    }
  });
  return problemas;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buscarEntidad, validarTabla, tokens, coincide };
}
return module.exports;
})();

const __require = (ruta) => {
  const clave = String(ruta).split('/').pop().replace(/\.js$/, '');
  if (!(clave in __modulos)) throw new Error('Módulo no empaquetado: ' + ruta);
  return __modulos[clave];
};

__modulos["procesar"] = ((require) => {
const module = { exports: {} };
'use strict';

/**
 * Orquestador del flujo: lo que hace el nodo "Procesar" de n8n.
 *
 * procesar({ salidaLLM, cetesRespuesta, tablaSipres, config, hoy }) devuelve SIEMPRE un objeto:
 *   { accion: 'responder', texto, motivo, log, advertencias }   -> enviar `texto` directamente
 *   { accion: 'redactar', ctx, plantilla, log, advertencias }   -> pasar `ctx` al LLM de redacción
 *
 * Encadena: validarExtraccion -> (tasa de CETES o búsqueda SIPRES) -> calcular -> semaforo -> armarContexto.
 * No guarda nada, no llama a ninguna API y no incluye el texto del usuario ni la imagen en la salida;
 * el log solo lleva fecha, tipo de entrada, color del semáforo y estado SIPRES.
 */

const { validarExtraccion } = require('../extraccion/validar-extraccion');
const { calcular } = require('../calculo/calculo');
const { semaforo } = require('../semaforo/semaforo');
const R = require('../respuesta/respuesta');
const { tasaCetes } = require('../banxico/banxico');
const { buscarEntidad } = require('../sipres/sipres');

function procesar({ salidaLLM, cetesRespuesta, tablaSipres, config = {}, hoy = null } = {}) {
  const advertencias = [];
  const log = (tipo, color, sipres) => ({ fecha: hoy, tipo_entrada: tipo, semaforo: color, estado_sipres: sipres });
  const responder = (texto, motivo, tipo = 'desconocido') => ({
    accion: 'responder',
    texto,
    motivo,
    log: log(tipo, 'n.a.', 'n.a.'),
    advertencias,
  });

  const v = validarExtraccion(R.textoDeSalidaLLM(salidaLLM));
  if (v.estado === 'error_formato') return responder(R.mensajes.error(config), 'error_formato');
  if (v.estado === 'cobranza') return responder(R.plantillaCobranza(config), 'cobranza', 'cobranza');
  if (v.estado === 'desconocido' || v.estado === 'preguntar') {
    return responder(R.mensajes.aclaracion(v.preguntas, config), v.motivo);
  }

  const datos = v.datos;
  let calculo;
  let sem;
  let fuentes;

  if (datos.tipo_entrada === 'etiqueta_tienda') {
    const cetes = tasaCetes(cetesRespuesta, config.banxico);
    if (cetes.fuente.respaldo) advertencias.push(`cetes_respaldo:${cetes.motivo}`);
    calculo = calcular(datos, { tasaCetesPct: cetes.tasa_pct });
    sem = semaforo({ calculo });
    fuentes = { cetes: cetes.fuente };
  } else {
    const sipres = buscarEntidad(tablaSipres, {
      nombre_comercial: datos.credito.otorgante_nombre_comercial,
      razon_social: datos.credito.otorgante_razon_social,
    });
    if (sipres.motivo !== 'ok') advertencias.push(`sipres:${sipres.motivo}`);
    sipres.advertencias.forEach((a) => advertencias.push(`sipres:${a}`));
    calculo = calcular(datos);
    sem = semaforo({
      calculo,
      senales: datos.senales_riesgo,
      sipres: {
        estado: sipres.estado,
        fecha_consulta: sipres.fecha_consulta,
        terminos_buscados: sipres.terminos_buscados,
      },
    });
    fuentes = { sipres: { fecha: sipres.fecha_consulta } };
  }

  if (calculo.estado !== 'ok') {
    return responder(
      R.mensajes.aclaracion(['No pude calcular con esos datos. ¿Me confirmas el precio, los pagos y el plazo?'], config),
      `calculo_invalido:${calculo.motivo}`,
      datos.tipo_entrada
    );
  }
  const ctx = R.armarContexto({ calculo, semaforo: sem, fuentes, config });
  if (!ctx) return responder(R.mensajes.error(config), 'sin_contexto', datos.tipo_entrada);

  return {
    accion: 'redactar',
    ctx,
    plantilla: R.plantillaDesdeContexto(ctx),
    log: log(datos.tipo_entrada, sem.color, sem.estado_sipres || 'n.a.'),
    advertencias: [...advertencias, ...ctx.advertencias],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { procesar };
}
return module.exports;
})(__require);

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE ESTE FLUJO (la única parte que se edita a mano en n8n)
// ---------------------------------------------------------------------------

// Tabla de SIPRES capturada a mano al llegar. La fila de abajo es FICTICIA: reemplázala.
// estado: "registrada" o "no_registrada_confirmada" (esta última exige 2 o más términos buscados).
const TABLA_SIPRES = [
  {
    nombre_comercial: 'Marca de Ejemplo',
    razon_social: 'Ejemplo Financiero SA de CV',
    estado: 'registrada',
    terminos_buscados: ['Marca de Ejemplo', 'Ejemplo Financiero'],
    fecha_consulta: '30/10/2026',
    alerta_publica_condusef: null,
    verificado_por: 'XX',
  },
];

// enlaceSipres: ponlo solo cuando hayas verificado la dirección. canalesCobranza: texto con teléfonos/enlaces oficiales verificados.
const CONFIG = { enlaceSipres: null, canalesCobranza: null };

// Nombres de los nodos LLM de extracción (uno por rama). Deben coincidir con los de tu flujo.
const NODOS_EXTRACCION = ['Extraer foto', 'Extraer texto'];

// ---------------------------------------------------------------------------
// ENTRADAS Y SALIDA
// ---------------------------------------------------------------------------

const { procesar } = __modulos["procesar"];
const nodoLLM = NODOS_EXTRACCION.find((n) => $(n).isExecuted);
const salidaLLM = nodoLLM ? $(nodoLLM).first().json : null;
// Este nodo va justo después del HTTP Request de CETES: su salida es la respuesta de Banxico (o el error).
const cetesRespuesta = $input.first().json;
const resultado = procesar({
  salidaLLM,
  cetesRespuesta,
  tablaSipres: TABLA_SIPRES,
  config: CONFIG,
  hoy: new Date().toISOString().slice(0, 10),
});
return [{ json: resultado }];
