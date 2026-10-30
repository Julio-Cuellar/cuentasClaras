'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buscarEntidad, validarTabla, tokens, coincide } = require('./sipres');

const FECHA = '30/10/2026';
const TABLA = [
  {
    nombre_comercial: 'Marca Uno', razon_social: 'Uno Financiera SAPI de CV', estado: 'registrada',
    terminos_buscados: ['Marca Uno', 'Uno Financiera'], fecha_consulta: FECHA,
  },
  {
    nombre_comercial: 'Préstamos Rápidos Dos', razon_social: 'Dos Servicios SA de CV', estado: 'no_registrada_confirmada',
    terminos_buscados: ['Rápidos Dos', 'Dos Servicios'], fecha_consulta: FECHA,
  },
  {
    nombre_comercial: 'Tres Pay', razon_social: null, estado: 'no_registrada_confirmada',
    terminos_buscados: ['Tres'], fecha_consulta: FECHA,
  },
  { nombre_comercial: 'Ana Pia', razon_social: null, estado: 'registrada', terminos_buscados: ['Ana Pia'], fecha_consulta: FECHA },
];

test('tokens: sin acentos, sin puntuación ni sufijos legales ni palabras genéricas', () => {
  assert.deepEqual(tokens('Préstamos Rápidos S.A.P.I. de C.V.'), ['rapidos']);
  assert.deepEqual(tokens('MARCA   uno!'), ['marca', 'uno']);
  assert.deepEqual(tokens('Financiera Digital'), []);
  assert.deepEqual(tokens(null), []);
  assert.deepEqual(tokens(42), []);
});

test('coincide: mismos términos, o el nombre corto completo dentro del largo y con 5 letras o más', () => {
  assert.equal(coincide(['marca', 'uno'], ['uno', 'marca']), true);
  assert.equal(coincide(['marca', 'uno'], ['marca', 'uno', 'plus']), true);
  assert.equal(coincide(['ana'], ['ana', 'pia']), false);
  assert.equal(coincide([], ['ana']), false);
  assert.equal(coincide(['ana', 'luz'], ['ana', 'pia']), false);
});

test('una entidad registrada se encuentra con su nombre comercial, con fecha', () => {
  const r = buscarEntidad(TABLA, { nombre_comercial: 'Marca Uno' });
  assert.equal(r.estado, 'registrada');
  assert.equal(r.fecha_consulta, FECHA);
  assert.equal(r.entidad, 'Marca Uno');
  assert.equal(r.motivo, 'ok');
  assert.deepEqual(r.terminos_buscados, ['Marca Uno', 'Uno Financiera']);
});

test('no distingue mayúsculas, acentos ni puntuación, y también busca por razón social', () => {
  assert.equal(buscarEntidad(TABLA, { nombre_comercial: 'MÁRCA   uno!' }).estado, 'registrada');
  assert.equal(buscarEntidad(TABLA, { razon_social: 'UNO FINANCIERA S.A.P.I. DE C.V.' }).estado, 'registrada');
  assert.equal(buscarEntidad(TABLA, { nombre_comercial: 'Marca Uno Plus' }).estado, 'registrada');
});

test('no registrada confirmada exige fecha y dos términos buscados, y los devuelve', () => {
  const r = buscarEntidad(TABLA, { nombre_comercial: 'Rapidos Dos' });
  assert.equal(r.estado, 'no_registrada_confirmada');
  assert.equal(r.fecha_consulta, FECHA);
  assert.deepEqual(r.terminos_buscados, ['Rápidos Dos', 'Dos Servicios']);
});

test('una "no registrada" con una sola búsqueda baja a sin verificar, con advertencia', () => {
  const r = buscarEntidad(TABLA, { nombre_comercial: 'Tres Pay' });
  assert.equal(r.estado, 'sin_verificar');
  assert.equal(r.motivo, 'confirmacion_insuficiente');
  assert.ok(r.advertencias.includes('confirmacion_insuficiente'));
});

test('lo que no está en la tabla es sin verificar, nunca "no registrada"', () => {
  const r = buscarEntidad(TABLA, { nombre_comercial: 'Entidad Desconocida' });
  assert.equal(r.estado, 'sin_verificar');
  assert.equal(r.motivo, 'no_esta_en_tabla');
  assert.equal(r.fecha_consulta, null);
  assert.deepEqual(r.terminos_buscados, []);
});

