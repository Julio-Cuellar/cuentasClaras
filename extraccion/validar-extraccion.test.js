'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validarExtraccion, leerNumero, UMBRAL_CONFIANZA } = require('./validar-extraccion');

const SENALES_VACIAS = {
  pide_anticipo: false,
  pide_permiso_contactos: false,
  pide_permiso_fotos_archivos: false,
  deposito_menor_a_ofrecido: false,
  plazo_menor_a_15_dias: false,
  presion_urgencia: false,
  texto_evidencia: [],
};

/** Etiqueta de tienda válida (caso T1 del documento) con sobrescrituras por sección. */
function etiqueta({ top = {}, producto = {}, credito = {}, senales = {} } = {}) {
  return {
    tipo_entrada: 'etiqueta_tienda',
    confianza_extraccion: 0.9,
    datos_faltantes: [],
    ...top,
    producto: { descripcion: 'TV 55 pulgadas', precio_contado: 7999, tienda: null, ...producto },
    credito: {
      otorgante_nombre_comercial: null,
      otorgante_razon_social: null,
      monto_ofrecido: null,
      monto_depositado: null,
      enganche: 0,
      abono: 149,
      periodicidad: 'semanal',
      numero_pagos: 104,
      plazo_dias: null,
      monto_total_a_pagar: null,
      comisiones: [],
      seguros: [],
      cat_publicado: null,
      ...credito,
    },
    senales_riesgo: { ...SENALES_VACIAS, ...senales },
  };
}

/** Oferta de préstamo de pago único (caso T8 del documento) con sobrescrituras. */
function oferta({ top = {}, credito = {}, senales = {} } = {}) {
  return etiqueta({
    top: { tipo_entrada: 'oferta_credito', ...top },
    producto: { descripcion: null, precio_contado: null, tienda: null },
    credito: {
      monto_ofrecido: 3000,
      monto_depositado: 2100,
      enganche: null,
      abono: null,
      periodicidad: 'unico',
      numero_pagos: 1,
      plazo_dias: 7,
      monto_total_a_pagar: 3600,
      ...credito,
    },
    senales,
  });
}

test('T1: etiqueta completa queda lista para calcular', () => {
  const r = validarExtraccion(etiqueta());
  assert.equal(r.estado, 'listo');
  assert.equal(r.datos.modo_pago, 'periodico');
  assert.equal(r.datos.credito.periodos_por_anio, 52);
  assert.equal(r.datos.producto.precio_contado, 7999);
  assert.deepEqual(r.advertencias, []);
});

test('enganche ausente se asume 0 y queda advertido', () => {
  const r = validarExtraccion(etiqueta({ credito: { enganche: null } }));
  assert.equal(r.estado, 'listo');
  assert.equal(r.datos.credito.enganche, 0);
  assert.ok(r.advertencias.includes('enganche_no_indicado_se_asume_0'));
});

test('T9: falta el abono, el bot pregunta y no calcula', () => {
  const r = validarExtraccion(etiqueta({ credito: { abono: null } }));
  assert.equal(r.estado, 'preguntar');
  assert.equal(r.motivo, 'datos_faltantes');
  assert.deepEqual(r.datos_faltantes, ['abono']);
  assert.match(r.preguntas[0], /abono/);
  assert.equal(r.datos, null);
});

test('T10: confianza baja pide foto más clara', () => {
  const r = validarExtraccion(etiqueta({ top: { confianza_extraccion: 0.5 } }));
  assert.equal(r.estado, 'preguntar');
  assert.equal(r.motivo, 'confianza_baja');
  assert.equal(r.datos, null);
});

test('la confianza justo en el umbral pasa', () => {
  const r = validarExtraccion(etiqueta({ top: { confianza_extraccion: UMBRAL_CONFIANZA } }));
  assert.equal(r.estado, 'listo');
});

test('confianza ausente se trata como baja y se advierte', () => {
  const entrada = etiqueta();
  delete entrada.confianza_extraccion;
  const r = validarExtraccion(entrada);
  assert.equal(r.motivo, 'confianza_baja');
  assert.ok(r.advertencias.includes('confianza_ausente_o_invalida'));
});

