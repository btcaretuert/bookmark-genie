# Decisiones

Registro para quien retome el proyecto. Cada decisión lleva su razón y el costo de cambiarla. Tiene tres partes: las decisiones de la evaluación (M0), las de la extensión 0.4.0 a 0.5.0 (D1 a D15 y sus ajustes, hasta 0.5.1), y el diseño de M1 en adelante, que se construyó en parte: esa sección dice qué quedó igual, qué cambió y qué sigue pendiente.

Marcas de origen:

| Marca | Significa |
|---|---|
| Sin marca, con enlace | Documentación oficial leída el 2026-11-05 |
| `[código]` | Código de Chromium, rama `main`, leído el 2026-11-05; no la etiqueta de Chrome 156 |
| `[medido]` | Ejecutado durante la auditoría, sobre datos sintéticos y contra un servidor local |
| `[simulado]` | Simulador propio con reglas leídas del código de Chromium; nada corrió en Chrome |
| `[inferencia]` | Deducción sin ejecutar |
| `[de memoria]` | Sin fuente consultada; confírmalo antes de construir sobre esto |

Los códigos como ARQ-5 o SEG-6 son los hallazgos de la auditoría del 2026-11-05.

## Decisiones vigentes en M0

### Contrato de una corrida

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| Cada corrida escribe `manifest.json`, las asignaciones completas y la taxonomía; el CSV lleva `id` (ARQ-1, ARQ-2, ARQ-8) | Las respuestas de un modelo no se reproducen, así que lo escrito es la única evidencia. `[medido]` Con otro prompt, y con los mismos marcadores en otro orden (6 de 30 filas en común), `report.md` salía idéntico salvo la latencia | Agregar campos: nada. Renombrar o quitar: subir la versión de `schema` y ajustar `score` y `blind`. Una corrida pagada sin manifiesto no se puede auditar después: solo repetirla, con otras respuestas |
| `review_sha256` es la huella del **conjunto** de filas: `id` ordenados, sin deduplicar | Ordenar el CSV en una hoja de cálculo no debe invalidar la revisión; una fila borrada o repetida sí | `score` y `blind` dependen de ella. Cambiarla invalida las corridas anteriores |
| `prompts` se calcula sobre la petición armada con datos vacíos | Cubre sistema, plantilla del mensaje, esquema y `maxTokens`; no depende de los marcadores | Cambiar la fórmula hace incomparables las huellas viejas |
| La huella de código imita a `sha256sum` sobre `extension/`, `tools/` y `package-lock.json` | No hay git. Se puede comprobar desde un shell, con el comando que está en `hashCodeTree` | Bajo: otro formato solo impide comparar con corridas anteriores |
| `endpoint`, `key_suffix`, `data_policy`, `effort`, `fallback` y `prompts` van por modelo; `params` guarda lo pedido en la línea de comandos | Con varios proveedores, la raíz no tiene un valor único | Mover un campo es cambio de versión de `schema` |
| `report.md` es una vista para personas, sin contrato | Lo que analiza una corrida lee el manifiesto y los JSONL | Ninguno |
| `score` recalcula desde el CSV, validado contra la corrida (ARQ-8) | El CSV es la única fuente del juicio humano; una copia quedaría obsoleta | Bajo |
| Sin reanudación en M0 | Lo pagado queda en disco por lote; reanudar es de M2 | Bajo: `assignments-*.jsonl` ya tiene lo necesario |

El contrato exacto está en `tools/lib/manifest.mjs`.

