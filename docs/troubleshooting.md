# Troubleshooting

Tiene dos partes: la [extensión](#errores-de-la-extensión) (0.5.1), con sus textos en español tal como los muestra la ventana, y la [herramienta de evaluación](#errores-de-la-evaluación-cli), cuyos mensajes salen en inglés, tal como los imprime la CLI.

## Errores de la extensión

### Errores de una llamada al proveedor

Una llamada que falla queda en «Actividad reciente» como una fila de error con este texto, y la insignia muestra «!» roja hasta que abres la ventana. El texto crudo del proveedor está en «Detalles», plegable, en inglés. **Un error no pausa la extensión**: el siguiente Ctrl+D lo intenta de nuevo.

| Categoría | Texto en la ventana | Cuándo ocurre | Qué hacer |
|---|---|---|---|
| `key` | «La clave no es válida o no tiene acceso a la API. Revísala en Ajustes.» | Respuesta 401 o 403, o un 400 que habla de la clave | Pega la clave otra vez y usa «Probar la clave». En Gemini, la clave no debe estar restringida a otra API |
| `quota` | «El proveedor no tiene cuota disponible ahora (límite por minuto o por día). Espera unos minutos o hasta mañana.» | Respuesta 429. **No se reintenta**: en un plan gratuito significa cuota por minuto o por día | Espera. Si ocurre seguido, baja el ritmo o pasa a un plan de pago |
| `server` | «El proveedor falló o no respondió bien. Prueba de nuevo más tarde.» | 5xx, 408, 409 (se reintenta una vez si queda plazo), o cualquier otro 4xx | Reintenta más tarde con «Reintentar» |
| `timeout` | «La IA tardó más de 20 s. Prueba de nuevo.» | Sin respuesta en 20 s. Puede haberse facturado | «Reintentar» |
| `model` | «El modelo elegido no está disponible para tu cuenta. Elige otro en Ajustes.» | Respuesta 404 | Elige otro modelo. `gemini-2.5-flash-lite` ya no está para cuentas nuevas |
| `permission` | «Falta un permiso de Chrome. Abre Ajustes y pulsa «Guardar» para pedirlo.» | Chrome no concedió `tabs` o el host del proveedor | En la ventana, «Reparar» |
| `no-key` | «No hay una clave guardada para este proveedor. Agrégala en Ajustes.» | No hay clave del proveedor elegido | Pégala y guarda |
| `daily-cap` | «Se alcanzó el tope diario. Vuelve a intentarlo mañana o súbelo en Ajustes.» | 50 llamadas (o el tope que fijaste) o US$0,10 a tarifa de pago en el día local | Espera a mañana, o sube las llamadas en Ajustes. El tope de dinero es fijo |

Si el contexto se recortó, la fila termina con «Se enviaron N de M carpetas.»: hay más de 100 carpetas, o alguna tiene una ruta de más de 100 caracteres o un nombre con un correo o un identificador. Las que no entran se ordenan por uso reciente y tamaño.

### Motivos por los que un marcador se queda donde está

Aparecen en «Actividad reciente» como «Dejado» con su motivo. No son errores.

| Motivo | Texto | Qué hacer |
|---|---|---|
| `saved-in-folder` | «lo guardaste dentro de una carpeta: se respeta tu elección» | Nada. Con «Reintentar» sí se envía desde una subcarpeta |
| `chosen-by-person` | «elegiste la carpeta tú» | Nada: durante los 8 s cambiaste la carpeta |
| `gone` | «lo borraste antes de clasificarlo» | Nada |
| `excluded-folder` | «está en una carpeta excluida: no se envía» | Quita la exclusión en Ajustes si no la querías |
| `private-host`, `unsupported-scheme`, `invalid-url` | «es un host privado: no se envía», «no es una página web», «su URL no se puede enviar» | Nada: nunca se envía. Elige la carpeta a mano |
| `no-topic` | «no tiene un tema claro» | «Elegir carpeta» |
| `already-there` | «ya estaba en la carpeta indicada» | Nada |
| `refused`, `truncated`, `invalid-answer` | «el modelo se negó a clasificarlo», «la respuesta llegó cortada», «la respuesta no fue válida» | «Reintentar» una vez; si se repite, «Elegir carpeta» |
| `unknown-model`, `provider-pending` | «el modelo elegido no está en el catálogo», «ese proveedor aún no funciona en la extensión» | Elige otro modelo en Ajustes |
| `no-permission`, `no-key`, `no-consent` | Falta un permiso, una clave o aceptar la política de datos | Ver [el estado pausado](funcionalidades.md#estado-de-la-extensión) |
| `daily-calls`, `daily-budget` | «se alcanzó el tope diario de llamadas» o «de gasto» | Espera a mañana |
| `duplicate` | «Ya lo tenías en «X».» | «Quitar el duplicado nuevo» |
| `expired`, `dropped`, `discarded` | La propuesta caducó (14 días), cayó por el tope de 50 o la descartaste | Vuelve a guardar la página o usa «Reintentar» |

Una observación del código: la guarda de permisos corre **antes** de la de la pestaña activa. Con el orden activado y un permiso faltante, cada marcador nuevo que llegue por Chrome (incluido uno de sync) deja un registro `no-permission` y marca la insignia. Se resuelve con «Reparar».

### Permisos de Chrome

| Permiso | Cuándo se pide | Para qué |
|---|---|---|
| `bookmarks`, `storage`, `unlimitedStorage` | Al instalar | Leer y mover marcadores, y guardar el estado sin el tope de 10 MB |
| `tabs` (opcional) | Al guardar con «Activar» | Leer la URL de la pestaña activa y comprobar que el marcador nuevo es el que acabas de guardar. Chrome lo muestra como «historial de navegación» |
| El host del proveedor (opcional) | Al guardar con «Activar» | Llamar a su API. Son 6: OpenAI, Gemini, Mistral, xAI, DeepSeek y Perplexity |

Si rechazas el diálogo, lo escrito queda guardado y la extensión queda pausada con «Reparar». Al desactivar se devuelve `tabs` y el host de cada proveedor que no sea el guardado. El diálogo de permisos exige un clic tuyo: no se puede pedir desde el worker.

### Cuentas compartidas y la copia privada

Si otras cuentas pueden escribir en la carpeta del repositorio (por ejemplo, un grupo compartido con modo 775), pueden cambiar código que tú ejecutas. Chrome ejecuta lo que ve en la carpeta cargada, así que quien pueda cambiar `extension/` podría ejecutar código con acceso a tu clave y a todos tus marcadores. **Carga siempre la copia** `~/bookmark-genie-extension` de la cuenta que usa Chrome ([los pasos](quick-start.md#usar-la-extensión)), no la del proyecto.

- *Chrome no puede leer la carpeta:* comprueba que cargas la copia y no la carpeta del repositorio. Los permisos del grupo, o el sandbox de un Chrome Snap o Flatpak, pueden bloquear rutas fuera de tu carpeta personal.
- *El `rsync` falla con «Permiso denegado»:* pide al dueño del repositorio lectura para otros (`chmod -R o+rX`) sobre `extension/`.
- *Sigue diciendo una versión vieja:* repite el `rsync` y pulsa ↻ en `chrome://extensions`.
- *Cada perfil de Chrome tiene su propia instalación, clave y diario.*

### La burbuja de Ctrl+D

La extensión espera unos 8 s tras guardar, porque el diálogo de Ctrl+D ya creó el marcador y aún puedes elegir carpeta. Si cambias la carpeta en ese lapso, gana tu elección (`chosen-by-person`). Si pulsas «Listo» sin cambiar nada, a los pocos segundos llega la propuesta. **No se verificó qué hace la burbuja si sigue abierta cuando el marcador se mueve.** Una página guardada en una subcarpeta, o con el grupo de Ctrl+Shift+D, no se ordena.

### Gemini gratuito

En el plan gratuito de Gemini, lo que se envía se usa para mejorar productos y personas pueden leerlo; en el de pago, no. Ninguna API dice en cuál estás, por eso Gemini siempre pide el consentimiento. Además, el plan gratuito tiene límites por minuto y por día que dan errores `quota`. Para uso diario, una clave de un proyecto con facturación activa, restringida a la API de Gemini, o [otro proveedor](proveedores.md#matriz-de-datos).

### Deshacer

| Mensaje | Causa |
|---|---|
| «Ese cambio ya estaba deshecho.» | Ya lo deshiciste. No se mueve nada |
| `Change … does not exist (it may have aged out of the journal)` | El diario guarda los 20 últimos cambios; uno más viejo ya no se puede deshacer |
| `Change … is being undone, or has nothing to undo` | Otro Deshacer lo tiene reclamado hace menos de 60 s |
| «… no volvieron: ya no estaban donde los dejó» | Moviste ese marcador después. Gana tu cambio |
| «La carpeta creada se conservó porque tiene cosas que no movió Bookmark Genie» | Agregaste algo a la carpeta nueva; no se borra |

### Qué no hace todavía

- **Búsqueda difusa, abrir en bloque, renombrar y borrar** (M3).
- **Duplicados masivos y enlaces muertos** (M5). Solo se detecta, al guardar, una URL exacta que ya tenías.
- **Restaurar desde un respaldo.** Los archivos se descargan, pero ningún botón los aplica. Para volver atrás con un HTML, impórtalo desde Chrome (crea una copia aparte).
- **Anthropic dentro de la extensión.** En la evaluación sí.
- **Orden masivo con reanudación** (M4). «Ordenar sueltos» propone, no reanuda.

## Errores de la evaluación (CLI)

Los mensajes están tal como los imprime la CLI (en inglés). Salvo que se indique otra cosa, un error de uso o de configuración termina con salida 1 **antes de crear el directorio y antes de enviar nada**.

## Errores antes de enviar

### `<VARIABLE> is not set. Nothing else is used as a credential.`

**Causa:** falta la variable de la clave del proveedor de algún modelo (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` o `PERPLEXITY_API_KEY`). Cada proveedor lee solo la suya; `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `GOOGLE_API_KEY` y similares no cuentan. No se gasta nada. Un `--dry-run` no exige clave.

**Solución:**

```bash
read -rs ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
```

### `<VARIABLE> does not look like an API key (no spaces or control characters, 8 to 512 characters).`

**Causa:** la clave tiene espacios, saltos de línea o caracteres fuera de ASCII imprimible, o su largo no está entre 8 y 512. Suele ser un salto de línea pegado al copiarla. **Solución:** vuelve a cargarla con `read -rs`.

### `The data policy of <ids> needs your explicit consent: add --accept-data-policy <id>.`

**Causa:** el modelo es de Gemini, Mistral o DeepSeek, cuyos proveedores entrenan con los datos de la API o pueden hacerlo según el plan de la cuenta, que ninguna API informa. **Solución:** lee la política que la consola imprimió arriba (con su fuente), haz lo que dice `Only you can check`, y agrega `--accept-data-policy gemini` (uno por proveedor). Con `--dry-run` solo avisa (`Dry run: The data policy of ...`).

### `Unknown model <ref>: it has no known price, so the spending cap could not hold. Known models:`

**Causa:** la referencia no está en el catálogo. Sin precio no se puede sostener el tope, así que se rechaza. Revisa el formato (`proveedor/modelo`, por ejemplo `openai/gpt-6-luna`) y la lista que sigue al mensaje. Otros errores de formato: `A model reference must be provider/model, got "..."` y `--models is required, as provider/model references. Known models:` (falta `--models` sin `--dry-run`).

**Copilot** tiene su propio mensaje: `Provider copilot is not available: no usable inference API: ...`, con la razón completa, tanto en `--models copilot/...` como en `eval.mjs models --provider copilot`. Ver [Proveedores](proveedores.md#copilot-no-está).

### `--effort none is not documented for <modelos>, and sending another level would measure something else.`

**Causa:** `--effort none` se rechaza si algún modelo pedido no documenta ese nivel (hoy lo documentan OpenAI, Gemini 2.5, Mistral Small y DeepSeek). **Solución:** elige otros modelos u otro esfuerzo. Un nivel que el catálogo no confirma para un modelo no se envía en silencio: el manifiesto registra `effort: null` y la consola avisa (`Note: ... has no confirmed "low" effort level`).

### `--exclude-folder "<patrón>" matches no folder, so it excludes nothing. Check it for a typo. Nothing was sent.`

**Causa:** el patrón no coincide con la ruta de ninguna carpeta. En una corrida real es un error, porque un tipeo en un filtro de privacidad no debe terminar en un envío. Con `--dry-run` solo advierte (`Warning: ... matches no folder`). **Solución:** corrige la expresión regular. Compara sin distinguir mayúsculas contra la ruta completa (`Barra/Banca/Cuentas`), no anclada: `Banca` coincide con cualquier ruta que lo contenga. También hay `--exclude-folder is empty, ...` y `--exclude-folder is not a valid regular expression: ...`.

### Errores de uso de las opciones

Todos imprimen su explicación sin pila:

| Mensaje | Qué pasó |
|---|---|
| `Missing --input <bookmarks.html>` | Falta `--input` |
| `--max-usd must be a positive amount with a decimal point, such as 1.5; got "1,5"` | Una coma o un valor no numérico desactivaría el tope, así que se rechaza |
| `--sample must be a whole number of at least 1, got "..."` | Igual para `--review` (mínimo 1) y `--seed` (mínimo 0) |
| `--effort must be one of none, low, medium, high, got "..."` | Esfuerzo inválido |
| `--accept-data-policy needs a provider id (...), got "..."` | Id de proveedor desconocido |
| `--fallback only exists on Anthropic, and this run has <modelos>` | `--fallback` con otro proveedor |
| `--models repeats a model` | Modelo repetido |
| `Cannot use "<comando>" like that.` seguido de la ayuda | Comando desconocido, o `score` y `blind` sin archivos |
| `Node 20.12 or newer is required (this is X). Run it with "npm run eval --".` | Ejecutaste con el Node del sistema |

### `No sendable bookmarks found in <archivo>`

**Causa:** el archivo no tiene marcadores reconocibles o todos quedaron excluidos (hosts privados, esquemas no web, `--exclude-folder`). El lector busca `<DT><A HREF="...">`; otros formatos no están probados. **Solución:** confirma que sea una exportación de Chrome. La consola de un `--dry-run` muestra `Never sent: N (motivo: n)`.

También `The collection is too small: nothing is left to classify after the folder sample.` cuando, tras reservar la muestra de carpetas, no queda nada que clasificar. Sin prueba automatizada.

### `Refusing to reuse <dir>: it already exists, and a new run would overwrite its reviews. Choose a new directory.`

**Causa:** `--out` apunta a algo que existe. No se reutiliza para no pisar juicios ni heredar permisos. **Solución:** usa un directorio nuevo.

### `The taxonomy file is not valid JSON`, `... needs a "folders" list`, `... has N unusable folders: ...`, `... has no folders`

**Causa:** el archivo de `--taxonomy` no tiene la forma `{"folders": [{"name", "description"}]}` o contiene carpetas que se descartarían (vacías, reservadas, de más de 2 niveles o 60 caracteres, repetidas). Con `--taxonomy` nada se descarta en silencio. El de `taxonomy-*.json` de una corrida sirve tal cual.

## Errores durante la corrida

### `Stopped early. <modelo>: ...` con un error de autenticación o permisos

**Causa:** clave inválida, revocada, sin saldo o sin permiso. Anthropic lo informa como el error del SDK (`401 ...`); los demás como `<Proveedor> rejected the request (status 401)` con el mensaje de la API si es texto. Estos errores no se reintentan, el modelo queda `stopped` y los siguientes de `--models` sí corren. Salida 1.

**Solución:** revisa la clave, el saldo y el límite de gasto en la consola del proveedor. En Anthropic, una clave que no es de un único espacio de trabajo falla: créala para uno solo (ver [Proveedores](proveedores.md#riesgos-de-la-primera-llamada)). En Gemini, una clave estándar sin restringir se rechaza.

### `Next call could exceed the US$1.0000 cap`

**Causa:** lo gastado más el peor caso de la siguiente llamada supera el tope compartido. El peor caso supone usar todo `max_tokens`, por lo que puede detenerse antes de gastar realmente el tope, sobre todo con modelos caros. Salida 2. Lo ya pagado queda en disco.

**Solución:** sube el tope o reduce la muestra, y repite con un `--out` nuevo:

```bash
npm run eval -- run --input /ruta/bookmarks.html --models proveedor/modelo --max-usd 2 --out /ruta/nueva
npm run eval -- run --input /ruta/bookmarks.html --models proveedor/modelo --sample 150 --review 50 --out /ruta/otra
```

### `<modelo> returned N output tokens for max_tokens M: that provider did not respect the maximum, so the US$X cap cannot be guaranteed with it.`

**Causa (guardia `cap_broken_by`):** el proveedor devolvió más salida (típicamente razonamiento) que el máximo pedido. El tope de gasto asume que `max_tokens` acota lo cobrado; con ese proveedor no se puede garantizar. La respuesta ya pagada se entrega, la llamada siguiente se rechaza y la corrida termina con salida 2. El manifiesto guarda `cap_broken_by` y la consola agrega `The cap cannot be guaranteed with <modelo>: ... Try --effort none if the model allows it.` El exceso es de una llamada.

**Solución:** `--effort none` si el modelo lo permite (DeepSeek, Gemini 2.5, Mistral Small, OpenAI). Si no, trata ese proveedor como sin tope y fíjalo en su consola. Es esperable en la primera corrida de DeepSeek, Gemini o `perplexity/glm-5.3-flash`: ver [Proveedores](proveedores.md#tope-de-gasto-y-max_tokens).

### El gasto supera el tope

**Causa:** es una limitación actual. Antes de cada petición se comprueba un peor caso calculado con tokens de entrada **estimados**, pero lo gastado suma el uso **real**. Además, una llamada que pudo facturarse sin respuesta útil (tiempo agotado, corte tras enviar) se carga al peor caso: eso hace el total pesimista, no optimista (`lost_usd`). Si el gasto cruza el tope, la corrida lo dice (`The spending cap was crossed: US$X of US$Y`) y sale con 2, aunque haya completado. Con un proveedor que no respeta `max_tokens`, el exceso de una llamada puede ser grande.

**Solución:** trata `--max-usd` como una guarda y fija un límite de gasto en la consola del proveedor, que es la protección final.

### `Rate limited: waiting N s`, `Server error 5xx`, `Server asked to retry (408|409)`, `Connection failed` o `Request timed out`

**Causa:** fallo temporal. El aviso `waiting N s` no es un error: la herramienta hace hasta 5 intentos con esperas de `retry-after` o de 2, 4, 8 y 16 s. Se detiene si los agota, si hubo 2 tiempos agotados o, sin esperar, si el servidor pide más de 5 min. 429 sin remedio por cuota agotada (OpenAI) o por límite de gasto propio (Anthropic, `enforced_spend_limit_reached`) no se reintenta.

Un tiempo agotado, una conexión cortada tras enviar o un corte a mitad pudieron facturarse: se cargan al peor caso y se cuentan en `lost_usd`. **Límite conocido:** un `UND_ERR_CONNECT_TIMEOUT` de Claude pierde su causa en el SDK, así que se carga como posiblemente facturado y cuenta como tiempo agotado. Es pesimista; nunca subestima.

**Solución:** si se detuvo, repite la corrida más tarde.

### La corrida se detuvo y no se reanuda

**Causa:** es una limitación de M0. El manifiesto, el reporte y los CSV de los modelos completos se escriben igual, y lo pagado del modelo en curso queda en `assignments-*.jsonl` y `taxonomy-*.json`, pero no hay reanudación: repetir `run` es una corrida nueva que vuelve a pagar. El modelo detenido no deja CSV de revisión, y su sección de `report.md` dice `INCOMPLETE`.

**Solución:** repite con un `--out` nuevo y solo los modelos pendientes, con la misma semilla y la misma exportación para conservar las mismas muestras:

```bash
npm run eval -- run --input /ruta/bookmarks.html --models anthropic/claude-opus-5-5 --out /ruta/nueva
```

### `<modelo> returned no usable folders (stop reason: ...)`

**Causa:** el modelo no entregó carpetas utilizables. `stop reason` indica el motivo. Con `refusal` o `max_tokens` se prueba con partes de la muestra; con otro motivo, como un JSON inválido, hay una sola llamada. Salida 1.

**Solución:** con `refusal`, busca títulos problemáticos en `payload-preview.jsonl` y prueba otra semilla (`--seed 2`). Con DeepSeek (modo JSON sin esquema) un JSON mal formado es más probable.

### `Warning: <ref> was answered by <id>, not by the model asked for.`

**Causa:** el proveedor respondió con otro modelo (una redirección silenciosa de un id retirado, o un respaldo). Las respuestas son de ese modelo, no del que pediste. `report.md` agrega `Unexpected model answered`, y `score` baja el brazo a `GRAY` y muestra `Served as: <id>` si aparece en `served` o en `answered_by` (por llamada, la taxonomía incluida). Bajo un alias móvil (DeepSeek) el id servido se muestra sin bajar el veredicto. **Solución:** usa un id fijo, o vuelve a medir con el modelo pedido.

### `Perplexity ran a tool such as a web search with the request content; stopping`

**Causa:** una herramienta corrió con el contenido. El error lleva `stopsRun`: detiene toda la corrida, con salida 1, para no repetirlo con el lote siguiente. El contenido de ese lote ya salió. Ver [Proveedores](proveedores.md#riesgos-de-la-primera-llamada).

### `Unexpected finish_reason: ...`, `Response has no choices`, `Response is not JSON`, `Unexpected response status`, `Response usage is missing or unusable`

**Causa:** el proveedor respondió con algo que el contrato documentado no prevé. Es habitual en la primera llamada a Gemini, donde la capa compatible no documenta `finish_reason` ni qué devuelve un prompt bloqueado (`choices: []`). El modelo se detiene; se cobra el uso si se leyó, o el peor caso. **Solución:** repórtalo con el mensaje y su `request-id`, que viene incluido cuando existe.

### Error 400 de la API con Opus o Sonnet

**Causa posible, sin verificar:** con `--fallback`, nunca se ha probado la combinación de respaldo del servidor con salida estructurada contra la API real. **Solución:** corre sin `--fallback`, que es el valor por defecto, o con Haiku, que no tiene respaldo.

## Errores al calcular el puntaje

| Mensaje | Causa y solución |
|---|---|
| `<archivo> has no column judgment, id, ...: use the file that the run wrote` | Al CSV le faltan columnas: es otro archivo, o se guardó mal. Usa el que escribió la corrida (ordenado como quieras) |
| `No manifest.json next to <archivo>: a review can only be scored together with the run that produced it.` | `score` exige el manifiesto junto al CSV. No muevas el CSV solo |
| `<archivo> does not hold the bookmarks of its run: it has N rows and the run reviewed M.` | Se borraron o repitieron filas. Ordenar no importa; borrar sí. Usa el original |
| `<modelo> did not finish in this run (status: stopped), so <archivo> cannot be scored` | Solo se puntúan modelos completos |
| `These reviews are not about the same bookmarks, so they cannot be compared.` | Dos corridas con otra exportación, semilla, `--sample` o `--review` |
| `<archivo> could be any of <modelos>: use the name the run gave it` | Renombraste un CSV y el nombre no identifica un único modelo |
| `<a> and <b> are both reviews of <modelo> in the same run: keep one.` | Dos archivos del mismo brazo |
| `Incomplete: judge every row before using this result.` | Quedan filas sin juicio o con valor no reconocido. Usa `y`, `yes`, `s`, `si`, `sí`, `n` o `no`. Salida 1, y el porcentaje es provisional |
| `Nothing judged yet: fill the judgment column with y or n.` | No hay ninguna fila juzgada |
| `Refusing to overwrite <ruta>: it may hold judgments. Choose another --out.` | `blind` no pisa una lista ni su clave |
| `<dir> has no review-*.csv: only models that finished have one` | `blind` sobre una corrida sin modelos completos |
| `<dir> comes from another export, so its ids mean other bookmarks.` / `<dir> reviewed other bookmarks: use the same export, seed, --sample and --review.` | Corridas distintas mezcladas en `blind` |
| `<lista> judged other bookmarks, so its judgments cannot carry over.` | `--previous` de otra exportación o de otras filas |
| `Row rN of <lista> does not match its key: the folder changed.` | Editaste la columna `folder` de la lista ciega |

`score` termina con salida 1 aunque calculó el porcentaje cuando el veredicto no es `PASS`: es esperado, no un fallo.

### Los acentos del CSV se ven mal o el CSV viene de Excel

`score` y `blind` leen UTF-8 y, si el archivo no es UTF-8 válido, Windows-1252, que es lo que Excel suele guardar en español: `sí` y las carpetas con tilde se leen bien. También aceptan BOM, CRLF, filas vacías y `;` como separador. Lo que no se lee es UTF-16 («Texto Unicode» de Excel): guarda como «CSV UTF-8» o «CSV (delimitado por comas)». Si Excel dejó `Cocina` con un apóstrofo delante, es el prefijo `'` que la herramienta agrega a las celdas que empiezan con `=`, `+`, `-` o `@`, para que una hoja no ejecute un título como fórmula.

### Versión de Node incorrecta

**Síntoma:** `node --version` muestra 18.19.1, que es el Node del sistema; la CLI se niega a correr.

**Solución:** usa `npm run eval -- ...`. Si falta el Node local, ejecuta `npm ci`.

### `npm test` queda detenido o una prueba falla por tiempo

**Causa:** el límite es de 60 s por prueba. Las pruebas no necesitan red externa, pero sí abrir puertos locales.

**Solución:** ejecuta un archivo aislado, con el Node local en el `PATH`:

```bash
PATH=$PWD/node_modules/.bin:$PATH node --test tests/unit/llm.test.mjs
```

## Calidad de los resultados

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Aceptación bajo 78 % en todos los modelos | Títulos pobres o carpetas inadecuadas | Revisa `Folders used / proposed` y las carpetas propuestas en `report.md`; cobertura baja apunta a la taxonomía |
| Zona gris (`GRAY`) por una carpeta con más de 35 % | Una carpeta toma casi todo | Prueba otra semilla, edita la taxonomía y repite con `--taxonomy` |
| Muchos `__unsorted__` | Carpetas demasiado específicas o muestra poco representativa | Prueba otra semilla o una muestra mayor |
| Mucha baja confianza | La URL reducida y el título dicen poco | Es una limitación esperada; el enriquecimiento está previsto en M6 |
| Más de 2 % sin clasificar | Negativas o truncados | Mira `Refused or truncated` y busca títulos problemáticos; el veredicto no pasa de `GRAY` |
| `missing` distinto de cero | El modelo omitió o repitió índices tras reintentar (más probable en DeepSeek, que no impone el esquema) | Es `FAIL` por regla; prueba otro modelo o `--effort` |
| Mejor resultado solo en un modelo caro | Diferencia real de calidad | Compara el costo proyectado; a escala personal puede valer la pena |
| `Repeated rows: N of M changed` con N de 2 o más | Tu criterio de juicio no es estable | Trata las diferencias de menos de 10 filas como empate |

## Limitaciones

### Navegadores y versiones

La extensión 0.5.1 se probó en **Chrome 156.0.8078.79 headless**, con un perfil desechable y el proveedor desviado a un servidor local. Después se probó a mano en un Chrome real, con Gemini 3.5 Flash-Lite ([Pruebas reales](pruebas-reales.md)); esa prueba cubre el diálogo de permisos y la burbuja de Ctrl+D, no Web Locks entre el worker y las páginas. Con la evaluación, el navegador solo exporta el HTML.

| Navegador | Evaluación: exportación HTML | Extensión |
|---|---|---|
| Chrome 156.0.8078.79 (instalado) | Exportación real usada en M0 | Probada en headless; sin probar con ventana |
| Chrome 134 o superior | Formato esperado | Mínimo del manifest (`minimum_chrome_version`): usa `syncing` de `chrome.bookmarks` |
| Chrome inferior a 134 | Formato esperado | No carga |
| Chromium (Playwright) | No aplica | Previsto para pruebas e2e, porque Chrome con marca eliminó `--load-extension` desde la 137 |
| Edge, Brave, Opera, Vivaldi | No probado | No probado. Al estar basados en Chromium podrían funcionar, pero es una inferencia |
| Firefox, Safari | No probado | Fuera del alcance previsto |

La carga manual desde `chrome://extensions` es la vía de instalación en Chrome con marca. No hay publicación prevista en la Chrome Web Store.

### Entorno de ejecución

| Componente | Requisito |
|---|---|
| Node | 26.13.0 local, ejecutado con `npm run` (`engines`: 20.12 o superior) |
| Sistema operativo | Solo probado en Linux |
| Red | HTTPS hacia la API de cada proveedor en corridas reales |

### Funcionales de la evaluación (M0)

- No modifica marcadores: las carpetas propuestas son solo un resultado de medición.
- **No hay reanudación**; una falla deja lo pagado en disco, pero repetir es una corrida nueva.
- **Solo Gemini 3.5 Flash-Lite se ha probado contra su API real** (la corrida de M0). La forma de las peticiones, el mapa de `finish_reason` y los textos de error se contrastaron con la documentación y con servidores falsos.
- `--effort` solo se envía donde el catálogo lo confirma; en el resto rige el esfuerzo por defecto del modelo.
- Los IDs (`b0`, `b1`...) dependen de la posición, no son los de Chrome.
- Los juicios se comparan entre modelos sobre los mismos marcadores, pero cada modelo propone sus propias carpetas (salvo con `--taxonomy`).
- Una muestra de 100 da un intervalo de unos 14 puntos de ancho. Una diferencia pequeña entre modelos no es significativa; por eso un brazo más caro solo gana por 10 filas netas.
- Una colección con menos de unos 150 marcadores enviables no alcanza a reunir 100 filas de revisión, así que `score` da `GRAY`.

### Privacidad

- Los títulos, dominios, rutas legibles y nombres de carpetas salen al proveedor que elijas. Solo un modelo local evitaría por completo a un tercero.
- El saneamiento es heurístico y no reconoce dominios sensibles. En el corpus reservado todavía pasan 8 de 34 secretos sintéticos dentro de títulos o URL; nombres, salud y finanzas en un título salen tal cual. Revisa `payload-preview.jsonl` y usa `--exclude-folder`. Detalle: [Límites del saneamiento](arquitectura-alto-nivel.md#límites-del-saneamiento).
- Haz la corrida real sobre una copia privada de la exportación y con un `--out` privado. El directorio del proyecto es compartido con otras cuentas.
- Pagar no equivale a retención cero. En Anthropic el contenido marcado se puede guardar hasta 2 años y los puntajes de clasificación de seguridad hasta 7; un título rechazado puede arrastrar a los vecinos de su lote (riesgo inferido). Ver [Retención en Anthropic](arquitectura-alto-nivel.md#retención-en-anthropic).

### Costo

- Los estimados no incluyen razonamiento; `report.md` tiene el costo real.
- Los precios están escritos en el catálogo con su fecha y fuente de lectura (2026-11-05). Si un proveedor los cambia, el cálculo queda desactualizado, y `models --check` no lo detecta.
- DeepSeek se cobra a tarifa de pico, y `gpt-6-luna` a 0,125 de entrada (escritura en caché): el costo informado sobrestima.
- Una respuesta servida por otro modelo se cobra a la tarifa de ese modelo si está en el catálogo del mismo proveedor; si no, a la del pedido, y la advertencia lo dice.
- [El tope no es estricto](#el-gasto-supera-el-tope).
- `Projected cost` es una proyección lineal desde la muestra, sin contar la llamada de carpetas ni lo cargado por llamadas sin respuesta útil, no una medición sobre 2.000 marcadores.
- El cargo de la herramienta de Perplexity, si corriera, no se suma.

### Sin verificar

- Solo se hicieron llamadas reales a Gemini 3.5 Flash-Lite, con los prompts de M0. Los de Ctrl+D y «Ordenar sueltos» solo corrieron contra servidores falsos. La calidad de los otros seis proveedores es desconocida.
- No se ha probado con una exportación real de tus marcadores en los otros proveedores, ni con un cliente que escriba en `eval-out` desde otra cuenta.
- No se pudo confirmar si `onCreated` de `chrome.bookmarks` se dispara con sync: la guarda de la pestaña activa cubre ambos casos.
- Chrome con ventana, el diálogo de permisos, Web Locks entre el worker y las páginas, la burbuja de Ctrl+D y si el worker aguanta un «Ordenar sueltos» largo: [lista completa](decisiones.md#sin-verificar).
- M3 a M6 no están construidos.
