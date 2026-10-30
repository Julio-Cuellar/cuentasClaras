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
