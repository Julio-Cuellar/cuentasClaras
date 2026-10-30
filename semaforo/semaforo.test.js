'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { semaforo, LEYENDAS } = require('./semaforo');
const { calcular, redondear } = require('../calculo/calculo');
const { validarExtraccion } = require('../extraccion/validar-extraccion');

const SENALES_VACIAS = {
  pide_anticipo: false,
  pide_permiso_contactos: false,
  pide_permiso_fotos_archivos: false,
  deposito_menor_a_ofrecido: false,
  plazo_menor_a_15_dias: false,
  presion_urgencia: false,
  texto_evidencia: [],
};
const senales = (extra = {}) => ({ ...SENALES_VACIAS, ...extra });

/** Resultado de calcular() para una tienda, con el % de sobrecosto que se quiera probar. */
function calcTienda(pct) {
  const precio = 1000;
  const sobre = redondear((precio * pct) / 100, 2);
  return {
    estado: 'ok',
    tipo: 'tienda',
    metricas: { precio_contado: precio, costo_total: precio + sobre, sobrecosto_pesos: sobre, sobrecosto_pct: pct },
  };
}

/** Resultado de calcular() para un préstamo; el costo y la diferencia se derivan de los montos. */
function calcPrestamo({ recibes = 2000, pagas = 2400, ofrecido = 2000, cargos = 0 } = {}) {
  const costo = pagas - recibes;
  return {
    estado: 'ok',
    tipo: 'prestamo',
    metricas: {
      recibes,
      pagas,
      costo_credito_pesos: costo,
      costo_pct_sobre_recibido: redondear((costo / recibes) * 100, 2),
      monto_ofrecido: ofrecido,
      diferencia_ofrecido_depositado: Math.max(0, ofrecido - recibes),
      cargos_iniciales_declarados: cargos,
    },
    cat: { texto: 'más de 1,000%' },
  };
}

const REGISTRADA = { estado: 'registrada', fecha_consulta: '30/10/2026' };
const NO_REGISTRADA = {
  estado: 'no_registrada_confirmada',
  fecha_consulta: '30/10/2026',
  terminos_buscados: ['Marca Ejemplo', 'Ejemplo SA de CV'],
};
const SIN_VERIFICAR = { estado: 'sin_verificar' };
const codigos = (r) => r.razones.map((x) => x.codigo);

// Módulo A

test('A: la TV del ejemplo (94% de sobrecosto) es roja', () => {
  const calculo = calcular({
    tipo_entrada: 'etiqueta_tienda',
    modo_pago: 'periodico',
    producto: { precio_contado: 7999 },
    credito: { enganche: 0, abono: 149, periodicidad: 'semanal', numero_pagos: 104, comisiones: [], seguros: [] },
  });
  const r = semaforo({ calculo });
  assert.equal(r.color, 'rojo');
  assert.equal(r.razones[0].codigo, 'sobrecosto');
  assert.match(r.razones[0].hecho, /\$15,496/);
  assert.match(r.razones[0].hecho, /\$7,999/);
  assert.equal(r.leyenda, LEYENDAS.rojo);
});

test('A: límites exactos del 15% y del 50%', () => {
  assert.equal(semaforo({ calculo: calcTienda(14.99) }).color, 'verde');
  assert.equal(semaforo({ calculo: calcTienda(15) }).color, 'amarillo');
  assert.equal(semaforo({ calculo: calcTienda(49.99) }).color, 'amarillo');
  assert.equal(semaforo({ calculo: calcTienda(50) }).color, 'rojo');
});

test('A: sobrecosto negativo o cálculo con error no producen un color engañoso', () => {
  assert.equal(semaforo({ calculo: calcTienda(-10) }).color, 'gris');
  assert.equal(semaforo({ calculo: { estado: 'error', motivo: 'datos_invalidos' } }).color, 'gris');
  assert.equal(semaforo({ calculo: { estado: 'error' } }).razones[0].codigo, 'sin_calculo');
  assert.equal(semaforo({}).color, 'gris');
  assert.equal(semaforo().color, 'gris');
});

test('A: umbrales configurables', () => {
  const r = semaforo({ calculo: calcTienda(30) }, { umbrales: { tienda: { rojo_desde_pct: 30 } } });
  assert.equal(r.color, 'rojo');
});

// Módulo B

test('T13: SIPRES sin verificar y sin otras señales es gris, nunca rojo', () => {
  const r = semaforo({ calculo: calcPrestamo({ pagas: 2400 }), senales: senales(), sipres: SIN_VERIFICAR });
  assert.equal(r.color, 'gris');
  assert.equal(r.estado_sipres, 'sin_verificar');
  assert.ok(codigos(r).includes('sipres_sin_verificar'));
  assert.equal(r.resumen.rojas, 0);
});

