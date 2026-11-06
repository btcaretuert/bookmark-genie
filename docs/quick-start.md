# Quick start

Este manual tiene dos partes. [Usar la extensión](#usar-la-extensión) (0.5.1) te lleva paso a paso desde instalarla hasta deshacer un movimiento. Después viene el [protocolo de M0](#protocolo-de-evaluación-m0), que mide cómo clasifican uno o varios modelos una muestra de tus marcadores **sin modificarlos**, y la [medición de Ctrl+D](#medir-el-prompt-con-autosort-check).

> **Solo Gemini 3.5 Flash-Lite se ha probado con una corrida real** (M0, plan gratuito, 20 de 20 aceptados sobre 62 marcadores). Los otros seis proveedores y la extensión 0.4.0 o posterior no se han probado contra una API real: las pruebas usan servidores locales que imitan la documentación. Tu primera corrida con cada proveedor es su primera prueba real.

## Usar la extensión

Hazlo en la cuenta del sistema donde usas Chrome y con Chrome 134 o superior.

1. **Instala desde una copia privada.** Si otras cuentas pueden escribir en la carpeta del repositorio (por ejemplo, un grupo compartido), cualquiera de ellas podría cambiar código que Chrome ejecuta. Por eso conviene cargar una copia tuya, aunque seas el único usuario:

   ```bash
   rsync -a --delete extension/ ~/bookmark-genie-extension/ && chmod -R go-w ~/bookmark-genie-extension
   ```

   En `chrome://extensions`, activa «Modo de desarrollador» (arriba a la derecha), pulsa «Cargar descomprimida» y elige `~/bookmark-genie-extension`, la carpeta que contiene `manifest.json`. Debe decir versión **0.5.1**. Se abre sola la página de ajustes. Conviene fijar el ícono (menú de la pieza de rompecabezas).

   **Para actualizar,** repite el mismo `rsync` y pulsa el botón de recarga (↻) de Bookmark Genie. La clave y los ajustes se conservan, el diario y las propuestas también. Si vienes de 0.5.0 o anterior, **el consentimiento sube a v3** (ahora salen las rutas completas de las carpetas): marca la casilla otra vez en Ajustes y guarda, o Ctrl+D quedará pausada con «falta aceptar la política de datos».

2. **Configura el proveedor.** En la página de ajustes («Orden automático (Ctrl+D)»):
   - **Modelo:** por defecto, `gemini-3.5-flash-lite`. Los modelos de Anthropic aparecen como «próximamente», y `gemini-2.5-flash-lite` como no disponible para cuentas nuevas.
   - **Clave:** pégala y se guarda al pulsar «Guardar». La página solo vuelve a mostrar sus últimos 4 caracteres. Se guarda sin cifrar en el perfil: usa una clave solo para esto, con límite de gasto.
   - **Política y consentimiento:** lee las tres líneas (y la política completa, plegable) y marca la casilla. **Gemini en plan gratuito usa lo que recibe para mejorar productos y personas pueden leerlo**; para uso diario, usa un proyecto con facturación activa u otro proveedor.
   - **Contexto:** «Completo» envía además nombres de carpeta con ejemplos y sueltos; «Solo el marcador y los nombres de tus carpetas» envía menos.
   - **Carpetas excluidas:** marca las que nunca deben salir (ni el nombre ni su contenido).
   - **Confirmar antes de mover** viene marcado. Déjalo así.
   - Marca **Activar** y pulsa «Guardar». Chrome pide dos permisos: leer la pestaña activa (lo muestra como «historial de navegación») y conectar con el proveedor. Acéptalos. Si los rechazas, queda guardado pero pausado, y la ventana ofrece «Reparar».

3. **Prueba la clave.** Pulsa «Probar la clave». Hace una llamada mínima con un marcador de prueba, sin datos tuyos. Cuenta en el tope diario. Debe decir «La clave funciona». Si no, el texto dice qué hacer: [Troubleshooting](troubleshooting.md#errores-de-la-extensión).

4. **Guarda una página con Ctrl+D.** Abre una página pública, pulsa Ctrl+D, **no cambies la carpeta** (déjala en la barra, en Otros o en Celular) y pulsa «Listo». Espera unos 10 s: la extensión espera 8 s para que puedas elegir carpeta. Una página guardada dentro de una subcarpeta no se ordena.

5. **Revisa la propuesta.** La insignia del ícono muestra un número. Abre la ventana: en «Por revisar» verás «¿Mover a «X»?» o una carpeta nueva con los sueltos que irían en ella.
   - «Mover» (o «Crear y mover N») aplica; puedes cambiar el nombre, desmarcar sueltos o elegir «Otra carpeta…».
   - «Dejar como está» la descarta.
   - Si en «Actividad reciente» aparece «Dejado» o «Error», el motivo está al lado: ver [los motivos](troubleshooting.md#motivos-por-los-que-un-marcador-se-queda-donde-está).

   Con «Confirmar antes de mover», **nada se mueve sin tu clic**. Cuando hayas aceptado 20 propuestas sin cambios y corregido a lo más 1, la ventana te sugerirá pasar a automático; es opcional, y se puede volver.

6. **Deshaz.** En «Actividad reciente», o en la franja que aparece arriba tras aceptar, pulsa «Deshacer»: el marcador vuelve a su lugar y la carpeta que se creó se borra si quedó vacía. Revisa en `chrome://bookmarks`.

7. **Ordena los sueltos** (opcional). En «Ordenar sueltos», elige una carpeta (por ejemplo, la barra) y pulsa «Ordenar sueltos». Lee la confirmación: cuántos marcadores salen, a quién, con los nombres de tus carpetas, cuántas llamadas hará y qué se omite y por qué. Hasta que pulses «Enviar N y proponer» no sale nada. Las propuestas llegan a «Por revisar»; «Aceptar todas» aplica todo como **un solo cambio** y un «Deshacer» lo revierte entero.

8. **Respalda.** Pulsa «Respaldar ahora»: descarga `bookmark-genie-<fecha>.html` (Chrome lo importa) y `bookmark-genie-<fecha>.backup@1.json`. Si Chrome pregunta si permites varias descargas, elige «Permitir». Guárdalos en un lugar privado: contienen tus URL completas. La ventana te recuerda respaldar tras 14 días. **Aún no hay botón para restaurar**: el HTML se importa desde Chrome.

Para apagarla, desmarca «Activar» y guarda: la extensión devuelve el permiso de pestañas y los de los demás proveedores.

## Protocolo de evaluación (M0)

## Requisitos

- Dependencias instaladas con `npm ci`. Incluyen Node 26.13.0 local (paquete `node-linux-x64`). El Node del sistema no sirve (hoy es 18.19.1; el mínimo es 20.12.0). Ejecuta siempre con `npm run eval --`, que antepone el Node local al `PATH`.
- Solo probado en Linux.
- Tus marcadores exportados a HTML.
- Una clave por cada proveedor que evalúes. Se factura aparte de cualquier suscripción de consumo (por ejemplo, la de Claude o ChatGPT). Qué variable lee cada uno, y qué debes confirmar en su consola: [Proveedores](proveedores.md#credenciales-y-destino).
- **Un lugar privado para trabajar.** Si otras cuentas pueden escribir en el directorio del proyecto (por ejemplo, un grupo compartido con modo 775), quien pueda escribir en él puede reemplazar `tools/` y ejecutar su código con tu clave en el entorno; ningún chequeo de la herramienta lo impide. Para la corrida real:
  - guarda la exportación en un directorio con modo 700 de tu cuenta (`install -d -m 700 <carpeta-privada>`);
  - pasa siempre un `--out` dentro de ese directorio;
  - idealmente, corre desde una copia del proyecto en ese mismo directorio. Es la única medida que cierra el caso (ver [Decisiones](decisiones.md#escritura-de-archivos)).

## Protocolo

Los tiempos son **estimados, no medidos**: salen del número de llamadas y de supuestos, no de una corrida real.

| Paso | Qué haces | Tiempo (estimado) |
|---|---|---|
| 0 | Fijas el criterio y la regla antes de ver resultados | 5 min |
| 1 | Exportas | 2 min |
| 2 | `--dry-run` y revisión de lo que saldría | 15 min la primera vez |
| 3 | Cargas claves y consentimientos | 5 min |
| 4 | Prueba de humo por proveedor | 5 min cada una |
| 5 | Corrida: tres brazos | Unos minutos por brazo: 1 llamada de carpetas más 6 de lotes, a la latencia de cada proveedor |
| 6 | Revisión de `report.md`, sin juzgar | 10 min |
| 7 | `blind` y juicio ciego | Unos 40 min para unas 230 filas, a 10 s por fila (supuesto) |
| 8 | `score` y decisión | 5 min |
| 9 | Si queda en zona gris: brazos nuevos y solo lo nuevo se vuelve a juzgar | Hasta 15 min (estimado) |

### 0. Fija el criterio y la regla

Antes de ver un solo resultado, escribe en un `decision.md` el criterio de juicio y la regla del paso 8. Si lo decides después de ver los números, el umbral se acomoda a ellos.

Criterio de juicio: **`y` si esperarías encontrar el marcador en esa carpeta; `n` si lo moverías o no lo decides en 15 segundos.** Úsalo igual para todos los brazos.

### 1. Exporta los marcadores

En `chrome://bookmarks`, abre el menú ⋮ y elige **Exportar marcadores**. Guarda el archivo en tu directorio privado y legible solo por ti:

```bash
chmod 600 <carpeta-privada>/bookmarks.html
```

### 2. Revisa qué saldría

No necesita clave ni red. Con `--dry-run`, `--models` es opcional (sin él no hay estimado por modelo ni `manifest.json`):

```bash
cd <ruta-al-repositorio>
E=<carpeta-privada>/bookmarks.html
BARATO=anthropic/claude-haiku-5-5
REFERENCIA=anthropic/claude-opus-5-5
npm run eval -- run --input $E --seed 1 --sample 300 --review 100 \
  --models $BARATO,$REFERENCIA --dry-run --out <carpeta-privada>/vista
```

`BARATO` y `REFERENCIA` son solo un ejemplo: pon los modelos que elijas (`npm run eval -- models --candidates` y la [matriz](proveedores.md#matriz-de-modelos)). Los comandos son iguales con cualquier proveedor.

La consola imprime primero la política de datos de cada proveedor, con su fuente y su fecha de lectura, y luego (ejemplo con 2.000 marcadores sintéticos):

```text
Bookmarks in export: 2000
Never sent: 0 (none)
Data quality (counts): exact duplicates 0, empty titles 0, title equal to URL 0, URL reduced to the host 0
Folder sample: 150. Classification sample: 300 in 6 batches. To review: 100.
Estimated tokens, without reasoning: 27867 in / 5700 out
  anthropic/claude-haiku-5-5: about US$0.0056
  anthropic/claude-opus-5-5: about US$0.2255
Spending cap: US$1.0000
Preview of the titles and URLs that would leave, as the model would see them: .../vista/payload-preview.jsonl
Existing folder names that would leave: .../vista/existing-folders.json
The preview is not the literal request: the request adds the prompt, the folder list and the schema.
Destination: anthropic/claude-haiku-5-5 -> https://api.anthropic.com
Destination: anthropic/claude-opus-5-5 -> https://api.anthropic.com
Dry run: nothing was sent.
```

El estimado no incluye razonamiento. Revisa dos archivos:

- **`payload-preview.jsonl`**: una línea por marcador de las dos muestras (la de carpetas, hasta 150, y la de clasificación): `id`, `title` tal como lo vería el modelo, `url` reducida, `in_taxonomy_sample` e `in_review`. Con `--taxonomy` solo trae la muestra de clasificación.
- **`existing-folders.json`**: hasta 60 nombres de tus carpetas actuales (los más poblados, a 2 niveles) que viajan en la petición de carpetas. No existe con `--taxonomy`.

Busca lo que no quieras enviar: nombres de personas, salud, finanzas, clientes, tokens cortos. **El saneamiento es heurístico y tiene límites conocidos** (ver [Qué sale a la nube](arquitectura-alto-nivel.md#qué-sale-a-la-nube)): en un corpus reservado de prueba, todavía pasan 8 de 34 secretos sintéticos dentro de títulos o URL. Lo semántico (nombres, salud) no se puede enmascarar con patrones.

Para excluir carpetas completas, repite `--exclude-folder <regex>` las veces que necesites. Compara sin distinguir mayúsculas contra la ruta completa de la carpeta (`Barra/Banca/Cuentas`); los marcadores excluidos se cuentan en `Never sent` como `excluded-folder`. Si un patrón no coincide con ninguna carpeta, en una corrida real **es un error antes de enviar nada** (`--exclude-folder "..." matches no folder, so it excludes nothing. Check it for a typo. Nothing was sent.`, salida 1, sin crear el directorio): un error de tipeo en un filtro de privacidad no debe terminar en un envío. Con `--dry-run` solo advierte. Después de cambiar los patrones, repite el dry run con un `--out` nuevo.

### 3. Carga las claves y acepta las políticas

`read -s` evita que la clave quede en el historial. Una variable por proveedor:

```bash
read -rs ANTHROPIC_API_KEY; export ANTHROPIC_API_KEY
```

Haz antes lo que la consola dice que solo tú puedes comprobar (línea `Only you can check`), por ejemplo, crear la clave de Anthropic para un solo espacio de trabajo y con límite de gasto propio. Si usas Gemini, Mistral o DeepSeek, agrega `--accept-data-policy <proveedor>` a cada `run`; sin eso termina antes de enviar nada. Detalle y variables: [Proveedores](proveedores.md).

### 4. Prueba de humo

Una corrida mínima por proveedor, con tope bajo. Comprueba que la clave, el modelo y el formato de la respuesta funcionan, y despeja la duda de `max_tokens` de [los proveedores que la tienen](proveedores.md#tope-de-gasto-y-max_tokens):

```bash
npm run eval -- run --input $E --seed 1 --sample 20 --review 5 --models $BARATO \
  --max-usd 0.05 --out <carpeta-privada>/humo-barato
npm run eval -- run --input $E --seed 1 --sample 20 --review 5 --models $REFERENCIA \
  --max-usd 0.20 --out <carpeta-privada>/humo-referencia
```

El tope debe cubrir el peor caso de **una llamada**, o la guardia detiene la corrida con `Next call could exceed the US$0.0500 cap`. Calculado con el export sintético y `--effort low`, una llamada de carpetas cuesta como máximo US$0,003 con Haiku 5.5 y US$0,12 con Opus 5.5; una de lote, US$0,0025 y US$0,10. Por eso Opus lleva 0,20. Con otros modelos, calcula el peor caso con el precio de la [matriz](proveedores.md#matriz-de-modelos) y sube `--max-usd` si la guardia dispara.

Debe cumplirse todo esto:

- Salida 0, y `M0 completeness: PASS (missing=0, not attempted=0)`.
- En `report.md`, `Models that answered (calls)` nombra el modelo que pediste. Si nombra otro, la corrida lo avisa (`was answered by ..., not by the model asked for`) y `score` no lo dejará aprobar: baja a `GRAY` si otro modelo aparece en `served` (por asignación) o en `answered_by` (por llamada, taxonomía incluida).
- Sin `cap_broken_by` en `manifest.json` y sin salida 2.
- `Total spent` coincide con lo que muestra la consola del proveedor.

### 5. Corre los tres brazos

Misma exportación, misma semilla y mismas muestras en los tres. Cada brazo es una corrida con su propio `--out` y su propio tope:

```bash
P=<carpeta-privada>
S="--input $E --seed 1 --sample 300 --review 100"
npm run eval -- run $S --models $REFERENCIA --out $P/B
npm run eval -- run $S --models $BARATO --out $P/A
npm run eval -- run $S --models $BARATO \
  --taxonomy $P/B/taxonomy-anthropic__claude-opus-5-5.json --out $P/C
```

- **B** es la referencia (cara). **A** es el candidato barato con sus propias carpetas. **C** es el candidato barato con las carpetas de B; separa el efecto de la taxonomía del de la clasificación.
- Costos estimados, sin razonamiento: A y C, del orden de un centavo cada uno. B, hasta US$0,70 con Opus 5.5 (techo del plan, sin contar reintentos por negativas). Si el tope por defecto (US$1) no alcanza, súbelo con `--max-usd`.
- **La corrida no se reanuda.** Si se detiene, lo pagado queda en disco (`assignments-*.jsonl`, `taxonomy-*.json`, `manifest.json`) pero repetirla es una corrida nueva, con otro `--out`, que vuelve a pagar. Si un modelo falla, los siguientes del mismo `--models` sí corren; el tope, `stopsRun` y una señal detienen todo.
- `Ctrl+C` (o `SIGTERM` y `SIGHUP`, por ejemplo, al cerrar la terminal) detiene la corrida con salida 130 y escribe el manifiesto y el reporte. Una segunda señal sale de inmediato.
- Al final la consola imprime el gasto, las rutas y, por modelo, la completitud:

```text
Total spent: US$0.0003
Report: .../report.md
Manifest: .../manifest.json
Review: .../review-anthropic__claude-haiku-5-5.csv
anthropic/claude-haiku-5-5: complete, placed 120 of 120, unsorted 0, unclassified 0
  M0 completeness: PASS (missing=0, not attempted=0)
```

(Ejemplo de una corrida contra el servidor falso.) Códigos de salida: [abajo](#códigos-de-salida).

### 6. Revisa `report.md` sin juzgar

Antes de gastar 40 minutos en juzgar, descarta o repite un brazo que ya se ve mal. Criterios del plan de evaluación, que el código no impone:

- `M0 completeness` en `PASS`. `missing` bloquea M0 y `score` lo da por `FAIL`; las negativas y los truncados se informan aparte con su proporción, y sobre 2 % de la muestra el veredicto no pasa de `GRAY`.
- `Folders used / proposed`: menos de 60 % de las carpetas en uso indica una taxonomía que no encaja.
- `Taxonomy built from`: si la taxonomía se construyó con menos de 130 de los 150 marcadores, el modelo rechazó o truncó la muestra y la taxonomía es menos representativa.
- `Largest folder share`: sobre 35 % de las filas, `score` baja a `GRAY`.
- `Models that answered (calls)`: debe ser el modelo pedido.

### 7. Genera la lista ciega y juzga

```bash
npm run eval -- blind $P/A $P/B $P/C --out $P/lista.csv
```

Escribe `lista.csv` con las columnas `judgment, row, title, url, folder` y `lista.key.json` al lado, ambos con modo 600. La lista no muestra modelo, confianza ni carpeta original; cada par marcador-carpeta aparece una sola vez aunque lo hayan propuesto varios brazos, así que la misma respuesta recibe el mismo juicio. Las filas `__unsorted__` y `(unclassified)` no se preguntan: cuentan como no aceptadas. Un par de cada diez se repite (hasta 10), lejos del original, para medir si tu criterio es estable. No sobrescribe: si `lista.csv` o su clave existen, falla con `Refusing to overwrite`.

**No abras `lista.key.json`** hasta terminar: contiene qué brazo propuso cada fila.

Ábrela en una hoja de cálculo y escribe `y` o `n` en `judgment` en cada fila (acepta también `yes`, `s`, `si`, `sí`, `no`). Guárdala como CSV; se aceptan coma o punto y coma, con o sin BOM, y UTF-8 o Windows-1252.

### 8. Calcula el puntaje y decide

```bash
npm run eval -- score $P/lista.csv
```

`score` detecta la clave junto a la lista y atribuye cada juicio a su brazo. Ejemplo de la salida de un brazo:

```text
anthropic/claude-haiku-5-5 low [A]
M0 completeness: PASS (missing=0, not attempted=0)
Accepted: 37  Rejected: 3  Abstained: 0  Pending: 0
Acceptance: 92.5 % [80.1 %, 97.4 %] of 40 rows (95 % Wilson interval; abstentions count as not accepted; target 85.0 %)
Precision: 37/40 (92.5 %) of the rows with a folder. Coverage: 100.0 %
By confidence: high 37/40 (92.5 %), low 0/0
By origin: already in a folder 0/0, loose 37/40 (92.5 %)
Largest folder: 57.5 % of the rows with a folder
Verdict: GRAY
  - one folder holds 57.5 % of these rows, over the 35.0 % allowed: ...
  - 40 rows are too few: M0 decides on 100
```

(Ejemplo con 40 filas contra el servidor falso; en una corrida real son 100.) La regla, sobre las aceptadas del total de filas del brazo y con las abstenciones como no aceptadas:

| Resultado | Veredicto |
|---|---|
| 85 % o más | `PASS` |
| 78 % a 84 % | `GRAY` |
| 77 % o menos | `FAIL` |
| Más de 2 % de la corrida sin clasificar, modelo servido distinto del pedido, o una carpeta con más de 35 % de las filas | Un `PASS` baja a `GRAY` |
| Menos de 100 filas | `GRAY` |
| Algún `missing` o marcadores sin intentar | `FAIL`, en cualquier caso |

El intervalo de Wilson al 95 % se imprime para que veas el margen: con 100 filas mide unos 14 puntos de ancho. 78 % es el piso de `GRAY` porque con 78 de 100 el extremo alto del intervalo llega justo a 85 %, y con 77 solo a 84,2 %.

**Entre brazos:** `score` elige el **más barato que apruebe**, ordenando por `spent_usd - lost_usd` (el costo sin los cargos al peor caso por llamadas que no devolvieron uso). Uno más caro solo gana si supera al elegido por **10 filas netas**; con 100 filas, una diferencia menor no se distingue del azar. También imprime, por cada par, las filas que solo acertó cada uno y en cuántas coincide la carpeta.

Salida 0 solo si hay un brazo elegido (`Decision: go on with ...`). Con salida 1:

| Mensaje | Qué hacer |
|---|---|
| `Incomplete: judge every row before using this result.` | Quedan filas sin juicio o con un valor no reconocido |
| `Decision: not yet. The best result is in the gray zone...` | Ve al paso 9: no concluyas |
| `Decision: do not go on...` | Todos con 77 % o menos, o con `missing`. Cobertura baja apunta a la taxonomía; precisión baja en todos, a que el título y la URL no bastan (enriquecer es M6); cambiar de modelo no ayuda |

Con una lista ciega, `score` imprime además `Repeated rows: N of M changed`. Con 2 o más cambios dice que tu criterio no es estable: trata las diferencias de menos de 10 filas como empate.

La probabilidad de aprobar con 100 filas, según la tasa real de aceptación: con 90 %, aprueba 96 % de las veces; con 85 %, aprueba 57 % y queda gris 41 %; con 80 %, aprueba 13 %, gris 61 % y falla 26 %; con 75 %, aprueba 1 %, gris 27 % y falla 71 % (cálculo del diseño de la regla, no medido con datos reales).

### 9. Si queda en zona gris

No concluyas. Cambia una cosa y vuelve a medir solo lo que cambia:

- Edita las carpetas en una copia de `taxonomy-*.json` y repite el brazo C con `--taxonomy`.
- Sube el esfuerzo del modelo barato: `--effort medium`.
- Si solo la referencia aprueba, prueba un modelo intermedio (`anthropic/claude-sonnet-5-5`) contra la taxonomía de B.

Genera la lista nueva con las corridas viejas y las nuevas, y pasa la lista ya juzgada en `--previous` (repetible):

```bash
npm run eval -- blind $P/A $P/B $P/C $P/D --previous $P/lista.csv --out $P/lista2.csv
npm run eval -- score $P/lista2.csv
```

Los juicios de `lista.csv` se arrastran y esos pares **no se vuelven a preguntar**; solo juzgas lo nuevo. `--previous` exige la misma exportación y las mismas filas de revisión.

Para medir repetibilidad sin juicio nuevo, repite el brazo elegido con la misma taxonomía y agrégalo con `--previous`: `score` imprime `same folder in N of 100`. Bajo 90 delata carpetas que se solapan; corrígelas antes de M2.

### 10. Registra la decisión

En `decision.md`: brazo elegido, aceptación con su intervalo, precisión en `high`, costo directo por 2.000 marcadores (`Projected cost` de `report.md`, aproximado) y latencia p95. Si un modelo aprueba, se sigue con él; si no, el enfoque se revisa.

El resultado no se traslada de un modelo a otro: cada brazo se juzga por separado, con el mismo protocolo.

## Medir el prompt con autosort-check

Mide el prompt **real** de Ctrl+D (el de la extensión, con su mismo armado de contexto), un marcador a la vez. Tres tipos de caso: dejar uno fuera (cada marcador de una carpeta se «guarda de nuevo» en la barra), quitar una carpeta (su contenido queda suelto, y lo correcto es una carpeta nueva) y sueltos reales, que van al CSV para que tú los juzgues. No modifica nada.

```bash
cd <ruta-al-repositorio>
E=<carpeta-privada>/bookmarks.html
npm run eval -- autosort-check --input $E --models gemini/gemini-3.5-flash-lite --dry-run --out <carpeta-privada>/check-vista
read -rs GEMINI_API_KEY && export GEMINI_API_KEY
npm run eval -- autosort-check --input $E --models gemini/gemini-3.5-flash-lite --accept-data-policy gemini --repeat 3 --out <carpeta-privada>/check
```

- Usa las mismas `--exclude-folder` que en M0 y que las carpetas excluidas de la extensión.
- El `--dry-run` imprime los casos, las llamadas y el costo estimado antes de gastar. Opciones propias: `--repeat` (3 por defecto), `--max-cases` (60), `--pause` (4 s, por los límites del plan gratuito) y `--context full|bookmark-only`.
- **Costo con 29 enviables:** unos 30 casos, o sea unas 100 llamadas de 1 a 1,5 mil tokens, en unos 10 min. US$0 en el plan gratuito; a tarifa de pago, unos US$0,05.
- La salida es `report.md` (y la consola), con la precisión de `existing high`, `existing low`, `new` y `none` con su intervalo de Wilson; si `high` acierta más que `low`; carpetas nuevas bien propuestas; forzadas; estabilidad; y cuántas llamadas pasan los 20 s. Escribe además `requests-preview.jsonl`, `answers-*.jsonl`, `review-*.csv` y `check-manifest.json` (directorio 700, archivos 600).
- **La recomendación tiene su regla escrita:** activar el modo automático solo con 0 `high` incorrectos, estabilidad y una cota inferior de al menos 95 %. Si no, seguir confirmando.

**El límite:** con tu colección (29 enviables), esta pasada **solo puede rechazar el prompt, no certificar el 95 %.** Una cota inferior de 95 % exige al menos 73 casos `high` sin un solo error, y 30 casos no alcanzan. Lo esperable es «seguir confirmando», y por eso «Confirmar antes de mover» viene encendido.

## Opciones de `run`

Todas están en `eval.mjs --help`.

| Opción | Por defecto | Descripción |
|---|---|---|
| `--input <archivo>` | Obligatoria | Exportación HTML de Chrome |
| `--models a,b` | Obligatoria salvo con `--dry-run` | Referencias `proveedor/modelo`. Un modelo fuera del [catálogo](proveedores.md#elegir-modelo) se rechaza |
| `--dry-run` | Desactivada | Escribe la vista previa y el estimado, sin clave ni red |
| `--sample <n>` | `300` | Marcadores a clasificar |
| `--review <n>` | `100` | Filas de cada CSV de revisión |
| `--seed <n>` | `1` | Semilla de toda decisión aleatoria; repetirla con el mismo archivo reproduce las muestras |
| `--language <idioma>` | `Spanish` | Idioma de los nombres de carpeta |
| `--max-usd <n>` | `1` | Tope de gasto compartido por todos los modelos. Decimal con punto; `1,5` se rechaza |
| `--effort none\|low\|medium\|high` | `low` | Esfuerzo de razonamiento, enviado solo donde el catálogo lo confirma. `none` se rechaza si algún modelo no lo documenta |
| `--taxonomy <archivo.json>` | Ninguno | Usa estas carpetas en vez de pedirlas. Formato `{"folders": [{"name", "description"}]}`; nada se descarta en silencio |
| `--exclude-folder <regex>` | Ninguno | Repetible. Nunca envía marcadores cuya ruta de carpeta coincida |
| `--accept-data-policy <id>` | Ninguno | Repetible, uno por proveedor. Obligatorio para Gemini, Mistral y DeepSeek |
| `--fallback` | Desactivada | Solo Anthropic: permite el respaldo del servidor ante una negativa. En Haiku no existe |
| `--out <dir>` | `eval-out/<fecha y hora>` en la raíz del proyecto | Directorio nuevo: si existe, la corrida falla |

## Otros comandos

| Comando | Para qué |
|---|---|
| `blind <run-dir>... [--out file] [--seed 1] [--previous juzgada.csv]...` | Lista ciega y su clave. `--out` por defecto: `blind.csv` en la primera corrida |
| `score <review.csv \| lista.csv>...` | Puntaje y decisión. Con un `review-*.csv` suelto se ve el modelo y la carpeta de cada fila; la lista ciega evita ese sesgo |
| `models [--provider <id>] [--check] [--candidates]` | Catálogo, y comparación con el listado de cada proveedor. [Detalle](proveedores.md#comandos-de-models) |

`score` exige el `manifest.json` de la corrida junto al CSV, y que el CSV tenga las mismas filas que la corrida revisó. Ordenar las filas no importa; borrarlas o repetirlas, sí.

## Códigos de salida

| Comando | Código | Significado |
|---|---|---|
| `run` | 0 | Terminó, o fue un dry run |
| `run` | 1 | Opciones inválidas, clave o consentimiento faltante, un modelo falló o error. Si ya había empezado, conserva el manifiesto y el reporte |
| `run` | 2 | Se detuvo por el tope de gasto, o el gasto lo superó, o un proveedor no respetó `max_tokens` (`cap_broken_by`). Puede ocurrir aun con todos los modelos completos |
| `run` | 130 | Interrumpida por `SIGINT`, `SIGTERM` o `SIGHUP` |
| `score` | 0 | Hay un brazo elegido |
| `score` | 1 | Error, revisión incompleta, zona gris o ningún brazo aprueba |
| `blind` | 0 / 1 | Lista escrita / error |
| `models` | 0 / 1 | Sin hallazgos / proveedor desconocido o sin clave con `--check`, o catálogo desactualizado |

## Pruebas

```bash
npm test          # 1429 pruebas, verificadas el 2026-11-05
npm run check     # typecheck más pruebas
sh scripts/gate.sh  # lo anterior, y exige al menos 1100 pruebas: un corredor puede perder resultados y salir con 0
```

No usan la red ni consumen saldo: los SDK y los adaptadores hablan con servidores locales falsos.
