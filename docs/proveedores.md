# Proveedores

> **Lectura del 2026-11-05. Solo `gemini/gemini-3.5-flash-lite` se ha probado contra su API real** (la corrida de M0, plan gratuito); de los demás, no se hizo ninguna llamada, ni siquiera la de listar modelos, ni se usó una clave. Los adaptadores se prueban contra servidores locales ([`fake-openai.mjs`](../tests/helpers/fake-openai.mjs) y `fake-claude.mjs`) que modelan lo que dice la documentación. Eso demuestra que el código cumple lo leído, no que lo leído coincida con el servicio. Precios, retención y políticas de entrenamiento cambian sin aviso: relee la fuente antes de decidir con un dato de esta página.

Los mismos datos viven en el código: el catálogo de modelos en [`extension/core/models.js`](../extension/core/models.js) (id exacto, precio, fuente y fecha por modelo) y el registro de proveedores en [`extension/platform/providers.js`](../extension/platform/providers.js) (destino, adaptador, política de datos con fuente). Esta página es la versión con contexto; si difieren, manda el código.

Cómo se leyó:

- Solo sitios del proveedor. Las páginas pasaron por una extracción automática que puede resumir; lo que va entre comillas es lo que esa extracción devolvió como cita y no todas se cotejaron palabra por palabra. Se volvieron a leer, pidiendo el texto literal, las que deciden el diseño: el tope de xAI, la búsqueda de Perplexity y la definición de servicio de pago de Gemini.
- `[búsqueda]` marca un dato visto solo en el extracto del buscador oficial, porque la página no se pudo leer directamente. Es más débil.
- «No documentado» significa que no se encontró en las páginas leídas, no que no exista.

## Elegir modelo

`--models proveedor/modelo,...` es obligatorio salvo con `--dry-run`. No hay modelo por defecto ni proveedor privilegiado. La referencia se corta en la primera barra, porque algunos ids tienen barra propia: `perplexity/openai/gpt-6-luna`.

**El id es exacto.** Cada modelo del catálogo lleva su id tal como viaja por la red, su precio, la URL de donde salió y la fecha de lectura (`readOn`). La corrida guarda esos precios, con su fuente, en `prices_usd_per_mtok` del manifiesto. Un alias móvil puede pasar a otro modelo sin aviso y entonces la medición ya no describe lo que correrá después; por eso solo DeepSeek, que no publica ids fijos, entra con alias, y la corrida lo advierte (`is a moving alias`).

**Un modelo fuera del catálogo se rechaza antes de gastar**, porque sin precio el tope no se podría sostener:

```text
Unknown model openai/gpt-x: it has no known price, so the spending cap could not hold. Known models:
  anthropic/claude-haiku-5-5
  ...
```

Para sumar uno hay que leer su precio y su política en la documentación del proveedor y agregarlo a `models.js`. La CLI no lo hace.

### Comandos de `models`

| Comando | Qué hace | Red |
|---|---|---|
| `models [--provider <id>]` | Tabla del catálogo (precio, esfuerzo, entrena por defecto, estabilidad del id, retiro), notas y política de datos con fuente | No |
| `models --check` | Compara el catálogo con el listado que devuelve cada proveedor para tu clave: ids nuevos, ausentes y en retiro | `GET` del listado, solo de los proveedores cuya variable de clave está definida. No envía marcadores |
| `models --candidates` | Filtra el catálogo a los que tienen salida estructurada con esquema y no entrenan por defecto; ordena del más barato al más caro por precio de entrada. Excluye `depends` y los alias móviles | No |

`--check` sale con 1 si falta un modelo del catálogo en el listado, si alguno se retira o está retirado, si un listado falla o si no se pudo comprobar nada (ninguna clave en el entorno). Los modelos nuevos se informan sin fallar. Los campos de retiro que lee dependen del proveedor: `lifecycle` y `retires_at` en Anthropic, `shutdown_date` en OpenAI, `deprecation` y `archived` en Mistral.

### Qué no se puede saber por API