test('montos escritos como texto con $ y comas se normalizan', () => {
  const r = validarExtraccion(
    etiqueta({ producto: { precio_contado: '$7,999.00' }, credito: { abono: '149', numero_pagos: '104' } })
  );
  assert.equal(r.estado, 'listo');
  assert.equal(r.datos.producto.precio_contado, 7999);
  assert.equal(r.datos.credito.abono, 149);
  assert.equal(r.datos.credito.numero_pagos, 104);
});

test('acepta JSON en bloque de código y con texto alrededor', () => {
  const json = JSON.stringify(etiqueta());
  assert.equal(validarExtraccion('```json\n' + json + '\n```').estado, 'listo');
  assert.equal(validarExtraccion('Aquí está el resultado: ' + json).estado, 'listo');
});

test('entradas que no son JSON dan error_formato', () => {
  for (const malo of ['no es json', '', null, undefined, [], '{roto', 42]) {
    assert.equal(validarExtraccion(malo).estado, 'error_formato', String(malo));
  }
});

test('cobranza va a la plantilla del Módulo C sin preguntar nada', () => {
  const r = validarExtraccion({ tipo_entrada: 'cobranza', confianza_extraccion: 0.4 });
  assert.equal(r.estado, 'cobranza');
  assert.deepEqual(r.preguntas, []);
});

test('tipo desconocido o inválido pide aclaración', () => {
  assert.equal(validarExtraccion({ tipo_entrada: 'desconocido', confianza_extraccion: 0.9 }).estado, 'desconocido');
  const r = validarExtraccion({ tipo_entrada: 'otra cosa', confianza_extraccion: 0.9 });
  assert.equal(r.estado, 'desconocido');
  assert.ok(r.advertencias.includes('tipo_entrada_invalido'));
});

test('sinónimos de periodicidad y acentos se normalizan', () => {
  assert.equal(validarExtraccion(etiqueta({ credito: { periodicidad: 'Semanales' } })).datos.credito.periodicidad, 'semanal');
  assert.equal(validarExtraccion(oferta({ credito: { periodicidad: 'Único' } })).datos.credito.periodicidad, 'unico');
});

test('abono negativo o número de pagos no entero cuentan como faltantes', () => {
  const a = validarExtraccion(etiqueta({ credito: { abono: -149 } }));
  assert.deepEqual(a.datos_faltantes, ['abono']);
  assert.ok(a.advertencias.includes('valor_no_positivo:abono'));
  const b = validarExtraccion(etiqueta({ credito: { numero_pagos: 10.5 } }));
  assert.deepEqual(b.datos_faltantes, ['numero_pagos']);
});

test('pagos menores al precio de contado piden confirmar', () => {
  const r = validarExtraccion(etiqueta({ credito: { abono: 50, numero_pagos: 10 } }));
  assert.equal(r.estado, 'preguntar');
  assert.equal(r.motivo, 'pagos_menores_al_precio');
});

test('T8: oferta de pago único con depósito menor; las señales numéricas las calcula el código', () => {
  const r = validarExtraccion(
    oferta({
      senales: { pide_permiso_contactos: true, texto_evidencia: ['Necesitamos acceso a tus contactos'] },
    })
  );
  assert.equal(r.estado, 'listo');
  assert.equal(r.datos.modo_pago, 'unico');
  assert.equal(r.datos.senales_riesgo.deposito_menor_a_ofrecido, true);
  assert.equal(r.datos.senales_riesgo.plazo_menor_a_15_dias, true);
  assert.equal(r.datos.senales_riesgo.pide_permiso_contactos, true);
});

test('el código manda sobre el LLM en las señales numéricas', () => {
  const r = validarExtraccion(
    oferta({
      credito: { monto_ofrecido: 2100, plazo_dias: 30 },
      senales: { deposito_menor_a_ofrecido: true, plazo_menor_a_15_dias: true },
    })
  );
  assert.equal(r.datos.senales_riesgo.deposito_menor_a_ofrecido, false);
  assert.equal(r.datos.senales_riesgo.plazo_menor_a_15_dias, false);
});

test('una señal de texto sin evidencia literal se descarta', () => {
  const r = validarExtraccion(oferta({ senales: { pide_permiso_contactos: true, texto_evidencia: [] } }));
  assert.equal(r.datos.senales_riesgo.pide_permiso_contactos, false);
  assert.ok(r.advertencias.includes('senal_sin_evidencia:pide_permiso_contactos'));
});

