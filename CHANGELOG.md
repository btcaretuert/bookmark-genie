# Changelog

Sigue el orden de más nuevo a más viejo. La extensión y la herramienta de evaluación (`tools/`) comparten `extension/core/` y se versionan por separado: la extensión por `extension/manifest.json`; la evaluación, por hitos y rondas, sin número de versión propio. Las fechas son de 2026.

## Extensión

### 0.5.1

**Agregado**
- Carpetas de cualquier profundidad como destino, ofrecidas al modelo por su ruta («Servicios/Nube/Backups»), hasta 100 carpetas y 100 caracteres por ruta.
- Consentimiento v3: ahora salen las rutas completas, así que hay que marcarlo otra vez en Ajustes.
- Aviso «Quedan fuera N carpetas…» en la confirmación de «Ordenar sueltos» cuando el contexto se recorta.

**Cambiado**
- «Aceptar todas» y «Aceptar las N de X» son **un solo cambio del diario**: un Deshacer los revierte y borra las carpetas que quedaron vacías. Antes, un cambio por grupo desbordaba los 20 cambios que guarda el diario.
- `truncated` cuenta toda carpeta que no se ofrece (tope, ruta larga, nombre con correo o token, repetida).

**Corregido**
- Deshacer un cambio ya deshecho no falla: avisa «Ese cambio ya estaba deshecho.».
- Los primeros grupos de un «Aceptar todas» grande dejaban de poder deshacerse.

### 0.5.0

**Agregado**
- «Ordenar sueltos»: propone carpetas para los marcadores sueltos de una carpeta, en lotes de 50, con confirmación previa de lo que saldrá. Nunca mueve solo, tampoco en modo automático, y corre en el worker.
- Métricas propias de «Ordenar sueltos» (`looseAccepted`, `looseDiscarded`, `looseFiled`), que no cuentan para sugerir el modo automático.
- `autosort-check` en la herramienta de evaluación (ver abajo).

### 0.4.1

**Agregado**
- «Probar la clave»: una llamada mínima con un marcador de prueba fijo; cuenta en el tope diario si pudo facturarse.
- El último resultado se guarda: la franja con «Deshacer» sobrevive a cerrar y reabrir la ventana.
- Motivo de la propuesta `move` (`confirm-mode` o `low-confidence`) y texto de la pregunta según el motivo.
- Carpetas excluidas guardadas también con su ruta: si el id cambia, se busca por ruta y se avisa.

**Cambiado**
- Una propuesta aceptada permanece en «Actividad» con su Deshacer.
- «Ver qué se envió» se escribe solo tras reservar la llamada, y lista lo que efectivamente salió (título limpio y host, nunca la URL).
- La opción «Solo el marcador» pasó a llamarse «Solo el marcador y los nombres de tus carpetas», y el consentimiento lo dice igual.
- Al cambiar de proveedor se devuelve el permiso de host del anterior.

**Corregido**
- El tope diario solo cuenta lo que pudo facturarse: un 429, un 400 o un 401 ya no cuentan.
- El error visible es siempre el texto en español de su categoría; el texto crudo del proveedor queda en un detalle plegable.
- La clave que dejó la 0.3.0 se borra al guardar.
- La línea semanal de métricas cuadra con lo hecho.

### 0.4.0

