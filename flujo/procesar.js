'use strict';

/**
 * Orquestador del flujo: lo que hace el nodo "Procesar" de n8n.
 *
 * procesar({ salidaLLM, cetesRespuesta, tablaSipres, config, hoy }) devuelve SIEMPRE un objeto:
 *   { accion: 'responder', texto, motivo, log, advertencias }   -> enviar `texto` directamente
 *   { accion: 'redactar', ctx, plantilla, log, advertencias }   -> pasar `ctx` al LLM de redacción
 *
 * Encadena: validarExtraccion -> (tasa de CETES o búsqueda SIPRES) -> calcular -> semaforo -> armarContexto.
 * No guarda nada, no llama a ninguna API y no incluye el texto del usuario ni la imagen en la salida;
 * el log solo lleva fecha, tipo de entrada, color del semáforo y estado SIPRES.
 */

const { validarExtraccion } = require('../extraccion/validar-extraccion');
const { calcular } = require('../calculo/calculo');
const { semaforo } = require('../semaforo/semaforo');
const R = require('../respuesta/respuesta');
const { tasaCetes } = require('../banxico/banxico');
const { buscarEntidad } = require('../sipres/sipres');

function procesar({ salidaLLM, cetesRespuesta, tablaSipres, config = {}, hoy = null } = {}) {
  const advertencias = [];
  const log = (tipo, color, sipres) => ({ fecha: hoy, tipo_entrada: tipo, semaforo: color, estado_sipres: sipres });
  const responder = (texto, motivo, tipo = 'desconocido') => ({
    accion: 'responder',
    texto,
    motivo,
    log: log(tipo, 'n.a.', 'n.a.'),
    advertencias,
  });

  const v = validarExtraccion(R.textoDeSalidaLLM(salidaLLM));
  if (v.estado === 'error_formato') return responder(R.mensajes.error(config), 'error_formato');
  if (v.estado === 'cobranza') return responder(R.plantillaCobranza(config), 'cobranza', 'cobranza');
  if (v.estado === 'desconocido' || v.estado === 'preguntar') {
    return responder(R.mensajes.aclaracion(v.preguntas, config), v.motivo);
  }

  const datos = v.datos;
  let calculo;
  let sem;
  let fuentes;

  if (datos.tipo_entrada === 'etiqueta_tienda') {
    const cetes = tasaCetes(cetesRespuesta, config.banxico);
    if (cetes.fuente.respaldo) advertencias.push(`cetes_respaldo:${cetes.motivo}`);
    calculo = calcular(datos, { tasaCetesPct: cetes.tasa_pct });
    sem = semaforo({ calculo });
    fuentes = { cetes: cetes.fuente };
  } else {
    const sipres = buscarEntidad(tablaSipres, {
      nombre_comercial: datos.credito.otorgante_nombre_comercial,
      razon_social: datos.credito.otorgante_razon_social,
    });
    if (sipres.motivo !== 'ok') advertencias.push(`sipres:${sipres.motivo}`);
    sipres.advertencias.forEach((a) => advertencias.push(`sipres:${a}`));
    calculo = calcular(datos);
    sem = semaforo({
      calculo,
      senales: datos.senales_riesgo,
      sipres: {
        estado: sipres.estado,
        fecha_consulta: sipres.fecha_consulta,
        terminos_buscados: sipres.terminos_buscados,
      },
    });
    fuentes = { sipres: { fecha: sipres.fecha_consulta } };
  }

  if (calculo.estado !== 'ok') {
    return responder(
      R.mensajes.aclaracion(['No pude calcular con esos datos. ¿Me confirmas el precio, los pagos y el plazo?'], config),
      `calculo_invalido:${calculo.motivo}`,
      datos.tipo_entrada
    );
  }
  const ctx = R.armarContexto({ calculo, semaforo: sem, fuentes, config });
  if (!ctx) return responder(R.mensajes.error(config), 'sin_contexto', datos.tipo_entrada);

  return {
    accion: 'redactar',
    ctx,
    plantilla: R.plantillaDesdeContexto(ctx),
    log: log(datos.tipo_entrada, sem.color, sem.estado_sipres || 'n.a.'),
    advertencias: [...advertencias, ...ctx.advertencias],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { procesar };
}
