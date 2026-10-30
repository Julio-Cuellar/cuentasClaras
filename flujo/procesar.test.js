'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { procesar } = require('./procesar');
const R = require('../respuesta/respuesta');

const HOY = '2026-10-30';
const FECHA_SIPRES = '30/10/2026';
const SENALES_VACIAS = {
  pide_anticipo: false,
  pide_permiso_contactos: false,
  pide_permiso_fotos_archivos: false,
  deposito_menor_a_ofrecido: false,
  plazo_menor_a_15_dias: false,
  presion_urgencia: false,
  texto_evidencia: [],
};

const CREDITO_VACIO = {
  otorgante_nombre_comercial: null, otorgante_razon_social: null, monto_ofrecido: null, monto_depositado: null,
  enganche: null, abono: null, periodicidad: null, numero_pagos: null, plazo_dias: null,
  monto_total_a_pagar: null, comisiones: [], seguros: [], cat_publicado: null,
};

const extraccionTienda = (credito = {}) => ({
  tipo_entrada: 'etiqueta_tienda',
  confianza_extraccion: 0.92,
  producto: { descripcion: 'TV 55 pulgadas', precio_contado: 7999, tienda: 'Tienda Ejemplo' },
  credito: { ...CREDITO_VACIO, enganche: 0, abono: 149, periodicidad: 'semanal', numero_pagos: 104, ...credito },
  senales_riesgo: { ...SENALES_VACIAS },
  datos_faltantes: [],
});

const extraccionPrestamo = ({ credito = {}, senales = {} } = {}) => ({
  tipo_entrada: 'oferta_credito',
  confianza_extraccion: 0.88,
  producto: { descripcion: null, precio_contado: null, tienda: null },
  credito: {
    ...CREDITO_VACIO, monto_ofrecido: 3000, monto_depositado: 2100, periodicidad: 'unico', numero_pagos: 1,
    plazo_dias: 7, monto_total_a_pagar: 3600, ...credito,
  },
  senales_riesgo: { ...SENALES_VACIAS, ...senales },
  datos_faltantes: [],
});

const salida = (obj) => ({ output: JSON.stringify(obj) });
const CETES_OK = {
  bmx: { series: [{ idSerie: 'SF43936', titulo: 'Cetes 28 días', datos: [{ fecha: '29/10/2026', dato: '6.22' }] }] },
};
const TABLA = [
  {
    nombre_comercial: 'Marca Uno', razon_social: 'Uno Financiera SAPI de CV', estado: 'registrada',
    terminos_buscados: ['Marca Uno', 'Uno Financiera'], fecha_consulta: FECHA_SIPRES,
  },
  {
    nombre_comercial: 'Rapidos Dos', razon_social: 'Dos Servicios SA de CV', estado: 'no_registrada_confirmada',
    terminos_buscados: ['Rapidos Dos', 'Dos Servicios'], fecha_consulta: FECHA_SIPRES,
  },
];
const correr = (extraccion, extra = {}) =>
  procesar({ salidaLLM: salida(extraccion), cetesRespuesta: CETES_OK, tablaSipres: TABLA, hoy: HOY, ...extra });

// ---------- tienda ----------

test('tienda: la TV con CETES vigente se redacta con Banxico y su fecha', () => {
  const r = correr(extraccionTienda());
  assert.equal(r.accion, 'redactar');
  assert.equal(r.ctx.tipo, 'tienda');
  assert.equal(r.ctx.color, 'rojo');
  assert.deepEqual(r.ctx.fuentes_a_citar, [
    { nombre: 'Banxico', detalle: 'CETES 28 días, subasta semanal', fecha: '29/10/2026', respaldo: false },
  ]);
  assert.match(r.plantilla, /Banxico, CETES 28 días, subasta semanal \(29\/10\/2026\)/);
  assert.match(r.plantilla, /en 53 semanas/);
  assert.equal(R.verificarRespuesta(r.plantilla, r.ctx).ok, true);
  assert.deepEqual(r.log, { fecha: HOY, tipo_entrada: 'etiqueta_tienda', semaforo: 'rojo', estado_sipres: 'n.a.' });
  assert.deepEqual(r.advertencias, []);
});

