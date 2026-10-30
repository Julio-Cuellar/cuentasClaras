'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./respuesta');
const { calcular } = require('../calculo/calculo');
const { semaforo } = require('../semaforo/semaforo');
const { validarExtraccion } = require('../extraccion/validar-extraccion');

const FECHA_CETES = '29/10/2026';
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
const senales = (extra = {}) => ({ ...SENALES_VACIAS, ...extra });
const lineas = (texto) => texto.split('\n').filter((l) => l.trim());
const normalizar = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Cadena completa para una tienda: calcular -> semáforo -> contexto. */
function ctxTienda({ precio = 7999, abono = 149, n = 104, tasa = null, fuentes = {}, config } = {}) {
  const calculo = calcular(
    {
      tipo_entrada: 'etiqueta_tienda',
      modo_pago: 'periodico',
      producto: { precio_contado: precio },
      credito: { enganche: 0, abono, periodicidad: 'semanal', numero_pagos: n, comisiones: [], seguros: [] },
    },
    { tasaCetesPct: tasa }
  );
  const sem = semaforo({ calculo });
  return R.armarContexto({ calculo, semaforo: sem, fuentes, config });
}

/** Cadena completa para un préstamo de pago único (caso T8) con las señales y el SIPRES que se pidan. */
function ctxPrestamo({ credito = {}, sen = senales(), sipres = { estado: 'sin_verificar' }, config, fuentes } = {}) {
  const calculo = calcular({
    tipo_entrada: 'oferta_credito',
    modo_pago: 'unico',
    producto: {},
    credito: {
      enganche: null, abono: null, periodicidad: 'unico', numero_pagos: 1, plazo_dias: 7,
      monto_ofrecido: 3000, monto_depositado: 2100, monto_total_a_pagar: 3600,
      comisiones: [], seguros: [], ...credito,
    },
  });
  const sem = semaforo({ calculo, senales: sen, sipres });
  return R.armarContexto({
    calculo,
    semaforo: sem,
    fuentes: fuentes === undefined ? { sipres: { fecha: FECHA_SIPRES } } : fuentes,
    config,
  });
}

const CON_FECHA = { estado: 'registrada', fecha_consulta: FECHA_SIPRES };
const NO_REGISTRADA = { estado: 'no_registrada_confirmada', fecha_consulta: FECHA_SIPRES, terminos_buscados: ['Marca'] };
const CONTACTOS = { pide_permiso_contactos: true, texto_evidencia: ['Necesitamos acceso a tus contactos'] };

// ---------- contexto ----------

test('contexto de la TV: solo lo que la IA puede decir, serializable y con cifras permitidas', () => {
  const ctx = ctxTienda();
  assert.equal(ctx.tipo, 'tienda');
  assert.equal(ctx.color, 'rojo');
  assert.equal(ctx.mostrar_cat, true);
  assert.equal(ctx.enlaces.hackathon, R.ENLACE_HACKATHON);
  assert.deepEqual(ctx.fuentes_a_citar, []);
  for (const n of [15496, 7999, 7497, 110.63, 104, 54, 7450]) {
    assert.ok(ctx.cifras_permitidas.includes(n), `falta ${n}`);
  }
  assert.doesNotThrow(() => JSON.stringify(ctx));
  assert.deepEqual(
    Object.keys(ctx).sort(),
    [
      'advertencias', 'ahorro', 'aviso_cat', 'cat', 'cifras_permitidas', 'color', 'enlaces', 'estado_sipres',
      'fuente_calculo', 'fuentes_a_citar', 'leyenda', 'metricas', 'mostrar_cat', 'razones', 'tipo',
    ]
  );
});

test('contexto: sin cálculo ok o sin semáforo devuelve null', () => {
  assert.equal(R.armarContexto(), null);
  assert.equal(R.armarContexto({ calculo: { estado: 'error' }, semaforo: { color: 'rojo' } }), null);
  assert.equal(R.armarContexto({ calculo: { estado: 'ok', tipo: 'tienda' }, semaforo: null }), null);
});

