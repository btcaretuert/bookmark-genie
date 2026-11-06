# FAQ

## Sobre el estado actual

### ¿Ya puedo instalarlo en Chrome?

Sí. La extensión 0.5.1 se carga desde una copia privada con «Cargar descomprimida»: [Usar la extensión](quick-start.md#usar-la-extensión). Está apagada hasta que la actives en los ajustes. Hay además una herramienta de evaluación por línea de comandos (M0). Los hitos M0, M1 y M2 están hechos; M3 a M6 no, y «Ordenar sueltos» es una versión reducida de M4.

### ¿Está probado contra las APIs reales?

Solo en parte. **Gemini 3.5 Flash-Lite**, en el plan gratuito, se probó con la corrida real de M0 (20 de 20 aceptados sobre una colección de 62 marcadores, 29 enviables). Los otros seis proveedores no, y los prompts de Ctrl+D y de «Ordenar sueltos» corrieron solo contra servidores locales que imitan la documentación. La extensión 0.5.1 se probó a mano en un Chrome real con ese proveedor y en headless con uno simulado: [Pruebas reales](pruebas-reales.md). Detalle: [Sin verificar](decisiones.md#sin-verificar).

### ¿La extensión puede cambiar o borrar mis marcadores?

Puede **mover** marcadores y crear carpetas, solo si la activas, y por defecto solo tras tu confirmación («Confirmar antes de mover»). Todo movimiento queda en un diario con su «Deshacer». **No borra marcadores** en el flujo normal; la única excepción es «Quitar el duplicado nuevo», que borra el marcador que acabas de guardar si ya tenías esa URL, a petición tuya. La herramienta de evaluación, en cambio, no tiene acceso a Chrome: lee una exportación HTML.

### ¿Por qué hay una carpeta `extension/` que también usa la evaluación?

Porque el núcleo se escribe una sola vez. La evaluación mide el mismo núcleo que corre en la extensión ([cómo se comparten](arquitectura-alto-nivel.md#cómo-comparte-el-núcleo-con-tools)).

### ¿Por qué «Confirmar antes de mover» viene encendido, y cuándo conviene el automático?

Porque la precisión de Ctrl+D no se midió antes de construirlo, y un movimiento equivocado donde nadie revisa cuesta más que un clic. Con el modo encendido, toda respuesta de la IA es una propuesta con un botón «Mover». La extensión **sugiere pasar a automático** cuando has aceptado al menos 20 propuestas sin cambios y corregido a lo más 1 (los totales no se reinician, y «Ordenar sueltos» no cuenta). Es una sugerencia: en automático solo mueve cuando la IA dice «carpeta existente» con confianza alta, y todo se puede deshacer. La medición con [`autosort-check`](quick-start.md#medir-el-prompt-con-autosort-check) puede **rechazar** el prompt, pero con 29 marcadores enviables no puede certificar el 95 %.

### ¿Por qué me pidió de nuevo el consentimiento?

Porque el texto del consentimiento dice exactamente qué sale, y cuando sale más, se vuelve a pedir. En la 0.5.1 pasó a **v3**, porque ahora se envían las rutas completas de las carpetas, de cualquier profundidad. Si vienes de una versión anterior, marca la casilla de nuevo en Ajustes y guarda; mientras tanto Ctrl+D queda pausada.

### ¿Gemini gratuito usa lo que envío?

Sí puede: en el plan gratuito, según su política, se usa para mejorar productos y personas pueden leerlo. Ninguna API dice en qué plan estás, por eso Gemini siempre pide consentimiento. Con Ctrl+D se envían títulos, URL reducidas, nombres de carpeta, ejemplos y sueltos: es más que en M0. Para uso diario, una clave de un proyecto con facturación activa u otro proveedor ([matriz de datos](proveedores.md#matriz-de-datos)), y las carpetas sensibles en «Carpetas excluidas».

### ¿Qué no hace todavía?

Búsqueda difusa, abrir en bloque, renombrar y borrar (M3); duplicados masivos y enlaces muertos (M5); etiquetas (M6); orden masivo con reanudación (M4); **restaurar desde un respaldo** (se descarga, pero ningún botón lo aplica); y Anthropic dentro de la extensión. Ver [Troubleshooting](troubleshooting.md#qué-no-hace-todavía).

### ¿Qué pasa si desinstalo la extensión?

Chrome borra su almacenamiento: la clave, los ajustes, el diario y las propuestas. Tus marcadores quedan donde estén. Por eso «Respaldar ahora» descarga archivos: son la copia que sobrevive.

### ¿Cuánto cuesta usar Ctrl+D?

Una llamada de 1 a 1,5 mil tokens por marcador guardado en una raíz, con tope diario de 50 llamadas (editable) y US$0,10 calculados a tarifa de pago. En el plan gratuito de Gemini es US$0, con los límites por minuto y por día del plan.

### ¿La evaluación puede cambiar o borrar mis marcadores?

No. Lee una copia exportada a HTML y no tiene acceso a Chrome.

## Funcionamiento

### ¿Es un script? ¿Corre en segundo plano?

La evaluación es un comando que termina al completar su trabajo. La extensión no tiene demonio ni servidor: funciona solo con Chrome abierto. Ctrl+D activa un service worker por unos segundos (espera 8 s, llama al proveedor con un plazo de 20 s y termina), y «Ordenar sueltos» corre en ese mismo worker.

### ¿Puedo reanudar una corrida que se detuvo?

No. Lo pagado queda en disco (`assignments-*.jsonl`, `taxonomy-*.json`, `manifest.json`), pero repetir `run` es una corrida nueva, con otro `--out`, que vuelve a pagar. La reanudación sería de M4. Ver [Troubleshooting](troubleshooting.md#la-corrida-se-detuvo-y-no-se-reanuda).

### ¿Qué pasa si presiono Ctrl+C?

Con `SIGINT`, `SIGTERM` o `SIGHUP` (por ejemplo, al cerrar la terminal), la corrida abandona la llamada en vuelo, que aún puede facturarse, escribe el manifiesto, el reporte y los CSV de los modelos completos, y sale con 130. Una segunda señal sale de inmediato.

### ¿Distingue los marcadores de cada perfil de Chrome?

Sí, por diseño. La evaluación procesa la exportación que le entregues, y cada perfil exporta la suya. En la extensión, cada perfil tiene su propia instalación, clave, diario y respaldos, y solo ve sus marcadores. Como consecuencia, no hay vista unificada, duplicados cruzados ni traslados entre perfiles. Dentro de un perfil, los marcadores locales y los de la cuenta no se mezclan: nada cruza de uno a otro.

### ¿Por qué no edita directamente el archivo `Bookmarks`?

Porque no permite reaccionar a Ctrl+D, y Chromium reparte los datos entre varios archivos. También hay reportes de que el navegador solo lee el archivo al arrancar y luego lo sobrescribe.

### ¿Se ejecutan varios flujos a la vez?

En la evaluación, no: todo corre en serie, hay una sola llamada en vuelo y cada decisión toma una sola salida. En la extensión sí pueden coincidir eventos (dos Ctrl+D seguidos, el worker y la ventana); un candado de `navigator.locks` evita que se pisen al escribir. La convención está en [Cómo leer los diagramas](funcionalidades.md#cómo-leer-los-diagramas).

### ¿La IA puede dañar mis URL?

No. Al clasificar solo responde con números de marcador y carpeta y un nivel de confianza, y la herramienta los valida localmente. Al proponer carpetas devuelve nombres y descripciones, pero ese texto nunca reemplaza una URL ni un título.

### ¿Qué significa `__unsorted__`?

Que el modelo consideró que ninguna carpeta servía. No se convertirá en una carpeta real. Es distinto de `(unclassified)`, que indica que no hubo una respuesta válida. Ninguno de los dos se juzga en el puntaje: cuentan como no aceptados.

## Proveedores y modelos

### ¿Qué proveedores puedo usar?

Anthropic, OpenAI, Gemini, Mistral, xAI, DeepSeek y Perplexity, con el modelo exacto del [catálogo](proveedores.md#matriz-de-modelos). Eliges con `--models proveedor/modelo`, que es obligatorio salvo con `--dry-run`: no hay modelo por defecto. Un modelo fuera del catálogo se rechaza antes de gastar, porque sin precio el tope no se sostendría.

### ¿Y un modelo local, o Copilot?

Un modelo local no está. **Copilot no está** porque ninguna de sus variantes ofrece una API de inferencia que un particular pueda usar con su propia credencial: GitHub Models se retiró el 2026-07-30, el SDK de GitHub Copilot controla una CLI local, Microsoft Copilot no documenta API y Microsoft 365 Copilot exige licencia empresarial y no da esquema. Detalle en [Proveedores](proveedores.md#copilot-no-está).

### ¿Qué credencial lee cada proveedor?

Solo su variable: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` o `PERPLEXITY_API_KEY`. Nada más se lee como credencial. Las variables `*_BASE_URL` solo aceptan loopback, para pruebas.

### ¿Por qué me pide `--accept-data-policy`?

Porque Gemini, Mistral y DeepSeek entrenan con los datos de la API (DeepSeek) o pueden hacerlo según el plan de tu cuenta (Gemini, Mistral), y ninguna API informa en qué plan estás. Antes de enviar se imprime la política con su fuente. Ver [Troubleshooting](troubleshooting.md#the-data-policy-of-ids-needs-your-explicit-consent-add---accept-data-policy-id).

### ¿Qué no puede decirme la API sobre un modelo?

La política de datos, el plan de tu cuenta, el precio (salvo en xAI), si el id es fijo, y cómo se comporta ante una negativa. `models --check` solo compara los ids con el listado de cada proveedor y no detecta cambios de precio ni de política. Ver [la tabla](proveedores.md#qué-no-se-puede-saber-por-api).

### ¿Qué significa «el modelo que respondió no es el pedido»?

Que el proveedor contestó con otro modelo (una redirección de un id retirado, por ejemplo). La corrida lo avisa, `report.md` lo marca y `score` baja el brazo a `GRAY`: lo medido no es el modelo que querías. Bajo el alias móvil de DeepSeek el id servido se muestra sin bajar el veredicto, porque se espera que cambie.

## Privacidad y seguridad

### ¿Qué ve el proveedor?

Con la extensión, qué sale y cuándo está en [Qué envía la extensión y cuándo](arquitectura-alto-nivel.md#qué-envía-la-extensión-y-cuándo); «Ver qué se envió», en Ajustes, muestra lo último. En la evaluación: títulos (con correos, URL y tokens enmascarados), dominios, partes legibles de las rutas y nombres de carpetas. Nunca query ni credenciales. Los hosts privados y las IP se excluyen. **El saneamiento es heurístico**: nombres de personas, salud o finanzas en un título salen tal cual, y en un corpus reservado todavía pasan 8 de 34 secretos sintéticos. El detalle y los límites están en [Qué sale a la nube](arquitectura-alto-nivel.md#qué-sale-a-la-nube).

### ¿Cómo evito que salgan ciertas carpetas?

Con `--exclude-folder <regex>`, repetible: nunca envía marcadores cuya ruta de carpeta coincida (sin distinguir mayúsculas). Revisa antes `payload-preview.jsonl` con un `--dry-run`. Si un patrón no coincide con ninguna carpeta, en una corrida real es un error antes de enviar nada; en `--dry-run` solo advierte.

### ¿Usan mis marcadores para entrenar?

Depende del proveedor y se resume en la [matriz de datos](proveedores.md#matriz-de-datos). Anthropic, OpenAI, xAI y Perplexity no entrenan por defecto; Gemini y Mistral dependen de la cuenta; DeepSeek entrena salvo que pidas la exclusión por correo y guarda los datos en China.

### ¿Cuánto retiene Anthropic?

Según el centro de privacidad, 30 días (la documentación de la API dice que no retiene por defecto; las fuentes no coinciden). El contenido marcado por seguridad puede guardarse hasta 2 años y los puntajes de clasificación de seguridad, hasta 7. Riesgo inferido, no documentado: un título que dispare una negativa podría arrastrar a los vecinos de su lote a la retención larga. Por eso el respaldo del servidor está apagado y la bisección se limita al lote. Ver [Retención en Anthropic](arquitectura-alto-nivel.md#retención-en-anthropic).

### ¿Dónde se guarda la clave?

En la evaluación, solo en la variable de entorno de tu shell; el manifiesto guarda únicamente los últimos 4 caracteres. En la extensión, en `chrome.storage.local`, sin cifrar en el perfil y nunca en `storage.sync`; la ventana solo muestra los últimos 4 caracteres, y «Borrar clave» la quita. Por eso conviene una clave solo para esto, con límite de gasto.

### ¿Un título malicioso puede controlar la herramienta?

Es muy limitado. El modelo no tiene herramientas y `<` se escapa en el prompt. Lo peor esperable es una clasificación errónea o un nombre de carpeta inadecuado. Perplexity es el único caso con una ruta hacia una herramienta (búsqueda web): el adaptador nunca la pide y, si corre, detiene la corrida.

### ¿Puedo compartir `eval-out/`?

No sin revisarla, porque contiene títulos y URL reducidas. Por eso está excluida en `.gitignore`, y la herramienta crea el directorio con modo 700 y los archivos con 600, y se niega a reutilizar un `--out` existente. El directorio del proyecto es compartido con otras cuentas: para la corrida real usa un `--out` privado y, idealmente, una copia privada del proyecto.

## Costos y modelos

### ¿Cuánto cuesta?

`--dry-run` imprime un estimado por modelo, sin razonamiento. Con el export sintético de 2.000 marcadores y la muestra por defecto de 300, la evaluación sale del orden de un centavo con Haiku 5.5 y de unos US$0,23 con Opus 5.5. El costo real aparece en `report.md`, y los precios, con fecha y fuente, en [Proveedores](proveedores.md#matriz-de-modelos).

### ¿Puede gastar más que el tope?

Sí, de varias formas:

- [El uso real puede superar lo estimado](troubleshooting.md#el-gasto-supera-el-tope), porque la comprobación previa usa tokens de entrada estimados.
- Un proveedor que no respeta `max_tokens` (DeepSeek, Gemini y `glm-5.3-flash` son los dudosos) puede devolver más salida de la pedida. La guardia lo detecta (`cap_broken_by`, salida 2) pero el exceso de una llamada ya se pagó.
- Una respuesta servida por otro modelo se cobra a su tarifa solo si está en el catálogo del mismo proveedor.
- Una llamada que pudo facturarse sin respuesta se cobra al peor caso (`lost_usd`): esto infla el total, no lo reduce.

El límite de gasto de la consola del proveedor es la protección final.

### ¿Mi suscripción a Claude o ChatGPT cubre el uso?

No debería: la API se factura aparte. Es un dato de memoria, así que confírmalo al crear la clave.

### ¿Qué modelo conviene?

Aún no se sabe. Lo decide tu corrida, comparando aceptación, costo y latencia; entre los que aprueben, `score` elige el más barato. Mi expectativa es que un modelo barato alcance, pero no está medido.

## Evaluación

### ¿Por qué el objetivo es 85 %?

Es un umbral fijado en el plan como criterio de decisión, no una cifra derivada de datos. Con 100 filas el intervalo de Wilson al 95 % mide unos 14 puntos de ancho, así que `score` solo da `PASS` con 85 % o más, `FAIL` con 77 % o menos, y `GRAY` entre medio.

### ¿Qué considero «aceptable»?

`y` si esperarías encontrar el marcador en esa carpeta; `n` si lo moverías o no lo decides en 15 segundos. Fíjalo antes de ver resultados y úsalo igual para todos los brazos. Con `blind` no ves qué modelo propuso qué.

### ¿Por qué hay filas repetidas en la lista ciega?

Un par de cada diez se repite (hasta 10) lejos de su original. Si cambias el juicio en 2 o más, tu criterio no es estable y las diferencias de menos de 10 filas son empate.

### ¿Por qué evaluar un modelo caro si no lo voy a usar?

Porque sirve de referencia: si el barato queda muy por debajo, la diferencia indica cuánta calidad se pierde, y su taxonomía separa el efecto de las carpetas del de la clasificación. A escala personal, la diferencia también puede ser poco dinero.

### ¿Qué pasa si queda en zona gris?

`score` dice `Decision: not yet`. No concluyas: edita la taxonomía o sube el esfuerzo, repite solo lo que cambia y pasa la lista ya juzgada con `--previous`; solo juzgas los pares nuevos.
