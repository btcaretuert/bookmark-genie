# Bookmark Genie

Bookmark Genie es una extensión de Chrome que ordena tus marcadores con IA. Es un equivalente propio de [Neat AI Bookmark Manager](https://chromewebstore.google.com/detail/neat-ai-bookmark-manager/cldmjlpneippgeeaibhgfgnkngolkblc), con dos criterios por encima de los demás: privacidad (tú eliges el proveedor y ves qué se le envía) y reversibilidad (nada se mueve sin tu confirmación, y todo movimiento se puede deshacer). El repositorio contiene también una herramienta de línea de comandos que mide si un modelo clasifica bien tus marcadores antes de que le confíes la extensión.

> **No está publicada en la Chrome Web Store.** Se instala desde el código, en modo de desarrollador.

## Qué hace hoy

**La extensión (0.5.1, en `extension/`):**

- Ctrl+D ordena el marcador que acabas de guardar: propone una carpeta existente o una nueva. Está apagado por defecto.
- Por defecto todo es una propuesta que confirmas; el modo automático es un ajuste.
- «Ordenar sueltos» propone carpetas para los marcadores sueltos de una carpeta, bajo demanda. Nunca mueve solo.
- Deshacer por cambio, con diario. «Aceptar todas» es un solo cambio y se deshace con un clic.
- «Respaldar ahora» descarga un HTML que Chrome puede importar y un `backup@1.json`.
- No tiene búsqueda, duplicados masivos, enlaces muertos ni restauración desde un respaldo (están en la [hoja de ruta](docs/README.md#hoja-de-ruta)).

**La herramienta de evaluación (`tools/eval.mjs`):** toma una exportación HTML de tus marcadores y mide, con el modelo que elijas, cuántos clasifica bien: muestreo reproducible, juicio ciego, intervalo de confianza y veredicto `PASS`, `GRAY` o `FAIL`. `autosort-check` mide el prompt de Ctrl+D. No modifica ningún marcador.

## Instalación rápida

Requiere Chrome 134 o superior en Linux (es lo único probado).

1. Clona el repositorio y copia la extensión a una carpeta tuya: `rsync -a --delete extension/ ~/bookmark-genie-extension/ && chmod -R go-w ~/bookmark-genie-extension`.
2. En `chrome://extensions`, activa «Modo de desarrollador».
3. Pulsa «Cargar descomprimida» y elige `~/bookmark-genie-extension`. Debe decir versión **0.5.1**.
4. En la página de ajustes que se abre, elige un proveedor y un modelo, pega tu clave, marca el consentimiento y pulsa «Guardar». Chrome pedirá permisos para las pestañas y para el host del proveedor.
5. Guarda una página con Ctrl+D y espera unos 8 s: aparece una propuesta en la ventana de la extensión.

La guía completa, con lo que debes ver en cada paso, está en [docs/quick-start.md](docs/quick-start.md).

## Privacidad

- **Sale** hacia el proveedor que elijas, y solo mientras Ctrl+D u «Ordenar sueltos» estén en uso: el título limpio y la URL reducida del marcador, los nombres y rutas de tus carpetas, hasta 5 títulos de ejemplo por carpeta y, en «Ordenar sueltos», hasta 30 sueltos por llamada.
- **Nunca sale** la URL completa (parámetros y fragmento), una carpeta que excluyas, ni tu clave a otro destino que no sea el host fijo del proveedor. La clave queda en el almacenamiento local de la extensión.
- **Proveedores:** OpenAI, Gemini, Mistral, xAI, DeepSeek y Perplexity en la extensión; Anthropic además en la herramienta de evaluación. No hay uno por defecto: lo eliges tú, y antes de enviar se te muestra su política de datos.
- El saneamiento es heurístico y tiene límites conocidos: [qué sale a la nube](docs/arquitectura-alto-nivel.md#qué-sale-a-la-nube).

## Estado

- **Probado con una API real solo con Gemini 3.5 Flash-Lite.** El resto de los proveedores está implementado y probado contra servidores locales que imitan su documentación, no contra el servicio real. Tu primera corrida con cada uno es su primera prueba.
- La extensión 0.5.1 también se probó en un Chrome real con ese proveedor: [pruebas reales](docs/pruebas-reales.md), con sus problemas conocidos.

## Desarrollo y pruebas

Requisitos y convenciones: [docs/desarrollo.md](docs/desarrollo.md).

```bash
npm ci
sh scripts/gate.sh   # typecheck, pruebas y un mínimo de pruebas ejecutadas
```

**Plataforma:** la dependencia de desarrollo `node-linux-x64` (Node 26.13.0 local) solo existe para Linux x64. En macOS o Windows necesitas tu propio Node 20.12 o superior, y `npm ci` puede fallar por esa dependencia.

## Documentación

Empieza por [docs/README.md](docs/README.md): índice, hoja de ruta y cómo leer los diagramas.

## Licencia

[MIT](LICENSE).
