'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calcular,
  ahorroParaContado,
  tasaPeriodica,
  catPagoUnico,
  formatoCAT,
} = require('./calculo');
const { validarExtraccion } = require('../extraccion/validar-extraccion');

/** Aserción numérica con tolerancia, para cifras con muchos decimales. */
function casi(real, esperado, tolerancia, mensaje) {
  assert.ok(
    typeof real === 'number' && Math.abs(real - esperado) <= tolerancia,
    `${mensaje || 'valor'}: esperado ${esperado} ± ${tolerancia}, real ${real}`
  );
}

/** `datos` como los entrega el validador para una etiqueta de tienda (caso T1). */
function tienda({ producto = {}, credito = {} } = {}) {
  return {
    tipo_entrada: 'etiqueta_tienda',
    modo_pago: 'periodico',
    producto: { descripcion: 'TV 55 pulgadas', precio_contado: 7999, tienda: null, ...producto },
    credito: {
      enganche: 0,
      abono: 149,
      periodicidad: 'semanal',
      periodos_por_anio: 52,
      numero_pagos: 104,
      plazo_dias: null,
      monto_ofrecido: null,
      monto_depositado: null,
      monto_total_a_pagar: null,
      comisiones: [],
      seguros: [],
      ...credito,
    },
  };
}

/** `datos` para una oferta de préstamo de pago único (caso T8). */
function prestamo({ credito = {}, modo = 'unico' } = {}) {
  return {
    tipo_entrada: 'oferta_credito',
    modo_pago: modo,
    producto: { descripcion: null, precio_contado: null, tienda: null },
    credito: {
      enganche: null,
      abono: null,
      periodicidad: 'unico',
      periodos_por_anio: null,
      numero_pagos: 1,
      plazo_dias: 7,
      monto_ofrecido: 3000,
      monto_depositado: 2100,
      monto_total_a_pagar: 3600,
      comisiones: [],
      seguros: [],
      ...credito,
    },
  };
}

test('T1: abonos de la TV (obligatorio)', () => {
  const r = calcular(tienda());
  assert.equal(r.estado, 'ok');
  assert.equal(r.tipo, 'tienda');
  assert.equal(r.metricas.costo_total, 15496);
  assert.equal(r.metricas.sobrecosto_pesos, 7497);
  assert.equal(r.metricas.sobrecosto_pct, 93.72);
  casi(r.cat.tasa_periodica * 100, 1.4429, 0.0005, 'r semanal (%)');
  assert.equal(r.cat.porcentaje, 110.63);
  assert.equal(r.cat.texto, '110.6%');
  assert.equal(r.cat.motivo, 'ok');
});

test('T2: enganche, comisión inicial y seguro periódico', () => {
  const r = calcular(
    tienda({
      credito: {
        enganche: 500,
        comisiones: [{ concepto: 'apertura', monto: 300, momento: 'inicial' }],
        seguros: [{ concepto: 'vida', monto: 10, momento: 'periodico' }],
      },
    })
  );
  assert.equal(r.metricas.costo_total, 17336);
  assert.equal(r.metricas.sobrecosto_pesos, 9337);
  assert.equal(r.metricas.sobrecosto_pct, 116.73);
  assert.equal(r.metricas.principal_neto, 7199);
  assert.equal(r.metricas.pago_por_periodo, 159);
  assert.equal(r.cat.porcentaje, 165.46);
});

test('T2b: mismo caso sin cargos, solo con enganche', () => {
  const r = calcular(tienda({ credito: { enganche: 500 } }));
  assert.equal(r.cat.porcentaje, 129.37);
});

test('T3: sin costo (r = 0) no divide entre cero', () => {
  const r = calcular(tienda({ producto: { precio_contado: 1000 }, credito: { abono: 100, numero_pagos: 10 } }));
  assert.equal(r.estado, 'ok');
  assert.equal(r.cat.porcentaje, 0);
  assert.equal(r.cat.motivo, 'sin_costo');
  assert.equal(r.metricas.sobrecosto_pesos, 0);
});