Los listados informan qué ids existen para tu clave y, según el proveedor, límites, capacidades o retiro. Lo demás sale de leer páginas:

| Dato | Qué entrega la API | De dónde sale |
|---|---|---|
| Política de datos (entrenamiento, retención, región) | Nada. Solo xAI informa la retención cero, con `x-zero-data-retention` en cada respuesta | Términos del proveedor; queda en `providers.js` con URL y fecha. `models --check` **no detecta** un cambio |
| Plan de la cuenta (Gemini y Mistral) y si un interruptor de privacidad está apagado | Nada | Solo tú, en la consola de cada proveedor |
| Precio | Solo xAI | Página de precios; queda en `models.js` |
| Si un id es fijo o móvil | Solo los `aliases` de xAI y Mistral | Documentación |
| Salida estructurada | Solo Anthropic la informa en su listado | Documentación |
| Retiro | Anthropic, OpenAI y Mistral | Los otros cuatro, en sus páginas de retiros |
| Comportamiento ante una negativa o un truncamiento | Nada; en Gemini y Mistral ni la documentación | Primera corrida real |
| Redirección silenciosa de un id retirado (Gemini, xAI) | Solo si la respuesta devuelve el modelo que respondió | `served` en el manifiesto, si el proveedor dice la verdad |
| Qué modelo clasifica bien **tus** marcadores | Nada | `run` más el juicio de `score` |

## Credenciales y destino

Cada proveedor lee **solo su propia variable**. Nada más se lee como credencial:

| Proveedor | Variable de la clave |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` (no se lee `GOOGLE_API_KEY`, que sus SDK priorizan) |
| `mistral` | `MISTRAL_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `perplexity` | `PERPLEXITY_API_KEY` |

- La clave debe tener entre 8 y 512 caracteres ASCII imprimibles, sin espacios. Si no, la corrida termina antes de gastar con `<VARIABLE> does not look like an API key (no spaces or control characters, 8 to 512 characters).`
- Antes de crear el SDK de Anthropic se eliminan del entorno `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE` y `ANTHROPIC_CUSTOM_HEADERS`, para que ninguna credencial ajena viaje con la petición.
- El destino sale del registro y no se cambia: la consola muestra `Destination: <modelo> -> <origen> (key ending ####)` con los últimos 4 caracteres de la clave. Las variables `<PROVEEDOR>_BASE_URL` existen para las pruebas y **solo aceptan loopback** (`127.0.0.1`, `[::1]`, `localhost`); cualquier otro valor se rechaza. Una redirección HTTP se rechaza también.
- El manifiesto guarda por modelo el origen del destino y el sufijo de 4 caracteres, nunca la clave.

### Consentimiento de datos

Gemini y Mistral (`depends`: depende del plan de la cuenta, que ninguna API informa) y DeepSeek (entrena) exigen `--accept-data-policy <id>` por proveedor. Sin él, `run` termina con salida 1 antes de crear nada:

```text
The data policy of gemini needs your explicit consent: add --accept-data-policy gemini.
```

Con `--dry-run` solo avisa (`Dry run: The data policy of ... needs your explicit consent`) y sigue. La política de cada proveedor se imprime antes de cualquier envío, también en un dry run.

## Matriz de modelos

Precios en US$ por millón de tokens, entrada / salida, a la tarifa de un prompt de pocos miles de tokens. Es lo que cobra el tope de gasto. Los costos reales de tu corrida salen de `report.md`.

