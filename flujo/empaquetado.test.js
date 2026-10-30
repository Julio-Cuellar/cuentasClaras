'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { construir, SALIDA } = require('../scripts/empaquetar');
const { procesar } = require('./procesar');
const R = require('../respuesta/respuesta');

const SENALES_VACIAS = {
  pide_anticipo: false,
  pide_permiso_contactos: false,
  pide_permiso_fotos_archivos: false,
  deposito_menor_a_ofrecido: false,
  plazo_menor_a_15_dias: false,
  presion_urgencia: false,
  texto_evidencia: [],
};
const EXTRACCION_T1 = {
  tipo_entrada: 'etiqueta_tienda',
  confianza_extraccion: 0.92,
  producto: { descripcion: 'TV 55 pulgadas', precio_contado: 7999, tienda: null },
  credito: {
    otorgante_nombre_comercial: null, otorgante_razon_social: null, monto_ofrecido: null, monto_depositado: null,
    enganche: 0, abono: 149, periodicidad: 'semanal', numero_pagos: 104, plazo_dias: null,
    monto_total_a_pagar: null, comisiones: [], seguros: [], cat_publicado: null,
  },
  senales_riesgo: SENALES_VACIAS,
  datos_faltantes: [],
};
const CETES_OK = {
  bmx: { series: [{ idSerie: 'SF43936', titulo: 'Cetes 28 días', datos: [{ fecha: '29/10/2026', dato: '6.22' }] }] },
};

/**
 * Corre un nodo generado como lo haría n8n: dentro de una función asíncrona, sin require ni module,
 * con `$input` y `$()` simulados. El resultado se pasa por JSON para comparar objetos de otro contexto.
 */
async function correrNodo(codigo, { entrada, nodos }) {
  const sandbox = {
    $input: { first: () => ({ json: entrada }) },
    $: (nombre) => {
      const n = nodos[nombre];
      if (!n) throw new Error(`Nodo inexistente en la simulación: ${nombre}`);
      return { isExecuted: n.ejecutado !== false, first: () => ({ json: n.json }) };
    },
  };
  const contexto = vm.createContext(sandbox);
  const resultado = await vm.runInContext(`(async () => {\n${codigo}\n})()`, contexto);
  return JSON.parse(JSON.stringify(resultado));
}

const { procesar: codigoProcesar, elegir: codigoElegir } = construir();

test('el nodo Procesar corre sin require ni module y da lo mismo que el módulo', async () => {
  const salidaLLM = { output: JSON.stringify(EXTRACCION_T1) };
  const r = await correrNodo(codigoProcesar, {
    entrada: CETES_OK,
    nodos: { 'Extraer foto': { json: salidaLLM }, 'Extraer texto': { ejecutado: false, json: null } },
  });
  assert.equal(r.length, 1);
  const directo = JSON.parse(
    JSON.stringify(procesar({ salidaLLM, cetesRespuesta: CETES_OK, tablaSipres: [], hoy: 'x' }))
  );
  assert.equal(r[0].json.accion, 'redactar');
  assert.deepEqual(r[0].json.ctx, directo.ctx);
  assert.equal(r[0].json.plantilla, directo.plantilla);
  assert.match(r[0].json.log.fecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r[0].json.log.semaforo, 'rojo');
});

test('el nodo Procesar toma la rama de texto cuando la de foto no corrió', async () => {
  const r = await correrNodo(codigoProcesar, {
    entrada: CETES_OK,
    nodos: {
      'Extraer foto': { ejecutado: false, json: null },
      'Extraer texto': { json: { text: JSON.stringify(EXTRACCION_T1) } },
    },
  });
  assert.equal(r[0].json.accion, 'redactar');
  assert.equal(r[0].json.ctx.metricas.costo_total, 15496);
});