test('oferta sin monto depositado: no se asume que es igual al ofrecido', () => {
  const r = validarExtraccion(oferta({ credito: { monto_depositado: null } }));
  assert.equal(r.estado, 'preguntar');
  assert.deepEqual(r.datos_faltantes, ['monto_depositado']);
});

test('oferta de pago único sin total ni plazo pregunta ambos', () => {
  const r = validarExtraccion(oferta({ credito: { monto_total_a_pagar: null, plazo_dias: null } }));
  assert.deepEqual(r.datos_faltantes, ['monto_total_a_pagar', 'plazo_dias']);
});

test('oferta que pagaría menos de lo depositado pide confirmar', () => {
  const r = validarExtraccion(oferta({ credito: { monto_total_a_pagar: 2000 } }));
  assert.equal(r.estado, 'preguntar');
  assert.equal(r.motivo, 'pago_menor_al_deposito');
});

test('oferta con pagos periódicos completa queda lista', () => {
  const r = validarExtraccion(
    oferta({
      credito: {
        monto_ofrecido: 5000, monto_depositado: 5000, abono: 700, numero_pagos: 10,
        periodicidad: 'quincenal', plazo_dias: null, monto_total_a_pagar: null,
      },
    })
  );
  assert.equal(r.estado, 'listo');
  assert.equal(r.datos.modo_pago, 'periodico');
  assert.equal(r.datos.credito.periodos_por_anio, 24);
});

test('oferta periódica incompleta pregunta solo lo que falta', () => {
  const r = validarExtraccion(
    oferta({ credito: { abono: 700, numero_pagos: null, periodicidad: null, plazo_dias: null, monto_total_a_pagar: null } })
  );
  assert.deepEqual(r.datos_faltantes, ['numero_pagos', 'periodicidad']);
});

test('oferta sin forma de pago pregunta cómo se paga', () => {
  const r = validarExtraccion(
    oferta({ credito: { periodicidad: null, numero_pagos: null, plazo_dias: null, monto_total_a_pagar: null } })
  );
  assert.deepEqual(r.datos_faltantes, ['forma_de_pago']);
});

test('comisión sin momento o con monto inválido se pregunta, no se adivina', () => {
  const sinMomento = validarExtraccion(
    etiqueta({ credito: { comisiones: [{ concepto: 'apertura', monto: 300, momento: null }] } })
  );
  assert.deepEqual(sinMomento.datos_faltantes, ['comision_momento']);
  const sinMonto = validarExtraccion(
    etiqueta({ credito: { seguros: [{ concepto: 'vida', monto: 'diez', momento: 'periodico' }] } })
  );
  assert.deepEqual(sinMonto.datos_faltantes, ['comision_monto']);
});

test('comisiones completas se conservan normalizadas', () => {
  const r = validarExtraccion(
    etiqueta({
      credito: {
        enganche: 500,
        comisiones: [{ concepto: 'apertura', monto: '300', momento: 'inicial' }],
        seguros: [{ concepto: 'vida', monto: 10, momento: 'periodico' }],
      },
    })
  );
  assert.equal(r.estado, 'listo');
  assert.deepEqual(r.datos.credito.comisiones, [{ concepto: 'apertura', monto: 300, momento: 'inicial' }]);
  assert.deepEqual(r.datos.credito.seguros, [{ concepto: 'vida', monto: 10, momento: 'periodico' }]);
});

test('no modifica la entrada', () => {
  const entrada = etiqueta({ credito: { enganche: null } });
  const copia = JSON.parse(JSON.stringify(entrada));
  validarExtraccion(entrada);
  assert.deepEqual(entrada, copia);
});

test('leerNumero: ausente, texto y basura', () => {
  assert.deepEqual(leerNumero(null), { valor: null, invalido: false });
  assert.deepEqual(leerNumero('$1,299.50'), { valor: 1299.5, invalido: false });
  assert.deepEqual(leerNumero('2500 pesos'), { valor: 2500, invalido: false });
  assert.deepEqual(leerNumero('abc'), { valor: null, invalido: true });
  assert.deepEqual(leerNumero(NaN), { valor: null, invalido: true });
});