test('contexto: usar la tasa de CETES obliga a citar Banxico con su fecha', () => {
  const ctx = ctxTienda({ tasa: 6.22, fuentes: { cetes: { fecha: FECHA_CETES } } });
  assert.equal(ctx.fuentes_a_citar.length, 1);
  assert.equal(ctx.fuentes_a_citar[0].nombre, 'Banxico');
  assert.equal(ctx.fuentes_a_citar[0].fecha, FECHA_CETES);
  const sinFuente = ctxTienda({ tasa: 6.22, fuentes: {} });
  assert.ok(sinFuente.advertencias.includes('falta_fuente_cetes'));
});

test('contexto: SIPRES conocida obliga a citar la fecha; sin fecha se advierte', () => {
  const ctx = ctxPrestamo({ sipres: CON_FECHA });
  assert.equal(ctx.fuentes_a_citar[0].nombre, 'SIPRES, Condusef');
  const sinFecha = ctxPrestamo({ sipres: CON_FECHA, fuentes: {} });
  assert.ok(sinFecha.advertencias.includes('falta_fecha_sipres'));
  assert.deepEqual(ctxPrestamo({ sipres: { estado: 'sin_verificar' } }).fuentes_a_citar, []);
});

// ---------- plantilla de tienda ----------

test('plantilla de la TV sin CETES: cifras del cálculo, tope, aviso del CAT, fuente y enlace', () => {
  const ctx = ctxTienda();
  const t = R.plantillaDesdeContexto(ctx);
  assert.match(t, /^🔴 En abonos pagas \$15,496\. De contado cuesta \$7,999\./);
  assert.match(t, /Son \$7,497 de más \(93\.7%\) repartidos en 104 semanas\./);
  assert.match(t, /CAT implícito estimado: 110\.6% anual \(informativo, sin IVA; puede diferir del CAT oficial\)\./);
  assert.match(t, /Si apartas \$149 cada semana, juntas el precio de contado en 54 semanas o menos y evitas pagar ≈\$7,450 de más\./);
  assert.match(t, /📊 Fuentes: cálculo propio con los datos de la etiqueta\./);
  assert.ok(t.endsWith(`Hecho en el AI Hackathon por México: ${R.ENLACE_HACKATHON}`));
  assert.ok(lineas(t).length <= R.MAX_LINEAS);
  assert.deepEqual(R.verificarRespuesta(t, ctx), { ok: true, fallas: [] });
});

test('plantilla de la TV con CETES: sin "o menos" y cita Banxico con fecha; respaldo se avisa', () => {
  const ctx = ctxTienda({ tasa: 6.22, fuentes: { cetes: { fecha: FECHA_CETES } } });
  const t = R.plantillaDesdeContexto(ctx);
  assert.match(t, /en 53 semanas y evitas pagar ≈\$7,599 de más/);
  assert.ok(!/53 semanas o menos/.test(t));
  assert.match(t, /Banxico, CETES 28 días, subasta semanal \(29\/10\/2026\)/);
  assert.equal(R.verificarRespuesta(t, ctx).ok, true);
  const respaldo = ctxTienda({ tasa: 6.22, fuentes: { cetes: { fecha: FECHA_CETES, respaldo: true } } });
  assert.match(R.plantillaDesdeContexto(respaldo), /29\/10\/2026, dato de respaldo\)/);
});

test('plantilla de tienda: amarillo no repite la leyenda y verde aclara que no es una recomendación', () => {
  const amarillo = ctxTienda({ precio: 1000, abono: 120, n: 10 });
  assert.equal(amarillo.color, 'amarillo');
  const ta = R.plantillaDesdeContexto(amarillo);
  assert.ok(ta.startsWith('🟡'));
  assert.equal(R.verificarRespuesta(ta, amarillo).ok, true);

  const verde = ctxTienda({ precio: 1000, abono: 105, n: 10 });
  assert.equal(verde.color, 'verde');
  const tv = R.plantillaDesdeContexto(verde);
  assert.ok(tv.startsWith('🟢'));
  assert.match(tv, /no es una recomendación de contratar/i);
  assert.ok(!/evitas pagar/.test(tv));
  assert.equal(R.verificarRespuesta(tv, verde).ok, true);
});