test('T14: SIPRES sin verificar con permiso a contactos es rojo por la señal, y lo aclara', () => {
  const r = semaforo({
    calculo: calcPrestamo(),
    senales: senales({ pide_permiso_contactos: true, texto_evidencia: ['Necesitamos acceso a tus contactos'] }),
    sipres: SIN_VERIFICAR,
  });
  assert.equal(r.color, 'rojo');
  assert.deepEqual(codigos(r).slice(0, 1), ['pide_permiso_contactos']);
  assert.ok(codigos(r).includes('sipres_sin_verificar'));
  assert.ok(!codigos(r).includes('sipres_no_registrada_confirmada'));
  assert.deepEqual(r.razones[0].evidencia, ['Necesitamos acceso a tus contactos']);
});

test('B: no registrada confirmada es roja y cita fecha y términos buscados', () => {
  const r = semaforo({ calculo: calcPrestamo(), senales: senales(), sipres: NO_REGISTRADA });
  assert.equal(r.color, 'rojo');
  assert.match(r.razones[0].hecho, /No la encontramos en el SIPRES/);
  assert.match(r.razones[0].hecho, /30\/10\/2026/);
  assert.match(r.razones[0].evidencia[0], /Marca Ejemplo/);
});

test('B: registrada, sin señales y con costo bajo es verde y explica qué significa', () => {
  const r = semaforo({ calculo: calcPrestamo({ recibes: 5000, pagas: 5500, ofrecido: 5000 }), senales: senales(), sipres: REGISTRADA });
  assert.equal(r.color, 'verde');
  assert.ok(codigos(r).includes('sipres_registrada'));
  assert.ok(codigos(r).includes('sin_senales_de_riesgo'));
  assert.match(r.leyenda, /no es una recomendación/i);
});

test('B: registrada con costo alto es amarilla; límites exactos del 50%', () => {
  const alto = semaforo({ calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 2100 }), senales: senales(), sipres: REGISTRADA });
  assert.equal(alto.color, 'amarillo');
  assert.ok(codigos(alto).includes('costo_alto'));
  assert.equal(
    semaforo({ calculo: calcPrestamo({ recibes: 1000, pagas: 1500, ofrecido: 1000 }), senales: senales(), sipres: REGISTRADA }).color,
    'amarillo'
  );
  assert.equal(
    semaforo({ calculo: calcPrestamo({ recibes: 1000, pagas: 1499, ofrecido: 1000 }), senales: senales(), sipres: REGISTRADA }).color,
    'verde'
  );
});

test('B: plazo muy corto o presión con evidencia dan amarillo si está registrada', () => {
  const base = calcPrestamo({ recibes: 5000, pagas: 5200, ofrecido: 5000 });
  assert.equal(semaforo({ calculo: base, senales: senales({ plazo_menor_a_15_dias: true }), sipres: REGISTRADA }).color, 'amarillo');
  const presion = semaforo({
    calculo: base,
    senales: senales({ presion_urgencia: true, texto_evidencia: ['Solo hoy'] }),
    sipres: REGISTRADA,
  });
  assert.equal(presion.color, 'amarillo');
  assert.ok(codigos(presion).includes('presion_urgencia'));
});

test('B: costo alto con entidad sin verificar se queda en gris, pero conserva el hecho', () => {
  const r = semaforo({ calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 2100 }), senales: senales(), sipres: SIN_VERIFICAR });
  assert.equal(r.color, 'gris');
  assert.ok(codigos(r).includes('costo_alto'));
});

test('B: depósito menor al ofrecido sin cargos que lo expliquen es rojo', () => {
  const r = semaforo({ calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 3000 }), senales: senales(), sipres: REGISTRADA });
  assert.equal(r.color, 'rojo');
  const d = r.razones.find((x) => x.codigo === 'deposito_menor_sin_explicacion');
  assert.match(d.hecho, /\$3,000/);
  assert.match(d.hecho, /\$2,100/);
  assert.match(d.hecho, /\$900/);
});

test('B: depósito menor explicado por cargos iniciales declarados no es rojo', () => {
  const r = semaforo({
    calculo: calcPrestamo({ recibes: 4400, pagas: 5000, ofrecido: 5000, cargos: 600 }),
    senales: senales(),
    sipres: REGISTRADA,
  });
  assert.notEqual(r.color, 'rojo');
  assert.ok(codigos(r).includes('deposito_menor_con_cargos'));
  // la tolerancia de 1 peso absorbe redondeos
  const casiIgual = semaforo({
    calculo: calcPrestamo({ recibes: 4400, pagas: 5000, ofrecido: 5000, cargos: 599.5 }),
    senales: senales(),
    sipres: REGISTRADA,
  });
  assert.notEqual(casiIgual.color, 'rojo');
  const insuficiente = semaforo({
    calculo: calcPrestamo({ recibes: 4400, pagas: 5000, ofrecido: 5000, cargos: 500 }),
    senales: senales(),
    sipres: REGISTRADA,
  });
  assert.equal(insuficiente.color, 'rojo');
});

