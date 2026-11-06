# Bookmark Genie

Herramienta personal para ordenar marcadores de Chrome con IA, equivalente propio de [Neat AI Bookmark Manager](https://chromewebstore.google.com/detail/neat-ai-bookmark-manager/cldmjlpneippgeeaibhgfgnkngolkblc).

> **Estado al 2026-11-05: la extensión 0.5.1 existe y se carga en Chrome; M0, M1 y M2 están hechos, y M3 a M6 no.** Hay dos cosas en el repositorio, y comparten el núcleo:
>
> - **La extensión** (`extension/`). Ordena con Ctrl+D (apagado por defecto), propone carpetas, mueve solo con tu confirmación, deshace por cambio, ordena los sueltos bajo demanda y respalda. No tiene búsqueda, duplicados masivos, enlaces muertos ni restauración desde respaldo.
> - **La herramienta de evaluación** (`tools/`). Un comando que mide si un modelo clasifica tus marcadores, y mide el prompt de Ctrl+D. No modifica ningún marcador.
>
> **Solo Gemini 3.5 Flash-Lite se ha probado con una corrida real** (M0: 20 de 20 aceptados sobre una colección de 62 marcadores). Los otros seis proveedores no se han probado. La extensión 0.5.1 se probó a mano en un Chrome real con ese proveedor, y sus flujos completos con un proveedor simulado en Chrome headless: [Pruebas reales](pruebas-reales.md), con sus problemas conocidos. Para empezar: [Usar la extensión](quick-start.md#usar-la-extensión).

## Objetivo del proyecto

El producto final es una extensión de Chrome que:

- ordene con IA, con vista previa y opción de deshacer (hoy: Ctrl+D y «Ordenar sueltos», siempre con propuesta y Deshacer);
- archive cada marcador guardado con Ctrl+D (hecho);
- busque con tolerancia a errores de tipeo (pendiente);
- detecte duplicados y enlaces muertos (pendiente);
- respalde y restaure los marcadores (el respaldo está; la restauración, no).

Tres principios guían el diseño:

- **Privacidad:** a la nube solo salen títulos limpios, URL reducidas y nombres de carpeta, hacia el proveedor que elijas y tras mostrarte su política de datos. El saneamiento es heurístico y tiene límites conocidos. Qué sale y cuándo: [Qué sale a la nube](arquitectura-alto-nivel.md#qué-sale-a-la-nube).
- **Reversibilidad:** el flujo normal nunca borra marcadores, y todo movimiento se puede deshacer.
- **Control:** por defecto nada se mueve sin tu confirmación. El orden automático es un ajuste que la extensión te sugiere cuando lo has ganado, no un valor por omisión.

## Hoja de ruta

Los hitos se reordenaron el 2026-11-05: con una colección de 62 marcadores, el orden masivo aporta poco, así que primero fueron la base, Ctrl+D y, después, la búsqueda.

| Hito | Entrega | Estado |
|---|---|---|
| M0 | Núcleo de clasificación y herramienta de evaluación con varios proveedores | **Hecho.** Corrida real con Gemini 3.5 Flash-Lite: 20 de 20 aceptados; veredicto gris solo por el tamaño de la muestra y un tema dominante, y se dio por suficiente |
| M1 | Manifest, lectura del árbol, respaldo, diario, aplicar y deshacer, sin IA | **Hecho** |
| M2 | Orden con Ctrl+D, apagado por defecto, con ajustes de proveedor, modelo y clave; propone carpetas nuevas | **Hecho**, con las mejoras de 0.4.0 a 0.5.1 (confirmar antes de mover, errores visibles, propuestas editables, «Ordenar sueltos») |
| M3 | Popup con búsqueda difusa, apertura en bloque, renombrar, mover y borrar | Pendiente |
| M4 | Orden masivo con reanudación, solo si la colección crece | Pendiente. «Ordenar sueltos» es su versión reducida y ya está hecha |
| M5 | Duplicados, enlaces muertos y cuarentena | Pendiente |
| M6 | Etiquetas y enriquecimiento opcional | Pendiente |

## Documentación

| Documento | Contenido |
|---|---|
| [Desarrollo](desarrollo.md) | Estructura del repositorio, requisitos, pruebas y compuerta, cómo agregar un proveedor, convenciones y cómo verificar la extensión sin una API real |
| [Pruebas reales](pruebas-reales.md) | Qué se probó con un proveedor y un Chrome reales, con su resultado y los problemas conocidos |
| [Quick start](quick-start.md) | Usar la extensión paso a paso; el protocolo de M0 (exportar, probar, correr, juzgar a ciegas y decidir) y la medición de Ctrl+D |
| [Proveedores](proveedores.md) | Catálogo de modelos, precios, datos y riesgos de la primera llamada de cada proveedor |
| [Funcionalidades](funcionalidades.md) | Qué hace hoy la extensión y la evaluación, flujos, estados y navegación |
| [Decisiones](decisiones.md) | Por qué es así: M0, las decisiones D1 a D15 de la extensión y qué se construyó del diseño de M1 |
| [Estructura de datos](estructura-de-datos.md) | El almacenamiento de la extensión, `backup@1.json`, y los archivos de la evaluación |
| [Arquitectura de alto nivel](arquitectura-alto-nivel.md) | Componentes, candado, diario, qué se envía y cuándo, y cómo se comparte el núcleo |
| [Arquitectura de bajo nivel](arquitectura-bajo-nivel.md) | Módulos, funciones, secuencia y reglas |
| [Troubleshooting](troubleshooting.md) | Errores de la extensión y de la evaluación, permisos, limitaciones y compatibilidad |
| [FAQ](faq.md) | Preguntas frecuentes |

## Cómo leer estos documentos

- Lo que aparece como **implementado** existe en el código y tiene pruebas contra servidores y un Chrome falsos (1429 pruebas); [las ramas sin prueba automatizada](arquitectura-bajo-nivel.md#pruebas) están listadas. Implementado no significa probado contra un proveedor real ni en Chrome con ventana.
- Lo que aparece como **pendiente** todavía no existe y puede cambiar.
- Lo que **no se ha verificado** se dice de forma explícita: [la lista](decisiones.md#sin-verificar).
- En los diagramas de flujo y de estados, cada decisión toma **una sola salida**. La convención completa está en [Cómo leer los diagramas](funcionalidades.md#cómo-leer-los-diagramas).