### Escritura de archivos

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| El directorio de una corrida no debe existir; los archivos nuevos usan `wx`, lo que se reescribe usa temporal y `rename`, y lo que se agrega usa `O_APPEND` con `O_NOFOLLOW` y modo 600 (ARQ-9, DAT-5) | `[medido]` Repetir sobre el mismo `--out` borraba los juicios y dejaba un reporte con solo la segunda corrida. También cierra el defecto de los permisos heredados de un `--out` existente | Bajo. Volver atrás reabre la pérdida de trabajo humano |
| Ningún archivo se escribe a través de un enlace simbólico en la ruta final | Un enlace plantado desviaría títulos a otro lugar | Bajo |
| Ya no se avisa ni se bloquea por un ancestro que otras cuentas pueden escribir (SEG-4); se retiró el chequeo de ancestros y de dueño | El repositorio puede estar en una carpeta compartida con modo 775: bloquear rompería la ruta por defecto, y avisar no resolvía nada: con escritura en el padre se puede reemplazar `tools/` y `node_modules/`, y ningún chequeo de esta herramienta lo impide | **Riesgo residual aceptado:** para una corrida real, usa una copia del proyecto en un directorio privado de la cuenta, con modo 700, y un `--out` privado. Lo documentan el Quick start y [Qué sale a la nube](arquitectura-alto-nivel.md#qué-sale-a-la-nube) |

### Evaluación y entorno

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| El parser no trata el primer nivel como raíz (DAT-2 rechazado) | `[código]` `bookmark_html_writer.cc:233-244,270-286`: solo la barra lleva `<H3>`; lo de Otros y Celular sube un nivel. Tratar el primer nivel como raíz borraría carpetas reales del usuario | Bajo. Hay un fixture con el formato real |
| El respaldo de modelos (`fallbacks`) queda apagado en la evaluación, tras `--fallback`, y solo existe en Anthropic (SEG-10, IA-6, INT-1) | M0 mide un modelo, y el respaldo mezcla otro. Saca del camino normal una combinación con `output_config` que no se ha probado contra la API | Bajo. Encenderlo por defecto vuelve a contaminar la medición |
| Solo credencial explícita, por proveedor; destino fijo tomado del registro, y redirección solo a loopback (SEG-1, INT-5) | Evita que el SDK resuelva otra credencial o envíe títulos a otro destino sin aviso | Bajo: una opción más si algún día se necesita un proxy |
| `--taxonomy` y la revisión ciega, sí; `--batch-size`, no (IA-3, IA-7, IA-12) | Los dos primeros separan taxonomía de clasificador y quitan sesgo del juicio. El tercero solo lo necesita M3 | Bajo: `makeBatches` ya acepta `maxItems` |
| `planRun` calcula carpetas sobre toda la colección y clasifica una muestra aleatoria simple, separada de la que diseña la taxonomía (IA-1, IA-2, IA-4, IA-5, DAT-1) | `[medido]` La muestra anterior repetía filas ya vistas por el modelo y ponderaba por carpeta, no por marcador | Medio: cambia lo medido y el arreglo dorado del PRNG |
| La semilla reproduce la muestra solo con el **mismo archivo** (ARQ-10: solo documentación) | `[medido]` Agregar un marcador al final deja 94 de 300 y 10 de 100 en común, el nivel de azar. Basta conservar el archivo; `input.sha256` delata el cambio | S: unas 10 líneas para ordenar por hash con semilla. `[medido]` Conserva 299 o más de 300. Solo vale la pena si se quiere comparar entre exportaciones |
| Sin CI (QA-6); `engines` y guarda de versión, sí | No hay remoto | Bajo |
| `npm run typecheck`, sí (FS-4) | Es la única red para los contratos entre módulos sin compilación | Bajo |
| `node-linux-x64` en vez de `node` (SEG-11, FS-5) | Sin script de instalación y con integridad en el lockfile | Otra plataforma exige otro paquete |
| DAT-8 solo se documenta; DAT-11 y FS-10 no se hacen | Sin retorno suficiente | Bajo |

## Proveedores intercambiables

**Decisión:** el modelo se elige como `proveedor/modelo`, y `--models` es obligatorio: el código no privilegia a ningún proveedor. Claude usa su SDK en `extension/platform/llm.js`. Los demás usan `extension/platform/openai-compatible.js`, con `fetch` y sin dependencias, y sus diferencias van en un registro de datos. Un proveedor sin API utilizable queda fuera, con la razón escrita.

**Razón:** fue un requisito del proyecto, y la privacidad es su criterio principal. Antes de gastar se muestra la política de datos del proveedor con su fuente, y queda en `models[].data_policy`. Un proveedor que entrena por defecto exige una opción explícita.

**Regla: nunca un alias móvil, con una excepción.** Lo medido debe ser un modelo exacto. La excepción es DeepSeek, que solo publica alias: entra al catálogo marcado `moving-alias`, la corrida lo advierte, `models --candidates` lo excluye y `score` no baja el veredicto por el id servido. Un alias puede pasar a otro modelo sin aviso, y entonces el resultado de M0 ya no describe lo que corre después. `eval.mjs models --check` compara el catálogo con el listado del proveedor. Si un proveedor solo publica alias, su medición no es reproducible, y la matriz lo indica.

**Costo:**

- La matriz de proveedores caduca: precios, retención y entrenamiento cambian sin aviso. Cada dato lleva fecha y fuente, y hay que releerlo antes de decidir con él.
- Cada adaptador queda **sin probar contra el proveedor real hasta su primera corrida** (solo Gemini 3.5 Flash-Lite se probó). El servidor local solo confirma lo que creemos que dice la documentación.
- `models[].served` registra lo que el proveedor dice que respondió. Una redirección silenciosa no se detecta si no devuelve el modelo real.
- Un resultado no se traslada de proveedor: cada modelo se juzga por separado, con el mismo protocolo.

**Costo de cambiarla:** quitar un proveedor es borrar su entrada. Agregar uno compatible es una entrada más; uno incompatible, un adaptador nuevo. Volver a un solo proveedor no exige migrar datos, porque `requested` ya guarda la referencia completa.

La matriz verificada vive en [Proveedores](proveedores.md). Sus cifras no se copian aquí, para que no caduquen en dos lugares.

**Efecto en la extensión:**

- Cada proveedor tiene su clave y su origen. Su host se pide con `optional_host_permissions` al elegirlo ([permisos](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)), no todos al instalar.
- La CSP y el manifest son estáticos, así que `connect-src` y `optional_host_permissions` deben listar los orígenes del registro. Una prueba debe compararlos.
- Las huellas de checkpoint incluyen la referencia completa. Solo Claude necesita `vendor/`.
- Con el permiso de host, lo que puede fallar es que el servidor rechace el `Origin`. La matriz indica quién lo documenta; el resto hay que comprobarlo en la primera llamada desde la extensión.

## Decisiones de la extensión (0.4.0 a 0.5.1)

Doce revisores miraron la versión 0.3.0 (producto, usuario, UX, funcional, seguridad, IA, ingeniería y arquitectura de datos, full stack, multi-proveedor, QA e integración). De sus hallazgos salieron 15 decisiones, D1 a D15, que rigen el código de 0.4.0. Las versiones 0.4.1 y 0.5.0 las ajustan, y abajo se dice cómo. Los informes de revisión no están en el repositorio.

### Los hitos, reordenados el 2026-11-05

Con la corrida real de M0 (Gemini 3.5 Flash-Lite, plan gratuito, 20 de 20 aceptados sobre una colección de 62 marcadores, 29 enviables) se dio M0 por suficiente. Con una colección así, el orden masivo aporta poco, así que el plan se reordenó:

| Hito | Entrega | Estado |
|---|---|---|
| M0 | Herramienta de evaluación | Hecho |
| M1 | Manifest, árbol, respaldo, diario, aplicar y deshacer, sin IA | Hecho |
| M2 | Orden con Ctrl+D, apagado por defecto, con ajustes de proveedor, modelo y clave. Después propone carpetas nuevas (M2.1) | Hecho |
| Mejoras 0.4.0, 0.4.1, 0.5.0 y 0.5.1 | D1 a D15, el último resultado, «Probar la clave», «Ordenar sueltos» y la medición `autosort-check` | Hecho |
| M3 | Búsqueda difusa, abrir en bloque, renombrar, mover y borrar | Pendiente |
| M4 | Orden masivo con reanudación, solo si la colección crece. «Ordenar sueltos» es una versión reducida, sin reanudación ni vista previa del árbol | Pendiente. Su versión reducida, «Ordenar sueltos», está hecha (0.5.0) |
| M5 | Duplicados, enlaces muertos y cuarentena | Pendiente |
| M6 | Etiquetas y enriquecimiento opcional | Pendiente |

### D1 a D15

| # | Decisión | Motivo | Costo de cambiarla |
|---|---|---|---|
| D1 | **«Confirmar antes de mover», encendido por defecto.** Con él, un `existing high` también es una propuesta, con un solo botón «Mover». El modo automático queda como ajuste. La extensión sugiere activarlo con al menos 20 propuestas aceptadas sin cambios y como máximo 1 corregida (totales de todas las semanas, sin contar «Ordenar sueltos») | La medición IA-12 no se había hecho y M2.1 cambió el prompt. Lo pidieron producto, IA y QA | Bajo: es el ajuste `confirmBeforeMove` y la constante `SUGGEST_AUTOMATIC` |
| D2 | **Solo se ordena lo guardado directamente en una raíz** (barra, otros o celular). Lo guardado en una subcarpeta o en un grupo de Ctrl+Shift+D queda como `left: saved-in-folder`, sin llamada | Respeta la carpeta que la persona eligió. Un revisor funcional lo reprodujo | Bajo. «Reintentar» sí envía desde una subcarpeta, porque es un pedido explícito |
| D3 | **URL ya guardada:** sin llamada. Registra «Ya lo tenías en X» con la acción «Quitar el duplicado nuevo» | Un revisor de usuario lo pidió: clasificar un duplicado gasta una llamada para nada. La comparación es por URL exacta | Bajo. Duplicados por forma canónica son de M5 |
| D4 | **Exclusión mutua** de todo lo que escribe en `storage`, con `navigator.locks` compartido entre el worker y las páginas. Candados: `journal`, `settings`, `proposals`, `usage`, `log` y `metrics` | `[medido]` Se perdieron cambios en 124 de 200 corridas con dos escritores. Con el candado, 25 corridas completas sin pérdida | Medio. Que Web Locks se comparta entre el worker y las páginas de una extensión no se verificó en Chrome con ventana |
| D5 | **Diario por cambio**, no reescrito por movimiento: intención antes de mover y cierre después. Deshacer por id de cambio, con lista de los últimos 20. Un cambio vacío o ya deshecho no tapa a otro | El diario de 0.3.0 era un arreglo reescrito completo tras cada movimiento (costo cuadrático medido), y un cambio vacío tapaba al real (funcional H2) | Alto una vez que hay diarios guardados: se migra solo desde la forma de 0.3.0 |
| D6 | **Instantáneas** solo al respaldar a mano (`manual`) y antes de una operación masiva (`bulk`), con retención de 3 por clase | Se tomaban en cada Ctrl+D y nadie las leía. Hoy ninguna operación pide `bulk`: queda para M4 | Bajo |
| D7 | **Propuestas sin duplicados ni pérdidas.** Al proponer, dos `create` con el mismo nombre (por `folderKey`) en el mismo padre se fusionan. Al aplicar, se reutiliza una carpeta hermana con la misma clave. La propuesta se quita solo si se aplicó o quedó obsoleta, y si falla tras crear la carpeta, esta se borra. Tope de 50, caducidad de 14 días; las que caen o caducan quedan registradas | Revisores de usuario, IA y funcional (H5 a H8): carpetas duplicadas y propuestas que se perdían o se aplicaban a medias | Bajo |
| D8 | **Errores visibles.** Ocho categorías (`key`, `quota`, `server`, `timeout`, `model`, `permission`, `no-key`, `daily-cap`), cada una con texto en español y su acción. Un 429 no se reintenta. La insignia muestra «!» roja hasta abrir la ventana; el número de pendientes va en azul | Los errores no se veían, y un 429 de cuota no se arregla reintentando de inmediato | Bajo. Un 4xx que no es de clave, modelo ni cuota queda como `server` |
| D9 | **Consentimiento (v2 en 0.4.0, v3 desde 0.5.1):** el texto dice exactamente qué sale (marcador, nombres de carpeta, hasta 5 títulos por carpeta, hasta 30 sueltos) y se pide de nuevo. Ajustes nuevos: «Contexto: completo / solo el marcador» y **carpetas excluidas**, que nunca se envían, ni como ejemplo ni como suelto | M2.1 envía mucho más que M2, y el consentimiento v1 solo cubría el marcador | Bajo. Un consentimiento v1 ya no cubre y se pide otra vez |
| D10 | **Contexto mejor elegido.** Hasta 100 carpetas, priorizadas por uso reciente y tamaño en vez del orden del árbol; si se recorta queda registrado («Se enviaron N de M carpetas»). Los ejemplos son los más recientes. El prompt pide nombres en el idioma de las carpetas existentes | Con más de 100 carpetas, el orden del árbol podía dejar fuera las más usadas | Bajo |
| D11 | **Ventana reorganizada:** línea de estado; franja del último resultado con su Deshacer; propuestas; actividad reciente con Deshacer o «Elegir carpeta» por fila; recordatorio de respaldo. Los ajustes van en una página propia, y se guardan **antes** de pedir permisos | Un popup se cierra al perder el foco, y el diálogo de permisos de Chrome hace justo eso: lo escrito se perdía | Bajo |
| D12 | **Propuestas editables:** nombre de carpeta editable, otra carpeta existente en un selector, «Crear solo con este», host visible y «Aceptar las N de X» | UX y usuario: aceptar o descartar a ciegas no bastaba | Bajo |
| D13 | **Métricas locales, sin títulos:** movidos, aceptados, descartados, deshechos, corregidos y caducados, por semana (12 semanas), más los sueltos en la barra | Producto: sin ellas no hay cómo decidir pasar a automático | Bajo |
| D14 | Borrar la clave; devolver los permisos al desactivar; `onInstalled` abre los ajustes; accesibilidad (`role=status`, foco, contraste); números y plurales en es-419; sin desplazamiento horizontal; `gemini-2.5-flash-lite` marcado «no disponible para cuentas nuevas» | UX, seguridad, multi-proveedor y usuario | Bajo |
| D15 | **Pruebas:** saneamiento del contexto (sobrevivían 4 de 5 mutaciones), zona horaria (3 pruebas dependían de UTC) y lógica de interfaz extraída a funciones puras (`ui/present.js`, `ui/save-flow.js`) | Seguridad P1 y QA P1 | Ninguno |

### Ajustes de 0.4.1

Salieron de una segunda revisión de la interfaz y del flujo:

- **El último resultado se guarda** (`autosortLastResult`): la franja con «Deshacer» sobrevive a cerrar y reabrir la ventana, y el botón aparece solo mientras el cambio siga siendo deshacible.
- **Una propuesta aceptada no desaparece de la actividad:** su fila pasa de `proposed` a `moved`, con `changeId` y «Deshacer». Una descartada pasa a `left: discarded`.
- **`reason` en la propuesta `move`:** `confirm-mode` (la IA estaba segura y el modo pide confirmar) o `low-confidence`. La pregunta de la tarjeta cambia.
- **El tope diario solo cuenta lo que pudo facturarse:** el uso se reserva antes de enviar y se devuelve si hubo un 429, un 4xx o un fallo antes de enviar. Cuentan el éxito, el tiempo agotado y el corte tras enviar.
- **«Ver qué se envió» se escribe solo tras reservar la llamada**, con el marcador, las carpetas con sus ejemplos y los sueltos (título limpio y host, nunca la URL).
- **`messageEs` es siempre el texto en español.** El texto crudo del proveedor queda en `detail`, plegable.
- **Carpetas excluidas con ruta:** si el id cambia (una reimportación), se busca la carpeta por su ruta, y la ventana avisa si cambió o desapareció.
- **«Probar la clave»:** una llamada mínima con un marcador de prueba fijo, sin datos propios. Cuenta en el tope si pudo facturarse.

### Ajustes de 0.5.1

Salieron de correr contra exportaciones reales de tamaño mayor:

- **«Aceptar todas» y «Aceptar las N de X» son un solo cambio del diario.** Preparan cada grupo, crean sus carpetas y hacen un único `applyPlan`. Un Deshacer lo revierte entero y borra las carpetas que quedaron vacías. *Razón:* un cambio por grupo desbordaba los 20 cambios que guarda el diario, y los primeros dejaban de poder deshacerse. Si falla, se borran las carpetas recién creadas y las propuestas quedan.
- **Deshacer un cambio ya deshecho no falla:** avisa «Ese cambio ya estaba deshecho.».
- **Carpetas de cualquier profundidad.** Se ofrecen al modelo por su ruta («Servicios/Nube/Backups»), hasta 100 carpetas y 100 caracteres por ruta (antes, 2 niveles y 60). `truncated` cuenta toda carpeta que no se ofrece (por el tope, una ruta larga, un nombre con correo o token, o un repetido), y la actividad y la confirmación de «Ordenar sueltos» avisan.
- **Consentimiento v3**, porque ahora salen las rutas completas. El v2 ya no cubre: hay que marcarlo otra vez en Ajustes.

### Decisiones de 0.5.0

- **«Ordenar sueltos» nunca corre solo y nunca mueve.** Es un botón; muestra antes qué saldrá, a quién y qué se omite; y todo resultado es una propuesta, también en modo automático. *Razón:* es la única acción que envía muchos marcadores de una vez, y la persona debe poder verla antes.
- **No tiene prompt nuevo.** Usa `proposeTaxonomy` y `classifyBatch` de M0, en lotes de 50. *Razón:* esos prompts dieron 20 de 20 en la corrida real de M0; uno nuevo exigiría medir otra vez.
- **Corre en el worker.** La página manda un mensaje y espera la respuesta, así que cerrar la ventana no la corta.
- **Sus métricas van aparte** (`looseAccepted`, `looseDiscarded`, `looseFiled`) y no cuentan para sugerir el modo automático de Ctrl+D, porque aceptar un lote revisado a ojo no dice nada sobre Ctrl+D.
- **Medición IA-12 con `autosort-check`**, en `tools/`. Mide el prompt real de la extensión, un marcador a la vez, con el mismo armado de contexto. Sustituye al `--batch-size` que el diseño original proponía: aquello medía lotes, y Ctrl+D clasifica de a uno. Su límite está en el [Quick start](quick-start.md#medir-el-prompt-con-autosort-check).

## Diseño de M1 en adelante

Es el diseño escrito antes de construir M1. La extensión 0.5.1 ya implementa parte; lo que cambió o falta está en esta tabla, y las subsecciones de abajo conservan el razonamiento original con una nota donde ya no rige.

| Decisión del diseño | Estado en 0.5.1 |
|---|---|
| Tres identidades (`id`, `[fingerprint, item_key]`, URL exacta) | `id` de Chrome: en uso. URL exacta: en uso para detectar un duplicado al guardar (D3). `checkpoints` y `tags`: no existen |
| `expect` de título y URL en cada operación | **No se construyó.** `checkMove` comprueba que el nodo siga en su carpeta de origen, que el destino sea una carpeta y que ambos tengan el mismo `syncing` |
| Deshacer con anclas | Construido (`invertJournal`, `undoChange`), lineal. Probado contra el falso de Chrome y en Chrome 156 headless |
| Aplicar con `intent`, `move`, `done` | Construido, con otra forma: intención antes de mover, tramos de 200 movimientos y cierre (D5). `recoverInterrupted` concilia con el árbol real |
| Respaldo en dos archivos | Construido: HTML para Chrome y `backup@1.json`. El JSON lleva solo el árbol: no hay etiquetas, taxonomía ni ajustes que guardar. **No hay restauración propia** |
| Esquema de IndexedDB | **No se construyó.** Todo vive en `chrome.storage.local` con `unlimitedStorage` ([Estructura de datos](estructura-de-datos.md#almacenamiento-de-la-extensión)). IndexedDB queda para las etiquetas de M6 y los checkpoints de M4 |
| Raíces por `(folderType, syncing)` | Construido. Una carpeta nueva se crea en el padre del marcador, o en la carpeta que se ordena |
| Clave en `storage.local` con `TRUSTED_CONTEXTS`; `tabs` y hosts opcionales | Construido. Son 6 hosts: **Anthropic no está en la extensión** (aparece como «próximamente») |
| CSP más estricta | **No se construyó:** el manifest no declara `content_security_policy`. Una prueba verifica que no hay scripts de contenido ni recursos accesibles desde la web, y que ninguna página escribe HTML desde cadenas |
| Tope diario en la extensión | Construido: 50 llamadas (editable) y US$0,10 a tarifa de pago (fijo) |
| `timeoutMs` de 20 s en el worker | Construido (`DEADLINE_MS`). No hace falta `allowBrowser` mientras Anthropic no esté |
| Ctrl+D apagado por defecto | Construido |
| Medir IA-12 antes de construir Ctrl+D | No se hizo antes. Se hizo después, de otra forma: `autosort-check` |
| Checkpoints y carpetas por número (orden masivo) | Pendiente, M4 |
| Verificador de enlaces, cuarentena | Pendiente, M5 |
| Etiquetas en IndexedDB | Pendiente, M6 |
| Vendor del SDK de Claude | No construido: sin adaptador de Anthropic en la extensión |

### Identidades

**Decisión:** tres identidades separadas, en lugar del único hash del plan.

| Función | Identidad | Dónde |
|---|---|---|
| Aplicar y deshacer | `id` de Chrome más `expect` | `journal` |
| No volver a cobrar | `[fingerprint, item_key]` | `checkpoints` |
| Duplicados y etiquetas | URL exacta, con `canon_key` derivado | `tags`, `core/dedupe.js` |
| Trazar una fila de M0 | `b{n}` más `input.sha256` | CSV y manifiesto |

**Razón:** no hay un identificador que sirva para todo. `chrome.bookmarks` solo expone `id`, sin `guid` ni `uuid`: «IDs are unique within the current profile, and they remain valid even after the browser is restarted» ([API bookmarks](https://developer.chrome.com/docs/extensions/reference/api/bookmarks)).

**Costo de cambiarla:** `checkpoints`, casi nada, porque se descarta. `tags`, alto: es dato del usuario sin otra copia.

| Si el marcador... | `b{n}` | `id` | `item_key` | URL exacta |
|---|---|---|---|---|
| Cambia de título | Igual | Igual | Cambia: se reclasifica | Igual |
| Cambia solo el query de la URL | Igual | Igual | Igual: no se cobra | Cambia |
| Cambia la ruta de la URL | Igual | Igual | Cambia | Cambia |
| Se mueve de carpeta | Cambia al reexportar | Igual | Igual | Igual |
| Otro marcador se inserta antes | Cambia al reexportar | Igual | Igual | Igual |
| Se borra y se vuelve a crear | Cambia al reexportar | Nuevo | Igual | Igual |
| Se reimporta o restaura | Cambia | Nuevo | Igual | Igual |
| Se cierra y se reabre la sesión de la cuenta | No aplica | Nuevo `[inferencia]` | Igual | Igual |
| Se ve en otro dispositivo | No aplica | Distinto `[inferencia]` | Igual | Igual |

Hechos del código `[código]`:

- `bookmark_codec.cc:152,167,288` y `bookmark_model.cc:1290,1651`: el siguiente ID sale del mayor ID presente al cargar. `[inferencia]` Borrar el nodo de mayor ID y reiniciar permite reutilizar ese ID.
- `bookmark_codec.cc:447-461`: se reasignan ID al cargar si son inválidos.
- `bookmark_model.cc:1491,1654-1693`: las raíces de cuenta se pueden eliminar y recrear con ID nuevos.
- `bookmark_model.cc:610-622`: un `move` entre local y cuenta conserva el nodo y su ID.

### Aplicar: `expect` en cada operación

> **No se construyó.** Hoy se comprueban la carpeta de origen y `syncing`, no el título ni la URL. Si la persona edita un título entre la propuesta y la aplicación, se mueve igual el marcador editado. Sigue siendo una decisión abierta.

**Decisión:** cada operación lleva `expect: {parent_id, url, title, syncing}`, y además `target.syncing === node.syncing`. Si algo no coincide, se omite y se reporta. El plan solo comprobaba que el nodo existiera y siguiera en su carpeta.

**Razón:**

- Si la persona edita el título o la URL entre la vista previa y la aplicación, se aplicaría una clasificación calculada para otro contenido.
- Un ID reutilizado apuntaría a otro marcador.
- `syncing` «may change for an existing node» (misma página). Cruzar local y cuenta tiene un riesgo documentado: `bookmark_model.cc:624-629`, «leading to data loss or data duplication» `[código]`.

**Costo de cambiarla:** bajo mientras el diario sea joven; agregarlo después deja sin esa protección los planes ya guardados.

### Deshacer con anclas

**Decisión:** `invert` coloca cada nodo después de su antecesor vivo más cercano según el orden del snapshot. El índice queda solo como dato informativo. Si el nodo ya no está en el destino, se omite y se reporta: gana el cambio de la persona.

**Razón:** `index` es «The 0-based position of this node within its parent folder», y cualquier cambio entre hermanos lo invalida. La API rechaza un índice mayor que la cantidad de hijos (`bookmarks_api.cc:736-748`) y lo ajusta dentro de un mismo padre (`bookmark_model.cc:585-593`) `[código]`.

`[simulado]` 2.000 intentos por celda, 8 carpetas origen de 12 marcadores, cerca de la mitad movidos. Cada celda es «% con el orden relativo intacto / % con algún `move` fallido»:

| Entre aplicar y deshacer | Índice previo a cada `move`, inverso LIFO | Igual, con índice acotado | Con anclas |
|---|---|---|---|
| Nada | 100 / 0 | 100 / 0 | 100 / 0 |
| Agregan 1 en una carpeta origen | 28,9 / 0 | 29,4 / 0 | **100 / 0** |
| Borran 3 de una carpeta origen | 32,1 / 87,7 | 4,2 / 0 | **100 / 0** |
| Vacían una carpeta origen | 100 / 99,8 (casi nada vuelve) | 1,4 / 0 | **100 / 0** |
| Otro dispositivo reordena 1 hermano | 29,8 / 0 | 30,9 / 0 | 29,4 / 0 |

Si «índice original» se toma del snapshot y se deshace en LIFO, falla el 100 % de las veces **sin ninguna interferencia**. Con anclas, un reorden de otro dispositivo no mejora: es un cambio real, y solo se revierte pisándolo. Queda como decisión de producto.

```js
for (const op of [...journal].reverse()) {
  if (op.kind === 'create_folder') { removeIfEmpty(op.created_id); continue; }
  const node = await get(op.node_id);
  if (!node || node.parentId !== op.to.parent_id || node.url !== op.expect.url) { skip(op); continue; }
  if (!(await exists(op.from.parent_id))) { skip(op); continue; }
  const order = snapshot.children[op.from.parent_id];
  const live = (await getChildren(op.from.parent_id)).map((child) => child.id);
  let index = 0;
  for (let k = order.indexOf(node.id) - 1; k >= 0; k -= 1) {
    const at = live.indexOf(order[k]);
    if (at !== -1) { index = at + 1; break; }
  }
  await move(node.id, { parentId: op.from.parent_id, index });
}
```

`remove()` borra «a bookmark or an empty bookmark folder», así que una carpeta con marcadores ajenos queda en su lugar. Un plan no debe generar movimientos dentro de la misma carpeta: ahí el índice significa otra cosa.

**El criterio de M1 no basta.** «Aplicar y deshacer deja el árbol idéntico» se cumple sin interferencia con casi cualquier estrategia. Las pruebas de `plan.js` deben incluir como propiedad: tras agregar o borrar en el origen, los sobrevivientes conservan su orden relativo. Para el doble de pruebas bastan tres reglas: un índice mayor que los hijos falla; sin índice, va al final; en el mismo padre, `index` igual al actual o al siguiente no hace nada, y uno mayor se reduce en 1.

**Costo de cambiarla:** no es migración, es daño. Un orden alterado que sync propaga no se repara cuando el snapshot rota.

### Respaldo en dos archivos

> **Construido sin la restauración propia.** El botón «Respaldar ahora» descarga los dos archivos, y el JSON lleva solo el árbol y `syncing`. No existe `tree_epoch` ni un botón de restaurar.

**Decisión:** cada snapshot descarga dos archivos.

1. El HTML para Chrome, con un `<H3>` por raíz, que `backup.js` controla al escribir.
2. `backup@1.json`, con snapshot, etiquetas, taxonomía y ajustes, sin claves.

La restauración propia resuelve raíces por `(folderType, syncing)`, sube `tree_epoch` y marca los planes anteriores como no deshacibles.

**Razón:** el formato de Chrome no sirve para reconstruir. `[código]` `bookmark_html_writer.cc:233-244,270-286` deja Otros y Celular indistinguibles y funde local y cuenta; solo escribe `HREF`, `ADD_DATE` e `ICON` por marcador. Al desinstalar se pierden etiquetas, ediciones de taxonomía y diario: `chrome.storage` «cleared when the extension is removed» ([API storage](https://developer.chrome.com/docs/extensions/reference/api/storage)); IndexedDB corre la misma suerte `[de memoria]`.

**Forma normal.** «Idéntico» se compara sobre `(id, parentId, index, title, url, dateAdded)`: `bookmark_model.cc:599` actualiza `dateGroupModified` en cada `move` `[código]`, así que comparar `getTree()` completo nunca da igual. «Coincide» tras reimportar compara `[segments[], title, url]` por raíz, porque los ID son nuevos. No uses rutas unidas con `/`: `Dev > CI/CD` y `Dev > CI > CD` colisionan.

**Costo de cambiarla:** los respaldos ya hechos no recuperan raíces, etiquetas ni taxonomía.

### Esquema de IndexedDB

> **No se construyó así.** La extensión 0.5.1 guarda todo en `chrome.storage.local`. Este esquema sigue siendo la referencia para las etiquetas (M6) y los checkpoints (M4).

**Decisión:** base `bookmark_genie`, versión 1, sin comprimir. La versión de esquema es la de `indexedDB.open`; cada registro lleva `v: 1`.

| Almacén | Clave | Índices | Contenido | Si se pierde |
|---|---|---|---|---|
| `meta` | `key` | | `canon_version`, `tree_epoch`, `profile_label`, `quarantine_by_root`, gasto diario | Se reconstruye en parte |
| `snapshots` | `id` | `created_at` | `{created_at, reason, node_count, tree_sig, roots: [{id, folderType, syncing}], nodes: [...]}`. Un registro por snapshot, de escritura atómica | Queda el archivo descargado |
| `taxonomies` | `hash` | `created_at` | `{folders: [{fk, name, parent_fk, description, bindings: {<rootId>: <nodeId>}}]}` | Se vuelve a generar y se pierden ediciones |
| `runs` | `id` | `status`, `updated_at` | `{status, scope: {root_ids, protected_ids, new_folder_root}, snapshot_id, taxonomy_hash, model, prompt_hash, fingerprint, spent_usd, resume_at}` | Desechable |
| `checkpoints` | `[fingerprint, item_key]` | | `{outcome, fk, confidence, served_model, at}` | Desechable, cuesta centavos |
| `plans` | `id` | `status` | `{kind: bulk, auto, quarantine o restore; run_id, snapshot_id, status, op_count, counts, tree_epoch}` | Se pierde deshacer; queda el snapshot |
| `journal` | `[plan_id, seq]` | `node_id` | `{kind: move o create_folder, node_id, temp_ref, expect, from: {parent_id, index, prev_id}, to: {parent_id, parent_ref}, state, reason, created_id, at}` | Se pierde deshacer; queda el snapshot |
| `tags` | `url` | `canon_key`, `tags` (`multiEntry`) | `{tags, canon_key, canon_version, updated_at}` | **Irrecuperable sin `backup@1.json`** |

`chrome.storage.local` guarda solo las claves y `settings: {v, model, profile_label}`.

**Razón del tamaño:** `[medido]` con datos sintéticos, un snapshot de 10.000 nodos ocupa 2,6 MB en JSON, una operación de diario 340 bytes y un checkpoint 171 bytes. `unlimitedStorage` «exempts extensions from both quota restrictions and eviction» ([almacenamiento de extensiones](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). El crecimiento no es un riesgo. La retención es solo orden: 10 snapshots más los referidos por planes deshacibles, 20 planes y 3 `fingerprint`.

**Atomicidad.** Una transacción de IndexedDB no puede abarcar `chrome.bookmarks`, porque se cierra al esperar una promesa ajena `[de memoria]`:

1. Transacción con `state: intent`.
2. `await move`, fuera de toda transacción.
3. Transacción con `state: done`. Se puede agrupar en bloques de 50.

**Recuperación al abrir.** Para cada plan en `applying` y cada operación en `intent`, se lee el nodo: en destino, `done`; en origen, vuelve a `planned`; en otro lugar, `skipped` con motivo. Una carpeta creada sin `created_id` registrado se busca por `(parent, title, dateAdded >= at)`; en el peor caso queda una carpeta vacía. El paso de `confirmed` a `applying` va dentro de una transacción, y una Web Lock evita que dos pestañas apliquen a la vez `[de memoria]`.

**Versionado.** `checkpoints` y `runs` se descartan en un cambio incompatible. `plans` y `journal`, si no se pueden migrar, quedan como no deshacibles, conservando el snapshot. `tags` siempre se migra.

**Costo de cambiarla:** medio. Solo `tags` exige una migración cuidadosa; el resto se regenera o se pierde sin daño para los marcadores.

### Raíces

**Decisión:** las raíces se leen al usar, por `(folderType, syncing)`. Nunca se guardan como las constantes `'1'` o `'2'`, y se conservan en `snapshots.roots` solo para restaurar.

**Razón:** «There may be zero, one or multiple nodes of each folder type», y `syncing` puede cambiar en un nodo existente ([API bookmarks](https://developer.chrome.com/docs/extensions/reference/api/bookmarks)).

- **Gestionadas:** fuera del plan. La exportación de Chrome no las incluye: `bookmark_html_writer.cc:170-179` solo codifica barra, otros y celular `[código]`.
- **Marcadores sin carpeta:** su `parent_id` es una raíz. Las carpetas nuevas se crean en `scope.new_folder_root`, siempre con el mismo `syncing`. El plan no lo fijaba.

**Costo de cambiarla:** bajo mientras no haya datos guardados con ID de raíz.

### Checkpoints (orden masivo, hoy M4)

**Decisión:** `fingerprint = sha256({model, prompt_hash, effort, taxonomy_hash})`, con `model` como `proveedor/modelo`, e `item_key = sha256` de lo que **realmente se envía**. Se guardan también `refused`, `truncated` y `missing`. La carpeta se guarda como clave estable `fk`, no como número `f` ni como nombre. El plan usaba `hash(id, título, url, versión de taxonomía)`.

**Razón:** `[medido]`

- Sin modelo ni prompt, cambiar de modelo acierta en caché, y la vista previa muestra respuestas del modelo anterior como si fueran nuevas. Esto es lo grave; el sobrecobro son centavos.
- Con clave por lote, insertar un marcador al inicio da 0 de 41 aciertos; por marcador, 2.000 de 2.001.
- `id` y el título o la URL originales sobran: el mismo contenido enviado se cobraría de nuevo.
- Un título rechazado en un lote de 50 cuesta 13 llamadas; sin guardar el resultado negativo, se reenvía en cada reanudación.

«No aplicar obsoletos» no es tarea de esta clave, sino de `expect`. `classifyBatch` ya avisa con `onResolved` tras cada respuesta, y por ahí se guarda lo pagado dentro de un lote.

**Costo de cambiarla:** casi nada: la caché se puede descartar.

### Carpetas (orden masivo, hoy M4)

**Decisión:** las carpetas existentes se refieren por número: se envían como `[{e, path: ["Dev","CI/CD"]}]`, y el modelo responde `{name, parent, existing, description}`. Internamente la ruta son segmentos, y `/` queda solo para mostrar. `maxFolders` cuenta las carpetas reales. M0 ya tiene unicidad por segmento con NFC y solo rutas elegibles (ARQ-3, ARQ-4).

**Razón:** `[medido]` `Dev > CI/CD` y `Dev > CI > CD` dan la misma ruta; `TCP/IP` se materializaría como padre e hijo; `Trabajo` en dos raíces no dice cuál reutilizar; 30 entradas pueden crear 60 carpetas. Chrome admite carpetas homónimas, así que nada falla: quedan duplicados que sync propaga.

**Por qué no en M0:** cambia prompt y esquema sin que M0 lo necesite.

**Costo de cambiarla:** volver a medir en M2, que cuesta menos que complicar la primera medición.

### Etiquetas (M6)

**Decisión:** en IndexedDB, por **URL exacta**, con `canon_key` y `canon_version` como datos derivados. Al subir `canon_version` se recalcula en una transacción. Van en `backup@1.json`. El plan las ponía en `storage.local`, por URL canónica.

**Razón:** son el único dato irrecuperable. La canonización pierde información, así que con la forma canónica como clave, cambiar una regla deja registros huérfanos o fusiona páginas, y migrar es imposible. `storage.local` no ofrece índice por etiqueta y su página no dice nada sobre atomicidad entre claves; sin `unlimitedStorage` tiene un límite de 10 MB. Editar la URL también deja huérfanas las etiquetas: `onChanged` entrega `title` y `url`, y la documentación no menciona el valor anterior.

**Costo de cambiarla:** alto una vez que haya etiquetas. Puede esperar a M6, porque hasta entonces nada persiste esa clave.

Si M6 agrega meta description, hay que limitar su largo y limpiarla como un título: es texto de terceros más largo que sale al proveedor (SEG-8).

### Clave, permisos, CSP y tope (SEG-5)

Todo esto va en M1. Hacerlo entonces es S; retroadaptarlo en M4 es L, porque cada vista y flujo ya supondría lo contrario.

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| Clave de bajo valor como control principal: una clave solo para esto, con límite mensual pequeño, y `storage.local` a conciencia con `setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})` al iniciar | `local` «By default, it's exposed to content scripts». `session` se recomienda para datos sensibles, pero «is cleared if the extension is disabled, reloaded, updated, and when the browser restarts» ([API storage](https://developer.chrome.com/docs/extensions/reference/api/storage)): Ctrl+D dejaría de clasificar tras cada reinicio. Con el tope, `local` es proporcional. Algunos proveedores desaconsejan por escrito usar su clave en un navegador ([Proveedores](proveedores.md)): es un costo real, asumible en una extensión personal con clave propia | Pasar a `session` cambia el flujo de Ctrl+D |
| El límite se fija donde el proveedor lo permita, y se verifica | En Anthropic: «You cannot set spend limits on the Default Workspace» ([Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)); hay que crear uno propio. Los demás, en [Proveedores](proveedores.md) | Ninguno |
| CSP más estricta: `default-src 'self'; connect-src` con los orígenes del registro | La CSP por defecto es `script-src 'self'; object-src 'self';` y no limita conexiones ([CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)). Esa página no dice si admite otras directivas; `[de memoria]` sí. Hay que probarlo al crear el manifest | Bajo. M5 necesitará otra `connect-src` o un contexto aparte |
| Nunca `innerHTML` con datos, incluido el resaltado de M4, con una prueba que falle si aparece en `extension/ui/` | Popup y Manager pintan títulos de terceros y nombres generados por el modelo, en la misma página que puede leer la clave. Una inyección de HTML no ejecuta código bajo la CSP, pero puede filtrar datos | Alto si se deja para el final |
| `tabs` opcional, pedido al activar el orden automático | Como permiso fijo da la URL y el título de todas las pestañas en todo momento, y su único uso es la guarda de M3 | Bajo |
| Prueba de manifest: sin scripts de contenido, sin `web_accessible_resources`, sin `externally_connectable` | Toda adición debe ser deliberada; en particular, un script de contenido expondría `storage.local` si falta `setAccessLevel` | Ninguno |
| El tope también rige en la extensión, con un límite diario para Ctrl+D, antes de M2 | `core/budget.js` ya es puro y portable. Sin esto, cada Ctrl+D es una llamada sin tope local | Bajo: falta solo el contador diario en `meta` |

### Verificador, respaldos y Ctrl+D (SEG-6)

> Del verificador no hay código (M5). El respaldo escapa título y URL y advierte que contiene URL completas; no rota los anteriores, porque son descargas. Ctrl+D está apagado por defecto y respeta las carpetas excluidas, pero **no tiene lista de dominios que nunca se envían ni detector de secretos**: rigen `sanitizeForLlm` y `cleanTitle`.

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| Verificador con regla invertida: solo si no hay query y `sanitizeForLlm` conservó la ruta completa, sin marcadores de secreto. El resto queda «no verificado» y nunca se preselecciona | Un GET consume enlaces de un solo uso, y estos también viven en la ruta (`verify/482913`, `confirm/ABCD-EFGH-JKLM-NPQR`). No se puede deshacer | Bajo |
| No seguir redirecciones: `redirect: 'manual'`, y una respuesta opaca se clasifica como «vivo, redirige» | Una URL pública puede redirigir a `http://192.168.1.1/`. `[de memoria]` Con `manual` la respuesta es opaca, sin estado ni `Location`, y no se puede validar cada salto. Se pierde detectar un 404 tras redirección | Bajo |
| Bloquear rangos privados con `declarativeNetRequest` para las peticiones de la extensión | Defensa adicional. **Sin probar**: hay que confirmarlo en M5. El rebinding de DNS queda como riesgo residual | Bajo |
| Quitar `webRequest`: todo fallo de red repetido es «dudoso» | Se pierde distinguir DNS de otros fallos, y desaparece el permiso que permite ver toda la navegación | Bajo. Es el mejor intercambio del plan |
| `<all_urls>` se retira al terminar cada verificación, con `chrome.permissions.remove` | Limita el tiempo en que la extensión puede leer cualquier sitio | Ninguno |
| Respaldo: escapar título y URL, probar con `</a><script>`, advertir que contiene URL completas y rotar los anteriores | El archivo se abre como `file://`, y un título sin escapar se ejecuta. Además deja en Descargas, en claro, los tokens que el saneamiento protege | Bajo |
| Ctrl+D apagado por defecto, con título saneado, lista de dominios que nunca se envían y sin envío si se detecta un marcador de secreto | No hay revisión del envío: el título de una página sensible sale en segundos, sin la vista previa que justifica el resto del diseño de privacidad. Al activarlo se muestra la política del proveedor | Bajo |

### Empaquetado y service worker (FS-9, INT-6)

| Decisión | Razón | Costo de cambiarla |
|---|---|---|
| `esbuild` exacto como `devDependency`, y `tools/build-vendor.mjs`: `--bundle --format=esm --platform=browser --target=chrome120 --minify`, con la versión del SDK en la cabecera | El plan decía «se empaqueta una vez», sin script ni versión. Sin eso, nadie sabrá con qué se generó | Un comando por cada versión del SDK |
| `vendor/anthropic.js` se versiona | No hay otro paso de compilación. `[medido]` SDK 1.5.0 con esbuild 0.28.2: 366.386 bytes; corre en página con CSP de MV3, Worker y service worker contra un servidor local. No se probó que la API real acepte el origen `chrome-extension://` | Bajo. Solo Claude lo necesita: los demás usan `fetch` |
| En `sw.js`, `timeoutMs` de 20 s, y «tiempo agotado» se registra | Chrome detiene el worker «When a fetch() response takes more than 30 seconds to arrive» ([ciclo de vida](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)), y una petición sin streaming no devuelve cabeceras hasta terminar. El valor por defecto del adaptador son 120 s: la llamada se cobraría sin respuesta. El marcador queda donde está | Bajo |
| `allowBrowser: true` en `sw.js` y Manager | El SDK solo envía la cabecera de acceso directo desde navegador con esa opción, y su detección de navegador no actúa en un service worker. Sin ella, la petición sale sin esa cabecera, y la API la exige `[inferencia]` | Bajo. Falta probar si otros proveedores aceptan peticiones desde una extensión |

### Medir Ctrl+D antes de confiar en él (IA-12)

> **Hecho de otra forma, y después.** Ctrl+D se construyó sin medir (apagado por defecto y con confirmación, D1), y la medición llegó con `autosort-check`, que mide el prompt real de la extensión un marcador a la vez. Su límite: con 29 marcadores enviables solo puede rechazar el prompt, no certificar el 95 % ([Quick start](quick-start.md#medir-el-prompt-con-autosort-check)).

**Decisión original:** antes de construir M3 se mide un marcador a la vez, con `--batch-size` (a agregar) y `--taxonomy` sin descripciones, sobre las filas ya juzgadas. Regla: precisión de al menos 95 % en `high`, cifra que fija la persona.

**Razón:** M3 clasifica un marcador a la vez, contra carpetas existentes, sin descripciones (`chrome.bookmarks` no las guarda) y **sin vista previa**. M0 mide lotes de 50 con descripciones, y su latencia es por lote. Un modelo puede aprobar M0 y equivocarse en M3 donde nadie revisa. `[inferencia]` No conviene decidir M3 con los datos de M0.

**Costo de cambiarla:** S. `makeBatches` ya acepta `maxItems`, y solo se juzgan los pares nuevos.

### Directorio compartido (M1)

**Decisión:** la extensión se carga desde una copia en un directorio privado de la cuenta, no desde el árbol compartido.

**Razón:** Chrome lee una extensión desempaquetada desde el disco sin verificar su contenido `[de memoria]`. Si otra cuenta puede escribir en `extension/`, puede ejecutar código con acceso a la clave y a todos los marcadores. El plan solo trataba este directorio como un problema de lectura.

**Costo de cambiarla:** ninguno en código; es un paso de instalación.

## Qué fijar y cuándo

La numeración es la actual (M2 es Ctrl+D; el orden masivo pasó a M4).

| Cuándo | Qué | Estado |
|---|---|---|
| Al crear el manifest (M1) | `TRUSTED_CONTEXTS`, permisos opcionales, prueba de manifest, regla de render, copia privada | Hecho. La CSP propia no |
| Antes de cerrar M1 | Deshacer con anclas, forma normal, respaldo en dos archivos, raíces | Hecho. Identidades con `expect` y el esquema de IndexedDB, no |
| Antes de M2 | Tope en la extensión, `timeoutMs` de 20 s, apagado por defecto | Hecho |
| Antes de M2 | Medición de IA-12 | Hecha después, con `autosort-check` |
| En M4 | Clave de checkpoint, carpetas por número, `new_folder_root` | Pendiente |
| En M5 | Regla invertida del verificador, sin redirecciones, sin `webRequest` | Pendiente |
| En M6 | Etiquetas por URL exacta, límite de la meta description | Pendiente |

## Sin verificar

- **Chrome con ventana, ya parcialmente probado.** La 0.5.1 se probó a mano en un Chrome real con Gemini 3.5 Flash-Lite (permisos, burbuja de Ctrl+D, «Ordenar sueltos»: [Pruebas reales](pruebas-reales.md)). Antes, todo lo de la extensión corrió en Chrome 156 headless con un perfil desechable y el proveedor interceptado, y contra el falso de `chrome.*`. De lo que sigue, la prueba a mano cubrió el diálogo de permisos y la burbuja de Ctrl+D; queda sin verificar que Web Locks se comparta entre el worker y las páginas, si `onCreated` se dispara con sync, ni si Chrome pide permiso para el segundo archivo de «Respaldar».
- **Un proveedor real con la extensión 0.4.0 o posterior.** Gemini 3.5 Flash-Lite respondió a los prompts de M0 (20 de 20). Los prompts de Ctrl+D y el de «Ordenar sueltos» corrieron solo contra servidores falsos.
- Dónde deja Chrome lo importado, y cómo conserva sync el orden entre dispositivos.
- Reutilización de un ID tras reiniciar, ID nuevos al reabrir la sesión de la cuenta e ID distintos entre dispositivos: inferencias del código.
- Que cada proveedor acepte peticiones desde una extensión (el `Origin` `chrome-extension://`).
- Deshacer con anclas sigue contrastado con un simulador y con Chrome 156 headless, no con sync entre dispositivos.
