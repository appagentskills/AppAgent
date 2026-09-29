# AppAgent

**Cree y mantenga aplicaciones de ServiceNow con un agente. Como extensión de Chrome.**

AppAgent es su compañero de desarrollo para ServiceNow. Puede crear y mantener aplicaciones, y ejecutar pruebas sobre ellas. Hace las pruebas rellenando formularios y tomando capturas de pantalla. No se necesitan conocimientos técnicos.

Usted aporta su propia clave de API (BYOK) y listo. Es compatible con OpenAI, OpenRouter, la API de Claude e incluso con los planes de Claude Code (contáctenos en privado).

Es una extensión de Chrome que guarda todo el chat en su navegador (ni siquiera sale de él). Solo interactúa con su instancia de ServiceNow y con el proveedor de API de su modelo.

![Ejemplo de AppAgent](AppAgentExample.png)

Usa menos tokens que Claude Code, porque se apoya mucho en la caché de la API, la caché de herramientas y el encadenamiento de herramientas (de serie).

Puede agregarle habilidades, controla el navegador mediante pestañas y tiene botones de deshacer mecánicos para todos los cambios que hace en su instancia.

> **Nota:** por ahora, AppAgent está pensado para usarse solo en instancias de desarrollo.

## Contacto

Rellene este formulario y nos pondremos en contacto con usted: [Formulario de contacto](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funciones

| Función | Qué hace |
|---------|--------------|
| **Use su propio modelo** | Elija entre Claude, GPT, Gemini, Grok y más |
| **Iniciar sesión con Claude** | Flujo OAuth: use su plan actual de Claude Code Personal o Enterprise, sin necesidad de clave de API |
| **Imágenes y PDF** | Adjunte capturas de pantalla, diagramas o documentos para que el agente los analice |
| **Edición de código** | Lee y modifica scripts con seguimiento completo de versiones |
| **Control del navegador** | Prueba su propio trabajo: navega por pestañas, hace clic, rellena formularios y toma capturas de pantalla |
| **Paneles en vivo** | Crea widgets que obtienen datos en tiempo real de su instancia |
| **Habilidades del agente** | Cree sus propias habilidades para ampliar las capacidades del agente |
| **Acciones de habilidades** | Las habilidades pueden mostrar en la página de inicio botones que inician flujos de trabajo predefinidos con un clic |
| **Progreso en vivo** | Vea lo que hace el agente en tiempo real: píldoras de progreso dinámicas con estados en ejecución/bloqueado/terminado/error |
| **Espacios de trabajo** | Área de archivos por chat: clone repositorios de GitHub, lea, escriba, edite, compare y cambie de rama. Varios repositorios por chat, con protección de propiedad entre chats |
| **Git y envío a GitHub integrados** | El agente puede hacer pull y push con GitHub, crear ramas y abrir pull requests directamente desde el chat, sin terminal ni IDE |
| **Documentos inteligentes** | Markdown persistente y versionado que el agente puede editar y consultar entre chats |
| **Varias instancias** | Detecta automáticamente todas las instancias de ServiceNow abiertas en su navegador; el agente puede verlas y actuar sobre todas desde un mismo chat |
| **Subagentes** | Delega el trabajo pesado o en paralelo en agentes trabajadores en segundo plano que informan al chat principal |
| **25 idiomas** | Interfaz y ayuda en inglés y 24 idiomas más, incluidos el árabe y el hebreo de derecha a izquierda |
| **Pausar e interrumpir** | Pause o envíe un mensaje nuevo en plena respuesta: la llamada en curso se cancela de inmediato |
| **Búsqueda web** | Búsquedas web gratuitas y sin clave mediante Google y DuckDuckGo |
| **Deshacer mecánico** | Cada cambio se registra y se revierte con un clic |
| **Exportación a XML** | Exporte todos los cambios para desplegarlos en otras instancias |
| **Permisos de herramientas** | Seguridad integrada: controle lo que el agente puede hacer en la instancia |
| **Estándares abiertos** | Compatible con [OpenRouter](https://openrouter.ai) y [AgentSkills.io](https://agentskills.io) |
| **Caché del modelo** | Reduce el coste hasta 10 veces gracias a la caché de prompts |
| **Contexto inteligente** | Carga solo las partes necesarias de los archivos grandes. No sobrecarga el modelo |
| **Cero dependencias** | Sin bibliotecas ni frameworks, JavaScript puro |

## Cómo funciona

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│              │      │              │      │              │
│   Chrome     │◀────▶│    Model     │      │  ServiceNow  │
│  Extension   │      │   (Claude,   │      │   Instance   │
│              │      │   GPT, etc)  │      │              │
│  [AppAgent]  │      └──────────────┘      │              │
│              │◀──────────────────────────▶│              │
└──────────────┘                            └──────────────┘
```

AppAgent es una extensión de Chrome con un bucle de agente integrado. Usted describe lo que quiere → el agente consulta al modelo → ejecuta herramientas en el navegador → accede a ServiceNow con los permisos de su usuario actual. El agente se comunica directamente con los proveedores de API de modelos, locales o en línea.

## Comparativa de AppAgent

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Usuario objetivo** | No técnico | Desarrolladores | Desarrolladores | Fundadores no técnicos |
| **Diseñado para ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Acciones agénticas en ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Requiere entorno de desarrollo** | ✗ | ✓ | ✓ | ✗ |
| **Crea aplicaciones** | ✓ | ✓ | ✓ | ✓ |
| **Control del navegador para pruebas** | ✓ | ✗ | ✗ | ✗ |
| **Toma capturas de pantalla** | ✓ | ✗ | ✗ | ✗ |
| **Tareas en segundo plano** | ✓ (mediante acciones de habilidades) | ✗ | ✓ | ✗ |
| **Agentes en paralelo** | ✓ (subagentes) | ✗ | ✓ | ✗ |
| **Deshacer mecánico** | ✓ | ✗ | ✗ | ✗ |
| **Imágenes y PDF** | ✓ | ✓ | ✓ | Limitado |
| **Paneles inteligentes** | ✓ | ✗ | ✗ | ✓ |
| **Habilidades ampliables** | ✓ | ✓ | ✗ | ✗ |
| **Acciones de habilidades (botones de un clic)** | ✓ | ✗ | ✗ | ✗ |
| **Píldoras de progreso en vivo** | ✓ | ✗ | ✗ | ✗ |
| **Compatibilidad con varias instancias** | ✓ | ✗ | ✗ | ✗ |
| **Espacios de trabajo por chat** | ✓ | ✗ | ✗ | ✗ |
| **Git integrado** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push a GitHub desde el chat** | ✓ | ✓ (CLI) | Limitado | ✗ |
| **Documentos inteligentes** | ✓ | ✗ | ✗ | ✗ |
| **Pausar / interrumpir en plena respuesta** | ✓ | ✓ | Limitado | ✗ |
| **Búsqueda web** | ✓ | ✓ | ✓ | ✗ |
| **Permisos de herramientas** | ✓ | ✓ | Limitado | ✗ |
| **Exportación de cambios** | ✓ XML | ✓ | ✓ | ✓ |
| **Use su propio modelo** | ✓ | ✗ | ✓ | ✗ |
| **Caché de prompts** | ✓ | ✓ | ✓ | ✗ |
| **Contexto inteligente** | ✓ | ✓ | ✓ | ✗ |
| **Cero dependencias** | ✓ | ✗ | ✗ | ✓ |

*Base44 no puede crear aplicaciones de ServiceNow, pero se incluye para los usuarios que conocen su experiencia.*

## Instalación

1. **Instalar**: instale la extensión AppAgent desde Chrome Web Store (o cárguela sin empaquetar para desarrollo)
2. **Obtener una clave de API**: regístrese en [OpenRouter](https://openrouter.ai), use Anthropic/OpenAI directamente o conecte su suscripción de Claude Code (Enterprise o Personal)
3. **Configurar**: abra la extensión y agregue su clave de API (o inicie sesión con Claude) en Configuración → Proveedores de API
4. **Empezar a crear**: abra su instancia de ServiceNow en una pestaña (se detecta automáticamente) y empiece a chatear

## Ejemplos

### "Créame una aplicación sencilla para hacer seguimiento de las tareas del equipo"
AppAgent creará la tabla, agregará los campos, diseñará un formulario y una vista de lista, y configurará un módulo en el navegador de aplicaciones. Un solo prompt, una aplicación completa.

### "Haz una auditoría completa de esta instancia"
AppAgent buscará brechas de seguridad, cuentas de administrador inactivas, registros obsoletos y buenas prácticas de configuración, y después le entregará un informe con recomendaciones.

### "Prueba esta página e informa de cualquier problema que encuentres"
AppAgent abrirá la página en una pestaña del navegador, rellenará formularios, hará clic en botones, tomará capturas de pantalla y elaborará un informe con todo lo que encuentre.

### "Hay un error en este formulario, ¿puedes arreglarlo?"
AppAgent abrirá el formulario, inspeccionará los scripts que hay detrás, identificará el error, corregirá el código y le mostrará exactamente qué ha cambiado. Un clic para deshacerlo si hace falta.

### "Crea un widget de panel para mis tickets abiertos"
AppAgent creará un widget en vivo que obtiene datos en tiempo real de su instancia y los muestra en su panel.

### "Importa este archivo de Excel en la tabla de usuarios"
AppAgent leerá el archivo, asignará las columnas a los campos e importará los datos en su instancia.

### "Revisa el historial de actualizaciones y corrige los problemas de personalización"
AppAgent revisará qué cambió en la actualización, encontrará las personalizaciones rotas y las corregirá.

### "Avisa al equipo cuando se cree un incidente P1"
AppAgent creará una regla de notificación que se active con los incidentes P1 y envíe una alerta a su equipo.

---

## La visión

Ahora mismo Opus 4.7 es excelente, pero todavía necesita cierta supervisión.

Seguiremos llevando al límite lo que los modelos de IA son capaces de hacer en cada generación, y seguiremos subiendo por la pila de abstracción hasta que nos quedemos atascados.

GPT-4 => Autocompletado de código
GPT-4o => Escribe un archivo independiente
Sonnet 3.5 => Edita un archivo dentro de una base de código
Opus 4.5 => Escribe una funcionalidad completa
Opus 4.6 => Mantiene una aplicación de principio a fin
Opus 4.7 => ... (todavía lo estamos probando)

---

## Hoja de ruta

- RAG
- Especificaciones y casos de prueba

Sin ningún orden en particular.

Esta versión sirve principalmente para recoger comentarios.

Es posible que las próximas versiones no sean de código abierto, pero seguiremos manteniendo esta versión hasta que sea estable.

---

## Pautas de contribución

No abra ningún PR: es un proyecto comercial y solo publicamos el código para ofrecer visibilidad y confianza.

Si encuentra errores, puede abrir un issue o contactarnos directamente. Solo ofrecemos soporte comercial, así que solo corregiremos los errores que puedan afectar a otros usuarios.

---

## Licencia

Uso privado y comercial. Se permite la modificación interna. Se prohíben la distribución y la reventa.