test('tienda: si Banxico falla, se usa el respaldo y la respuesta lo dice', () => {
  const r = correr(extraccionTienda(), { cetesRespuesta: { error: { mensaje: 'Token inválido' } } });
  assert.equal(r.accion, 'redactar');
  assert.ok(r.advertencias.includes('cetes_respaldo:error_api'));
  assert.equal(r.ctx.fuentes_a_citar[0].respaldo, true);
  assert.match(r.plantilla, /29\/10\/2026, dato de respaldo\)/);
  assert.equal(R.verificarRespuesta(r.plantilla, r.ctx).ok, true);
  const sinRespuesta = correr(extraccionTienda(), { cetesRespuesta: undefined });
  assert.ok(sinRespuesta.advertencias.includes('cetes_respaldo:sin_respuesta'));
});

// ---------- préstamo ----------

test('préstamo T14: sin tabla, la entidad queda sin verificar y las señales mandan', () => {
  const r = correr(
    extraccionPrestamo({
      senales: { pide_permiso_contactos: true, texto_evidencia: ['Necesitamos acceso a tus contactos'] },
    })
  );
  assert.equal(r.accion, 'redactar');
  assert.equal(r.ctx.color, 'rojo');
  assert.equal(r.ctx.estado_sipres, 'sin_verificar');
  assert.ok(r.advertencias.includes('sipres:sin_nombre_utilizable'));
  assert.match(r.plantilla, /Pide acceso a tus contactos/);
  assert.match(r.plantilla, /No la tenemos en nuestra base/);
  assert.deepEqual(r.log, { fecha: HOY, tipo_entrada: 'oferta_credito', semaforo: 'rojo', estado_sipres: 'sin_verificar' });
  assert.equal(R.verificarRespuesta(r.plantilla, r.ctx).ok, true);
});

test('préstamo: un nombre que no está en la tabla queda sin verificar, no "no registrada"', () => {
  const r = correr(
    extraccionPrestamo({ credito: { otorgante_nombre_comercial: 'Entidad Desconocida', monto_ofrecido: 2100 } })
  );
  assert.equal(r.ctx.estado_sipres, 'sin_verificar');
  assert.ok(r.advertencias.includes('sipres:no_esta_en_tabla'));
  assert.equal(r.ctx.color, 'gris');
  assert.ok(!/no (está|esta|aparece) registrada/i.test(r.plantilla));
  assert.deepEqual(r.ctx.fuentes_a_citar, []);
});

test('préstamo: una entidad registrada en la tabla cita SIPRES con fecha', () => {
  const r = correr(
    extraccionPrestamo({ credito: { otorgante_nombre_comercial: 'Marca Uno', monto_ofrecido: 2100, plazo_dias: 30 } })
  );
  assert.equal(r.ctx.color, 'amarillo');
  assert.equal(r.ctx.estado_sipres, 'registrada');
  assert.deepEqual(r.ctx.fuentes_a_citar.map((f) => [f.nombre, f.fecha]), [['SIPRES, Condusef', FECHA_SIPRES]]);
  assert.match(r.plantilla, /Aparece registrada en el SIPRES de Condusef \(consulta del 30\/10\/2026\)\./);
  assert.equal(r.log.estado_sipres, 'registrada');
  assert.equal(R.verificarRespuesta(r.plantilla, r.ctx).ok, true);
});

test('préstamo: no registrada confirmada es roja y cita la búsqueda manual', () => {
  const r = correr(extraccionPrestamo({ credito: { otorgante_razon_social: 'Dos Servicios SA de CV' } }));
  assert.equal(r.ctx.color, 'rojo');
  assert.equal(r.ctx.estado_sipres, 'no_registrada_confirmada');
  assert.match(r.plantilla, /No la encontramos en el SIPRES de Condusef \(búsqueda manual del 30\/10\/2026\)\./);
  assert.equal(r.log.estado_sipres, 'no_registrada_confirmada');
  assert.equal(R.verificarRespuesta(r.plantilla, r.ctx).ok, true);
});

test('config: el enlace de SIPRES configurado llega al contexto y a la plantilla', () => {
  const config = { enlaceSipres: 'https://ejemplo.test/sipres' };
  const r = correr(extraccionPrestamo({ senales: { pide_anticipo: true, texto_evidencia: ['Paga para liberar'] } }), { config });
  assert.equal(r.ctx.enlaces.sipres, 'https://ejemplo.test/sipres');
  assert.match(r.plantilla, /https:\/\/ejemplo\.test\/sipres/);
});

// ---------- respuestas directas ----------

