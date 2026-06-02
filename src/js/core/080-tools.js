// Default token limits (overridden by provider-specific settings) (overridden by provider-specific settings)
var MAX_TOKENS = 16000;
var THINKING_BUDGET = 10000;

var TOOLS = [
    {
        type: 'function',
        function: {
            name: 'js_eval',
            description: 'Execute JavaScript code in an isolated sandbox. PREFERRED for chaining multiple tool calls in a single step — call tools sequentially, process intermediate results, and return a final summary. This is more efficient than separate tool calls because you avoid round-trips to the API between each step.\n\nCall other tools via: await executeTool(name, args). Each tool returns its full result object. IMPORTANT: Always return the key metadata from your chained calls (widget IDs, screenshot IDs, sys_ids, etc.) so you can reference them in follow-up actions.\n\nWhen creating widgets from js_eval: fetch/prepare all data FIRST in js_eval, then embed it directly in the widget HTML. Only use executeTool inside the widget itself when you need live/dynamic data. Example:\nvar data = await executeTool("servicenow_api", {method:"GET", table:"incident", limit:5});\nvar rows = data.data.result.map(function(i){return "<tr><td>"+i.number+"</td><td>"+i.short_description+"</td></tr>";}).join("");\nvar widget = await executeTool("html_widget", {title:"Incidents", html:"<table>"+rows+"</table>"});\nreturn {widgetId: widget.widgetId, count: data.data.result.length};\n\nNo access to page globals or sessionToken.\n\nScreenshots & Images: take_screenshot returns {base64, width, height, screenshot_id}. The base64 is a complete data URL — use directly as img.src.\n1. To READ an image (send to vision): return _images array — return {_images: [{base64: ss.base64, name: "page"}]};\n2. To USE an image (in widget, etc.): use ss.base64 directly.\n3. To CREATE an image: var canvas = document.createElement("canvas"); return {_images: [{base64: canvas.toDataURL("image/png"), name: "chart"}]};\n4. To RETRIEVE a previous screenshot: await executeTool("screenshot_by_id", {id: "ss_1_..."}).',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'JavaScript code to execute' },
                    confirm: { type: 'boolean', description: 'Set to true when executing code that modifies external state (ServiceNow records, widgets) and you think the user should review. Omit or set false for read-only operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_api',
            description: 'Call ServiceNow Table API. Supports GET, POST, PUT, PATCH, DELETE on any table. Also supports uploading attachments via the Attachment API: set method to "POST", table to "attachment", and provide attachment_data, attachment_file_name, attachment_table_name, and attachment_table_sys_id. PREFERRED for any read or write of ServiceNow records — use this instead of driving the UI with iframe_tool whenever the same job can be done via the Table API.',
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                    table: { type: 'string', description: 'Table name e.g. incident, sys_user. Use "attachment" to upload a file attachment.' },
                    scope: { type: 'string', description: 'Application scope for the record. Use "global" for global scope, or a sys_id for a scoped app. Required for POST/PUT/PATCH.' },
                    sys_id: { type: 'string', description: 'Record sys_id (for GET/PUT/PATCH/DELETE single record)' },
                    query: { type: 'string', description: 'Encoded query string for filtering (GET)' },
                    fields: { type: 'string', description: 'Comma-separated fields to return' },
                    limit: { type: 'number', description: 'Max records to return' },
                    data: { type: 'object', description: 'Record data for POST/PUT/PATCH' },
                    url_params: { type: 'object', description: 'Additional URL parameters as key-value pairs, e.g. { "sysparm_display_value": "true", "sysparm_exclude_reference_link": "true" }' },
                    attachment_data: { type: 'string', description: 'Base64-encoded file content for attachment upload (data URL like "data:image/png;base64,..." or raw base64)' },
                    attachment_file_name: { type: 'string', description: 'File name for attachment upload, e.g. "screenshot.png"' },
                    attachment_table_name: { type: 'string', description: 'Target table for attachment, e.g. "incident"' },
                    attachment_table_sys_id: { type: 'string', description: 'sys_id of the record to attach the file to' },
                    attachment_content_type: { type: 'string', description: 'MIME type of the attachment, e.g. "image/png". Auto-detected from file name if not provided.' },
                    instance: { type: 'string', description: 'Target a specific ServiceNow instance by short name (e.g. "dev12345") or URL. Defaults to the active instance. Use list_instances to see available instances.' },
                    confirm: { type: 'boolean', description: 'Set to true for write operations (POST/PUT/PATCH/DELETE) that you think the user should review before execution. When true, the user will be prompted to approve. Omit or set false for routine operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['method', 'table', 'scope']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_run_script',
            description: 'Execute a server-side JavaScript snippet on the ServiceNow instance. Runs synchronously, captures gs.print/gs.info output, and returns the response. Each execution is logged in sys_script_execution_history. DO NOT use this as a replacement for multiple Table API calls — if the work is just "fetch N records, update each", chain servicenow_api calls inside js_eval instead. ONLY use servicenow_run_script for things the Table API genuinely cannot do: server-only globals (gs.*), GlideRecord-only APIs, transactions, system operations, or logic that must run server-side.',
            parameters: {
                type: 'object',
                properties: {
                    script: { type: 'string', description: 'Server-side JavaScript to execute. Use gs.print(...) or gs.info(...) for output.' },
                    scope: { type: 'string', description: 'Application scope to execute in (e.g. "global" or a scope name like "x_snc_myapp"). Default: global.' },
                    record_for_rollback: { type: 'boolean', description: 'If true (default), records changes for rollback via sys_script_execution_history.' },
                    sandbox: { type: 'boolean', description: 'If true, runs in sandboxed mode (limits some operations). Default: false.' },
                    instance: { type: 'string', description: 'Target a specific ServiceNow instance by short name. Defaults to the active instance.' },
                    confirm: { type: 'boolean', description: 'Set to true when you think the user should review before execution. Often appropriate for this tool.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['script']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_diff_edit',
            description: 'Edit a ServiceNow record field using search-and-replace operations. NO line numbers needed - uses unique text anchors. Each edit specifies: find (unique text to locate) and replace (replacement text). The tool searches for exact matches and fails safely if text is not found or not unique. Multiple edits are applied in sequence. IMPORTANT: (1) Use unique text anchors in find - include 2-3 lines of context to ensure uniqueness. (2) Whitespace must match exactly - spaces, tabs, and newlines in find must match the source precisely. Example: {"table": "sys_script_include", "sys_id": "abc123", "field": "script", "edits": [{"find": "function oldFunc() {\\n    return false;", "replace": "function newFunc() {\\n    return true;"}]}',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Table name e.g. sys_script_include, sys_ui_page' },
                    sys_id: { type: 'string', description: 'Record sys_id' },
                    field: { type: 'string', description: 'Field name to edit e.g. script, html, client_script' },
                    edits: {
                        type: 'array',
                        description: 'Array of edit operations using text search (no line numbers needed).',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find. Must be unique in the document. Include enough context (few lines) to ensure uniqueness.' },
                                replace: { type: 'string', description: 'Replacement text. Use empty string to delete the found text.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    instance: { type: 'string', description: 'Target a specific ServiceNow instance by short name (e.g. "dev12345") or URL. Defaults to the active instance.' },
                    confirm: { type: 'boolean', description: 'Set to true when you think the user should review this code edit before execution. Omit or set false for routine changes.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['table', 'sys_id', 'field', 'edits']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'iframe_tool',
            description: 'Control an iframe to navigate, interact with elements, extract visible text/DOM, debug pages, and debug/edit widgets. Use this for testing UI rendering, debugging web pages/widgets, exercising client scripts, or interacting with things that have no API equivalent. DO NOT use iframe_tool to read or modify ServiceNow records when servicenow_api (Table API) can do the same job — the Table API is faster, more reliable, and the preferred path for CRUD. If the job is normally performed by clicking a UI Action, read the UI Action source first (sys_ui_action.script + condition) and replicate the work via Table API or servicenow_run_script instead of clicking through the UI — the UI is always slower and more brittle. For widgets, provide widget_id to target that specific widget.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['navigate', 'get_visible_text', 'get_dom', 'click', 'fill', 'type', 'wait_for', 'get_console_logs', 'get_network_requests', 'close', 'open_widget', 'edit_html', 'dispatch_event', 'select_option', 'scroll', 'resize', 'get_properties', 'set_style', 'impersonate', 'get_page_info'],
                        description: 'Action to perform: navigate (load URL - not for widgets), get_visible_text (extract visible text content from page - use take_screenshot tool for actual images), get_dom (get HTML), click (click element), fill (fill input - one-shot, fires full keydown→input→keyup→change chain so frameworks/client-scripts see real user input), type (per-character typing with key events - slower but reliably triggers debounced/autocomplete handlers; supports delay, append), wait_for (block until a condition is met: selector_visible, selector_gone, text, or url_matches), get_console_logs, get_network_requests, close (close panel - not for widgets), open_widget (open widget in panel for debugging - requires widget_id), edit_html (edit widget HTML using find/replace - requires widget_id and edits), dispatch_event (trigger a DOM event on element - requires selector and event), select_option (select dropdown option - requires selector and value or text), scroll (scroll page to position/element/coordinates), resize (resize viewport - use preset or width/height), get_properties (get computed styles, dimensions, values of elements), set_style (apply CSS styles or toggle classes on elements), impersonate (impersonate a ServiceNow user - requires user param with username/name/sys_id, use "stop" to end), get_page_info (get current page URL, title, and viewport dimensions)'
                    },
                    url: { type: 'string', description: 'URL path to navigate to (for navigate action, not applicable for widgets). Same-origin only.' },
                    early_error_capture: { type: 'boolean', description: 'For navigate action: if true, injects error capture script to catch errors that occur before page load. WARNING: This may break some pages (e.g. ServiceNow Unified Navigation). Default: false.' },
                    wait: { type: 'boolean', description: 'For navigate action: if true, waits for the page (and any nested gsft_main iframe) to fully load before returning, up to 15 seconds. Useful when you need to take a screenshot or interact with the page immediately after navigation. Default: false.' },
                    selector: { type: 'string', description: 'CSS selector for element (for click/fill/dispatch_event/select_option/scroll/get_properties/set_style actions). For click/fill: optional if x and y coordinates are provided instead.' },
                    value: { type: 'string', description: 'Value to fill (for fill/type action) or option value to select (for select_option action)' },
                    delay: { type: 'number', description: 'For type action: ms delay between keystrokes. Default: 30. Use 0 for fastest, higher values (50-100) for stubborn debounced inputs.' },
                    append: { type: 'boolean', description: 'For type action: if true, types after existing value instead of clearing first. Default: false.' },
                    timeout: { type: 'number', description: 'For wait_for action: max ms to wait. Default: 10000.' },
                    poll: { type: 'number', description: 'For wait_for action: polling interval in ms. Default: 100.' },
                    selector_visible: { type: 'string', description: 'For wait_for action: wait until this CSS selector matches an element with non-zero size.' },
                    selector_gone: { type: 'string', description: 'For wait_for action: wait until this CSS selector no longer matches a visible element.' },
                    url_matches: { type: 'string', description: 'For wait_for action: wait until window.location.href contains this substring.' },
                    event: { type: 'string', enum: ['click', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'], description: 'For dispatch_event action: DOM event to trigger' },
                    key: { type: 'string', description: 'For dispatch_event action with keydown/keyup: key value (e.g. "Enter", "Escape", "Tab")' },
                    text: { type: 'string', description: 'For select_option action: option visible text to select (alternative to value)' },
                    deep: { type: 'boolean', description: 'For get_visible_text action: if false (default), returns only text content. If true, includes rect, selector, id, etc.' },
                    position: { type: 'string', enum: ['top', 'bottom'], description: 'For scroll action: scroll to top or bottom of page' },
                    x: { type: 'number', description: 'For scroll action: horizontal scroll position. For click/fill actions: x coordinate to find element at that position (use with y instead of selector)' },
                    y: { type: 'number', description: 'For scroll action: vertical scroll position. For click/fill actions: y coordinate to find element at that position (use with x instead of selector)' },
                    behavior: { type: 'string', enum: ['smooth', 'instant'], description: 'For scroll action: scroll behavior. Default: instant' },
                    preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fullhd'], description: 'For resize action: viewport size preset (mobile=375x812, tablet=768x1024, desktop=1440x900, fullhd=1920x1080)' },
                    width: { type: 'number', description: 'For resize action: custom viewport width in pixels' },
                    height: { type: 'number', description: 'For resize action: custom viewport height in pixels' },
                    max_length: { type: 'number', description: 'Max chars for get_dom output. Default 200000.' },
                    include: { type: 'array', items: { type: 'string', enum: ['rect', 'styles', 'value', 'attributes'] }, description: 'For get_properties action: what to include. Default: all' },
                    styles: { type: 'object', description: 'For set_style action: CSS properties to set, e.g. {"display": "none", "color": "red"}' },
                    className: { type: 'string', description: 'For set_style action: add/remove/toggle a class - "add:className", "remove:className", or "toggle:className"' },
                    widget_id: { type: 'string', description: 'Target a specific html_widget by its ID. Required for open_widget, edit_html. Optional for get_visible_text, get_dom, click, fill to target widget instead of browser.' },
                    user: { type: 'string', description: 'For impersonate action: username, display name, or sys_id of user to impersonate. Use "stop" to end impersonation.' },
                    instance: { type: 'string', description: 'Target a specific ServiceNow instance by short name for navigate action. Finds/creates a tab on that instance.' },
                    edits: {
                        type: 'array',
                        description: 'For edit_html action: array of edit operations to apply to widget HTML.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Text to find in the widget HTML. Must be unique.' },
                                replace: { type: 'string', description: 'Replacement text. Use empty string to delete.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    confirm: { type: 'boolean', description: 'Set to true for actions that modify the instance (click, fill, impersonate, dispatch_event, select_option) when you think the user should review before execution. Omit or set false for read-only actions.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_chat_title',
            description: 'Set the title of the current chat. Use this to give the chat a descriptive, concise title that summarizes what was accomplished. Call this as your FINAL action after completing all tasks.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'A concise title for the chat (max 60 characters). Should summarize the main task or outcome.' },
                    confirm: { type: 'boolean', description: 'Set to true if you think the user should review the title before it is set. Omit or set false for routine title updates.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_outline',
            description: 'View structural outline of large cached tool results. When a tool returns data > 4k tokens, it is cached and an outline is shown. Use this to explore the cached content at different detail levels or focus on specific paths.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'The cached content ID (from _cached.content_id in the tool result)' },
                    detail_level: { type: 'number', description: 'Amount of detail: 1=minimal, 3=medium (default), 5+=detailed. Affects depth and array sample count.' },
                    path: { type: 'string', description: 'JSON path to focus on e.g. "result.data" or "items[0].details". Omit for root level.' },
                    array_offset: { type: 'number', description: 'For array pagination: skip first N items (default: 0). Use when previous result shows "_more" items.' },
                    array_limit: { type: 'number', description: 'For array pagination: max items to show (default: based on detail_level). Rejected if result exceeds ~16KB.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['content_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_search',
            description: 'Search for regex patterns within large cached tool results. Finds matches in all string values and returns context with surrounding lines.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'The cached content ID (from _cached.content_id in the tool result)' },
                    query: { type: 'string', description: 'Regex pattern to search for (e.g., "function\\s+\\w+", "error|warning", "(?i)todo" for case-insensitive)' },
                    path: { type: 'string', description: 'JSON path to limit search scope (e.g., "result.script"). Omit to search all fields.' },
                    offset: { type: 'number', description: 'Skip first N matches for pagination (default: 0). Use when previous search hit max_matches or size limit.' },
                    max_matches: { type: 'number', description: 'Maximum matches to return per page (default: 20)' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['content_id', 'query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_read',
            description: 'Read specific parts of large cached tool results. Navigate to a path and optionally read line ranges for code fields.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'The cached content ID (from _cached_content.id in the tool result)' },
                    path: { type: 'string', description: 'JSON path to read e.g. "result.script" or "items[0]". If omitted, reads from root.' },
                    start_line: { type: 'number', description: 'For string values: start line number (1-indexed). Default: 1' },
                    end_line: { type: 'number', description: 'For string values: end line number. Default: start_line + 99' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['content_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_skill',
            description: 'Retrieve AI skill content and files. Actions: "get" returns SKILL.md content and lists available files. "read_file" reads a specific file from the skill.',
            parameters: {
                type: 'object',
                properties: {
                    skill_id: { type: 'string', description: 'The ID of the skill (shown in AVAILABLE AI SKILLS list)' },
                    action: { type: 'string', enum: ['get', 'read_file'], description: 'Action to perform. Default: "get"' },
                    filename: { type: 'string', description: 'Filename to read (required when action is "read_file")' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['skill_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_skill',
            description: 'Create, update, or manage AI skills and their files. Use this to create new skills with custom tools (JS files) or content files (XML/MD). Use action="edit" with an `edits` array to apply search-and-replace changes to the skill body (or a skill file when `filename` is supplied) without resending the whole content — same shape as servicenow_diff_edit, workspace edit, and document edit.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'update', 'edit', 'add_file', 'update_file', 'delete_file', 'activate', 'deactivate', 'delete'], description: 'Action to perform. NOTE: "delete" permanently removes the entire skill and cascades to all its files/assets — destructive, confirm recommended.' },
                    skill_id: { type: 'string', description: 'Skill ID (required for all actions except create)' },
                    name: { type: 'string', description: 'Skill name in lowercase with hyphens (for create/update)' },
                    description: { type: 'string', description: 'Brief description of what the skill does (for create/update)' },
                    body: { type: 'string', description: 'Skill content/instructions in markdown format (for create/update)' },
                    actions: {
                        type: 'array',
                        description: 'Optional list of Action buttons that surface this skill in the UI (for create/update). Each action becomes a one-click button that runs the skill in a background chat. Pass [] to clear actions on update; omit to leave them unchanged.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Action label, max 48 chars. The skill body should contain a matching "## Action Lifecycle: <name>" section with the steps to run.' },
                                icon: { type: 'string', description: 'Icon name. One of: search, shield, eye, play, check, close, spinner, lock, pause, stop, bell, code, database, stats, zap, alert, list, clipboard, rocket, bug, browser, clock, skill, tool, widget, api, download, upload, refresh, edit, trash. Default: play.' },
                                show: {
                                    type: 'array',
                                    description: 'Where the button is rendered. One or more of: home (home view), chat (above chat input), sidebar (left rail). Default: ["home"]. NOTE: the top bar is reserved for live (running / not-yet-dismissed) actions and is populated automatically — you cannot place buttons there via config.',
                                    items: { type: 'string', enum: ['home', 'chat', 'sidebar'] }
                                }
                            },
                            required: ['name']
                        }
                    },
                    filename: { type: 'string', description: 'Filename for file operations (e.g., "tool.js", "config.xml")' },
                    file_content: { type: 'string', description: 'File content for add_file/update_file. For JS tools (run in isolated sandbox with only executeTool access), use format: var TOOL_DEFINITION = { type: "function", function: { name: "tool_name", description: "...", parameters: {...} } };\nasync function tool_name(args) { await executeTool("servicenow_api", {...}); return {...}; }' },
                    edits: {
                        type: 'array',
                        description: 'For action="edit": search-and-replace operations applied in order. Each edit\'s find must occur exactly once in the target content (skill body, or the file named by `filename`); the call fails before mutating anything if a find is missing or non-unique. Add 2-3 lines of surrounding context to disambiguate.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find. Must be unique in the target.' },
                                replace: { type: 'string', description: 'Replacement text. Use empty string to delete.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    confirm: { type: 'boolean', description: 'Set to true when creating, updating, or deleting skills that you think the user should review. Omit or set false for routine operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'html_widget',
            description: 'Display an interactive HTML widget inline in the chat. The widget runs inside an isolated iframe with its own document context - all scripts, CSS, and DOM are fully isolated. You can include ANY interactive content: click handlers, dynamic rendering, forms, animations, API calls, etc. For ServiceNow API requests from within the widget, use headers: { "X-UserToken": window.sessionToken } (NOT Authorization Bearer). Widgets can also call agent tools via: await executeTool(name, args) - e.g. await executeTool("servicenow_api", {method:"GET", table:"incident", limit:5}). To embed a previously taken screenshot inside a widget, use: executeTool("screenshot_by_id", {id: screenshotId}).then(function(r){ img.src = r.base64; }) — the screenshot_id is returned by take_screenshot. The response includes a widgetId that can be used with iframe_tool for debugging (get_visible_text, get_dom, click, fill actions) or take_screenshot for visual analysis. DO NOT use this tool unless the user asked for a visualization/dashboard/interactive UI, or the data is too large or structured for a plain-text answer. For short answers, reply in plain text instead.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title for the widget (shown in header and sidebar)' },
                    html: { type: 'string', description: 'Complete HTML document including styles and scripts. Use <style> for CSS and <script> for JS. Scripts run in isolated iframe with access to executeTool(name, args) for calling agent tools. For ServiceNow API calls, use: await executeTool("servicenow_api", {method:"GET", table:"incident", ...})' },
                    height: { type: 'string', description: 'Initial height of the widget (e.g., "400px", "auto"). Default: "400px"' },
                    width: { type: 'string', description: 'Width of the widget (e.g., "400px", "500px"). Default: "400px"' },
                    confirm: { type: 'boolean', description: 'Set to true when creating widgets that will modify instance data and you think the user should review. Omit or set false for display-only widgets.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['title', 'html']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'take_screenshot',
            description: 'Capture a real PNG screenshot and send it to the AI for visual analysis. Use this to SEE what is actually rendered on screen - UI elements, layouts, colors, charts, errors, etc. The screenshot is sent as a base64 image to the vision-capable model. Best for: debugging visual issues, verifying UI changes, analyzing rendered widgets, understanding page layouts. Returns a screenshot_id that can be used later with screenshot_by_id to retrieve the image data (e.g. to embed it in a widget or process it in js_eval).',
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        enum: ['browser', 'widget', 'element'],
                        description: 'What to capture: "browser" (the iframe panel content), "widget" (a specific html_widget by ID), "element" (a specific DOM element by selector)'
                    },
                    widget_id: { type: 'string', description: 'For target="widget": the widget ID to capture' },
                    selector: { type: 'string', description: 'For target="element": CSS selector of the element to capture' },
                    max_width: { type: 'number', description: 'Max width in pixels to resize the screenshot (for token efficiency). Default: 1600' },
                    grid: { type: 'boolean', description: 'If true, overlays a coordinate grid on the screenshot with labeled axes. Use this to identify x,y coordinates for click/fill actions when CSS selectors are hard to determine. Default: false' },
                    name: { type: 'string', description: 'Short name for the screenshot, max 3-4 words (e.g. "Users list", "Form error", "Dashboard"). Used for display and download.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['target', 'name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'screenshot_by_id',
            description: 'Retrieve a previously taken screenshot by its ID. Returns the base64 data URL, dimensions, and name. Every take_screenshot call returns a screenshot_id — use that ID here to get the image data. Useful in widgets (to embed/display screenshots) and in js_eval (to process or send screenshot images). Available via executeTool("screenshot_by_id", {id: "..."}) in widgets and js_eval.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The screenshot ID returned by take_screenshot' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_file',
            description: 'Retrieve any file by its ID. Works for screenshots, user attachments (images, PDFs, text files), fetched files, smart documents — anything with a file_id. Returns the file content, metadata, and a download URL. To view/analyze an image or PDF yourself, use attach=true instead of download.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The file_id (returned by take_screenshot, read_attached_file, web_fetch with save_file, document tool, etc.)' },
                    download: { type: 'boolean', description: 'Returns only metadata and a download button for the user to save the file. Does not let you see the file.' },
                    attach: { type: 'boolean', description: 'Attaches the file to the conversation so you can see/analyze it directly (images and PDFs). Use this instead of download when you need to view the file.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'display',
            description: 'Render structured data using a predefined display template. Produces a consistent, interactive widget inline in chat. PREFERRED over html_widget when your data fits a template — gives the user a familiar, polished UI without writing HTML.\n\nTemplates:\n- table: Sortable, filterable table. Args: columns (string[]), rows (object[] or array[]).\n- card_list: Grid of expandable cards. Args: cards ({title, subtitle?, icon?, badge?, badge_color?, detail?}[]).\n- checklist: Checkable items. Args: items (string[] or {label, description?, checked?}[]).\n- status_summary: Metric cards with counts. Args: items ({label, count, icon?, color?}[]).\n- code: Syntax-highlighted code block with line numbers and copy. Args: code (string), language? (string).\n- timeline: Ordered events. Args: events ({title, time?, detail?, color?}[]).\n- chart: Bar or pie chart. Args: chart_type ("bar"|"pie"), data ({label, value}[]) OR labels (string[]) + values (number[]).\n- diff: Code diff view. Args: changes (string[] with +/- prefixes, or {type,text}[]) OR old_text + new_text. Optional: file/header (string).',
            parameters: {
                type: 'object',
                properties: {
                    template: { type: 'string', enum: ['table', 'card_list', 'checklist', 'status_summary', 'code', 'timeline', 'chart', 'diff'], description: 'Display template to use' },
                    title: { type: 'string', description: 'Title for the display (shown in header)' },
                    columns: { type: 'array', items: { type: 'string' }, description: 'For table: column headers' },
                    rows: { type: 'array', items: {}, description: 'For table: array of row objects or arrays' },
                    cards: { type: 'array', items: { type: 'object' }, description: 'For card_list: array of card objects {title, subtitle, icon, badge, badge_color, detail}' },
                    items: { type: 'array', items: {}, description: 'For checklist: array of items. For status_summary: array of {label, count, icon, color}' },
                    code: { type: 'string', description: 'For code: the source code string' },
                    language: { type: 'string', description: 'For code: programming language name' },
                    events: { type: 'array', items: { type: 'object' }, description: 'For timeline: array of {title, time, detail, color}' },
                    chart_type: { type: 'string', enum: ['bar', 'pie'], description: 'For chart: chart type' },
                    data: { type: 'array', items: { type: 'object' }, description: 'For chart: array of {label, value}' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'For chart: label strings (alternative to data)' },
                    values: { type: 'array', items: { type: 'number' }, description: 'For chart: numeric values (alternative to data)' },
                    changes: { type: 'array', items: {}, description: 'For diff: array of diff lines ("+added", "-removed", or "context")' },
                    old_text: { type: 'string', description: 'For diff: original text' },
                    new_text: { type: 'string', description: 'For diff: modified text' },
                    file: { type: 'string', description: 'For diff: filename header' },
                    width: { type: 'string', description: 'Widget width. Default: "100%"' },
                    height: { type: 'string', description: 'Widget height. Default: "auto"' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['template']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_action_state',
            description: 'Maintain a live progress card with a state and todo list, visible to the user as either an action-button (background chats) or a sidebar timeline (foreground chats).\n\nWHEN TO CALL (concrete triggers — do not wait to be asked):\n  • Background Action chat (user message starts with "Run action: <name>") — ALWAYS, on the very first response. The PM only sees the button, not the chat transcript.\n  • Foreground chat — call as soon as ANY of these is true: (a) you expect to make 3+ tool calls before your final reply; (b) the user\'s request has 2+ named phases (e.g. implement → test → push, audit → fix → verify, build → embed → walkthrough); (c) the work spans multiple turns of a conversation working toward one goal; (d) you would naturally write a numbered plan in your reply.\n\nForeground triggers apply EQUALLY to background — "foreground" does not mean "optional". If you find yourself partway through a multi-phase task with no progress card, you already missed the trigger; create one now and backfill the completed steps as `done` tasks.\n\nFREQUENCY after the first call: every new step, task change, or result. State transitions: running (working), stuck (blocked/need input), done (success), error (failed). Call with state=done as soon as the work succeeds. Always pass the FULL `tasks` array (not a delta). On done/error always include `output` (markdown) — that is the headline summary the user sees.\n\nALWAYS also set `status_message` — a short human-friendly description of what THIS specific call is doing (e.g. "Marking audit complete", "Queuing render step"). `label` is the sticky card text; `status_message` is the per-call narration shown in the chat transcript. They are different fields.',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', enum: ['running', 'stuck', 'done', 'error'], description: 'running = working, stuck = blocked or needs user attention, done = success, error = failed' },
                    icon: { type: 'string', enum: ['search','shield','eye','play','check','close','spinner','lock','pause','stop','bell','code','database','stats','zap','alert','list','clipboard','rocket','bug'], description: 'Icon shown on the action button' },
                    label: { type: 'string', description: 'Short status text shown on the button (<= 60 chars)' },
                    tasks: {
                        type: 'array',
                        description: 'Live todo list shown on the progress card / button hover. Pass the SAME full array every time (not a delta) — each call replaces the previous one.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'Task label' },
                                status: { type: 'string', enum: ['pending', 'running', 'done', 'error'], description: 'Task status' }
                            },
                            required: ['label', 'status']
                        }
                    },
                    output: { type: 'string', description: 'Optional rich output shown on done/error in the progress card / when the user clicks the button. Supports markdown. Use for summaries, links, key numbers. Keep short — full details belong in the chat transcript.' },
                    auto_dismiss_ms: { type: 'number', description: 'Action chats only: if set, the done/error button auto-dismisses itself after N milliseconds. Use for short confirmations that don\'t need review (e.g. 3000 for a 3-second toast). Set to 0 or omit for buttons the user must explicitly dismiss. Has no effect in foreground chats.' },
                    status_message: { type: 'string', description: 'REQUIRED. Short human-friendly description of what THIS update call is doing (e.g. "Audit complete, rendering report"). Distinct from `label` (sticky card text) — status_message is per-call narration shown in the chat transcript.' }
                },
                required: ['state', 'icon', 'label', 'status_message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'show_action_button',
            description: 'Render an Action button inline in the chat message flow. Use this to give the PM a one-click shortcut to run a specific skill action with context from the current conversation. The button runs the action in a background chat so the PM never loses their place. Use the `context` field to pass the agent the specific info it needs (e.g. a record sys_id, a table name, a query).',
            parameters: {
                type: 'object',
                properties: {
                    skill: { type: 'string', description: 'The skill id that owns the action (e.g. "instance-audit").' },
                    action: { type: 'string', description: 'The action name, exactly as declared in the skill (e.g. "Quick Audit").' },
                    label: { type: 'string', description: 'Optional label override to display on the button. Defaults to the action name.' },
                    context: { type: 'string', description: 'Extra context to pass to the agent when the button is clicked. This is injected into the synthetic user message alongside "Run action: <name>". Use it to pre-fill parameters or narrow the scope (e.g. "Audit this record: incident sys_id abc123").' },
                    status_message: { type: 'string', description: 'REQUIRED. Short human-friendly description of why you are showing this button (e.g. "Offering quick audit").' }
                },
                required: ['skill', 'action', 'status_message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'prompt_user',
            description: 'Show an inline form to collect structured input from the user. BLOCKING — the agent waits until the user submits or cancels. Use this when you need specific parameters before proceeding (e.g. which format to export, which specs to include, date range). Generate the form dynamically based on context — options should come from the instance or conversation, not be hardcoded.\n\nField types: text, textarea, select, multi-select, date, boolean, number.\nModes:\n- Empty: you need info ("which specs to export?")\n- Prefilled: confirming ("here\'s what I understood, correct?")\n- Partially filled: you know some, need the rest',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Form title shown in the header' },
                    description: { type: 'string', description: 'Optional description text below the title' },
                    fields: {
                        type: 'array',
                        description: 'Array of form fields',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Field name (key in returned values)' },
                                type: { type: 'string', enum: ['text', 'textarea', 'select', 'multi-select', 'date', 'boolean', 'number'], description: 'Field type' },
                                label: { type: 'string', description: 'Display label' },
                                value: { description: 'Default/prefilled value' },
                                options: { type: 'array', items: {}, description: 'For select/multi-select: array of option strings or {value, label} objects' },
                                required: { type: 'boolean', description: 'Whether the field is required' },
                                placeholder: { type: 'string', description: 'Placeholder text' }
                            },
                            required: ['name', 'type', 'label']
                        }
                    },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['fields']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch content from any URL. Returns raw response body. For JSON APIs: JSON.parse(result.body). IMPORTANT: For HTML pages, do NOT call this tool directly — instead use js_eval to fetch AND parse in one step:\nvar res = await executeTool("web_fetch", {url: "..."});\nvar doc = new DOMParser().parseFromString(res.body, "text/html");\nreturn { text: doc.body.innerText, title: doc.querySelector("title")?.textContent, links: [...doc.querySelectorAll("a[href]")].map(a => ({text: a.textContent.trim(), href: a.href})) };\nThis avoids returning raw HTML which wastes tokens.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to fetch' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET' },
                    headers: { type: 'object', description: 'Additional HTTP headers as key-value pairs' },
                    body: { type: 'string', description: 'Request body (for POST/PUT)' },
                    save_file: { type: 'boolean', description: 'If true, saves the response as a file and returns a file_id instead of the body. Use for binary content (images, PDFs, archives) or any file you want to reference later, copy to workspace, or provide as a download.' },
                    confirm: { type: 'boolean', description: 'Set to true for requests that modify external resources (POST/PUT/DELETE) and you think the user should review. Omit or set false for GET requests.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'workspace',
            description: 'Work with GitHub repositories: clone, browse, edit files, and push PRs. All data is stored locally in IndexedDB.\n\nWorkflow: clone a repo → browse/read/edit files → push changes as a PR.\n\nActions:\n- clone: Clone a repo (replaces existing clone). Fetches full tree + blobs.\n- ls: List files/directories at a path.\n- read: Read file content (optional offset/limit for large files).\n- write: Create or overwrite a file.\n- edit: Search-and-replace edits (same as servicenow_diff_edit — each find must be unique).\n- delete: Delete a file from the workspace.\n- grep: Regex search across files.\n- status: List all modified files.\n- diff: Show diffs of modified files.\n- push: Create a NEW branch, commit dirty files, and open a NEW PR against the base branch we worked from. One-shot operation. ALWAYS a brand-new PR — never append to, amend, or reuse an existing PR; every push creates a fresh PR containing ALL changes against the base branch (not an incremental diff on a prior PR). Files stay modified locally on the base branch. Do NOT set base_branch — it auto-defaults to the source branch.\n- discard: Discard changes to a file (or all files if no path given). Resets to original cloned content. New files are removed, deleted files are restored.\n\nCross-chat safety: every mutating action (write/edit/delete/copy/discard) is stamped with the current chat id. If a *currently running* chat has uncommitted changes on the same file, the next mutation from a different chat is blocked with a cross_chat_conflict error so two live agents do not silently clobber each other. If the other chat is dormant/closed, the mutation proceeds and a `cross_chat_warning` is attached to the response. Gitignored paths (dist/, .env, etc.) are exempt from the lock entirely — generated artefacts never block cross-chat work. After a successful push, ownership stamps are released. read and status surface ownership metadata. Pass {"force": true} to override a hard block.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['clone', 'list', 'ls', 'read', 'write', 'edit', 'delete', 'grep', 'status', 'diff', 'push', 'discard'],
                        description: 'Action to perform'
                    },
                    repo: { type: 'string', description: 'Repository in "owner/repo" format (for clone action)' },
                    workspace: { type: 'string', description: 'Workspace identifier (owner/repo::branch). Optional — defaults to the current workspace if omitted.' },
                    branch: { type: 'string', description: 'Branch name (for clone: branch to clone; for push: ignored — always creates a new branch)' },
                    path: { type: 'string', description: 'File or directory path (for ls, read, write, edit, diff)' },
                    content: { type: 'string', description: 'File content (for write action). Not needed if file_id is provided.' },
                    file_id: { type: 'string', description: 'Write a file from the file store (for write action). Use instead of content to copy a screenshot, attachment, or fetched file into the workspace.' },
                    dest: { type: 'string', description: 'Destination path (for copy action)' },
                    offset: { type: 'number', description: 'Start line for read (1-indexed). Default: 1' },
                    limit: { type: 'number', description: 'Max lines to return for read. Default: all' },
                    edits: {
                        type: 'array',
                        description: 'For edit action: search-and-replace operations. Each find must be unique in the file.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find' },
                                replace: { type: 'string', description: 'Replacement text' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    pattern: { type: 'string', description: 'Regex pattern (for grep action)' },
                    branch_name: { type: 'string', description: 'New branch name (for push action)' },
                    commit_message: { type: 'string', description: 'Commit message (for push action)' },
                    pr_title: { type: 'string', description: 'Pull request title (for push action)' },
                    pr_body: { type: 'string', description: 'Pull request body (for push action). Supports full GitHub markdown. Use actual newlines in the string value for multi-line content — do NOT use backslash-n escape sequences.' },
                    base_branch: { type: 'string', description: 'Base branch for PR (for push action, defaults to cloned branch). Omit this unless you need to override — the default is almost always correct.' },
                    include_git_ignored: { type: 'boolean', description: 'If true, includes gitignored files (e.g. dist/) in ls, grep, status, diff results. Default: false.' },
                    force: { type: 'boolean', description: 'For mutating actions (write, edit, delete, copy, discard): override the cross-chat conflict block and clobber another chat\'s uncommitted changes. Use only when you have intentionally decided to take over the file. Default: false.' },
                    confirm: { type: 'boolean', description: 'Set to true for write operations (write, edit, delete, push) that you think the user should review before execution. Omit or set false for read-only operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_attached_file',
            description: 'Read the content of a text file attached by the user in this conversation. Returns the file content which can be searched and cached for large files. Use this to read CSV or other text files the user has attached.',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: 'The name of the attached file to read (as shown in the attachment message)' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['filename']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'document',
            description: 'Create, read, update, and manage Smart Documents. Documents are persistent, versioned markdown files that render inline in chat. They support embedded display templates (table, chart, etc.) and non-blocking user prompts. Multiple references to the same document always show the latest version. Documents persist across chats and are accessible from any conversation.\n\nActions:\n- create: Create a new document. Args: title, content (markdown), prompts? (non-blocking questions).\n- update: Update document content/title (creates new version). Args: doc_id, content?, title?, prompts?.\n- edit: Search-and-replace edits on document content (creates new version). Args: doc_id, edits (array of {find, replace}). Each find must be unique in the document.\n- read: Read current version + prompt responses. Args: doc_id.\n- list: List all documents.\n- list_versions: List version history. Args: doc_id.\n- read_version: Read a specific version. Args: doc_id, version.\n- delete: Delete a document. Args: doc_id.\n\nTo embed display templates: call the display tool first, get the placeholder, include it in the document content.\nTo add prompts: pass a prompts array with fields (same schema as prompt_user fields).\nThe user can edit documents inline — read the document to see their changes.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'update', 'edit', 'read', 'list', 'list_versions', 'read_version', 'delete'], description: 'Action to perform' },
                    doc_id: { type: 'string', description: 'Document ID (for update, read, list_versions, read_version, delete)' },
                    title: { type: 'string', description: 'Document title (for create, update)' },
                    content: { type: 'string', description: 'Markdown content (for create, update)' },
                    version: { type: 'number', description: 'Version number (for read_version)' },
                    edits: { type: 'array', description: 'For edit action: search-and-replace operations. Each find must be unique in the document.', items: { type: 'object', properties: { find: { type: 'string', description: 'Unique text to find' }, replace: { type: 'string', description: 'Replacement text' } }, required: ['find', 'replace'] } },
                    prompts: { type: 'array', description: 'Non-blocking prompts below document. Array of {title?, description?, fields: [{name, type, label, options?, placeholder?, value?}]}', items: { type: 'object' } },
                    confirm: { type: 'boolean', description: 'Set to true for operations that create, modify, or delete documents that you think the user should review. Omit or set false for read-only operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_instances',
            description: 'List all connected ServiceNow instances with their connection status, user info, and short names. Use this to discover which instances are available before targeting them with servicenow_api or iframe_tool.',
            parameters: {
                type: 'object',
                properties: {
                    refresh: { type: 'boolean', description: 'If true, re-probes all open tabs for fresh token/user data. Default: false (uses cached data).' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                }
            }
        }
    },
    // ─── Async tool layer (Sub-Agent spec §4) ───────────────────────────
    // Any tool call may pass `await: false` to fire-and-forget — the call
    // returns immediately with `{ handle: "h_...", status: "pending" }` and
    // the work runs in the background. Use the tools below to collect.
    {
        type: 'function',
        function: {
            name: 'await_handle',
            description: 'Block (on the scheduler, not the model) until an async tool handle resolves. Returns the snapshot {status: done|error|cancelled|pending, result?, error?}. If status is still "pending" after timeout_ms, the handle is left in-flight — you can poll or await again.',
            parameters: {
                type: 'object',
                properties: {
                    handle: { type: 'string', description: 'Handle id returned by a previous async tool call (e.g. "h_xxx").' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['handle']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'poll_handle',
            description: 'Non-blocking peek at an async tool handle. Returns the current snapshot {status, result?, error?} without waiting. Status "pending" means the work is still running.',
            parameters: {
                type: 'object',
                properties: {
                    handle: { type: 'string', description: 'Handle id returned by a previous async tool call.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['handle']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'await_any',
            description: 'Wait for the FIRST of several async handles to settle. Returns {handle, snapshot, timeout:false} on win, or {handle:null, snapshot:null, timeout:true, pendingSnapshots:[...]} on timeout. Useful when you launched several speculative tool calls and want whichever finishes first.',
            parameters: {
                type: 'object',
                properties: {
                    handles: { type: 'array', items: { type: 'string' }, description: 'Array of handle ids to race.' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['handles']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'await_all',
            description: 'Wait for ALL of several async handles to settle. Returns {snapshots: [...], timedOut} in the same order as the input. `timedOut` is true when at least one handle never settled within timeout_ms (its snapshot is still status:"pending") — a single flag for detecting a partial result without scanning every snapshot. Useful to fan out tool calls and collect when every one is done.',
            parameters: {
                type: 'object',
                properties: {
                    handles: { type: 'array', items: { type: 'string' }, description: 'Array of handle ids to wait on.' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['handles']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancel_handle',
            description: 'Mark an in-flight async tool handle as cancelled. The underlying tool may still finish in the background (we cannot abort fetches / GlideRecord calls), but the result will be DISCARDED and the handle moves to status "cancelled". No effect if the handle has already settled.',
            parameters: {
                type: 'object',
                properties: {
                    handle: { type: 'string', description: 'Handle id to cancel.' },
                    reason: { type: 'string', description: 'Optional human-readable reason recorded on the handle.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['handle']
            }
        }
    },
    // ─── Sub-agent runtime (Sub-Agent spec §3 / Phase 2) ────────────────
    // Spawn background sub-agents to offload context-heavy work (file scans,
    // multi-record audits, log scraping). Each sub gets its own chat + context
    // window, runs to completion, and reports back a distilled summary via
    // `report_to_parent`. Pool size = 2 concurrent; excess spawns queue.
    {
        type: 'function',
        function: {
            name: 'spawn_sub_agent',
            description: 'Spawn a background sub-agent in a fresh chat to do focused, context-heavy work without polluting your context window. Returns immediately with {agent_id, chat_id, handle}. The sub runs in its own chat with its own context, calls `report_to_parent` when done, and the spawn handle resolves with the distilled summary — collect via `await_handle(handle)`. If the sub reports `status:"error"` or crashes (auto_report fallback), the OUTER handle settles as `status:"error"` too (snapshot.error = headline, snapshot.result = full report). Use for: file/grep dumps, multi-record audits, deep log scans, iterative debugging. Do NOT use for: single small Table API calls or work whose result must flow into the very next tool call. Pass `output_schema` to declare the exact shape the sub must return in report_to_parent\'s `data` — handy when you spawn and parse the result programmatically (e.g. inside js_eval).',
            parameters: {
                type: 'object',
                properties: {
                    instructions: { type: 'string', description: 'The task. Becomes the sub\'s first user message. Be specific about what should be returned (e.g. "return only sys_ids and names, no script bodies").' },
                    name: { type: 'string', description: 'Short label shown in the sidebar / Workers strip. Defaults to a generated id.' },
                    allow_nested: { type: 'boolean', description: 'If true, the sub may spawn/stop/wake its own sub-agents (default: false). Use only when you genuinely need the sub to delegate further — multi-stage research, recursive audits, etc. Max nesting depth is 5.' },
                    context_seed: { type: 'object', description: 'Small JSON blob copied into the sub\'s first message (record ids, queries, etc.).' },
                    output_schema: { type: 'object', description: 'Optional JSON-Schema-ish object describing the EXACT shape the sub must return in report_to_parent\'s `data` field. Injected into the sub\'s first message with a directive to conform (same keys/types, no extras). Use when you spawn + parse the result programmatically (e.g. inside one js_eval) and want a predictable structure to destructure. The root should be an object (report_to_parent\'s `data` is itself an object) — wrap arrays in a named property, e.g. {items:[...]}, rather than using a root-level array.' },
                    auto_report: { type: 'boolean', description: 'If true (default), a fallback report is synthesized from the last assistant message if the sub finishes without calling report_to_parent.' },
                    max_tool_calls: { type: 'number', description: 'Hard cap on tool calls the sub may make. Default: 200.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['instructions']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'report_to_parent',
            description: 'SUB-AGENT ONLY. Push a distilled result up to the parent agent. Settles the parent\'s spawn handle (if still pending) and parks you (state=sleeping) — the parent can `wake_sub_agent` you with a follow-up or `stop_sub_agent` to terminate. `status` is informational (UI badge color, parent decision logic). For mid-flight progress that should NOT settle the handle, use `agent_message({to:"parent", content:"..."})` instead. The summary is what the parent SEES — it never reads your raw transcript. Cap: 4 KB summary, 32 artifacts.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['done', 'error', 'need_input'], description: 'Informational status. done=task complete, error=failed, need_input=parked waiting for parent. All three settle the spawn handle and park you.' },
                    summary: { type: 'string', description: '1-3 sentence distilled result. THIS is what the parent reads. Soft-capped at 4 KB.' },
                    data: { type: 'object', description: 'Optional small structured payload (counts, ids, etc.).' },
                    artifacts: { type: 'array', items: { type: 'string' }, description: 'file_ids / doc_ids / widget_ids the parent can reference without inlining the content.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['status', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_status',
            description: 'Read-only snapshot of sub-agents. By default lists every sub spawned by the current chat (running, sleeping, stopped, errored) with last_report, tool_calls_used, inbox size, and pool position. Pass agent_id for a single sub, or parent_chat_id:"*" to see every sub in every chat. Cheap, synchronous — use freely.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Specific sub agent_id. Omit to list.' },
                    parent_chat_id: { type: 'string', description: 'Filter list by parent chat. Pass "*" to list every sub on the instance.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'wake_sub_agent',
            description: 'Resume a sleeping sub-agent, optionally with a new instruction. If the sub has queued inbox messages, they are drained into a combined user turn on wake. Returns `{handle}` — an awaitable spawn handle for the resumed run (a fresh handle if the previous one already settled, or the existing one if it\'s still pending). The parent should `await_handle(result.handle)` to collect the next `report_to_parent` payload. No-op if the sub is already running. Errors if the sub is stopped/errored.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Sub agent_id to wake.' },
                    instruction: { type: 'string', description: 'Optional new user message. Drained with any pending inbox into the sub\'s next turn.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['agent_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'stop_sub_agent',
            description: 'Terminate a sub-agent. Pending tool handles owned by the sub are cancelled; the spawn handle resolves with status:"cancelled". Use when you no longer need the sub\'s result (changed your mind, the user redirected, the sub is stuck).',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Sub agent_id to stop.' },
                    reason: { type: 'string', description: 'Optional human-readable reason recorded on the sub\'s final report.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['agent_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sleep_self',
            description: 'SUB-AGENT ONLY. Voluntarily park yourself until the parent wakes you via `wake_sub_agent` or sends a message via `agent_message`. Frees your worker pool slot so another queued sub can start. Prefer `report_to_parent` (it parks you AND tells the parent why) — only use `sleep_self` when you have nothing to report but still need to wait. If the spawn handle is still unsettled when you sleep, it will be auto-settled with status="need_input" so the parent does not hang.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional reason recorded for diagnostics.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_message',
            description: 'Send a message between agents. From a parent: `to:"sub_xxx"` pushes to that sub (auto-wakes if sleeping unless wake:false; the response includes a fresh `handle` the parent can `await_handle` for the resumed run\'s next report). From a sub: `to:"parent"` pushes a mid-flight status update to the parent chat (renders as an inline callout, does NOT settle the spawn handle, the sub keeps running). For terminal sub→parent results that should settle the handle, use `report_to_parent`.',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient: an agent_id, or the literal string "parent" (sub-only).' },
                    content: { type: 'string', description: 'Message text.' },
                    wake: { type: 'boolean', description: 'If recipient is sleeping, wake them. Default: true.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['to', 'content']
            }
        }
    }
];

// ─── headless flag ──────────────────────────────────────────────────
// `headless: true` means the tool can run in a Service Worker / offscreen
// context with no side panel attached. `headless: false` means the tool
// touches the side panel DOM and must be routed to a registered executor.
//
// js_eval is headless because its sandbox iframe is hosted by the offscreen
// document, not the side panel.
var HEADLESS_TOOLS = {
    js_eval: true,
    servicenow_api: true,
    servicenow_run_script: true,
    servicenow_diff_edit: true,
    set_chat_title: true,
    cached_content_outline: true,
    cached_content_search: true,
    cached_content_read: true,
    // get_skill / manage_skill / update_action_state / show_action_button
    // live in tools/080-widget-tools.js + tools/120-actions.js — neither is
    // in WORKER_SHARED_FILES, and the impls reach into page-only globals
    // (renderSkillsList, activeActions, persistActionState, scrollToBottomIfAllowed,
    // currentView, …). Route them to the panel rather than try to mirror that
    // surface in the SW.
    get_skill: false,
    manage_skill: false,
    screenshot_by_id: true,
    get_file: true,
    update_action_state: false,
    show_action_button: false,
    web_fetch: true,
    workspace: true,
    read_attached_file: true,
    document: true,
    list_instances: true,
    // Async tool layer helpers — pure in-memory registry reads, fully headless
    await_handle: true,
    poll_handle: true,
    await_any: true,
    await_all: true,
    cancel_handle: true,
    // Sub-agent runtime tools — the registry is in-memory + IDB, fully
    // headless. All seven dispatch through tools/020-tool-execution.js to
    // SubAgents.* helpers. Side-effects (chat creation, runAgent kick) work
    // identically in SW and page contexts because runAgent + the chats map
    // are shared globals in WORKER_SHARED_FILES.
    spawn_sub_agent: true,
    report_to_parent: true,
    agent_status: true,
    wake_sub_agent: true,
    stop_sub_agent: true,
    sleep_self: true,
    agent_message: true,
    // UI-required (must route to a page executor)
    iframe_tool: false,
    take_screenshot: false,
    html_widget: false,
    display: false,
    prompt_user: false
};
for (var _ti = 0; _ti < TOOLS.length; _ti++) {
    var _tn = TOOLS[_ti].function && TOOLS[_ti].function.name;
    TOOLS[_ti].headless = !!HEADLESS_TOOLS[_tn];
}
function isHeadlessTool(name) { return !!HEADLESS_TOOLS[name]; }
