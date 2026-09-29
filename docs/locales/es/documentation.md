# Primeros pasos {#getting-started}

AppAgent es un agente de IA para ServiceNow que funciona como extensión de Chrome. Describa lo que necesita en lenguaje natural y el agente consulta datos, edita registros, crea aplicaciones y widgets, prueba páginas en su navegador y le informa del resultado.

:::tip
**Inicio rápido:** configure un modelo, abra una pestaña en su instancia de ServiceNow, escriba una solicitud en el chat y pulse <kbd>Enter</kbd>.
:::

## Configurar un modelo {#guide-setup}

1. Abra [Configuración](app:openSettingsPageView) y vaya a **Proveedores de API**
2. Agregue un proveedor (Anthropic, OpenRouter o una API personalizada compatible con OpenAI) con su clave de API, o active **OAuth** en un proveedor de Anthropic para iniciar sesión con su cuenta de Claude
3. Elija el modelo que desea usar en **Modelo del agente**

Su clave de API se guarda solo en su navegador. Las llamadas de IA van directamente de su navegador al proveedor.

## Conectar sus instancias {#guide-instances}

AppAgent **detecta automáticamente todas las instancias de ServiceNow** que tenga abiertas en el mismo perfil de Chrome: no hay que introducir ninguna cadena de conexión. Inicie sesión en una instancia en una pestaña normal y el agente podrá trabajar en ella con los roles y derechos de acceso de su usuario. Pida *"list instances"* para ver todas las instancias detectadas, sus roles y el estado de la conexión.

Cada instancia tiene un **nivel de permisos**, que se elige en el menú desplegable de la instancia:

- **Manual**: usted aprueba cada operación de escritura (crear, actualizar, eliminar, rellenar formularios)
- **Automático**: el agente decide sobre las operaciones de escritura sin preguntar
- **Dev**: ninguna aprobación; todas las llamadas a herramientas en esta instancia se ejecutan sin preguntar. Úselo solo en instancias de desarrollo

