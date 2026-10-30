// GENERADO por scripts/empaquetar.js. No lo edites aquí: cambia el módulo y vuelve a generar.
// Nodo Code de n8n: "Elegir respuesta". Modo "Run Once for All Items", lenguaje JavaScript.

const __modulos = {};
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

// ---------------------------------------------------------------------------
// ENTRADAS Y SALIDA
// ---------------------------------------------------------------------------

const { elegirRespuesta, textoDeSalidaLLM } = __modulos["respuesta"];
const ctx = $('Procesar').first().json.ctx;
// Este nodo va justo después del LLM de redacción.
const textoLLM = textoDeSalidaLLM($input.first().json);
return [{ json: elegirRespuesta(textoLLM, ctx) }];