test('T4: pagos menores al principal dan CAT nulo y el motivo', () => {
  const r = calcular(tienda({ producto: { precio_contado: 1000 }, credito: { abono: 90, numero_pagos: 10 } }));
  assert.equal(r.cat.valor, null);
  assert.equal(r.cat.motivo, 'pagos_menores_al_principal');
  assert.equal(r.metricas.sobrecosto_pesos, -100);
});

test('T5: pago único a 7 días, más de 1,000%', () => {
  const r = calcular(prestamo({ credito: { monto_ofrecido: 2000, monto_depositado: 2000, monto_total_a_pagar: 2400 } }));
  casi(r.cat.porcentaje, 1344943.7, 1, 'CAT 7 días (%)');
  assert.equal(r.cat.texto, 'más de 1,000%');
});

test('T6: pago único a 14 días, más de 1,000%', () => {
  const r = calcular(
    prestamo({ credito: { monto_ofrecido: 2000, monto_depositado: 2000, monto_total_a_pagar: 2400, plazo_dias: 14 } })
  );
  casi(r.cat.porcentaje, 11497.6, 0.5, 'CAT 14 días (%)');
  assert.equal(r.cat.texto, 'más de 1,000%');
});

test('T7: pago único a 30 días se muestra con porcentaje', () => {
  const r = calcular(
    prestamo({ credito: { monto_ofrecido: 2000, monto_depositado: 2000, monto_total_a_pagar: 2400, plazo_dias: 30 } })
  );
  casi(r.cat.porcentaje, 819.1, 0.1, 'CAT 30 días (%)');
  assert.equal(r.cat.texto, '819.1%');
});

test('T8: se calcula sobre lo depositado, no sobre lo ofrecido', () => {
  const r = calcular(prestamo());
  assert.equal(r.tipo, 'prestamo');
  assert.equal(r.metricas.recibes, 2100);
  assert.equal(r.metricas.pagas, 3600);
  assert.equal(r.metricas.costo_credito_pesos, 1500);
  assert.equal(r.metricas.costo_pct_sobre_recibido, 71.43);
  assert.equal(r.metricas.diferencia_ofrecido_depositado, 900);
  assert.equal(r.cat.texto, 'más de 1,000%');
  assert.equal(r.ahorro, null);
});

test('T8b: calcular sobre $3,000 (mal) daría un CAT muy distinto', () => {
  casi(catPagoUnico(3000, 3600, 14).cat * 100, 11498, 1, 'CAT sobre 3000 a 14 días');
  casi(catPagoUnico(3000, 3600, 30).cat * 100, 819, 1, 'CAT sobre 3000 a 30 días');
});

test('T9: dato faltante devuelve error con los campos', () => {
  const r = calcular(tienda({ credito: { abono: null } }));
  assert.equal(r.estado, 'error');
  assert.equal(r.motivo, 'datos_invalidos');
  assert.deepEqual(r.campos, ['abono']);
});

test('T11: apartar el abono sin rendimiento es un tope de 54 semanas', () => {
  const r = calcular(tienda());
  assert.equal(r.ahorro.periodos, 54);
  assert.equal(r.ahorro.aportado, 8046);
  assert.equal(r.ahorro.ahorro_vs_credito, 7450);
  assert.equal(r.ahorro.es_tope, true);
  assert.equal(r.ahorro.periodos_del_credito, 104);
});

test('T12: apartar el abono con CETES de prueba (10% anual, ficticio)', () => {
  const r = calcular(tienda(), { tasaCetesPct: 10 });
  assert.equal(r.ahorro.periodos, 52);
  assert.equal(r.ahorro.aportado, 7748);
  assert.equal(r.ahorro.saldo, 8143.73);
  assert.equal(r.ahorro.es_tope, false);
  assert.equal(r.ahorro.tasa_anual_usada_pct, 10);
});

test('ahorro mensual usa periodos de 30 días y respeta la periodicidad', () => {
  const r = ahorroParaContado({ precio: 1000, abono: 100, periodicidad: 'mensual', tasaAnualPct: 0 });
  assert.equal(r.periodos, 10);
  assert.equal(r.periodicidad, 'mensual');
  assert.equal(ahorroParaContado({ precio: 1000, abono: 0, periodicidad: 'mensual' }), null);
  assert.equal(ahorroParaContado({ precio: 1000, abono: 100, periodicidad: 'unico' }), null);
});

