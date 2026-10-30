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
