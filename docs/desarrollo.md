# Desarrollo

Para quien clona el repositorio y quiere correr las pruebas, cambiar código o agregar un proveedor. Cómo usar la extensión: [Quick start](quick-start.md).

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `extension/` | La extensión de Chrome (Manifest V3). Es lo único que se carga en el navegador |
| `extension/core/` | Lógica pura, sin `chrome.*` ni red: saneamiento, prompts, clasificación, taxonomía, presupuesto, planes, árbol, respaldo y exportación Netscape |
| `extension/platform/` | Lo que toca el entorno: `chrome.*` (marcadores, almacenamiento, diario), proveedores y adaptadores `fetch` |
| `extension/ui/` | Ventana (`manager.*`), página de ajustes (`options.*`) y funciones puras de presentación |
| `extension/sw.js` | Service worker: eventos de Ctrl+D, mensajes de la ventana, recuperación al arrancar |
| `tools/eval.mjs`, `tools/lib/` | La herramienta de evaluación: lectura de la exportación, corrida, reporte, juicio ciego, puntaje y `autosort-check` |
| `tests/unit/` | Pruebas con el runner de Node (`node --test`) |
| `tests/helpers/` | Servidores falsos de proveedor (`fake-openai.mjs`, `fake-claude.mjs`) y el Chrome falso (`fake-chrome.mjs`) |
| `tests/fixtures/` | Exportaciones de marcadores sintéticas, incluidas formas malformadas |
| `scripts/gate.sh` | La compuerta |
| `docs/` | Esta documentación |

La herramienta de evaluación y la extensión **comparten `extension/core/`**: lo que se mide en `tools/` es el mismo código que corre en Chrome.

## Requisitos

- **Linux x64** para el flujo completo. `npm ci` instala un Node 26.13.0 local (`node-linux-x64`) y `npm run` lo antepone al `PATH`, así que `npm test` y `npm run eval --` lo usan sin que tengas que configurar nada.
- **macOS o Windows:** `node-linux-x64` solo existe para Linux x64, así que `npm ci` puede fallar por esa dependencia. Instala tu propio Node 20.12 o superior (`engines` lo exige). Si `npm ci` falla, quita la línea `node-linux-x64` de `devDependencies` en tu copia local (sin subir ese cambio) y ejecuta `npm install`. No está probado fuera de Linux.
- El Node del sistema puede ser demasiado viejo (el mínimo es 20.12.0). Comprueba con `node --version`.
- Chrome 134 o superior para cargar la extensión.

```bash
npm ci
```

## Pruebas y compuerta

| Comando | Qué hace |
|---|---|
| `npm test` | Todas las pruebas de `tests/unit/` (`--test-timeout=60000`) |
| `npm run typecheck` | `tsc -p .` sobre el JavaScript con anotaciones JSDoc: es la única red para los contratos entre módulos, porque no hay compilación |
| `npm run check` | Tipos y pruebas |
| `sh scripts/gate.sh` | `check` más un **piso de pruebas ejecutadas** (`MIN_TESTS`). El piso existe porque un runner puede perder resultados y salir con 0 |

Antes de dar un cambio por terminado corre `sh scripts/gate.sh`. Si agregas pruebas de forma sostenida, sube `MIN_TESTS`.

### Nada de las pruebas toca la red

- **Proveedores falsos.** `fake-openai.mjs` y `fake-claude.mjs` son servidores HTTP locales que modelan lo que dice la documentación de cada proveedor: formas de petición, `finish_reason`, errores y límites. Las variables `<PROVEEDOR>_BASE_URL` solo aceptan loopback, y así se redirige un adaptador al falso. Pasar estas pruebas demuestra que el código cumple lo leído, no que lo leído coincida con el servicio real.
- **Chrome falso.** `fake-chrome.mjs` implementa en memoria `chrome.bookmarks`, `chrome.storage.local`, `tabs`, `permissions` y `action`, solo lo que usa la extensión. Sigue la documentación y, donde calla, el código de Chromium (por ejemplo, la regla del índice en `move`). Si extiendes la extensión con otra API de `chrome.*`, extiende primero el falso y su prueba (`fake-chrome.test.mjs`).
- **Mutaciones.** Un arreglo de comportamiento lleva una prueba que falla sin él. Una forma rápida de comprobarlo es revertir el arreglo en una copia y ver que la prueba falla.

## Convenciones

- **ESM sin bundler.** Módulos `.js` o `.mjs` con `import` relativos y extensión explícita. La extensión se carga tal cual está en `extension/`; no hay paso de compilación. Por eso `typecheck` es obligatorio.
- **`core/` no usa `chrome.*`.** Recibe todo por parámetros, así `tools/` lo reutiliza y las pruebas lo ejercitan sin navegador. Lo que necesita el entorno vive en `platform/`.
- **Idioma.** Código, identificadores, comentarios y mensajes de commit en inglés. La interfaz de la extensión y esta documentación, en español latinoamericano neutro, con plurales y números en `es-419`.
- **Las claves nunca se registran** ni se guardan en el diario, el manifiesto o el reporte. La URL completa tampoco sale al proveedor ni al registro: pasa por `sanitizeForLlm`.
- **Nada se escribe a través de un enlace simbólico**, y las corridas de evaluación crean su directorio nuevo (`wx`).

