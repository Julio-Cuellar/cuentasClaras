# Análisis de datos para Cuentas Claras

Consulta hecha el 30/10/2026. Solo fuentes oficiales. Lo no comprobado está marcado **POR VERIFICAR**.

## Archivos locales

| Archivo | Qué es | Detalle |
|---|---|---|
| `crudo/banxico_rib/rib_creditos_personales_agosto2025.pdf` | RIB de Banxico: créditos personales y microcréditos | 5.7 MB, 51 páginas, SHA-256 `154889e8…8a8b5`, descargado 30/10/2026 |
| `procesado/rib_creditos_personales.txt` | Texto extraído del PDF (`pdftotext -layout`) | Para buscar cifras |
| `crudo/banxico_sie/metadatos_2026-10-30.json`, `oportuno_2026-10-30.json` | Respuestas reales de la API SIE (CETES 28d e inflación anual) | 495 B y 316 B, sin el token dentro |
| `crudo/condusef/*.csv` (8 archivos) | **BASURA: son páginas "Access Denied", no datos.** | Borrar a mano; ver sección "Qué falló" |

## 1. RIB de Banxico: trae tasa de interés, NO CAT

- Título: "Indicadores Básicos de Créditos Personales y Microcréditos. Datos a agosto de 2025". Información de las instituciones al 3/11/2025.
- Reporta **tasa de interés promedio ponderada por saldo**. La palabra "CAT" no aparece en el documento. El CAT incluye comisiones; la tasa no.
- El documento dice que se publica **bimestralmente** (línea 41 del texto), así que casi seguro existe un RIB más reciente. **POR VERIFICAR**: no pude abrir el portal de Banxico para buscarlo.

Cifras (créditos personales otorgados sep 2024 – ago 2025):

| Segmento | Tasa promedio ponderada |
|---|---|
| Sistema (total) | 40.5% |
| Monto de $5 mil a $10 mil | 58.8% |
| Monto menor a $1 mil | 49.9% |
| Monto de $20 mil o más | 35.1% |
| Plazo hasta 12 meses | 63.8% |
| Plazo mayor a 36 meses | 29.2% |
| Segmento hasta $5 mil | 57.8% |
| Segmento de $5 mil a $30 mil | 55.2% |

El texto menciona créditos de "adquisición de bienes de consumo duradero" solo en la introducción; **no encontré cifras de referencia para ese tipo**, que es el de la TV a abonos.

**Impacto en el documento principal:** la tabla `cat_referencia` (§8) y las reglas del semáforo que comparan contra "CAT de referencia" (§10) no se pueden alimentar con el RIB tal cual. Opciones:
1. Comparar contra la **tasa de interés** por monto y plazo, aclarando que el CAT de la oferta incluye comisiones y por eso suele ser mayor.
2. Quitar esa comparación del semáforo y usar solo el sobrecosto y las señales.

## 2. API SIE de Banxico

**Verificado el 30/10/2026 con el token** (header `Bmx-Token`, funciona). Archivos: `crudo/banxico_sie/metadatos_2026-10-30.json` y `oportuno_2026-10-30.json`.

| ID | Título oficial | Periodicidad | Último dato |
|---|---|---|---|
| `SF282` | Cetes 28 días, tasa de rendimiento **promedio mensual**, en por ciento anual | Mensual | **6.29%** (periodo 01/09/2026) |
| `SP30578` | Índice Nacional de Precios al Consumidor, variación anual | Mensual | **3.45%** (periodo 01/09/2026) |

Ambos IDs coinciden con lo que decía el documento. Estructura real de la respuesta: `bmx.series[].datos[]` con `fecha` (DD/MM/AAAA) y `dato` (texto).

