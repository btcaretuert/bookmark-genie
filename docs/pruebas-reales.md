# Pruebas reales

Qué se probó con un proveedor real, un Chrome real o ambos, y con qué resultado. Aquí no hay datos personales: las colecciones se describen por tamaño. Todo lo que no aparece aquí se probó solo contra servidores y un Chrome falsos ([Desarrollo](desarrollo.md#pruebas-y-compuerta)); la lista de lo que falta está en [Sin verificar](decisiones.md#sin-verificar).

**Proveedor real: solo Gemini 3.5 Flash-Lite**, en el plan gratuito. Los otros seis proveedores del catálogo no se han probado.

## M0: la evaluación contra un proveedor real

| Prueba | Resultado |
|---|---|
| Humo con 7 marcadores | 6 de 7 aceptados |
| Humo con 20 marcadores | **20 de 20 aceptados** |
| Colección de 62 marcadores, 29 enviables | Veredicto `GRAY`, solo por el tamaño de la muestra y un tema dominante. Se dio M0 por suficiente |
| `gemini-2.5-flash-lite` | **Responde 404 a cuentas nuevas.** El catálogo lo marca «no disponible para cuentas nuevas» y recomienda 3.5 Flash-Lite |

Qué demuestra: que el prompt y el esquema de M0 funcionan con un modelo real. Qué no: con solo 29 enviables, la herramienta puede rechazar un prompt pero no avalarlo ([el límite](quick-start.md#medir-el-prompt-con-autosort-check)).

## M2: Ctrl+D con un proveedor real

Primera prueba con la extensión de M2 (0.2.0):

- Un marcador sobre dbt fue a su carpeta.
- Un tema que no tenía carpeta **quedó sin mover**: la versión solo podía elegir carpetas existentes.

Eso motivó **M2.1**: proponer carpetas nuevas cuando ninguna existente encaja.

## La 0.5.1 en un Chrome real

Chrome con ventana y Gemini 3.5 Flash-Lite:

| Paso | Resultado |
|---|---|
| Instalación con «Cargar descomprimida» | Versión 0.5.1, se abre la página de ajustes |
| Permisos | El diálogo real pidió `tabs` y el host de Gemini; se concedieron |
| «Probar la clave» | Respondió en unos 2 s |
| Ctrl+D con la burbuja abierta 15 s | El flujo siguió y terminó sin error |
| Propuesta de una carpeta nueva | Apareció con el nombre editable |
| «Crear y mover» | Creó la carpeta y movió el marcador |
| Deshacer | Devolvió el marcador y borró la carpeta que quedó vacía |
| «Ordenar sueltos» | 3 grupos propuestos |
| «Aceptar todas» | Aplicó los 3 grupos |
| Un solo Deshacer | Revirtió todo: es un solo cambio del diario |

Qué demuestra: el flujo completo funciona de extremo a extremo con un proveedor real, incluido el diálogo de permisos, que ninguna sonda automática puede dar. Qué no cubre: otros proveedores, Web Locks entre el worker y las páginas, ni un «Ordenar sueltos» largo.

## Escala con un proveedor simulado

Chrome con un proveedor simulado (host interceptado, nada sale de la máquina), sobre dos exportaciones reales de marcadores:

| Colección | Resultado |
|---|---|
| 444 marcadores | La ventana abre en menos de 210 ms |
| 821 marcadores | La ventana abre en menos de 210 ms |
| Ctrl+D | 4.400 a 6.900 tokens por llamada, según la colección |
| Deshacer | El árbol quedó **idéntico** al de antes |

De aquí salieron los arreglos de [0.5.1](decisiones.md#ajustes-de-051): «Aceptar todas» como un solo cambio y las carpetas de cualquier profundidad.

## Problemas conocidos

Hallados en estas pruebas y **no corregidos**:

| Problema | Detalle |
|---|---|
| «2,057 ms» | El texto de latencia usa coma como separador de miles |
| Una fila deshecha sigue con ✓ | Tras deshacer, la fila del cambio sigue mostrando ✓ |
| Descripciones sin tildes en «Ordenar sueltos» | Las descripciones de los grupos salen sin tildes. **Causa desconocida** |
| La propuesta de Ctrl+D sale en inglés | Si no hay carpetas existentes que imitar, la propuesta sale en inglés (el prompt toma el idioma de las carpetas existentes) |
| El cargo de herramienta de Perplexity no se suma | Si Perplexity ejecuta una herramienta (una búsqueda), la corrida se detiene, pero su cargo de la búsqueda (medido en US$0,005) no entra en el gasto: [Proveedores](proveedores.md) |
| `--effort none` en Mistral Small | Con ese esfuerzo, el reintento de un solo marcador puede truncarse: la documentación dice que razona poco, no que no razone |