test('plantilla de tienda con datos incoherentes pide una foto más clara y también es verificable', () => {
  const ctx = ctxTienda({ precio: 1000, abono: 90, n: 10 });
  assert.equal(ctx.color, 'gris');
  const t = R.plantillaDesdeContexto(ctx);
  assert.match(t, /^⚪ No pudimos validar los datos de la etiqueta\./);
  assert.equal(R.verificarRespuesta(t, ctx).ok, true);
});

// ---------- plantilla de préstamo ----------

test('plantilla de préstamo T14: hechos, evidencia, costo, acción, fuentes y enlace', () => {
  const ctx = ctxPrestamo({ sen: senales({ ...CONTACTOS, plazo_menor_a_15_dias: true }) });
  assert.equal(ctx.color, 'rojo');
  const t = R.plantillaDesdeContexto(ctx);
  assert.ok(t.startsWith('🔴 Encontramos señales de riesgo en esta oferta'));
  assert.match(t, /❌ Pide acceso a tus contactos\./);
  assert.match(t, /❌ Ofrece \$3,000 pero deposita \$2,100: \$900 menos/);
  assert.match(t, /❔ No la tenemos en nuestra base; hay que verificarla en el SIPRES\./);
  assert.match(t, /… y 1 hecho más\./);
  assert.match(t, /Lo que dice la oferta: «Necesitamos acceso a tus contactos»/);
  assert.match(t, /Pagarías \$3,600 por recibir \$2,100 \(\$1,500 de costo, 71\.4% de lo que recibes\)\./);
  assert.match(t, /CAT implícito estimado: más de 1,000% \(informativo, sin IVA/);
  assert.match(t, /Si ya instalaste la app, revisa y retira sus permisos\./);
  assert.ok(lineas(t).length <= R.MAX_LINEAS);
  assert.deepEqual(R.verificarRespuesta(t, ctx), { ok: true, fallas: [] });
});

test('el enlace de SIPRES solo aparece si está configurado, y entonces se permite', () => {
  const sin = R.plantillaDesdeContexto(ctxPrestamo({ sen: senales(CONTACTOS) }));
  assert.ok(!/https:\/\/(?!hackathon)/.test(sin));
  const config = { enlaceSipres: 'https://ejemplo.test/sipres' };
  const ctx = ctxPrestamo({ sen: senales(CONTACTOS), config });
  const con = R.plantillaDesdeContexto(ctx);
  assert.match(con, /verifica el registro en el SIPRES de Condusef: https:\/\/ejemplo\.test\/sipres/);
  assert.equal(R.verificarRespuesta(con, ctx).ok, true);
});

test('con muchas razones rojas se recorta y se dice cuántas faltan, sin pasar de 10 líneas', () => {
  const ctx = ctxPrestamo({
    sipres: NO_REGISTRADA,
    sen: senales({
      pide_anticipo: true, pide_permiso_contactos: true, pide_permiso_fotos_archivos: true,
      plazo_menor_a_15_dias: true, presion_urgencia: true,
      texto_evidencia: ['Paga $300 para liberar tu crédito', 'Solo hoy'],
    }),
  });
  const t = R.plantillaDesdeContexto(ctx);
  assert.match(t, /… y 4 hechos más\./);
  assert.match(t, /No la encontramos en el SIPRES de Condusef \(búsqueda manual del 30\/10\/2026\)\./);
  assert.match(t, /SIPRES, Condusef \(30\/10\/2026\)/);
  assert.equal(lineas(t).length, 10);
  assert.deepEqual(R.verificarRespuesta(t, ctx), { ok: true, fallas: [] });
});

test('préstamo verde: registrada, sin señales y sin costo alto', () => {
  const ctx = ctxPrestamo({
    sipres: CON_FECHA,
    credito: { monto_ofrecido: 5000, monto_depositado: 5000, monto_total_a_pagar: 5500, plazo_dias: 30 },
  });
  assert.equal(ctx.color, 'verde');
  const t = R.plantillaDesdeContexto(ctx);
  assert.ok(t.startsWith('🟢 No detectamos señales de riesgo'));
  assert.match(t, /✅ Aparece registrada en el SIPRES de Condusef \(consulta del 30\/10\/2026\)\./);
  assert.match(t, /no es una recomendación de contratar/i);
  assert.equal(R.verificarRespuesta(t, ctx).ok, true);
});

test('préstamo amarillo: el costo alto va en la línea de costo y no se duplica como viñeta', () => {
  const ctx = ctxPrestamo({ sipres: CON_FECHA, credito: { monto_ofrecido: 2100 } });
  assert.equal(ctx.color, 'amarillo');
  const t = R.plantillaDesdeContexto(ctx);
  assert.ok(t.startsWith('🟡 Hay puntos que conviene revisar'));
  assert.match(t, /\(\$1,500 de costo, 71\.4% de lo que recibes\)/);
  assert.equal((t.match(/Pagarías/g) || []).length, 1);
  assert.match(t, /Registrada no significa conveniente: compara antes de aceptar\./);
  assert.equal(R.verificarRespuesta(t, ctx).ok, true);
});

test('préstamo gris: no se afirma que no esté registrada', () => {
  const ctx = ctxPrestamo({ credito: { monto_ofrecido: 2100 } });
  assert.equal(ctx.color, 'gris');
  const t = R.plantillaDesdeContexto(ctx);
  assert.ok(t.startsWith('⚪ No pudimos verificar esta oferta en nuestra base'));
  assert.match(t, /👉 Verifícala tú en el SIPRES de Condusef\./);
  assert.ok(!/no (está|esta|aparece) registrada/i.test(t));
  assert.equal(R.verificarRespuesta(t, ctx).ok, true);
});

// ---------- verificador ----------

const base = () => {
  const ctx = ctxTienda();
  return { ctx, texto: R.plantillaDesdeContexto(ctx) };
};
const codigos = (v) => v.fallas.map((f) => f.codigo);

test('verificador: la plantilla válida pasa', () => {
  const { ctx, texto } = base();
  assert.equal(R.verificarRespuesta(texto, ctx).ok, true);
});

test('verificador: texto vacío o sin contexto', () => {
  const { ctx, texto } = base();
  assert.deepEqual(codigos(R.verificarRespuesta('', ctx)), ['texto_vacio']);
  assert.deepEqual(codigos(R.verificarRespuesta(null, ctx)), ['texto_vacio']);
  assert.deepEqual(codigos(R.verificarRespuesta(texto, null)), ['sin_contexto']);
});

test('verificador: exige el enlace del hackathon, la línea de fuentes y el emoji correcto', () => {
  const { ctx, texto } = base();
  assert.ok(codigos(R.verificarRespuesta(texto.replace(R.ENLACE_HACKATHON, ''), ctx)).includes('falta_enlace_hackathon'));
  assert.ok(codigos(R.verificarRespuesta(texto.replace('Fuentes:', 'Origen:'), ctx)).includes('falta_fuentes'));
  assert.ok(codigos(R.verificarRespuesta(texto.replace('🔴', '🟢'), ctx)).includes('semaforo_incorrecto'));
});

test('verificador: exige la fecha de cada fuente citada', () => {
  const ctx = ctxTienda({ tasa: 6.22, fuentes: { cetes: { fecha: FECHA_CETES } } });
  const texto = R.plantillaDesdeContexto(ctx);
  const v = R.verificarRespuesta(texto.replace(FECHA_CETES, 'hoy'), ctx);
  assert.ok(codigos(v).includes('falta_fecha_fuente'));
});

test('verificador: bloquea palabras acusatorias y recomendaciones de contratar', () => {
  const { ctx, texto } = base();
  for (const frase of [
    'Esto es un fraude.', 'Parece una estafa.', 'Es de los montadeudas.', 'Es ilegal.',
    'No uses esta app.', 'Te recomendamos contratar esta tienda.', 'Te recomiendo aceptar el crédito.',
  ]) {
    const v = R.verificarRespuesta(`${texto}\n${frase}`, ctx);
    assert.ok(codigos(v).includes('palabra_prohibida'), frase);
  }
  // la frase de la leyenda "no es una recomendación de contratar" no cuenta como recomendación
  const verde = ctxTienda({ precio: 1000, abono: 105, n: 10 });
  assert.equal(R.verificarRespuesta(R.plantillaDesdeContexto(verde), verde).ok, true);
});

test('verificador: cada cifra debe venir del cálculo, con tolerancia solo de redondeo', () => {
  const { ctx, texto } = base();
  const inventada = R.verificarRespuesta(texto.replace('$7,497', '$9,999'), ctx);
  assert.ok(codigos(inventada).includes('cifra_no_respaldada'));
  assert.equal(R.verificarRespuesta(texto.replace('93.7%', '94%'), ctx).ok, true);
  assert.ok(codigos(R.verificarRespuesta(texto.replace('$7,497', '$7,500'), ctx)).includes('cifra_no_respaldada'));
  assert.ok(codigos(R.verificarRespuesta(texto.replace('54 semanas', '40 semanas'), ctx)).includes('cifra_no_respaldada'));
});

test('verificador: exige las cifras clave', () => {
  const { ctx, texto } = base();
  const v = R.verificarRespuesta(texto.replace('$7,999', '$149'), ctx);
  assert.ok(codigos(v).includes('falta_cifra_clave'));
});

test('verificador: el CAT lleva siempre el aviso de informativo y sin IVA', () => {
  const { ctx, texto } = base();
  const v = R.verificarRespuesta(texto.replace('informativo, sin IVA; puede diferir del CAT oficial', 'oficial'), ctx);
  assert.ok(codigos(v).includes('falta_aviso_cat'));
});

test('verificador: no permite contradecir el estado de SIPRES', () => {
  const sinVerificar = ctxPrestamo({ sen: senales(CONTACTOS) });
  const t1 = R.plantillaDesdeContexto(sinVerificar);
  assert.ok(codigos(R.verificarRespuesta(`${t1}\nLa empresa no está registrada.`, sinVerificar)).includes('afirma_no_registrada_sin_verificar'));
  const registrada = ctxPrestamo({ sipres: CON_FECHA });
  const t2 = R.plantillaDesdeContexto(registrada);
  assert.ok(codigos(R.verificarRespuesta(`${t2}\nNo la encontramos en el SIPRES.`, registrada)).includes('contradice_estado_sipres'));
});

test('verificador: no permite enlaces inventados ni textos muy largos', () => {
  const { ctx, texto } = base();
  assert.ok(codigos(R.verificarRespuesta(`${texto}\nMás info: https://malo.example/x`, ctx)).includes('enlace_no_permitido'));
  const larga = `${texto}\n${Array(8).fill('línea extra').join('\n')}`;
  assert.ok(codigos(R.verificarRespuesta(larga, ctx)).includes('demasiadas_lineas'));
  assert.ok(codigos(R.verificarRespuesta(texto + 'x'.repeat(4000), ctx)).includes('demasiado_largo'));
  assert.equal(R.verificarRespuesta(larga, ctx, { maxLineas: 20 }).ok, true);
});

// ---------- elección ----------

test('elegirRespuesta: un texto del LLM que cumple se envía tal cual', () => {
  const { ctx, texto } = base();
  const r = R.elegirRespuesta(`  ${texto}  `, ctx);
  assert.equal(r.origen, 'llm');
  assert.equal(r.texto, texto);
  assert.deepEqual(r.fallas, []);
});

test('elegirRespuesta: si el LLM inventa una cifra o acusa, se usa la plantilla y se dicen las fallas', () => {
  const { ctx, texto } = base();
  const r = R.elegirRespuesta(texto.replace('$7,497', '$9,999') + '\nEs un fraude.', ctx);
  assert.equal(r.origen, 'plantilla');
  assert.equal(r.motivo, 'verificacion_fallida');
  assert.equal(r.texto, texto);
  assert.ok(r.fallas.map((f) => f.codigo).includes('cifra_no_respaldada'));
  assert.ok(r.fallas.map((f) => f.codigo).includes('palabra_prohibida'));
});

test('elegirRespuesta: sin texto del LLM o sin contexto, nunca se queda en silencio', () => {
  const { ctx, texto } = base();
  for (const vacio of [undefined, null, '', '   ', 42]) {
    const r = R.elegirRespuesta(vacio, ctx);
    assert.equal(r.origen, 'plantilla');
    assert.equal(r.motivo, 'sin_texto_llm');
    assert.equal(r.texto, texto);
  }
  const sinCtx = R.elegirRespuesta('hola', null);
  assert.equal(sinCtx.origen, 'mensaje_fijo');
  assert.match(sinCtx.texto, /Algo falló de nuestro lado/);
});

// ---------- cobranza y mensajes fijos ----------

test('cobranza: pasos de orientación, sin teléfonos inventados y con enlace', () => {
  const t = R.plantillaCobranza();
  assert.match(t, /retira los permisos/);
  assert.match(t, /guarda la evidencia/);
  assert.match(t, /Condusef y a la Policía Cibernética de tu estado/);
  assert.match(t, /solo orientación, no asesoría legal/);
  assert.ok(!/\d{7,}/.test(t));
  assert.ok(t.endsWith(R.ENLACE_HACKATHON));
  assert.match(R.plantillaCobranza({ canalesCobranza: 'Teléfono: [configurar]' }), /estado\. Teléfono: \[configurar\]/);
});

test('mensajes fijos: bienvenida con aviso de privacidad, aclaración y errores', () => {
  const b = R.mensajes.bienvenida();
  assert.match(b, /No guardo fotos ni datos personales\./);
  assert.ok(b.endsWith(R.ENLACE_HACKATHON));
  const uno = R.mensajes.aclaracion(['¿De cuánto es cada pago (abono)?']);
  assert.match(uno, /^¿De cuánto es cada pago \(abono\)\?/);
  const dos = R.mensajes.aclaracion(['¿Cuántos pagos son?', '¿Cada cuánto se paga?']);
  assert.match(dos, /^Para calcularlo necesito saber:\n• ¿Cuántos pagos son\?\n• ¿Cada cuánto se paga\?/);
  assert.match(R.mensajes.noEntendido(), /Mándame una foto/);
  assert.match(R.mensajes.error(), /intentar de nuevo/);
});

test('ninguna plantilla ni mensaje fijo usa palabras prohibidas', () => {
  const textos = [
    R.plantillaDesdeContexto(ctxTienda()),
    R.plantillaDesdeContexto(ctxPrestamo({ sen: senales(CONTACTOS) })),
    R.plantillaDesdeContexto(ctxPrestamo({ sipres: NO_REGISTRADA, sen: senales(CONTACTOS) })),
    R.plantillaCobranza(),
    R.mensajes.bienvenida(),
    R.mensajes.noEntendido(),
    R.mensajes.error(),
  ];
  for (const t of textos) {
    const n = normalizar(t);
    for (const palabra of ['fraude', 'estafa', 'montadeudas', 'ilegal', 'delincuente', 'no uses']) {
      assert.ok(!n.includes(palabra), `${palabra} en: ${t.slice(0, 40)}`);
    }
  }
});

// ---------- integración ----------

test('integración: extracción -> validador -> cálculo -> semáforo -> contexto -> elección', () => {
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
  const sem = semaforo({ calculo, senales: validado.datos.senales_riesgo, sipres: { estado: 'sin_verificar' } });
  const ctx = R.armarContexto({ calculo, semaforo: sem, fuentes: {} });
  const r = R.elegirRespuesta('Texto del modelo sin fuentes ni enlace.', ctx);
  assert.equal(r.origen, 'plantilla');
  assert.match(r.texto, /Pide acceso a tus contactos/);
  assert.match(r.texto, /\$1,500 de costo/);
  assert.equal(R.verificarRespuesta(r.texto, ctx).ok, true);
});

test('verificador: una cita literal de la evidencia puede traer cifras, una cita inventada no', () => {
  const ctx = ctxPrestamo({
    sipres: NO_REGISTRADA,
    sen: senales({ pide_anticipo: true, texto_evidencia: ['Paga $300 para liberar tu crédito'] }),
  });
  const texto = R.plantillaDesdeContexto(ctx);
  assert.match(texto, /«Paga \$300 para liberar tu crédito»/);
  assert.equal(R.verificarRespuesta(texto, ctx).ok, true);
  const inventada = texto.replace('«Paga $300 para liberar tu crédito»', '«Paga $9,999 ya»');
  assert.ok(codigos(R.verificarRespuesta(inventada, ctx)).includes('cifra_no_respaldada'));
  // fuera de las comillas, el mismo monto de la evidencia no está respaldado por el cálculo
  const suelta = texto + '\nTe piden $300 por adelantado.';
  assert.ok(codigos(R.verificarRespuesta(suelta, ctx)).includes('cifra_no_respaldada'));
});

test('textoDeSalidaLLM: entiende los formatos habituales de un nodo LLM', () => {
  const t = R.textoDeSalidaLLM;
  assert.equal(t('texto directo'), 'texto directo');
  assert.equal(t({ output: 'hola' }), 'hola');
  assert.equal(t({ text: 'hola' }), 'hola');
  assert.equal(t({ response: 'hola' }), 'hola');
  assert.equal(t({ message: { content: 'hola' } }), 'hola');
  assert.equal(t({ choices: [{ message: { content: 'hola' } }] }), 'hola');
  assert.equal(t({ choices: [{ text: 'hola' }] }), 'hola');
  assert.equal(t({ content: [{ type: 'text', text: 'hola' }] }), 'hola');
  assert.equal(t({ content: 'hola' }), 'hola');
  // JSON ya interpretado por el nodo: se vuelve a texto para que lo lea el validador
  assert.deepEqual(JSON.parse(t({ output: { tipo_entrada: 'cobranza' } })), { tipo_entrada: 'cobranza' });
  assert.deepEqual(JSON.parse(t({ tipo_entrada: 'cobranza', confianza_extraccion: 0.9 })), {
    tipo_entrada: 'cobranza',
    confianza_extraccion: 0.9,
  });
  for (const vacio of [null, undefined, 42, {}, [], { output: '' }, { output: '  ' }]) {
    assert.equal(t(vacio), '', String(vacio));
  }
});

test('armarContexto no modifica sus entradas', () => {
  const calculo = calcular({
    tipo_entrada: 'etiqueta_tienda',
    modo_pago: 'periodico',
    producto: { precio_contado: 7999 },
    credito: { enganche: 0, abono: 149, periodicidad: 'semanal', numero_pagos: 104, comisiones: [], seguros: [] },
  });
  const sem = semaforo({ calculo });
  const copia = JSON.parse(JSON.stringify({ calculo, sem }));
  R.armarContexto({ calculo, semaforo: sem, fuentes: {} });
  assert.deepEqual(JSON.parse(JSON.stringify({ calculo, sem })), copia);
});
