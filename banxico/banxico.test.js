'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tasaCetes, RESPALDO, DESCRIPCION, ID_SERIE } = require('./banxico');

const serie = (id, fecha, dato) => ({ idSerie: id, titulo: 'Serie de prueba', datos: [{ fecha, dato }] });
const respuesta = (...series) => ({ bmx: { series } });

test('lee la tasa y la fecha de la serie de CETES', () => {
  const r = tasaCetes(respuesta(serie(ID_SERIE, '29/10/2026', '6.22')));
  assert.equal(r.tasa_pct, 6.22);
  assert.equal(r.motivo, 'ok');
  assert.deepEqual(r.fuente, { fecha: '29/10/2026', descripcion: DESCRIPCION, respaldo: false });
});

test('busca la serie por idSerie y no por posición (la API no respeta el orden pedido)', () => {
  const r = tasaCetes(
    respuesta(serie('SP30578', '01/09/2026', '3.45'), serie(ID_SERIE, '29/10/2026', '6.22'), serie('SF282', '01/09/2026', '6.29'))
  );
  assert.equal(r.tasa_pct, 6.22);
  assert.equal(r.fuente.fecha, '29/10/2026');
});

test('acepta la respuesta como texto JSON', () => {
  const r = tasaCetes(JSON.stringify(respuesta(serie(ID_SERIE, '29/10/2026', '6.22'))));
  assert.equal(r.tasa_pct, 6.22);
  assert.equal(r.fuente.respaldo, false);
});

test('sin respuesta o con texto que no es JSON usa el respaldo', () => {
  for (const vacio of [null, undefined, '', '   ', 'no es json', 42, '[]']) {
    const r = tasaCetes(vacio);
    assert.equal(r.fuente.respaldo, true, String(vacio));
    assert.equal(r.tasa_pct, RESPALDO.tasa_pct);
    assert.equal(r.fuente.fecha, RESPALDO.fecha);
  }
  assert.equal(tasaCetes(null).motivo, 'sin_respuesta');
});

test('un error de la API (token inválido, límite, red) usa el respaldo con su motivo', () => {
  const invalido = { error: { url: 'https://example.test/token', mensaje: 'Token inválido', detalle: 'x' } };
  assert.equal(tasaCetes(invalido).motivo, 'error_api');
  assert.equal(tasaCetes({ message: 'ECONNREFUSED', code: 'ECONNREFUSED' }).motivo, 'error_api');
  assert.equal(tasaCetes({ timeReset: 123, secondsToReset: 30 }).motivo, 'respuesta_sin_series');
  assert.equal(tasaCetes({ bmx: {} }).motivo, 'respuesta_sin_series');
  assert.equal(tasaCetes(invalido).fuente.respaldo, true);
});

test('serie ausente o sin datos usa el respaldo', () => {
  assert.equal(tasaCetes(respuesta(serie('SF282', '01/09/2026', '6.29'))).motivo, 'serie_ausente');
  assert.equal(tasaCetes(respuesta({ idSerie: ID_SERIE, datos: [] })).motivo, 'sin_datos');
  assert.equal(tasaCetes(respuesta({ idSerie: ID_SERIE })).motivo, 'sin_datos');
});

test('datos inválidos (N/E, vacío, cero, fuera de rango, fecha mal formada) usan el respaldo', () => {
  for (const dato of ['N/E', '', '0', '-3', '150', 'abc', null]) {
    assert.equal(tasaCetes(respuesta(serie(ID_SERIE, '29/10/2026', dato))).motivo, 'dato_invalido', String(dato));
  }
  for (const fecha of ['2026-10-29', '29/10/26', '', null]) {
    assert.equal(tasaCetes(respuesta(serie(ID_SERIE, fecha, '6.22'))).motivo, 'dato_invalido', String(fecha));
  }
});

test('el respaldo se puede sustituir y la serie se puede cambiar', () => {
  const r = tasaCetes(null, { respaldo: { tasa_pct: 7.1, fecha: '01/11/2026' } });
  assert.equal(r.tasa_pct, 7.1);
  assert.equal(r.fuente.fecha, '01/11/2026');
  const otra = tasaCetes(respuesta(serie('SF282', '01/09/2026', '6.29')), { idSerie: 'SF282' });
  assert.equal(otra.tasa_pct, 6.29);
});

test('el resultado siempre es serializable y no modifica la entrada', () => {
  const entrada = respuesta(serie(ID_SERIE, '29/10/2026', '6.22'));
  const copia = JSON.parse(JSON.stringify(entrada));
  const r = tasaCetes(entrada);
  assert.deepEqual(entrada, copia);
  assert.doesNotThrow(() => JSON.stringify(r));
});
