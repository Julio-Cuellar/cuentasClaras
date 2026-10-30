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