## Cómo agregar un proveedor al catálogo

1. **Lee su documentación oficial** y anota la fuente y la fecha: precio por millón de tokens, esquema estructurado, niveles de esfuerzo, cómo cuenta `max_tokens`, `finish_reason`, política de datos (entrenamiento, retención, región) y listado de modelos.
2. **Registro, `extension/platform/providers.js`.** Agrega la entrada a `PROVIDERS`: `keyEnv`, `baseUrlEnv`, `baseURL`, `adapter` (`chat-completions` si es compatible con OpenAI, o `responses`), `completionPath`, `maxTokensParam`, `structuredOutput`, `finishReasons` (un valor que no esté en el mapa es un error, no se adivina), `quotaErrors`, `listing` y `dataPolicy` con su fuente. Si no tiene API usable, va a `EXCLUDED_PROVIDERS`, con el motivo.
3. **Modelos, `extension/core/models.js`.** Agrega los modelos a `CATALOG` con precios, fuente, `structuredOutput`, `effortLevels`, `idStability` y `retiresNotBefore`.
4. **Permiso de host.** Para que la extensión pueda llamarlo, agrega su origen a `optional_host_permissions` de `extension/manifest.json`. `extension-manifest.test.mjs` comprueba que la lista coincida con el registro.
5. **Pruebas.** Agrega un caso al falso (`fake-openai.mjs`) con las rarezas documentadas del proveedor y cubre el adaptador en `providers.test.mjs` y `openai-compatible.test.mjs`. La prueba del registro enumera los proveedores esperados: actualízala.
6. **Documentación.** Actualiza [Proveedores](proveedores.md), con una fila de datos y los riesgos de la primera llamada, y marca explícitamente que **no se probó contra el servicio real** hasta que alguien lo haga.
7. **Verifica.** `sh scripts/gate.sh`, y `npm run eval -- models --check` con tu clave para comparar el catálogo con el listado real.

## Convención de diagramas

Los diagramas son Mermaid, en bloques ```` ```mermaid ````. La regla, completa en [Cómo leer los diagramas](funcionalidades.md#cómo-leer-los-diagramas):

- En un flujo, un **rombo es una decisión exclusiva**: se toma exactamente una salida, hay al menos dos y todas están rotuladas.
- Un rectángulo es un paso con una sola salida (o ninguna, si termina).
- En un diagrama de estados, una decisión es un `choice` con condiciones que se excluyen y cubren todos los casos. Un estado sin salidas es final.
- En componentes y entidades, las flechas son relaciones que existen a la vez, no caminos.
- Cada diagrama describe el camino de **un** evento. La exclusión entre escritores no se dibuja.

Un diagrama se revisa por **sintaxis, geometría y significado**: que renderice en las versiones de Mermaid que uses, que ninguna caja se superponga con otra ni con una flecha, y que cada decisión cumpla la convención. Que compile no basta.

## Cómo verificar la extensión cargada en Chrome sin una API real

No necesitas clave para ejercitar los flujos completos. La idea es cargar la extensión en un perfil desechable y desviar el host del proveedor a un servidor local:

1. Arranca un servidor local que imite al proveedor (puedes reutilizar `tests/helpers/fake-openai.mjs`) y que devuelva las respuestas que quieres provocar: carpeta existente, carpeta nueva, un 429, un error de servidor, un tiempo agotado.
2. Lanza Chrome (con ventana o headless) con un perfil nuevo, la carpeta `extension/` cargada y el puerto de depuración remota activado. Las compilaciones recientes de Chrome de marca pueden no aceptar `--load-extension` por línea de comandos; Chromium sí, o puedes cargarla a mano con «Cargar descomprimida».
3. Por el protocolo de depuración (CDP), intercepta las peticiones al host del proveedor y desvíalas a `127.0.0.1`. La extensión envía a un host fijo, así que la intercepción ocurre en el navegador, no en la extensión.
4. Concede de antemano los permisos opcionales (`tabs` y el host del proveedor) en una copia del manifiesto de la prueba: el diálogo real de permisos exige un clic y una sonda no lo puede dar. El diálogo se prueba a mano.
5. Dispara el flujo desde el worker o la página de ajustes: crea marcadores con `chrome.bookmarks.create` con la URL de la pestaña activa, y lee `chrome.storage.local` para comprobar propuestas, diario, actividad y métricas.
6. Compara el árbol de marcadores antes y después de deshacer: debe ser idéntico.

Qué cubre y qué no: una sonda así verifica el cableado real de `chrome.*`, el worker y la interfaz. No verifica que el proveedor responda como dice su documentación. Resultados de las pruebas hechas con este método y con un proveedor real: [Pruebas reales](pruebas-reales.md).
