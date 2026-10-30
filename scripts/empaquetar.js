'use strict';

/**
 * Genera los archivos que se pegan en los nodos Code de n8n.
 *
 *   node scripts/empaquetar.js
 *
 * escribe:
 *   n8n/nodos/procesar.js            nodo "Procesar" (todos los módulos + el orquestador)
 *   n8n/nodos/elegir-respuesta.js    nodo "Elegir respuesta" (solo respuesta.js)
 *
 * Cada módulo se envuelve en su propia función para que sus nombres internos no choquen, y se
 * entrega un `require` mínimo para que flujo/procesar.js funcione igual dentro y fuera de n8n.
 * Los archivos generados NO se editan a mano: se cambia el módulo y se vuelve a generar
 * (una prueba avisa si quedaron desactualizados).
 */

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SALIDA = path.join(RAIZ, 'n8n', 'nodos');

const MODULOS = [
  ['validar-extraccion', 'extraccion/validar-extraccion.js'],
  ['calculo', 'calculo/calculo.js'],
  ['semaforo', 'semaforo/semaforo.js'],
  ['respuesta', 'respuesta/respuesta.js'],
  ['banxico', 'banxico/banxico.js'],
  ['sipres', 'sipres/sipres.js'],
];

function leer(relativa) {
  return fs.readFileSync(path.join(RAIZ, relativa), 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function envolver(nombre, fuente, conRequire) {
  const clave = JSON.stringify(nombre);
  if (conRequire) {
    return `__modulos[${clave}] = ((require) => {\nconst module = { exports: {} };\n${fuente}\nreturn module.exports;\n})(__require);\n`;
  }
  return `__modulos[${clave}] = (() => {\nconst module = { exports: {} };\n${fuente}\nreturn module.exports;\n})();\n`;
}

const REQUIRE_MINIMO = [
  'const __require = (ruta) => {',
  "  const clave = String(ruta).split('/').pop().replace(/\\.js$/, '');",
  "  if (!(clave in __modulos)) throw new Error('Módulo no empaquetado: ' + ruta);",
  '  return __modulos[clave];',
  '};',
  '',
].join('\n');

function cabecera(titulo) {
  return [
    '// GENERADO por scripts/empaquetar.js. No lo edites aquí: cambia el módulo y vuelve a generar.',
    `// Nodo Code de n8n: ${titulo}. Modo "Run Once for All Items", lenguaje JavaScript.`,
    '',
    'const __modulos = {};',
    '',
  ].join('\n');
}

const PIE_PROCESAR = [
  '',
  '// ---------------------------------------------------------------------------',
  '// CONFIGURACIÓN DE ESTE FLUJO (la única parte que se edita a mano en n8n)',
  '// ---------------------------------------------------------------------------',
  '',
  '// Tabla de SIPRES capturada a mano al llegar. La fila de abajo es FICTICIA: reemplázala.',
  '// estado: "registrada" o "no_registrada_confirmada" (esta última exige 2 o más términos buscados).',
  'const TABLA_SIPRES = [',
  '  {',
  "    nombre_comercial: 'Marca de Ejemplo',",
  "    razon_social: 'Ejemplo Financiero SA de CV',",
  "    estado: 'registrada',",
  "    terminos_buscados: ['Marca de Ejemplo', 'Ejemplo Financiero'],",
  "    fecha_consulta: '30/10/2026',",
  '    alerta_publica_condusef: null,',
  "    verificado_por: 'XX',",
  '  },',
  '];',
  '',
  '// enlaceSipres: ponlo solo cuando hayas verificado la dirección. canalesCobranza: texto con teléfonos/enlaces oficiales verificados.',
  'const CONFIG = { enlaceSipres: null, canalesCobranza: null };',
  '',
  '// Nombres de los nodos LLM de extracción (uno por rama). Deben coincidir con los de tu flujo.',
  "const NODOS_EXTRACCION = ['Extraer foto', 'Extraer texto'];",
  '',
  '// ---------------------------------------------------------------------------',
  '// ENTRADAS Y SALIDA',
  '// ---------------------------------------------------------------------------',
  '',
  'const { procesar } = __modulos["procesar"];',
  'const nodoLLM = NODOS_EXTRACCION.find((n) => $(n).isExecuted);',
  'const salidaLLM = nodoLLM ? $(nodoLLM).first().json : null;',
  '// Este nodo va justo después del HTTP Request de CETES: su salida es la respuesta de Banxico (o el error).',
  'const cetesRespuesta = $input.first().json;',
  'const resultado = procesar({',
  '  salidaLLM,',
  '  cetesRespuesta,',
  '  tablaSipres: TABLA_SIPRES,',
  '  config: CONFIG,',
  '  hoy: new Date().toISOString().slice(0, 10),',
  '});',
  'return [{ json: resultado }];',
  '',
].join('\n');

const PIE_ELEGIR = [
  '',
  '// ---------------------------------------------------------------------------',
  '// ENTRADAS Y SALIDA',
  '// ---------------------------------------------------------------------------',
  '',
  'const { elegirRespuesta, textoDeSalidaLLM } = __modulos["respuesta"];',
  "const ctx = $('Procesar').first().json.ctx;",
  '// Este nodo va justo después del LLM de redacción.',
  'const textoLLM = textoDeSalidaLLM($input.first().json);',
  'return [{ json: elegirRespuesta(textoLLM, ctx) }];',
  '',
].join('\n');

function construir() {
  const fuentes = Object.fromEntries(MODULOS.map(([nombre, ruta]) => [nombre, leer(ruta)]));

  let procesar = cabecera('"Procesar"');
  for (const [nombre] of MODULOS) procesar += envolver(nombre, fuentes[nombre], false) + '\n';
  procesar += REQUIRE_MINIMO + '\n';
  procesar += envolver('procesar', leer('flujo/procesar.js'), true);
  procesar += PIE_PROCESAR;

  let elegir = cabecera('"Elegir respuesta"');
  elegir += envolver('respuesta', fuentes.respuesta, false);
  elegir += PIE_ELEGIR;

  return { procesar, elegir };
}

function escribir() {
  const { procesar, elegir } = construir();
  fs.mkdirSync(SALIDA, { recursive: true });
  fs.writeFileSync(path.join(SALIDA, 'procesar.js'), procesar);
  fs.writeFileSync(path.join(SALIDA, 'elegir-respuesta.js'), elegir);
  return { procesar: procesar.length, elegir: elegir.length };
}

if (require.main === module) {
  const t = escribir();
  console.log(`n8n/nodos/procesar.js (${t.procesar} caracteres) y n8n/nodos/elegir-respuesta.js (${t.elegir} caracteres)`);
}

module.exports = { construir, escribir, SALIDA };