test('faltan datos: responde con la pregunta y no calcula', () => {
  const r = correr(extraccionTienda({ abono: null }));
  assert.equal(r.accion, 'responder');
  assert.equal(r.motivo, 'datos_faltantes');
  assert.match(r.texto, /¿De cuánto es cada pago \(abono\)\?/);
  assert.equal(r.ctx, undefined);
  assert.deepEqual(r.log, { fecha: HOY, tipo_entrada: 'desconocido', semaforo: 'n.a.', estado_sipres: 'n.a.' });
});

test('foto borrosa: pide una foto más clara', () => {
  const r = correr({ ...extraccionTienda(), confianza_extraccion: 0.3 });
  assert.equal(r.accion, 'responder');
  assert.equal(r.motivo, 'confianza_baja');
  assert.match(r.texto, /foto más clara/);
});

test('cobranza: responde con la plantilla de orientación', () => {
  const r = correr({ tipo_entrada: 'cobranza', confianza_extraccion: 0.9 });
  assert.equal(r.accion, 'responder');
  assert.equal(r.motivo, 'cobranza');
  assert.match(r.texto, /Condusef y a la Policía Cibernética de tu estado/);
  assert.equal(r.log.tipo_entrada, 'cobranza');
});

test('tipo desconocido pide aclaración', () => {
  const r = correr({ tipo_entrada: 'desconocido', confianza_extraccion: 0.9 });
  assert.equal(r.accion, 'responder');
  assert.equal(r.motivo, 'tipo_no_identificado');
});

test('el LLM no devolvió JSON utilizable: mensaje de error, sin excepciones', () => {
  for (const mala of ['no es json', null, undefined, {}, '']) {
    const r = procesar({ salidaLLM: mala, cetesRespuesta: CETES_OK, tablaSipres: TABLA, hoy: HOY });
    assert.equal(r.accion, 'responder', String(mala));
    assert.equal(r.motivo, 'error_formato');
    assert.match(r.texto, /Algo falló de nuestro lado/);
  }
  assert.equal(procesar().accion, 'responder');
});

test('entiende la salida del LLM en varios formatos', () => {
  const texto = JSON.stringify(extraccionTienda());
  const formatos = [
    texto,
    { output: texto },
    { text: texto },
    { message: { content: texto } },
    { choices: [{ message: { content: texto } }] },
    { content: [{ type: 'text', text: texto }] },
    { output: extraccionTienda() },
  ];
  for (const f of formatos) {
    const r = procesar({ salidaLLM: f, cetesRespuesta: CETES_OK, tablaSipres: TABLA, hoy: HOY });
    assert.equal(r.accion, 'redactar', JSON.stringify(f).slice(0, 40));
    assert.equal(r.ctx.metricas.costo_total, 15496);
  }
});

// ---------- privacidad y pureza ----------

test('la salida no incluye el texto de la oferta, el producto ni el nombre de la entidad; el log solo tiene 4 campos', () => {
  const r = correr(
    extraccionPrestamo({ credito: { otorgante_nombre_comercial: 'Marca Uno' }, senales: { pide_anticipo: true, texto_evidencia: ['Paga para liberar'] } })
  );
  const t = correr(extraccionTienda());
  assert.ok(!JSON.stringify(t).includes('TV 55 pulgadas'));
  assert.ok(!JSON.stringify(t).includes('Tienda Ejemplo'));
  assert.deepEqual(Object.keys(r.log).sort(), ['estado_sipres', 'fecha', 'semaforo', 'tipo_entrada']);
  assert.ok(!JSON.stringify(r.log).includes('Marca Uno'));
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('no modifica la tabla ni la configuración', () => {
  const tabla = JSON.parse(JSON.stringify(TABLA));
  const config = { enlaceSipres: null, banxico: { respaldo: { tasa_pct: 6.5, fecha: '01/11/2026' } } };
  const copiaConfig = JSON.parse(JSON.stringify(config));
  procesar({ salidaLLM: salida(extraccionTienda()), cetesRespuesta: null, tablaSipres: tabla, config, hoy: HOY });
  assert.deepEqual(tabla, TABLA);
  assert.deepEqual(config, copiaConfig);
});

test('el respaldo de CETES se puede cambiar por configuración', () => {
  const r = procesar({
    salidaLLM: salida(extraccionTienda()),
    cetesRespuesta: null,
    tablaSipres: TABLA,
    config: { banxico: { respaldo: { tasa_pct: 7.5, fecha: '05/11/2026' } } },
    hoy: HOY,
  });
  assert.equal(r.ctx.fuentes_a_citar[0].fecha, '05/11/2026');
  assert.equal(r.ctx.ahorro.tasa_anual_usada_pct, 7.5);
});