| Modelo | Entrada / salida | Esfuerzo confirmado (por defecto) | Salida | Id | Retiro | Notas |
|---|---|---|---|---|---|---|
| `anthropic/claude-haiku-5-5` | 0,10 / 0,50 | low, medium, high (medium) | esquema | fijo | no antes de 2027-10-07 | Sobre 100.000 tokens de prompt: 0,50 / 2,50. Sin respaldo en el servidor |
| `anthropic/claude-sonnet-5-5` | 2 / 10 | low, medium, high (high) | esquema | fijo | no antes de 2027-09-28 | |
| `anthropic/claude-opus-5-5` | 4 / 20 | low, medium, high (medium) | esquema | fijo | no antes de 2027-09-22 | |
| `anthropic/claude-fable-5-1` | 10 / 50 | low, medium, high (high) | esquema | fijo | no antes de 2027-09-01 | Modelo cubierto: exige retención de 30 días. Está en el catálogo para cobrar bien un respaldo que caiga en él; que admita respaldo es inferencia |
| `openai/gpt-6-luna` | **0,125** / 0,50 | none, low, medium, high, xhigh, max (medium) | esquema | nombre estable, ambiguo | sin anuncio | Ver «Escritura en caché» |
| `gemini/gemini-2.5-flash-lite` (**no disponible para cuentas nuevas**: la API respondió 404 el 2026-11-05) | 0,10 / 0,40 | none, low, medium, high (none) | esquema | nombre estable | sin anuncio | Razona solo si se envía esfuerzo. La propia página recomienda 3.5 Flash-Lite para proyectos nuevos |
| `gemini/gemini-3.1-flash-lite` | 0,25 / 1,50 | low, medium, high | esquema | nombre estable | no antes de 2027-05-07 | |
| `gemini/gemini-3.5-flash-lite` | 0,30 / 2,50 | low, medium, high | esquema | nombre estable | sin anuncio | Su esfuerzo por defecto documentado (`minimal`) no está en la escala del código |
| `mistral/ministral-3b-2512` | 0,10 / 0,10 | ninguno | esquema | fijo | sin anuncio | |
| `mistral/ministral-8b-2512` | 0,15 / 0,15 | ninguno | esquema | fijo | sin anuncio | |
| `mistral/mistral-small-2603` | 0,15 / 0,60 | none, high | esquema | fijo | sin anuncio | La escala low/medium/high se documenta solo para Mistral Large 4 |
| `xai/grok-4.20-0309-non-reasoning` | 1,25 / 2,50 | ninguno | esquema | fijo | sin anuncio | Bajo 200.000 tokens de prompt. Es el único Grok del catálogo: en los que razonan, `max_completion_tokens` no acota el razonamiento |
| `deepseek/deepseek-flash` | **0,30 / 1,20** | none, low, high, max (high) | **solo modo JSON** | **alias móvil** | sin id fijo | Tarifa de pico; fuera de pico es la mitad. Servía `DeepSeek-V4.1-Flash-1017` al leerlo |
| `deepseek/deepseek-v4-pro` | **1,32 / 3,96** | none, low, high, max (high) | **solo modo JSON** | **alias móvil** | sin id fijo | Tarifa de pico. Servía `DeepSeek-V4-Pro-0813` al leerlo |
| `perplexity/openai/gpt-6-luna` | **0,125** / 0,50 | low, medium, high | esquema | nombre estable | sin anuncio | Dos encargados de datos: Perplexity y OpenAI. 0,125 por inferencia desde OpenAI |
| `perplexity/perplexity/glm-5.3-flash` | 0,15 / 0,50 | ninguno | esquema | nombre estable | sin anuncio | Razona; ver «Tope de gasto» |

`--effort` (por defecto `low`) se envía solo donde la columna de esfuerzo lo confirma. En los demás no viaja ningún nivel, rige el del modelo y el manifiesto registra `effort: null`. `--effort none` se rechaza con un `UsageError` si algún modelo pedido no lo documenta.

**Escritura en caché de `gpt-6-luna`: 1,25x.** El precio de lista de entrada es 0,10, pero desde GPT-5.6 la escritura en caché cuesta 1,25x y está activa por defecto, con un mínimo de 1.024 tokens. Como cada lote termina distinto, lo esperable es escribir sin reutilizar (inferencia), así que el catálogo cobra 0,125. Sobrestima algo los prompts cortos. Perplexity revende el mismo modelo; su esquema de uso tiene `cache_creation_cost` y no documenta la tarifa, así que se aplica el mismo 0,125 por inferencia.