Resultado de una revisión de la 0.3.0 por doce roles. Ver [D1 a D15](docs/decisiones.md#d1-a-d15).

**Agregado**
- «Confirmar antes de mover», encendido por defecto; el modo automático es un ajuste que la extensión sugiere tras 20 propuestas aceptadas sin cambios y a lo más 1 corregida.
- Errores visibles en ocho categorías, con texto en español y acción; insignia «!» roja hasta abrir la ventana.
- Propuestas editables (nombre, otra carpeta, «Crear solo con este», «Aceptar las N de X»), con tope de 50 y caducidad de 14 días.
- Ajustes en página propia: contexto «completo / solo el marcador», carpetas excluidas, tope de llamadas por día, «Borrar clave».
- Métricas locales por semana, sin títulos.
- Consentimiento v2, que dice exactamente qué sale.
- Aviso de duplicado al guardar: «Ya lo tenías en X», sin llamada.

**Cambiado**
- Diario por cambio, con Deshacer por id y los últimos 20 cambios (se migra solo desde la forma de 0.3.0).
- Solo se ordena lo guardado directamente en una raíz (barra, otros o celular).
- Exclusión mutua de todo lo que escribe en `storage`, con `navigator.locks`.
- Instantáneas solo al respaldar a mano (y, a futuro, antes de una operación masiva), con retención de 3 por clase.
- Contexto de hasta 100 carpetas priorizadas por uso reciente y tamaño; el prompt pide nombres en el idioma de las carpetas existentes.
- Se devuelven los permisos al desactivar; los ajustes se guardan antes de pedir permisos.

**Corregido**
- Se perdían cambios cuando el worker y la ventana escribían a la vez (124 de 200 corridas en la medición).
- Carpetas duplicadas y propuestas que se perdían o se aplicaban a medias.
- Pruebas que dependían de la zona horaria.

### 0.3.0

**Agregado**
- Propuesta de carpetas nuevas cuando ninguna existente encaja (M2.1), tras la prueba real de M2 en que un tema sin carpeta quedó sin mover.

### 0.2.0

**Agregado**
- Orden con Ctrl+D (M2), apagado por defecto: el service worker espera unos 8 s tras guardar y pide al modelo una carpeta existente.
- Ajustes de proveedor, modelo y clave; consentimiento de datos con la política del proveedor.
- Permisos opcionales (`tabs` y el host del proveedor), pedidos solo al activar.
- Tope diario de 50 llamadas y US$0,10 a tarifa de pago.
- Seis proveedores con adaptador `fetch`: OpenAI, Gemini, Mistral, xAI, DeepSeek y Perplexity.

### 0.1.0

**Agregado**
- Primera versión (M1), sin IA: manifest, lectura del árbol de marcadores, respaldo en dos archivos (HTML importable por Chrome y `backup@1.json`), diario, aplicar y deshacer por anclas.
- Mínimo Chrome 134.

## Herramienta de evaluación (`tools/eval.mjs`)

### Ronda de `autosort-check` (con la 0.5.0)

**Agregado**
- `autosort-check`: mide el prompt real de Ctrl+D un marcador a la vez (precisión por tipo de respuesta, calibración, estabilidad, latencia) y emite una recomendación con la regla escrita.

### Rondas de revisión posteriores a M0

Dos revisiones adversariales bloquearon el primer cierre de M0, y se corrigieron sin rediseñar.

**Corregido**
- Cobro ante errores: se cobra lo que pudo facturarse sin respuesta útil (`lost_usd`).
- Escritura de archivos: el directorio de una corrida no puede existir; nada se escribe a través de enlaces simbólicos.
- Muestreo: la clasificación usa una muestra aleatoria simple distinta de la que diseña la taxonomía.
- Guardia `cap_broken_by` para un proveedor que no respeta `max_tokens`.
- `Promise.race`/señales: `SIGINT`, `SIGTERM` y `SIGHUP` detienen con salida 130 y escriben manifiesto y reporte.

### M0

**Agregado**
- Lectura de la exportación HTML de Chrome, saneamiento de URL y título, `--exclude-folder`.
- Muestreo reproducible con semilla; propuesta de taxonomía (o `--taxonomy`); clasificación por lotes con recuperación ante fallos.
- Varios proveedores con `--models proveedor/modelo` sobre un catálogo con precio, fuente y fecha: Anthropic, OpenAI, Gemini, Mistral, xAI, DeepSeek y Perplexity.
- Control de gasto con tope compartido, `--dry-run` sin clave ni red, escritura incremental de cada respuesta pagada.
- Manifiesto auditable y `report.md`; `blind` (juicio ciego) y `score` (intervalo de Wilson, veredicto `PASS`/`GRAY`/`FAIL`).
- `models`, `models --check` y `models --candidates`.

**Resultado:** corrida real con Gemini 3.5 Flash-Lite, 20 de 20 aceptados; ver [Pruebas reales](docs/pruebas-reales.md).