test('el nodo Procesar responde con un mensaje de error si ninguna rama de extracción corrió', async () => {
  const r = await correrNodo(codigoProcesar, {
    entrada: CETES_OK,
    nodos: {
      'Extraer foto': { ejecutado: false, json: null },
      'Extraer texto': { ejecutado: false, json: null },
    },
  });
  assert.equal(r[0].json.accion, 'responder');
  assert.equal(r[0].json.motivo, 'error_formato');
});

test('el nodo Procesar usa el respaldo si el HTTP Request de CETES devolvió un error', async () => {
  const r = await correrNodo(codigoProcesar, {
    entrada: { error: { mensaje: 'Token inválido' } },
    nodos: { 'Extraer foto': { json: { output: JSON.stringify(EXTRACCION_T1) } }, 'Extraer texto': { ejecutado: false, json: null } },
  });
  assert.ok(r[0].json.advertencias.includes('cetes_respaldo:error_api'));
  assert.equal(r[0].json.ctx.fuentes_a_citar[0].respaldo, true);
});

test('el nodo Elegir respuesta usa el texto del LLM si cumple y la plantilla si no', async () => {
  const salidaLLM = { output: JSON.stringify(EXTRACCION_T1) };
  const procesado = procesar({ salidaLLM, cetesRespuesta: CETES_OK, tablaSipres: [], hoy: 'x' });
  const nodos = { Procesar: { json: JSON.parse(JSON.stringify(procesado)) } };

  const bueno = await correrNodo(codigoElegir, { entrada: { output: procesado.plantilla }, nodos });
  assert.equal(bueno[0].json.origen, 'llm');
  assert.equal(bueno[0].json.texto, procesado.plantilla);

  const malo = await correrNodo(codigoElegir, { entrada: { text: 'Es un fraude, sin fuentes.' }, nodos });
  assert.equal(malo[0].json.origen, 'plantilla');
  assert.equal(malo[0].json.texto, procesado.plantilla);
  assert.ok(malo[0].json.fallas.length > 0);

  const vacio = await correrNodo(codigoElegir, { entrada: {}, nodos });
  assert.equal(vacio[0].json.motivo, 'sin_texto_llm');
  assert.equal(R.verificarRespuesta(vacio[0].json.texto, procesado.ctx).ok, true);
});

test('los paquetes no llaman a require salvo dentro de la envoltura del orquestador', () => {
  const marca = '__modulos["procesar"] = ((require) => {';
  const indice = codigoProcesar.indexOf(marca);
  assert.ok(indice > 0, 'falta la envoltura del orquestador');
  assert.ok(!/\brequire\(/.test(codigoProcesar.slice(0, indice)), 'hay un require antes de la envoltura');
  assert.ok(!/\brequire\(/.test(codigoElegir), 'el nodo Elegir respuesta no debe usar require');
  for (const codigo of [codigoProcesar, codigoElegir]) {
    assert.ok(codigo.startsWith('// GENERADO por scripts/empaquetar.js'));
  }
});

test('el paquete de Procesar incluye la configuración editable y los nombres de nodos esperados', () => {
  assert.match(codigoProcesar, /const TABLA_SIPRES = \[/);
  assert.match(codigoProcesar, /const CONFIG = \{ enlaceSipres: null, canalesCobranza: null \};/);
  assert.match(codigoProcesar, /\['Extraer foto', 'Extraer texto'\]/);
  assert.match(codigoElegir, /\$\('Procesar'\)/);
});

test('los archivos de n8n/nodos están al día (si fallan: node scripts/empaquetar.js)', () => {
  for (const [archivo, esperado] of [
    ['procesar.js', codigoProcesar],
    ['elegir-respuesta.js', codigoElegir],
  ]) {
    const ruta = path.join(SALIDA, archivo);
    assert.ok(fs.existsSync(ruta), `falta ${ruta}: corre node scripts/empaquetar.js`);
    assert.equal(fs.readFileSync(ruta, 'utf8'), esperado, `${archivo} está desactualizado: corre node scripts/empaquetar.js`);
  }
});