**DeepSeek a tarifa de pico y solo con alias móviles.** El pico es de 01:00 a 04:00 y de 06:00 a 10:00 UTC, de lunes a viernes. El catálogo cobra siempre el pico para que el tope siga siendo un techo, así que el costo informado puede ser hasta el doble del real. Sin id fijo, lo medido hoy no es reproducible. `models --candidates` lo excluye.

**Fuera del catálogo, con razón:** Mistral Large 4 (Public Preview: entrena con tus datos aunque hayas optado por no hacerlo), los Grok que razonan (el razonamiento queda fuera del tope), `perplexity/sonar` (su función es buscar), `gpt-5-nano` (se apaga el 2026-12-11), Gemini 3.6 y 3.8 Flash (su precio se duplica el 2027-01-01) y `gemini-2.5-flash` y `gemini-2.5-pro` (se redirigen el 2026-12-01).

## Matriz de datos

Qué hace cada proveedor con lo que le envías. «Solo tú» es lo que ninguna API informa y se comprueba en la consola del proveedor. El texto de `providers.js` es el que la corrida imprime antes de enviar.

| Proveedor | ¿Entrena por defecto? | Retención | Retención cero | Región | Solo tú |
|---|---|---|---|---|---|
| Anthropic | No | **Las fuentes no coinciden**: el centro de privacidad dice 30 días; la documentación de la API dice que no se retiene por defecto. Contenido marcado por seguridad: hasta 2 años. **Puntajes de clasificación de seguridad: hasta 7 años** | Por acuerdo. Fable y Mythos exigen 30 días | Global; `inference_geo: "us"` cuesta 1,1x | Crear la clave para **un solo espacio de trabajo** |
| OpenAI | No, salvo que la organización opte por compartir | Registros contra abuso, que pueden contener prompts y respuestas, hasta 30 días | Con aprobación de ventas | Por proyecto, vía ventas (10 % más) | Que compartir datos esté apagado en la organización |
| Gemini | **Depende**: plan gratuito, sí, y personas pueden leerlo; plan de pago, no | Registros contra abuso; la política de uso dice 55 días, sin distinguir plan | No en esta API (remite a Vertex AI) | Cualquier país donde opere Google | Que la clave sea de un proyecto con **facturación activa**, y **restringirla a la API de Gemini** |
| Mistral | **Depende**: modo gratuito, sí; pago por uso, valor por defecto no documentado; modelos Preview o Labs, siempre | 30 días móviles contra abuso | Solo pago por uso, a pedido y a su discreción; no cubre Preview ni Labs | UE por defecto | Apagar «Anonymous improvement data» en Privacy y confirmar el modo de la cuenta |
| xAI | No sin permiso explícito | 30 días, cifrados, para auditoría | Interruptor de autoservicio por equipo; **cada respuesta trae `x-zero-data-retention`**: es la única política que una API deja verificar | Sin garantía en el endpoint por defecto | Decidir si activas la retención cero |
| DeepSeek | **Sí**: la política lista el entrenamiento como propósito; exclusión por correo. Ninguna página exime a la API | Mientras exista la cuenta | No documentada | **República Popular China**, bajo su ley | Pedir la exclusión a `privacy@deepseek.com` **antes** de enviar |
| Perplexity | No (no puede usar ni autorizar a terceros a usar tu contenido para entrenar) | Sin plazo publicado: varía por API, modelo y cuenta | Solo clientes elegibles, por acuerdo escrito | No documentada | Nada que la consola informe |

Notas:

- **Anthropic, retención larga.** El contenido marcado por el clasificador de seguridad puede guardarse hasta 2 años y los puntajes de clasificación, hasta 7 ([retención comercial](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [API y retención de datos](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)). Esa retención larga **no la agrega esta herramienta**, pero se aplica a lo que envías. Riesgo inferido, no documentado: si una negativa del clasificador cuenta como contenido marcado, un solo título puede arrastrar a los vecinos de su lote a la retención larga, y la bisección repite el envío. Medido contra el servidor falso, un título rechazado en un lote de 50 generó 13 llamadas y 7 peticiones rechazadas que llevaban 92 títulos ajenos. No se sabe si toda negativa cuenta como marcado. Una colección con marcadores de ML, seguridad o biología es donde esto puede ocurrir. Por eso el respaldo del servidor está apagado por defecto (`--fallback`) y cada negativa queda como `refusal` visible en lugar de reenviarse a otro modelo.
- **Gemini, plan gratuito.** Una clave gratuita funciona igual que una de pago y ninguna API distingue una de otra. Por eso Gemini exige consentimiento aunque tu cuenta sea de pago.
- **Esquema en caché.** Anthropic guarda los esquemas hasta 24 h aparte del contenido; por eso los nombres de carpeta viajan en el mensaje y no en el esquema.

## Riesgos de la primera llamada

Hasta la primera llamada real con cada proveedor (salvo Gemini 3.5 Flash-Lite), todo lo que depende de él está sin confirmar. Qué hacer antes y qué mirar, con una corrida mínima por proveedor (`--sample 20 --review 5 --max-usd 0.05`; ver [Quick start](quick-start.md#4-prueba-de-humo)). En todos: `served` igual al modelo pedido, costo coherente con la consola del proveedor.

| Proveedor | Antes de enviar | Riesgo concreto y qué mirar |
|---|---|---|
| **Anthropic** | Clave creada **para un solo espacio de trabajo** con límite de gasto propio: en el espacio por defecto no se puede fijar límite | Una clave que no es de un solo espacio exige la cabecera `anthropic-workspace-id`, que la herramienta no envía: falla en la primera llamada, sin gasto. Un 429 por límite de gasto propio (`enforced_spend_limit_reached`) no se reintenta |
| **OpenAI** | Compartir datos apagado en la organización | `gpt-6-luna` puede devolver un id con fecha: si ocurre, hay snapshot y el catálogo debería usarlo. `store: false` aceptado. Un 429 por saldo o límite agotado no se reintenta |
| **Gemini** | Proyecto con facturación activa. **Clave restringida a la API de Gemini**: «The Gemini API rejects requests from unrestricted standard keys» | Posible 4xx en la primera llamada. La capa compatible no documenta `max_tokens`, `finish_reason`, la negativa ni el uso: el código envía `max_tokens` de memoria. Un `finish_reason` fuera del mapa detiene el modelo con `Unexpected finish_reason`; una respuesta 200 sin `choices` (prompt bloqueado) lo detiene con `Response has no choices`. Los ids retirados se redirigen en silencio a otro modelo y se cobran a su tarifa |
| **Mistral** | «Anonymous improvement data» apagado y cuenta de pago por uso | Que acepte `json_schema` con `strict`. Con esfuerzo `high`, `message.content` es una lista de bloques `thinking` y `text`; con `none`, una cadena (el adaptador acepta ambas). La negativa no está documentada |
| **xAI** | Decidir la retención cero | `POST /chat/completions` figura como endpoint legado, sin fecha de retiro. El modelo no razona, así que el tope sí acota |
| **DeepSeek** | **Pedir la exclusión por correo** y aceptar que los datos van a China | Solo modo JSON: el esquema va en el prompt y nada lo impone, así que una respuesta mal formada cuesta un reintento y puede terminar en `missing`, lo que penaliza a DeepSeek en la medición. El razonamiento está encendido por defecto |
| **Perplexity** | Nada en la consola | Ver abajo |

**Perplexity y la búsqueda.** Usa la Agent API (`POST /v1/agent`, forma Responses) porque Sonar Chat Completions perdió soporte el 2026-09-27 y `disable_search` ya no está documentado. La documentación se **contradice**: dice que un modelo directo, sin `tools` y sin `effort` en la raíz, no busca, pero el ejemplo de su página de modelos pide un modelo directo sin `tools` y muestra `search_results` y `tool_calls_details`. Puede ser un ejemplo mal copiado; no se sabe. El adaptador nunca envía `tools` ni `effort` en la raíz (el esfuerzo va bajo `reasoning`, porque en la raíz selecciona un preajuste que sí busca). Si una herramienta corre de todos modos, el contenido ya salió: el error `Perplexity ran a tool such as a web search with the request content; stopping` lleva `stopsRun` y **detiene toda la corrida**, para no repetirlo con el lote siguiente. **Pendiente:** el cargo de esa búsqueda (medido en US$0,005 por búsqueda) no se suma al gasto, porque el error solo lleva tokens. Además, con un esquema nuevo la primera petición tarda de 10 a 30 s.

## Tope de gasto y `max_tokens`

El tope compara el **peor caso** de cada llamada (entrada estimada más `max_tokens`) con lo que queda. Eso solo es un techo si el proveedor respeta `max_tokens`:

| Proveedor | ¿`max_tokens` acota lo cobrado? |
|---|---|
| Anthropic | Sí, por documentación: el razonamiento cuenta contra `max_tokens` |
| OpenAI `gpt-6-luna` | Sí en salida: `max_completion_tokens` incluye el razonamiento |
| xAI `grok-4.20-0309-non-reasoning` | Sí: el modelo no razona |
| Mistral `ministral-*` | Sí en 3B (salida solo texto); 8B por inferencia |
| Perplexity `openai/gpt-6-luna` | Probable, por inferencia desde OpenAI |
| **DeepSeek** | **Sin confirmar**: razona por defecto y la documentación no dice si `max_tokens` incluye el razonamiento |
| **Gemini** | **Sin confirmar**: nativo, el corte es duro e incluye el razonamiento, pero la capa compatible ni siquiera nombra `max_tokens` |
| **Perplexity `glm-5.3-flash`** | **Sin confirmar**: es un modelo que razona |
| Mistral `mistral-small-2603` | **Sin confirmar**: razona y no se documenta si `max_tokens` lo incluye. **Pendiente:** su documentación dice que razona poco, no que no razone; con `--effort none` (que sí acepta) el reintento de un solo marcador puede truncarse |

**La duda se resuelve sola con una primera corrida barata.** Tras cobrar cada respuesta, si el proveedor devolvió más tokens de salida que el `max_tokens` pedido, la herramienta registra `cap_broken_by` (modelo, `max_tokens` y tokens devueltos), entrega esa respuesta ya pagada y **rechaza la llamada siguiente** con `BudgetExceededError`. La corrida termina con salida 2 y el reporte avisa. El exceso queda limitado a una llamada, de tamaño desconocido. Por eso la primera corrida de un proveedor con duda debe llevar `--sample 20 --review 5 --max-usd 0.05`: si termina sin `cap_broken_by`, el proveedor respetó el máximo en esas llamadas (no es una prueba general). Con DeepSeek, `--effort none` hace innecesaria la duda: sin razonamiento, `max_tokens` sí acota.

## Copilot no está

No hay una API de inferencia que un particular pueda usar con su propia credencial para este caso, en ninguna de sus cuatro variantes:

| Producto | Por qué no entra |
|---|---|
| GitHub Models | Retirado el 2026-07-30, incluida la API de inferencia |
| GitHub Copilot | Sin endpoint HTTP de inferencia documentado. Solo un SDK que controla la CLI de Copilot como proceso hijo: no hay `fetch` posible, no corre en una extensión y rompe «sin dependencias». Los planes Free, Pro, Pro+ y Max pueden usarse para entrenar desde el 2026-04-24 salvo que lo desactives |
| Microsoft Copilot (consumo) | Sin API documentada en las páginas oficiales |
| Microsoft 365 Copilot | Chat API en vista previa, con licencia empresarial por usuario; devuelve texto libre, sin esquema, sin elección de modelo y sin tokens documentados |

El BYOK de Copilot va en sentido contrario: es Copilot usando tus claves de otro proveedor. Copilot no está en el registro, así que nada puede enviarle marcadores. `eval.mjs models --provider copilot` imprime la razón; `--models copilot/...` responde `Unknown model`, sin la explicación.

## Fuentes

Leídas el 2026-11-05. Cada dato de esta página sale de una de ellas.

- **Anthropic:** [precios](https://platform.claude.com/docs/en/about-claude/pricing), [modelos](https://platform.claude.com/docs/en/models/overview), [retiros](https://platform.claude.com/docs/en/about-claude/model-deprecations), [salida estructurada](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [retención de datos](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [retención comercial](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [entrenamiento](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training), [negativas y respaldo](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback), [esfuerzo](https://platform.claude.com/docs/en/build-with-claude/effort), [errores](https://platform.claude.com/docs/en/api/errors), [autenticación](https://platform.claude.com/docs/en/manage-claude/authentication), [espacios de trabajo](https://platform.claude.com/docs/en/manage-claude/workspaces).
- **OpenAI:** [precios](https://developers.openai.com/api/docs/pricing), [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna), [retiros](https://developers.openai.com/api/docs/deprecations), [datos](https://developers.openai.com/api/docs/guides/your-data), [salida estructurada](https://developers.openai.com/api/docs/guides/structured-outputs), [caché de prompts](https://developers.openai.com/api/docs/guides/prompt-caching), [errores](https://developers.openai.com/api/docs/guides/error-codes), [referencia de chat](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
- **Gemini:** [precios](https://aistudio.google.com/docs/pricing), [modelos](https://aistudio.google.com/docs/models), [retiros](https://aistudio.google.com/docs/deprecations), [capa compatible con OpenAI](https://aistudio.google.com/docs/openai), [términos](https://aistudio.google.com/docs/terms), [política de uso](https://aistudio.google.com/docs/usage-policies), [razonamiento](https://aistudio.google.com/docs/thinking), [claves](https://aistudio.google.com/docs/api-key), [errores](https://aistudio.google.com/docs/api-errors), [retención cero](https://aistudio.google.com/docs/zdr).
- **Mistral:** [precios](https://docs.mistral.ai/inference/pricing), [modelos](https://docs.mistral.ai/getting-started/models/models_overview/), [razonamiento](https://docs.mistral.ai/studio/conversations/reasoning), [términos comerciales](https://legal.mistral.ai/terms/commercial-terms-of-service/) (vigentes desde 2026-09-25), [entrenamiento](https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models), [exclusión](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training), [retención cero](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention), [política de privacidad](https://legal.mistral.ai/terms/privacy-policy/), [errores](https://docs.mistral.ai/resources/error-glossary).
- **xAI:** [modelos](https://docs.x.ai/developers/models), [precios](https://docs.x.ai/developers/pricing), [referencia de chat](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions), [razonamiento](https://docs.x.ai/developers/model-capabilities/text/reasoning), [seguridad y datos](https://docs.x.ai/developers/faq/security), [`grok-4.20-0309-non-reasoning`](https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning).
- **DeepSeek:** [precios y modelos](https://api-docs.deepseek.com/quick_start/pricing), [modo JSON](https://api-docs.deepseek.com/guides/json_mode), [chat](https://api-docs.deepseek.com/api/create-chat-completion), [razonamiento](https://api-docs.deepseek.com/guides/thinking_mode), [errores](https://api-docs.deepseek.com/quick_start/error_codes), [privacidad](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) (actualizada 2026-02-10), [términos](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html).
- **Perplexity:** [modelos y precios](https://docs.perplexity.ai/docs/agent-api/models), [Agent API](https://docs.perplexity.ai/api-reference/agent-post), [migración desde Sonar](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to), [salida estructurada](https://docs.perplexity.ai/docs/agent-api/output-control), [privacidad](https://docs.perplexity.ai/docs/resources/privacy-security), [términos de la API](https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service), [modelos de terceros](https://www.perplexity.ai/hub/legal/third-party-models).
- **Copilot:** [GitHub Models](https://docs.github.com/en/github-models/about-github-models), [SDK de Copilot](https://github.com/github/copilot-sdk/blob/main/README.md), [políticas de datos](https://docs.github.com/copilot/how-tos/manage-your-account/managing-copilot-policies-as-an-individual-subscriber), [Microsoft 365 Copilot APIs](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/copilot-apis-overview).
- **Extensión de Chrome (para M1 en adelante):** [solicitudes de red](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [permisos](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [ciclo de vida del service worker](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