test('nombres genéricos, vacíos o demasiado cortos no coinciden con nada', () => {
  assert.equal(buscarEntidad(TABLA, { nombre_comercial: 'Financiera Digital' }).motivo, 'sin_nombre_utilizable');
  assert.equal(buscarEntidad(TABLA, {}).motivo, 'sin_nombre_utilizable');
  assert.equal(buscarEntidad(TABLA).motivo, 'sin_nombre_utilizable');
  assert.equal(buscarEntidad(TABLA, { nombre_comercial: 'Ana' }).estado, 'sin_verificar');
  assert.equal(buscarEntidad(TABLA, { nombre_comercial: 'Ana Pia' }).estado, 'registrada');
});

test('coincidencias con estados contradictorios no se adivinan', () => {
  const tabla = [
    { nombre_comercial: 'Marca Cuatro', estado: 'registrada', terminos_buscados: ['a', 'b'], fecha_consulta: FECHA },
    { nombre_comercial: 'Marca Cuatro', estado: 'no_registrada_confirmada', terminos_buscados: ['a', 'b'], fecha_consulta: FECHA },
  ];
  const r = buscarEntidad(tabla, { nombre_comercial: 'Marca Cuatro' });
  assert.equal(r.estado, 'sin_verificar');
  assert.equal(r.motivo, 'coincidencias_contradictorias');
});

test('una registrada sin fecha se advierte para no citarla sin fecha', () => {
  const tabla = [{ nombre_comercial: 'Marca Cinco', estado: 'registrada', terminos_buscados: [] }];
  const r = buscarEntidad(tabla, { nombre_comercial: 'Marca Cinco' });
  assert.equal(r.estado, 'registrada');
  assert.equal(r.fecha_consulta, null);
  assert.ok(r.advertencias.includes('sin_fecha'));
});

test('una fila con estado inválido no cuenta como respuesta', () => {
  const tabla = [{ nombre_comercial: 'Marca Seis', estado: 'quizas', fecha_consulta: FECHA }];
  assert.equal(buscarEntidad(tabla, { nombre_comercial: 'Marca Seis' }).estado, 'sin_verificar');
});

test('una tabla inválida o con filas basura no lanza excepciones', () => {
  assert.equal(buscarEntidad(null, { nombre_comercial: 'Marca Uno' }).motivo, 'tabla_invalida');
  assert.equal(buscarEntidad('texto', { nombre_comercial: 'Marca Uno' }).motivo, 'tabla_invalida');
  assert.equal(buscarEntidad([null, 5, 'x', ...TABLA], { nombre_comercial: 'Marca Uno' }).estado, 'registrada');
});

test('validarTabla: una tabla buena no tiene problemas y una mala los lista', () => {
  assert.deepEqual(validarTabla(TABLA.slice(0, 2)), []);
  const problemas = validarTabla([
    { nombre_comercial: '', razon_social: 'Financiera Digital', estado: 'registrada', fecha_consulta: FECHA },
    { nombre_comercial: 'Marca Siete', estado: 'tal vez', fecha_consulta: FECHA },
    { nombre_comercial: 'Marca Ocho', estado: 'no_registrada_confirmada', terminos_buscados: ['Marca Ocho'], fecha_consulta: FECHA },
    { nombre_comercial: 'Marca Nueve', estado: 'registrada' },
    null,
  ]);
  const texto = problemas.join('\n');
  assert.match(texto, /Fila 1: sin nombre comercial ni razón social utilizable/);
  assert.match(texto, /Fila 2: estado inválido/);
  assert.match(texto, /Fila 3: confirmar "no registrada" exige al menos 2 términos/);
  assert.match(texto, /Fila 4: falta la fecha de consulta/);
  assert.match(texto, /Fila 5: no es un objeto/);
  assert.deepEqual(validarTabla('x'), ['La tabla no es una lista.']);
});

test('no modifica la tabla ni la consulta', () => {
  const copia = JSON.parse(JSON.stringify(TABLA));
  const consulta = { nombre_comercial: 'Marca Uno' };
  buscarEntidad(TABLA, consulta);
  assert.deepEqual(TABLA, copia);
  assert.deepEqual(consulta, { nombre_comercial: 'Marca Uno' });
});