test('una tasa de CETES inválida o negativa se trata como 0', () => {
  assert.equal(calcular(tienda(), { tasaCetesPct: -3 }).ahorro.periodos, 54);
  assert.equal(calcular(tienda(), { tasaCetesPct: 'abc' }).ahorro.periodos, 54);
});

test('tasa fuera de rango (más de 1,000% por periodo) se marca sin inventar cifras', () => {
  assert.equal(tasaPeriodica(50, 1000, 2).motivo, 'fuera_de_rango');
  const r = calcular(
    prestamo({
      modo: 'periodico',
      credito: {
        monto_depositado: 50, monto_ofrecido: 50, abono: 1000, numero_pagos: 2,
        periodicidad: 'semanal', plazo_dias: null, monto_total_a_pagar: null,
      },
    })
  );
  assert.equal(r.cat.motivo, 'fuera_de_rango');
  assert.equal(r.cat.valor, null);
  assert.equal(r.cat.texto, 'más de 1,000%');
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('préstamo con pagos periódicos', () => {
  const r = calcular(
    prestamo({
      modo: 'periodico',
      credito: {
        monto_ofrecido: 5000, monto_depositado: 5000, abono: 700, numero_pagos: 10,
        periodicidad: 'quincenal', plazo_dias: null, monto_total_a_pagar: null,
      },
    })
  );
  assert.equal(r.estado, 'ok');
  assert.equal(r.metricas.pagas, 7000);
  assert.equal(r.metricas.costo_credito_pesos, 2000);
  assert.equal(r.metricas.costo_pct_sobre_recibido, 40);
  assert.equal(r.cat.motivo, 'ok');
  assert.ok(r.cat.valor > 0);
});

test('préstamo periódico advierte si el total declarado no cuadra con los pagos', () => {
  const r = calcular(
    prestamo({
      modo: 'periodico',
      credito: {
        monto_ofrecido: 5000, monto_depositado: 5000, abono: 700, numero_pagos: 10,
        periodicidad: 'quincenal', plazo_dias: null, monto_total_a_pagar: 9000,
      },
    })
  );
  assert.ok(r.advertencias.includes('total_declarado_distinto_a_pagos'));
  assert.equal(r.metricas.pagas, 7000);
});

test('comisión final entra al costo total pero no al CAT', () => {
  const con = calcular(tienda({ credito: { comisiones: [{ concepto: 'cierre', monto: 200, momento: 'final' }] } }));
  const sin = calcular(tienda());
  assert.equal(con.metricas.costo_total, sin.metricas.costo_total + 200);
  assert.equal(con.cat.porcentaje, sin.cat.porcentaje);
  assert.ok(con.advertencias.includes('cargo_final_fuera_del_cat'));
});

test('cargos mal formados se rechazan en vez de calcular a ciegas', () => {
  const r = calcular(tienda({ credito: { comisiones: [{ concepto: 'x', monto: 'diez', momento: 'inicial' }] } }));
  assert.equal(r.estado, 'error');
  assert.ok(r.campos.includes('cargos'));
});

test('entradas inválidas devuelven error y no lanzan excepciones', () => {
  for (const malo of [null, undefined, 42, 'texto', {}, { credito: {} }]) {
    assert.equal(calcular(malo).estado, 'error', String(malo));
  }
  assert.equal(calcular({ tipo_entrada: 'cobranza', credito: {} }).motivo, 'tipo_entrada_no_soportado');
  assert.equal(calcular({ ...tienda(), modo_pago: undefined }).motivo, 'modo_pago_ausente');
  assert.equal(calcular({ ...tienda(), modo_pago: 'unico' }).motivo, 'modo_pago_no_valido_para_tienda');
});

test('formatoCAT: límites de la regla de más de 1,000%', () => {
  assert.equal(formatoCAT(null), null);
  assert.equal(formatoCAT(0), '0.0%');
  assert.equal(formatoCAT(10), '1000.0%');
  assert.equal(formatoCAT(10.0001), 'más de 1,000%');
});

test('integración: extracción validada -> cálculo reproduce el caso T1', () => {
  const extraccion = {
    tipo_entrada: 'etiqueta_tienda',
    confianza_extraccion: 0.92,
    producto: { descripcion: 'TV 55 pulgadas', precio_contado: '$7,999.00', tienda: null },
    credito: {
      otorgante_nombre_comercial: null, otorgante_razon_social: null, monto_ofrecido: null,
      monto_depositado: null, enganche: 0, abono: 149, periodicidad: 'semanal', numero_pagos: 104,
      plazo_dias: null, monto_total_a_pagar: null, comisiones: [], seguros: [], cat_publicado: null,
    },
    senales_riesgo: {
      pide_anticipo: false, pide_permiso_contactos: false, pide_permiso_fotos_archivos: false,
      deposito_menor_a_ofrecido: false, plazo_menor_a_15_dias: false, presion_urgencia: false,
      texto_evidencia: [],
    },
    datos_faltantes: [],
  };
  const validado = validarExtraccion(extraccion);
  assert.equal(validado.estado, 'listo');
  const r = calcular(validado.datos, { tasaCetesPct: null });
  assert.equal(r.metricas.costo_total, 15496);
  assert.equal(r.cat.porcentaje, 110.63);
});

test('integración: la oferta del prompt (T8) pasa por validador y cálculo', () => {
  const extraccion = {
    tipo_entrada: 'oferta_credito',
    confianza_extraccion: 0.88,
    producto: { descripcion: null, precio_contado: null, tienda: null },
    credito: {
      otorgante_nombre_comercial: null, otorgante_razon_social: null, monto_ofrecido: 3000,
      monto_depositado: 2100, enganche: null, abono: null, periodicidad: 'unico', numero_pagos: 1,
      plazo_dias: 7, monto_total_a_pagar: 3600, comisiones: [], seguros: [], cat_publicado: null,
    },
    senales_riesgo: {
      pide_anticipo: false, pide_permiso_contactos: true, pide_permiso_fotos_archivos: false,
      deposito_menor_a_ofrecido: false, plazo_menor_a_15_dias: false, presion_urgencia: false,
      texto_evidencia: ['Necesitamos acceso a tus contactos'],
    },
    datos_faltantes: [],
  };
  const validado = validarExtraccion(extraccion);
  assert.equal(validado.estado, 'listo');
  const r = calcular(validado.datos);
  assert.equal(r.metricas.costo_credito_pesos, 1500);
  assert.equal(r.cat.texto, 'más de 1,000%');
});

test('préstamo expone los cargos iniciales declarados para explicar el depósito', () => {
  assert.equal(calcular(prestamo()).metricas.cargos_iniciales_declarados, 0);
  const r = calcular(
    prestamo({ credito: { comisiones: [{ concepto: 'apertura', monto: 600, momento: 'inicial' }] } })
  );
  assert.equal(r.metricas.cargos_iniciales_declarados, 600);
});

test('las métricas incluyen abono, número de pagos, periodicidad y plazo para las plantillas', () => {
  const t = calcular(tienda()).metricas;
  assert.equal(t.abono, 149);
  assert.equal(t.numero_pagos, 104);
  assert.equal(t.periodicidad, 'semanal');
  assert.equal(t.plazo_dias, null);
  const unico = calcular(prestamo()).metricas;
  assert.equal(unico.plazo_dias, 7);
  assert.equal(unico.numero_pagos, null);
  const periodico = calcular(
    prestamo({
      modo: 'periodico',
      credito: {
        monto_ofrecido: 5000, monto_depositado: 5000, abono: 700, numero_pagos: 10,
        periodicidad: 'quincenal', plazo_dias: null, monto_total_a_pagar: null,
      },
    })
  ).metricas;
  assert.equal(periodico.numero_pagos, 10);
  assert.equal(periodico.periodicidad, 'quincenal');
  assert.equal(periodico.plazo_dias, null);
});

test('no modifica la entrada', () => {
  const datos = tienda({ credito: { enganche: null } });
  const copia = JSON.parse(JSON.stringify(datos));
  calcular(datos, { tasaCetesPct: 6.22 });
  assert.deepEqual(datos, copia);
});
