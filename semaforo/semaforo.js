'use strict';

/**
 * Semáforo (sección 10 del documento, con las correcciones acordadas).
 *
 * Entrada:  { calculo, senales, sipres } y opciones { umbrales }
 *   calculo  salida de calcular() (estado 'ok')
 *   senales  datos.senales_riesgo que entrega validarExtraccion() (solo préstamo)
 *   sipres   { estado, fecha_consulta, terminos_buscados } o null (solo préstamo)
 *            estado: 'registrada' | 'no_registrada_confirmada' | 'sin_verificar'
 * Salida:   { color, leyenda, razones, resumen, estado_sipres, advertencias }
 *   color    'verde' | 'amarillo' | 'rojo' | 'gris'
 *   razones  [{ codigo, nivel, hecho, evidencia, datos }]: hechos verificables, nunca juicios
 *
 * Reglas de fondo:
 *  - Cualquier razón roja manda y se listan todas.
 *  - 'sin_verificar' por sí solo NUNCA produce rojo: da gris.
 *  - Las señales de texto (anticipo, permisos, presión) solo cuentan con evidencia literal.
 *  - Las señales numéricas (plazo corto) las calculó el validador; el depósito se evalúa aquí
 *    con los montos del cálculo.
 *  - Verde significa "no detectamos riesgos con la información consultada", no "contrátalo".
 *  - La referencia del RIB NO entra en las reglas (decisión: solo contexto).
 *
 * Los umbrales amarillos del préstamo son PROPUESTAS a ajustar con el equipo.
 */

const UMBRALES = {
  tienda: { rojo_desde_pct: 50, amarillo_desde_pct: 15 },
  prestamo: { costo_amarillo_desde_pct: 50, tolerancia_deposito_pesos: 1 },
};

const ESTADOS_SIPRES = ['registrada', 'no_registrada_confirmada', 'sin_verificar'];

const LEYENDAS = {
  verde: 'No detectamos riesgos con la información consultada. Esto no es una recomendación de contratar.',
  amarillo: 'Hay puntos que conviene revisar antes de decidir.',
  rojo: 'Encontramos señales de riesgo. Revisa estos hechos antes de dar tus datos o firmar.',
  gris: 'No pudimos verificar todo con la información disponible.',
};

const ORDEN_NIVEL = { rojo: 0, amarillo: 1, gris: 2, verde: 3, info: 4 };

function pesos(n) {
  const entero = Number.isInteger(n);
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function razon(codigo, nivel, hecho, evidencia = [], datos = {}) {
  return { codigo, nivel, hecho, evidencia, datos };
}

function resultado(color, razones, advertencias, estadoSipres = null) {
  const ordenadas = razones
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDEN_NIVEL[a.r.nivel] - ORDEN_NIVEL[b.r.nivel] || a.i - b.i)
    .map((x) => x.r);
  return {
    color,
    leyenda: LEYENDAS[color],
    razones: ordenadas,
    resumen: {
      rojas: ordenadas.filter((r) => r.nivel === 'rojo').length,
      amarillas: ordenadas.filter((r) => r.nivel === 'amarillo').length,
    },
    estado_sipres: estadoSipres,
    advertencias,
  };
}

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function semaforoTienda(calculo, umbral, advertencias) {
  const m = calculo.metricas || {};
  const pct = m.sobrecosto_pct;
  if (!esNumero(pct) || pct < 0 || !esNumero(m.costo_total) || !esNumero(m.precio_contado)) {
    return resultado(
      'gris',
      [razon('datos_incoherentes', 'gris', 'Los datos de la etiqueta no cuadran; conviene revisarlos.')],
      advertencias
    );
  }
  const nivel = pct >= umbral.rojo_desde_pct ? 'rojo' : pct >= umbral.amarillo_desde_pct ? 'amarillo' : 'verde';
  const hecho =
    `En abonos pagas ${pesos(m.costo_total)} y de contado cuesta ${pesos(m.precio_contado)}: ` +
    `${pesos(m.sobrecosto_pesos)} más (${pct}%).`;
  return resultado(
    nivel,
    [
      razon('sobrecosto', nivel, hecho, [], {
        costo_total: m.costo_total,
        precio_contado: m.precio_contado,
        sobrecosto_pesos: m.sobrecosto_pesos,
        sobrecosto_pct: pct,
        umbral_rojo_pct: umbral.rojo_desde_pct,
        umbral_amarillo_pct: umbral.amarillo_desde_pct,
      }),
    ],
    advertencias
  );
}