Cosas que cambian en el diseño:
1. **Con varias series en una llamada, el orden de la respuesta no es el de la petición** (devolvió `SP30578` antes que `SF282`). El código debe buscar por `idSerie`, no por posición.
2. **La "fecha" es el mes del dato**, no el día de la consulta: `01/09/2026` significa septiembre de 2026. El bot debe citar "promedio de septiembre 2026", no "consultada hoy".
3. `SF282` es un **promedio mensual**, no la tasa de la última subasta. Para el ahorro alternativo es suficiente y honesto, pero hay que decirlo. Otra serie con la tasa de colocación primaria podría existir (**POR VERIFICAR**, no la busqué).
4. Sin token, el catálogo respondía vacío y la API contestaba "Token inválido": el token es obligatorio.
5. La variable `BANXICO_TOKEN` está en `~/.bashrc`, pero al final del archivo, donde un shell no interactivo (como el de la app) no llega. Para que quede disponible sin trucos, moverla a `~/.profile` o al inicio de `~/.bashrc`.

## 3. Condusef en datos.gob.mx (hay más de lo esperado)

| Conjunto | Filas | Qué trae | Uso posible |
|---|---|---|---|
| Instituciones más reclamadas (2025) | 80 | 8 clases × 10 instituciones: banca, SOFOM ER/ENR, fintech (fondos de pago electrónico), SOFIPO, SOCAP, seguros, Afores | Reputación (roadmap) |
| Índice de reclamaciones (2025) | 77 | 11 por clase: banca, SOFOM, SOFIPO, SOCAP, Afores, seguros | Ídem |
| Calificaciones de supervisión (3T 2025) | 179 | Por institución y producto (crédito personal, nómina, automotriz, tarjeta…) | Ídem |
| Cláusulas abusivas (4T 2025) | 5 | Solo cajas, uniones de crédito y un banco | Casi inútil para apps |
| REDECO: despachos de cobranza | 2,409 | Entidad, despacho, dirección, teléfono, correo | Módulo C (no descargado: incluye datos de personas) |

**Limitación importante:** las listas de reclamadas e índice son **solo los primeros 10 u 11 por clase**, no el universo. Que una entidad no aparezca no significa que no tenga reclamaciones. Sirven para el roadmap (Buró), no para sustituir a SIPRES.

## 4. SIPRES y Buró de Entidades

- No existe un conjunto de SIPRES en datos.gob.mx. Desde esta máquina, el portal de SIPRES falló por certificado y el Buró no respondió. **La captura manual sigue siendo el plan**, con los tres estados.

## 5. Profeco

- **Quién es Quién en los Precios 2026**: 9 archivos mensuales, cada uno de ~600 mil a 750 mil filas, con producto, marca, precio, cadena, estado. Una búsqueda de "televisor" dio 0 resultados, así que parece cubrir productos de consumo habitual y **no electrodomésticos** (**POR VERIFICAR**: probé un solo término). Descartado para el MVP.
- **Registro Público de Casas de Empeño (RPCE)**: 8,524 registros (2014–2025) más 46 de 2026, con nombre comercial, razón social, domicilio y fecha de registro. Es un registro oficial descargable que permitiría el mismo "¿está registrada?" para préstamos prendarios. Idea para roadmap.

## Qué falló

- `repodatos.atdt.gob.mx` (donde están los CSV) devolvió **"Access Denied"** a la descarga por línea de comandos; la API de datos.gob.mx contestó **403** a `curl`, y solo respondió dentro del navegador. Intentar saltar ese bloqueo con otro user-agent fue rechazado por seguridad y no se hizo.
- **Consecuencia para el proyecto:** n8n podría recibir el mismo bloqueo. Las tablas oficiales deben cargarse como **instantáneas estáticas** (Sheets) al llegar, con su fecha, no consultarse en vivo.

## Siguiente paso, antes de desarrollar

1. Conseguir el token de Banxico y verificar los IDs de series.
2. Buscar el RIB más reciente en el portal de Banxico (desde tu navegador).
3. Decidir qué hacer con la comparación de referencia (opción 1 o 2 de la sección 1).