test('B: varias razones rojas se listan todas, ordenadas por gravedad', () => {
  const r = semaforo({
    calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 3000 }),
    senales: senales({
      pide_anticipo: true,
      pide_permiso_contactos: true,
      pide_permiso_fotos_archivos: true,
      plazo_menor_a_15_dias: true,
      texto_evidencia: ['Paga $300 para liberar', 'Permiso de contactos y fotos'],
    }),
    sipres: NO_REGISTRADA,
  });
  assert.equal(r.color, 'rojo');
  assert.equal(r.resumen.rojas, 5);
  assert.ok(r.resumen.amarillas >= 2);
  const niveles = r.razones.map((x) => x.nivel);
  assert.equal(niveles[0], 'rojo');
  assert.ok(niveles.lastIndexOf('rojo') < niveles.indexOf('amarillo'));
});

test('B: una señal de texto sin evidencia literal no cuenta y se advierte', () => {
  const r = semaforo({
    calculo: calcPrestamo({ recibes: 5000, pagas: 5200, ofrecido: 5000 }),
    senales: senales({ pide_anticipo: true, texto_evidencia: [] }),
    sipres: REGISTRADA,
  });
  assert.equal(r.color, 'verde');
  assert.ok(r.advertencias.includes('senal_sin_evidencia:pide_anticipo'));
});

test('B: sin objeto sipres o con estado inválido se trata como sin verificar', () => {
  const base = { calculo: calcPrestamo({ pagas: 2200 }), senales: senales() };
  const nulo = semaforo({ ...base, sipres: null });
  assert.equal(nulo.color, 'gris');
  assert.equal(nulo.estado_sipres, 'sin_verificar');
  const raro = semaforo({ ...base, sipres: { estado: 'quizas' } });
  assert.equal(raro.color, 'gris');
  assert.ok(raro.advertencias.includes('estado_sipres_invalido'));
});

test('B: SIPRES conocida pero sin fecha se advierte, para no citar sin fecha', () => {
  const r = semaforo({ calculo: calcPrestamo({ pagas: 2200 }), senales: senales(), sipres: { estado: 'registrada' } });
  assert.ok(r.advertencias.includes('sipres_sin_fecha'));
});

test('B: umbral de costo configurable', () => {
  const calculo = calcPrestamo({ recibes: 1000, pagas: 1200, ofrecido: 1000 });
  assert.equal(semaforo({ calculo, senales: senales(), sipres: REGISTRADA }).color, 'verde');
  assert.equal(
    semaforo({ calculo, senales: senales(), sipres: REGISTRADA }, { umbrales: { prestamo: { costo_amarillo_desde_pct: 15 } } }).color,
    'amarillo'
  );
});

test('los hechos no usan palabras acusatorias', () => {
  const r = semaforo({
    calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 3000 }),
    senales: senales({
      pide_anticipo: true, pide_permiso_contactos: true, presion_urgencia: true,
      texto_evidencia: ['Solo hoy'],
    }),
    sipres: NO_REGISTRADA,
  });
  const todo = [r.leyenda, ...r.razones.map((x) => x.hecho)].join(' ').toLowerCase();
  for (const prohibida of ['fraude', 'estafa', 'montadeudas', 'ilegal', 'no uses']) {
    assert.ok(!todo.includes(prohibida), prohibida);
  }
});

test('integración T14: oferta del prompt -> validador -> cálculo -> semáforo', () => {
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
  const calculo = calcular(validado.datos);
  const r = semaforo({ calculo, senales: validado.datos.senales_riesgo, sipres: SIN_VERIFICAR });
  assert.equal(r.color, 'rojo');
  assert.ok(codigos(r).includes('pide_permiso_contactos'));
  assert.ok(codigos(r).includes('deposito_menor_sin_explicacion'));
  assert.ok(codigos(r).includes('plazo_muy_corto'));
  assert.ok(codigos(r).includes('sipres_sin_verificar'));
});

test('integración: la misma oferta con SIPRES no registrada confirmada también es roja', () => {
  const calculo = calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 3000 });
  const r = semaforo({ calculo, senales: senales(), sipres: NO_REGISTRADA });
  assert.equal(r.color, 'rojo');
  assert.equal(r.estado_sipres, 'no_registrada_confirmada');
});

test('el resultado es serializable y no modifica las entradas', () => {
  const entrada = {
    calculo: calcPrestamo({ recibes: 2100, pagas: 3600, ofrecido: 3000 }),
    senales: senales({ pide_permiso_contactos: true, texto_evidencia: ['x'] }),
    sipres: NO_REGISTRADA,
  };
  const copia = JSON.parse(JSON.stringify(entrada));
  const r = semaforo(entrada);
  assert.deepEqual(entrada, copia);
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.deepEqual(Object.keys(LEYENDAS).sort(), ['amarillo', 'gris', 'rojo', 'verde']);
});