function semaforoPrestamo(calculo, senales, sipres, umbral, advertencias) {
  const m = calculo.metricas || {};
  const sig = senales && typeof senales === 'object' ? senales : {};
  const evidencia = Array.isArray(sig.texto_evidencia)
    ? sig.texto_evidencia.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  const conEvidencia = (campo) => {
    if (sig[campo] === true && evidencia.length === 0) {
      advertencias.push(`senal_sin_evidencia:${campo}`);
      return false;
    }
    return sig[campo] === true;
  };

  // SIPRES: tres estados. Todo lo que no sea uno de ellos se trata como sin verificar.
  let estado = 'sin_verificar';
  if (sipres && typeof sipres === 'object') {
    if (ESTADOS_SIPRES.includes(sipres.estado)) estado = sipres.estado;
    else advertencias.push('estado_sipres_invalido');
  }
  const fecha =
    sipres && typeof sipres.fecha_consulta === 'string' && sipres.fecha_consulta.trim()
      ? sipres.fecha_consulta.trim()
      : null;
  if (estado !== 'sin_verificar' && !fecha) advertencias.push('sipres_sin_fecha');
  const terminos =
    sipres && Array.isArray(sipres.terminos_buscados)
      ? sipres.terminos_buscados.filter((t) => typeof t === 'string' && t.trim())
      : [];

  const razones = [];

  if (estado === 'no_registrada_confirmada') {
    razones.push(
      razon(
        'sipres_no_registrada_confirmada',
        'rojo',
        `No la encontramos en el SIPRES de Condusef (búsqueda manual${fecha ? ' del ' + fecha : ''}).`,
        terminos.length ? [`Términos buscados: ${terminos.join(', ')}`] : [],
        { fecha_consulta: fecha }
      )
    );
  } else if (estado === 'registrada') {
    razones.push(
      razon(
        'sipres_registrada',
        'verde',
        `Aparece registrada en el SIPRES de Condusef (consulta${fecha ? ' del ' + fecha : ''}).`,
        [],
        { fecha_consulta: fecha }
      )
    );
  } else {
    razones.push(
      razon('sipres_sin_verificar', 'gris', 'No la tenemos en nuestra base; hay que verificarla en el SIPRES.')
    );
  }

  if (conEvidencia('pide_anticipo')) {
    razones.push(razon('pide_anticipo', 'rojo', 'Pide un pago por adelantado para liberar el crédito.', evidencia));
  }
  if (conEvidencia('pide_permiso_contactos')) {
    razones.push(razon('pide_permiso_contactos', 'rojo', 'Pide acceso a tus contactos.', evidencia));
  }
  if (conEvidencia('pide_permiso_fotos_archivos')) {
    razones.push(razon('pide_permiso_fotos_archivos', 'rojo', 'Pide acceso a tus fotos o archivos.', evidencia));
  }

  const dif = m.diferencia_ofrecido_depositado;
  if (esNumero(dif) && dif > 0) {
    const cargos = esNumero(m.cargos_iniciales_declarados) ? m.cargos_iniciales_declarados : 0;
    if (dif - cargos > umbral.tolerancia_deposito_pesos) {
      razones.push(
        razon(
          'deposito_menor_sin_explicacion',
          'rojo',
          `Ofrece ${pesos(m.monto_ofrecido)} pero deposita ${pesos(m.recibes)}: ${pesos(dif)} menos, ` +
            'y no declara cargos que lo expliquen.',
          [],
          { monto_ofrecido: m.monto_ofrecido, recibes: m.recibes, diferencia: dif, cargos_iniciales: cargos }
        )
      );
    } else {
      razones.push(
        razon(
          'deposito_menor_con_cargos',
          'info',
          `Deposita ${pesos(dif)} menos de lo ofrecido, que corresponde a cargos iniciales declarados (${pesos(cargos)}).`,
          [],
          { diferencia: dif, cargos_iniciales: cargos }
        )
      );
    }
  }

  const pct = m.costo_pct_sobre_recibido;
  if (esNumero(pct) && pct >= umbral.costo_amarillo_desde_pct) {
    razones.push(
      razon(
        'costo_alto',
        'amarillo',
        `Pagarías ${pesos(m.pagas)} por recibir ${pesos(m.recibes)}: ${pesos(m.costo_credito_pesos)} de costo ` +
          `(${pct}% de lo que recibes).`,
        [],
        {
          pagas: m.pagas,
          recibes: m.recibes,
          costo_credito_pesos: m.costo_credito_pesos,
          costo_pct_sobre_recibido: pct,
          cat_texto: calculo.cat ? calculo.cat.texto : null,
          umbral_pct: umbral.costo_amarillo_desde_pct,
        }
      )
    );
  }
  if (sig.plazo_menor_a_15_dias === true) {
    razones.push(razon('plazo_muy_corto', 'amarillo', 'El plazo para pagar es menor a 15 días.'));
  }
  if (conEvidencia('presion_urgencia')) {
    razones.push(razon('presion_urgencia', 'amarillo', 'Usa frases de presión o urgencia.', evidencia));
  }

  let color;
  if (razones.some((r) => r.nivel === 'rojo')) color = 'rojo';
  else if (estado === 'sin_verificar') color = 'gris';
  else color = razones.some((r) => r.nivel === 'amarillo') ? 'amarillo' : 'verde';

  if (color === 'verde') {
    razones.push(razon('sin_senales_de_riesgo', 'verde', 'No se detectaron señales de riesgo en lo que enviaste.'));
  }
  return resultado(color, razones, advertencias, estado);
}

function semaforo(entrada = {}, opciones = {}) {
  const { calculo, senales, sipres } = entrada || {};
  const u = opciones && opciones.umbrales ? opciones.umbrales : {};
  const umbrales = {
    tienda: { ...UMBRALES.tienda, ...(u.tienda || {}) },
    prestamo: { ...UMBRALES.prestamo, ...(u.prestamo || {}) },
  };
  const advertencias = [];

  if (!calculo || calculo.estado !== 'ok' || (calculo.tipo !== 'tienda' && calculo.tipo !== 'prestamo')) {
    return resultado(
      'gris',
      [razon('sin_calculo', 'gris', 'No hay datos suficientes para calcular el costo.')],
      advertencias
    );
  }
  if (calculo.tipo === 'tienda') return semaforoTienda(calculo, umbrales.tienda, advertencias);
  return semaforoPrestamo(calculo, senales, sipres, umbrales.prestamo, advertencias);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { semaforo, UMBRALES, LEYENDAS, ESTADOS_SIPRES };
}

// En n8n (nodo Code, "Run Once for All Items"): pegar este archivo completo y añadir al final
// (los nombres de los nodos anteriores son POR VERIFICAR con tu flujo):
//
//   const validado = $('Validar extracción').first().json;
//   const calculo = $('Calcular').first().json;
//   const sipres = $('Buscar SIPRES').first().json ?? null;
//   return [{ json: semaforo({ calculo, senales: validado.datos.senales_riesgo, sipres }) }];