Las lecturas siempre están permitidas. Consulte [Permisos de herramientas](#feature-permissions) para un control más preciso.

## Iniciar un chat {#guide-chat}

1. Haga clic en **Nuevo chat** en la barra lateral [Iniciar un nuevo chat →](app:startNewChat)
2. Escriba su solicitud, por ejemplo *"Muéstrame todos los incidentes creados hoy"*
3. Pulse <kbd>Enter</kbd> para enviarla
4. Siga el trabajo del agente: cada llamada a una herramienta aparece en el chat, y se muestran solicitudes de aprobación cuando un paso necesita su visto bueno

Puede seguir escribiendo mientras el agente trabaja: enviar un mensaje nuevo interrumpe el paso actual, y **Pausar** detiene la ejecución.

## Adjuntar imágenes y archivos {#guide-images}

1. Haga clic en el botón **Adjuntar archivo** del área de entrada para agregar una imagen, un PDF, un CSV o un archivo de texto
2. O pegue una imagen desde el portapapeles, o arrástrela y suéltela en el chat
3. Escriba su pregunta sobre el archivo adjunto

:::tip
Adjunte capturas de pantalla de errores, maquetas de interfaz o datos exportados para que el agente vea exactamente lo mismo que usted.
:::

# Funciones principales {#features}

## Chat {#page-chat}

La vista principal de la conversación. [Iniciar un nuevo chat →](app:startNewChat)

- **Área de mensajes**: la conversación, incluidas las llamadas a herramientas y sus resultados
- **Cuadro de entrada**: escriba mensajes, adjunte archivos y envíe mientras el agente trabaja para interrumpirlo
- **Pausar / Continuar / Reintentar**: detenga el agente, reanúdelo o reintente el último paso
- **Indicador de contexto**: muestra el nivel de llenado de la conversación; haga clic en él para resumirla en un chat nuevo
- **Tarjetas de respuesta**: debajo de una respuesta pueden aparecer una tarjeta **Resumen** y una tarjeta **Enlaces** (registros, PR, documentos)
- **Encabezado del chat**: cambie el nombre del chat o ánclelo, o abra AppAgent en una pestaña completa del navegador con **Expandir a página completa**

## Control del navegador {#feature-browser}

El agente puede abrir y controlar pestañas del navegador en su instancia para ver y probar páginas:

- **Navegar, hacer clic, rellenar y seleccionar**: eventos realistas, para que los formularios y los campos de autocompletado se comporten como si usted escribiera
- **Esperar**: espera un elemento, un texto o una URL en lugar de adivinar los tiempos
- **Capturas de pantalla**: captura la página, un widget o un único elemento para comprobaciones visuales
- **Inspeccionar**: lee propiedades y estilos de elementos, errores de consola y solicitudes de red
- **Suplantar**: prueba como otro usuario y luego vuelve al suyo

## Editar registros e historial de versiones {#feature-history}

Cada cambio que el agente hace en su instancia se registra en la barra lateral del chat:

- **Deshacer**: revierte un cambio concreto
- **Rehacer**: restaura un cambio revertido
- **Descargar XML**: exporta todos los cambios, por ejemplo para llevarlos a otra instancia

## Subagentes {#feature-subagents}

Para trabajos pesados o en paralelo, el agente puede iniciar **subagentes**: trabajadores en segundo plano que se ejecutan en su propio chat y contexto y después devuelven un resultado breve al chat principal.

- **Niveles de modelo**: cada subagente se ejecuta en un nivel **pequeño**, **mediano** o **grande**, o **igual** para usar el modelo del chat principal. Asigne modelos a los niveles en [Configuración](app:openSettingsPageView) → **Niveles de modelo de subagentes**
- **Barra de trabajadores**: los subagentes en ejecución aparecen como chips en vivo encima del cuadro de entrada; abra uno para seguir su progreso o leer su transcripción
- **Grupo**: el número de subagentes simultáneos está limitado; los adicionales esperan en una cola

## Panel y widgets {#page-dashboard}

Un panel de widgets interactivos generados por el agente. [Abrir el panel →](app:openDashboardView)

1. Haga clic en **Agregar widget**
2. Describa lo que quiere, por ejemplo *"Un gráfico con los incidentes abiertos por prioridad"*
3. El agente crea el widget; pida cambios o haga clic en **Regenerar** en cualquier momento

Los widgets pueden obtener datos en vivo de su instancia, así que se mantienen actualizados. Puede arrastrarlos, cambiar su tamaño, importarlos y exportarlos (consulte [Avanzado](#advanced)). Los widgets que el agente muestra dentro de un chat se pueden guardar con **Anclar al panel**.

## Documentos inteligentes {#page-documents}

Los **Documentos inteligentes** son documentos Markdown persistentes y versionados que el agente escribe y actualiza: planes, informes, especificaciones, conclusiones. Se muestran dentro del chat, conservan todas las versiones y usted puede editarlos directamente. Ábralos desde **Documentos** en la barra lateral. [Abrir documentos →](app:openDocumentsView)

## Habilidades {#page-skills}

Las habilidades dan al agente conocimientos y herramientas adicionales. [Abrir habilidades →](app:openSkillsView)

- **Activar / Desactivar**: active o desactive habilidades; desactive las que no necesite para que las respuestas sean más precisas
- **Nueva habilidad**: escriba su propia habilidad en Markdown o use **Editar con el agente**
- **Importar / Exportar**: comparta habilidades como carpetas
- **Acciones de habilidades**: algunas habilidades agregan botones en la página de inicio que inician un flujo de trabajo predefinido con un clic

Una habilidad puede aportar **conocimientos** (instrucciones, buenas prácticas) y **herramientas personalizadas** (funciones de JavaScript que se ejecutan en un entorno aislado).

## Espacio de trabajo y GitHub {#feature-workspace}

Cada chat tiene un **espacio de trabajo**: un área de archivos donde el agente puede leer, escribir, editar y comparar archivos.

- **GitHub**: conecte una cuenta de GitHub en [Configuración](app:openSettingsPageView) para clonar repositorios en un espacio de trabajo. El agente puede crear ramas, enviar commits y abrir pull requests desde el chat
- **Pull requests**: los PR abiertos desde un chat aparecen en la barra lateral del chat, con un botón **Fusionar**
- **Protección entre chats**: cada archivo recuerda qué chat lo modificó, así que dos chats que trabajan en paralelo no sobrescriben el trabajo del otro sin avisar
- **Sincronización automática**: los espacios de trabajo clonados se sincronizan con GitHub cuando navega, cambia de chat o vuelve a la pestaña

## Barra lateral del chat {#feature-sidebar}

La barra lateral derecha reúne todo lo que ha producido el chat actual:

- **Pull requests**: título, rama de destino y un botón **Fusionar**
- **Archivos del espacio de trabajo**: abra un archivo para verlo, ver sus diferencias o explorar versiones anteriores
- **Historial de versiones**: cambios en la instancia con **Deshacer**, **Rehacer** y **Descargar XML**
- **Trabajadores**: subagentes en ejecución y finalizados, con contadores de llamadas a herramientas, archivos editados y PR abiertos

## Acciones y progreso en vivo {#feature-actions}

Las tareas largas muestran su progreso en vivo en lugar de quedarse en silencio:

- **Tarjeta de progreso**: una sola tarjeta con un estado en color (en ejecución, bloqueado, terminado, error) y una lista de pasos
- **Botones de acción**: botones que inician flujos de trabajo de seguimiento con un clic
- **Indicador de ejecución**: la lista de chats marca los chats en los que el agente está trabajando
- **Notificación "Agente finalizado"**: si cambia de pestaña o de ventana durante una ejecución, una notificación de escritorio le avisa cuando el agente termina

## Chats activos y trabajos {#feature-jobs}

La píldora de trabajos del encabezado abre una vista en vivo de sus chats y del trabajo en segundo plano:

- **Chats activos**: chats en ejecución y chats con resultados sin leer (en **negrita**), cada uno con un anillo de uso del contexto
- **Subagentes**: aparecen bajo su chat principal; abra uno para leer su transcripción
- **Expandir**: abre la lista como un panel más grande, con disposición en columnas o en secciones

## Permisos de herramientas {#feature-permissions}

Además del nivel de permisos por instancia (**Manual**, **Automático**, **Dev**), cada herramienta tiene su propio ajuste en [Configuración](app:openSettingsPageView) → **Permisos de herramientas**:

- **Permitir**: la herramienta siempre se ejecuta sin preguntar
- **Automático**: la herramienta se ejecuta sin preguntar, salvo que el agente marque una llamada como pendiente de su confirmación
- **Preguntar**: recibe una solicitud de aprobación antes de cada llamada
- **Desactivado**: el agente no puede usar la herramienta

Algunas herramientas tienen controles más precisos: la API de ServiceNow por método HTTP (GET, POST, PUT, PATCH, DELETE), el control del navegador por acción (navegar, hacer clic, rellenar, suplantar…) y la gestión de habilidades por acción. Los cuadros de confirmación usan colores según el riesgo: **azul** (rutina), **naranja** (precaución), **rojo** (destructivo).

:::tip
Mantenga DELETE y las demás operaciones destructivas en **Preguntar**, y use **Dev** solo en instancias de desarrollo.
:::

## Herramientas del agente {#feature-tools}

Las principales herramientas que usa el agente:

| Herramienta | Qué hace |
|------|--------------|
| **API de ServiceNow** (`servicenow_api`) | Lee, crea, actualiza y elimina registros |
| **Script en segundo plano** (`servicenow_run_script`) | Ejecuta un script de servidor en la instancia (requiere el rol admin) |
| **Edición de scripts** (`servicenow_diff_edit`) | Modifica scripts con ediciones precisas de buscar y reemplazar |
| **Control del navegador** (`iframe_tool`) | Navega, hace clic, rellena, inspecciona y suplanta en pestañas del navegador |
| **Código en el navegador** (`js_eval`) | Ejecuta JavaScript en un entorno aislado que puede llamar a otras herramientas |
| **Capturas de pantalla** (`take_screenshot`) | Captura la página, un widget o un elemento |
| **Widgets y tarjetas** (`html_widget`, `display`) | Muestra widgets interactivos, tablas, tarjetas y cronologías en el chat |
| **Documentos inteligentes** (`document`) | Crea y actualiza documentos Markdown persistentes |
| **Preguntar al usuario** (`prompt_user`) | Le pide información mediante un formulario dentro del chat |
| **Subagentes** (`spawn_sub_agent`) | Delega trabajo en trabajadores en segundo plano |
| **Espacio de trabajo** (`workspace`) | Trabaja con archivos y repositorios de GitHub |
| **Obtención web** (`web_fetch`) | Lee páginas de la web pública |
| **Habilidades** (`get_skill`, `manage_skill`) | Lee y gestiona habilidades |

Abra [Configuración](app:openSettingsPageView) → **Permisos de herramientas** para ver cada herramienta, su origen y su permiso.

## Caché de contenido grande {#feature-caching}

Cuando el resultado de una herramienta es demasiado grande para la conversación (más de 4K tokens de forma predeterminada), AppAgent lo guarda en caché. El agente recibe un esquema y después lee, busca o explora solo las partes que necesita. Así los chats siguen siendo rápidos y centrados. Cambie el umbral (de 1K a 100K tokens) en [Configuración](app:openSettingsPageView) → **Caché de contenido grande**.

## Indicador de contexto {#feature-saturation}

El **indicador de contexto** junto al cuadro de entrada muestra el nivel de llenado de la conversación. A partir del 50 % se pide al agente que vaya terminando y delegue el trabajo pesado restante en subagentes; al 100 % se detiene e informa. Haga clic en el indicador en cualquier momento para resumir la conversación en un chat nuevo.

## Uso y límites de frecuencia {#feature-usage}

- **Píldora de uso**: el encabezado muestra su uso de la API y los límites restantes; haga clic en ella para ver los detalles
- **Reintentos automáticos**: cuando el proveedor limita la frecuencia o está sobrecargado (HTTP 429 / 529), AppAgent espera y reintenta automáticamente, con una cuenta atrás en el chat
- **Sin créditos**: cuando un 429 significa en realidad que se han agotado sus créditos, el chat lo indica claramente

## Idiomas {#feature-languages}

La interfaz está disponible en inglés y en 24 idiomas más: alemán, árabe, checo, chino (simplificado, tradicional), coreano, danés, español, finés, francés (Francia, Canadá), hebreo, húngaro, italiano, japonés, neerlandés, noruego, polaco, portugués (Brasil, Portugal), ruso, sueco, tailandés y turco.

Elija uno en [Configuración](app:openSettingsPageView) → **Idioma**, o desde el menú de ajustes rápidos del encabezado. **Automático** sigue el idioma de su navegador y, si no está disponible, usa el inglés. El cambio se aplica de inmediato, sin recargar.

- **De derecha a izquierda**: el árabe y el hebreo usan un diseño de derecha a izquierda
- **Formatos locales**: las fechas, las horas y los números siguen su idioma
- **Respuestas del agente**: el agente responde en el idioma elegido, salvo que usted escriba en otro. El código y los nombres de tablas y campos no cambian
- **Esta página de ayuda**: se muestra en su idioma; el registro de cambios se mantiene en inglés

# Páginas y configuración {#pages}

## Configuración {#page-settings}

[Abrir la configuración →](app:openSettingsPageView)

- **Modelo del agente**: el modelo que usa el agente
- **Proveedores de API**: Anthropic, OpenRouter o proveedores personalizados, con clave de API u OAuth
- **Endpoints de LLM**: pares `URL + API key` con nombre para cualquier API compatible con OpenAI
- **Niveles de modelo de subagentes**: asigne modelos a los niveles pequeño, mediano y grande, o **Igual**
- **Esfuerzo de razonamiento, Tokens máximos y Presupuesto de pensamiento**: ajuste la profundidad y la longitud de las respuestas
- **Ventana de contexto**: el tamaño de contexto que usa el indicador de contexto
- **Visualización**: estadísticas de la API, modo compacto, mantener la pantalla encendida
- **Idioma**: idioma de la interfaz, o **Automático**
- **Hooks**: títulos de chat automáticos, notificaciones "Agente finalizado" y otras automatizaciones
- **Caché de contenido grande**: cuándo se guardan en caché los resultados grandes
- **Permisos de herramientas**: qué se ejecuta automáticamente, qué pregunta antes y qué está desactivado
- **GitHub**: conecte una cuenta de GitHub y gestione los repositorios clonados
- **Prompt del sistema**: personalice las instrucciones del agente
- **Gestión de datos**: exporte, importe o elimine sus datos

## Historial {#page-history}

Todas sus conversaciones. [Abrir el historial →](app:openHistoryView)

- **Buscar**: encuentre chats por título, contenido, herramientas usadas o widgets
- **Anclar**: mantenga los chats importantes arriba
- **Exportar**: descargue un chat o todo su historial
- **Estadísticas**: número de chats, chats anclados y coste total

## Ayuda {#page-docs}

Esta página. [Abrir la ayuda →](app:openDocsView)

- **Buscar**: filtre los temas de ayuda desde el cuadro de búsqueda de la barra de herramientas
- **Contenido**: vaya a una sección desde el índice
- **Descargar**: guarde la documentación como archivo Markdown

# Consejos y atajos de teclado {#tips}

| Acción | Cómo |
|--------|-----|
| Enviar un mensaje | <kbd>Enter</kbd> |
| Nueva línea | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Buscar chats | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> en Mac) |
| Cerrar un cuadro de diálogo o un menú | <kbd>Esc</kbd> |
| Volver atrás | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Adjuntar una imagen | Péguela, o arrástrela y suéltela en el chat |
| Empezar de cero con un resumen | Haga clic en el indicador de contexto |
| Interrumpir al agente | Envíe un mensaje nuevo o haga clic en **Pausar** |

:::tip
**Sea específico.** En lugar de *"arregla esto"*, diga *"arregla el error de referencia nula en la línea 42 del script include MyUtils"*. Indique la tabla, el registro o la página siempre que pueda.
:::

- **Un objetivo por chat**: inicie un chat nuevo para una tarea no relacionada; el agente será más rápido y preciso
- **Déjelo probar**: pida al agente que abra la página y verifique su propio cambio con una captura de pantalla
- **Use habilidades**: active una habilidad adecuada para su tarea (por ejemplo, pruebas o auditoría) antes de empezar

# Solución de problemas y preguntas frecuentes {#faq}

### El agente no ve mi instancia

Abra la instancia en una pestaña del mismo perfil de Chrome, asegúrese de haber iniciado sesión y pida *"list instances"*. Si sigue sin aparecer, recargue la pestaña de la instancia.

### Recibo un error de API o de autenticación

Revise su proveedor en [Configuración](app:openSettingsPageView) → **Proveedores de API**: la clave de API, el endpoint seleccionado y el nombre del modelo. Para OAuth, vuelva a iniciar sesión en claude.ai en el mismo perfil de Chrome.

### El agente dice que ha alcanzado el límite de frecuencia

AppAgent reintenta automáticamente y muestra una cuenta atrás. Si sigue ocurriendo, consulte los créditos restantes en la píldora de uso o use un nivel de modelo más pequeño para los subagentes.

### Demasiadas solicitudes de aprobación, o muy pocas

Cambie el nivel de permisos de la instancia (**Manual**, **Automático**, **Dev**) en el menú desplegable de la instancia y ajuste cada herramienta en [Configuración](app:openSettingsPageView) → **Permisos de herramientas**.

### Las respuestas son más lentas o menos precisas en un chat largo

La conversación está llenando su contexto. Haga clic en el indicador de contexto para continuar en un chat nuevo con un resumen.

### ¿Cómo deshago un cambio?

Abra la barra lateral del chat y haga clic en **Deshacer** en el cambio correspondiente del historial de versiones. **Descargar XML** exporta todos los cambios.

### ¿Dónde se guardan mis datos?

Localmente en su navegador (IndexedDB). Los chats nunca van a un servidor de AppAgent, solo a su proveedor de IA y a su instancia de ServiceNow. Consulte [Almacenamiento de datos](#adv-data-storage).

### La interfaz o esta página están en el idioma equivocado

Elija el idioma en [Configuración](app:openSettingsPageView) → **Idioma**. **Automático** sigue el idioma de su navegador.

# Avanzado {#advanced}

Esta sección trata las funciones avanzadas, los botones del encabezado, los formatos de importación y exportación, y detalles técnicos sobre el funcionamiento de AppAgent.

## Botones del encabezado del panel {#adv-dashboard-header}

El encabezado del panel contiene varios botones de acción:

| Botón | Descripción |
|--------|-------------|
| **Mostrar u ocultar la barra lateral** | Muestra u oculta la navegación de la barra lateral izquierda |
| **Abrir por separado** | Abre el panel en una nueva pestaña del navegador para verlo de forma independiente |
| **Encabezados** | Muestra u oculta los encabezados de los widgets del panel. Al ocultarlos, los widgets se ven de forma más limpia |
| **Regenerar todo** | Regenera todos los widgets del panel con el agente. Útil para actualizar los datos |
| **Importar** | Importa un panel o un widget desde un archivo JSON |
| **Exportar** | Exporta todo el panel a un archivo JSON como copia de seguridad o para compartirlo |
| **Agregar widget** | Abre el editor de widgets para crear un widget nuevo con ayuda del agente |

## Botones del encabezado de los widgets {#adv-widget-headers}

**Encabezados de los widgets del panel** (visibles cuando la opción Encabezados está activada):

| Botón | Descripción |
|--------|-------------|
| **Asa de arrastre** | El icono del widget sirve de asa para arrastrarlo y reordenar los widgets |
| **Regenerar** | Pide al agente que regenere el contenido de este widget |
| **Historial** | Muestra las versiones anteriores de este widget (si las hay) |
| **Pantalla completa** | Amplía el widget a pantalla completa |
| **Editar** | Abre el editor de widgets para modificarlo mediante el chat con el agente |
| **Eliminar** | Quita el widget del panel (con confirmación) |

**Encabezados de los widgets del chat** (widgets dentro del chat):

| Botón | Descripción |
|--------|-------------|
| **Anclar al panel** | Guarda este widget en su panel |
| **Editar código** | Muestra y edita directamente el código HTML/CSS/JS del widget |
| **Expandir/contraer** | Muestra u oculta el contenido del widget |

## Cambiar el tamaño y mover widgets {#adv-resize-move}

**Cambiar el tamaño de los widgets:**

- Cada widget tiene un **asa de redimensionamiento** en la esquina inferior derecha
- Haga clic y arrastre el asa para cambiar el tamaño del widget
- El ancho se ajusta a una cuadrícula de 12 columnas (mínimo 3 columnas)
- La altura se mide en unidades de 50px (mínimo 2 unidades = 100px)

**Mover widgets:**

- Active la opción **Encabezados** para mostrar los encabezados de los widgets
- Haga clic y arrastre el **icono del widget** (asa de arrastre) para reordenarlo
- Suelte el widget sobre otro para intercambiar sus posiciones
- El orden de los widgets se guarda automáticamente

## Formatos de importación y exportación {#adv-import-export}

**Exportación del panel** (`dashboard-YYYY-MM-DD.json`):

```
{
  "type": "appagent-dashboard",
  "version": 1,
  "widgets": [
    {
      "id": "widget_123",
      "title": "Widget Title",
      "html": "<html>...</html>",
      "width": 6,
      "height": 8,
      "order": 0,
      "conversation": [...]
    }
  ]
}
```

**Exportación de un solo widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Exportación de un solo chat** (`chat-title-YYYY-MM-DD.json`):

```
{
  "exportType": "single_chat",
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chat": {
    "id": "chat_123",
    "title": "Chat Title",
    "messages": [
      {
        "role": "user",
        "content": "User message text"
      },
      {
        "role": "assistant",
        "content": "Agent response text"
      }
    ],
    "createdAt": 1705312200000
  }
}
```

Las exportaciones de chats conservan todo el historial de la conversación, incluidos todos los mensajes del usuario y las respuestas del agente. Use el menú desplegable del chat (···) y seleccione **Descargar** para exportar chats individuales.

**Exportación de habilidades** (estructura de carpetas):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Nota:** la importación y exportación de habilidades usa la File System Access API y **solo funciona en los navegadores Chrome o Edge**.
:::

**Exportación de todos los datos** (`appagent-backup-YYYY-MM-DD.json`):

```
{
  "version": 3,
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chats": [...],
  "settings": [...],
  "dashboardWidgets": [...],
  "apiProviders": [...]
}
```

La copia de seguridad completa incluye todo el historial de chats, la configuración, los permisos de herramientas, los widgets del panel y las configuraciones de los proveedores de API.

## Estadísticas de la API {#adv-api-stats}

Cuando se activan en Configuración, las estadísticas de la API se muestran después de cada respuesta del agente:

| Métrica | Descripción |
|--------|-------------|
| **Entrada** | Tokens de entrada: el tamaño del prompt enviado al agente |
| **Salida** | Tokens de salida: el tamaño de la respuesta del agente |
| **Total** | Suma de los tokens de entrada y de salida |
| **Lectura/escritura de caché** | Tokens leídos de la caché de prompts o escritos en ella (reduce el coste) |
| **Razonamiento** | Tokens usados para el razonamiento interno (algunos modelos) |
| **Coste** | Coste estimado de la llamada a la API en USD |
| **Duración** | Tiempo que tardó la llamada a la API |

En las conversaciones de varios turnos, las estadísticas agregadas muestran el total de todas las llamadas.

:::tip
Active o desactive las estadísticas de la API en [Configuración](app:openSettingsPageView) → Visualización → Mostrar estadísticas de la API.
:::

## Edición manual de habilidades {#adv-skills-manual}

Las habilidades se pueden crear y editar manualmente o con ayuda del agente:

**Crear una habilidad manualmente:**

1. Vaya a [Habilidades](app:openSkillsView) y haga clic en **Nueva habilidad**
2. Introduzca un nombre y una descripción para la habilidad
3. Escriba el contenido de la habilidad en formato Markdown
4. Haga clic en **Guardar** para crear la habilidad

**Formato de SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Editar con el agente:**

1. Haga clic en **Editar con el agente** en cualquier habilidad
2. Describa los cambios que quiere
3. El agente modificará el contenido de la habilidad
4. Revise y guarde los cambios

**Recursos de las habilidades:** las habilidades pueden incluir archivos adicionales (XML, JS, MD) que aportan contexto o código extra al agente.

## Prompt del sistema {#adv-system-prompt}

El prompt del sistema define el comportamiento y las capacidades del agente. Puede personalizarlo en [Configuración](app:openSettingsPageView).

**Editar el prompt del sistema:**

1. Vaya a Configuración → sección Prompt del sistema
2. Haga clic en **Editar** para pasar al modo de edición
3. Modifique la plantilla según sea necesario
4. Haga clic en **Guardar** para aplicar los cambios

**Marcadores disponibles:**

| Marcador | Descripción |
|-------------|-------------|
| `{{CURRENT_DATE}}` | La fecha de hoy (día de la semana, mes, día, año) |
| `{{ORCHESTRATOR_POLICY}}` | Política de delegación en subagentes: se incluye en los chats principales y queda vacía en los chats de subagentes |
| `{{DISABLED_TOOLS}}` | Lista de herramientas desactivadas |
| `{{TOOL_CATALOG}}` | Catálogo de herramientas diferidas (vacío cuando la carga diferida de herramientas está desactivada) |
| `{{SKILLS_SUMMARY}}` | Contenido de las habilidades activas |

Los marcadores se sustituyen automáticamente por sus valores reales al enviar el prompt a la IA. El recuento de tokens muestra tanto el tamaño de la plantilla como el tamaño expandido.

:::tip
Haga clic en **Restaurar predeterminado** para recuperar el prompt del sistema original si es necesario.
:::

## Llamadas a la API del agente {#adv-agent-api}

AppAgent funciona como una **extensión de Chrome**:

- Las llamadas a la API de IA van **directamente de su navegador al proveedor de IA** (p. ej., Anthropic, OpenRouter)
- **No** pasan por su instancia ni por ningún servidor de AppAgent
- Su clave de API (o token de OAuth) se guarda localmente en su navegador
- Los datos de la conversación se envían al proveedor de IA para su procesamiento

**Cómo funciona:**

1. Usted escribe un mensaje en el chat
2. AppAgent crea un prompt con las instrucciones del sistema, las herramientas y el historial de la conversación
3. El prompt se envía a la API del proveedor de IA
4. La respuesta del agente llega en streaming a su navegador
5. Las llamadas a herramientas se ejecutan en su navegador, usando la sesión de su instancia para las llamadas a la API

:::tip
**Privacidad:** su clave de API y los datos de la conversación se gestionan en el cliente. Las llamadas a herramientas que interactúan con su instancia usan las credenciales de su sesión actual.
:::

## Endpoints de LLM {#adv-endpoints}

Los modelos se conectan mediante **endpoints de LLM con nombre**: pares `URL + API key` reutilizables. Así puede apuntar AppAgent a **cualquier API de chat completions compatible con OpenAI**: OpenRouter, una pasarela local, un proxy o su propio modelo alojado.

1. En [Configuración → Endpoints de LLM](app:openSettingsPageView), haga clic en **Agregar endpoint**
2. Asígnele un nombre, la URL de la API y una clave de API
3. Cada modelo (proveedor de API) elige un endpoint: actualice una clave una sola vez y se actualizarán todos los modelos que la usan

:::tip
Los proveedores con **OAuth** de Claude no usan endpoints: se comunican directamente con `api.anthropic.com`.
:::

## Iniciar sesión con Claude (OAuth) {#adv-oauth}

En lugar de pegar una clave de API, puede iniciar sesión en los proveedores de Anthropic con su sesión actual de claude.ai:

1. En [Configuración → Proveedores de API](app:openSettingsPageView), agregue o edite un proveedor de Anthropic y active **OAuth**
2. La extensión usa su sesión de claude.ai del mismo perfil de Chrome para conectarse directamente a Anthropic
3. Sin ventana de inicio de sesión adicional y sin ningún servidor de AppAgent de por medio

**Requisitos:**

- Debe haber iniciado sesión en `claude.ai` en el mismo perfil de Chrome
- Funciona con cuentas de inicio de sesión único (SSO)

:::tip
Los tokens de OAuth se renuevan automáticamente. Si falla el inicio de sesión, abra `claude.ai` en el mismo perfil y vuelva a iniciar sesión.
:::

## Consideraciones de seguridad {#adv-security}

**Almacenamiento de la clave de API:**

- Su **clave de API se guarda localmente** en el IndexedDB de su navegador
- La clave nunca se envía a su instancia ni a ningún servidor que no sea el del proveedor de IA
- Al borrar los datos del navegador se elimina la clave de API guardada

**Sesión y permisos:**

- El agente funciona con su **sesión de usuario actual** y hereda sus derechos de acceso y roles
- Todas las llamadas a la API de su instancia usan las credenciales de su sesión
- El agente solo puede acceder a lo que puede acceder su cuenta de usuario

**Entorno de ejecución de herramientas:**

- **Código en el navegador (js_eval)** ejecuta JavaScript en un **entorno aislado** con acceso únicamente a `executeTool()`
- Los **scripts de widgets** se ejecutan en **iframes aislados** con acceso únicamente a `executeTool()` para las llamadas a la API
- Las **herramientas de habilidades** se ejecutan en **entornos aislados** con acceso únicamente a `executeTool()`
- Todo el acceso a la API pasa por el **sistema de permisos** mediante `executeTool("servicenow_api", {...})`
- El agente interactúa con las páginas en **pestañas del navegador** de su instancia de ServiceNow

**Capacidad de modificar registros:**

- La herramienta **API de ServiceNow** admite los métodos POST, PATCH, PUT y DELETE, que pueden modificar registros
- El agente puede crear y editar registros mediante el **navegador integrado** si tiene permisos para las herramientas de rellenar y hacer clic
- Configure los [Permisos de herramientas](app:openSettingsPageView) para decidir qué operaciones requieren aprobación

**Automejora:**

- El agente puede **gestionar sus propias habilidades**: crearlas, editarlas y activarlas
- Esto le permite aprender y mejorar con el tiempo
- Revise periódicamente los cambios en las habilidades para asegurarse de que se ajustan a sus expectativas

## Almacenamiento de datos {#adv-data-storage}

AppAgent guarda los datos localmente en su navegador mediante **IndexedDB**:

| Tipo de datos | Almacenamiento | Descripción |
|-----------|---------|-------------|
| **Chats** | IndexedDB | Todo el historial de conversaciones, mensajes y resultados de herramientas |
| **Configuración** | IndexedDB | Permisos de herramientas, claves de API, preferencias de modelo |
| **Widgets del panel** | IndexedDB | HTML, títulos, tamaños e historial de conversación de los widgets |
| **Habilidades** | IndexedDB | Definiciones, contenido y recursos de las habilidades |
| **Proveedores de API** | IndexedDB | Configuraciones y endpoints de los proveedores de API personalizados |
| **Estado de la interfaz** | localStorage | Estado de la barra lateral, vista actual, posiciones de desplazamiento |

**Descargar sus datos:**

1. Vaya a [Configuración](app:openSettingsPageView) → Gestión de datos
2. Haga clic en **Exportar datos**
3. Se descargará un archivo JSON de copia de seguridad

**Eliminar sus datos:**

1. Vaya a [Configuración](app:openSettingsPageView) → Gestión de datos
2. Haga clic en **Eliminar todos los datos**
3. Confirme dos veces para eliminarlo todo de forma permanente

:::tip
**Importante:** los datos se guardan localmente en la extensión. Si borra los datos del navegador, desinstala la extensión o usa otro perfil del navegador, tendrá almacenes de datos separados.
:::

# Acerca de {#about}

**Versión:** v__VERSION__

**Licencia:** uso privado y comercial. Se permite la modificación interna. Se prohíben la distribución y la reventa. Todos los derechos reservados.

## Registro de cambios {#changelog}

__CHANGELOG__
