// Default token limits (overridden by provider-specific settings)
var MAX_TOKENS = 16000;
var THINKING_BUDGET = 10000;

var TOOLS = [
    {
        type: 'function',
        function: {
            name: 'js_eval',
            description: 'Execute JavaScript code in an isolated sandbox. PREFERRED for chaining multiple tool calls in a single step — call tools sequentially, process intermediate results, and return a final summary. This is more efficient than separate tool calls because you avoid round-trips to the API between each step.\n\nCall other tools via: await executeTool(name, args). Each tool returns its full result object. IMPORTANT: Always return the key metadata from your chained calls (widget IDs, screenshot IDs, sys_ids, etc.) so you can reference them in follow-up actions.\n\nWhen creating widgets from js_eval: fetch/prepare all data FIRST in js_eval, then embed it directly in the widget HTML. Only use executeTool inside the widget itself when you need live/dynamic data. Example:\nvar data = await executeTool("servicenow_api", {method:"GET", table:"incident", limit:5});\nvar rows = data.data.result.map(function(i){return "<tr><td>"+i.number+"</td><td>"+i.short_description+"</td></tr>";}).join("");\nvar widget = await executeTool("html_widget", {title:"Incidents", html:"<table>"+rows+"</table>"});\nreturn {widgetId: widget.widgetId, count: data.data.result.length};\n\nNo access to page globals or sessionToken.\n\nWaiting/polling: use await sleep(ms) (alias: delay) — it is service-worker-backed and unthrottled. Raw setTimeout chains in this hidden sandbox are throttled to 1/minute by Chrome; delays >= 1000ms are auto-rerouted through sleep, but prefer calling sleep directly.\n\nScreenshots & Images: take_screenshot returns {base64, width, height, screenshot_id}. The base64 is a complete data URL — use directly as img.src.\n1. To READ an image (send to vision): return _images array — return {_images: [{base64: ss.base64, name: "page"}]};\n2. To USE an image (in widget, etc.): use ss.base64 directly.\n3. To CREATE an image: var canvas = document.createElement("canvas"); return {_images: [{base64: canvas.toDataURL("image/png"), name: "chart"}]};\n4. To RETRIEVE a previous screenshot: await executeTool("screenshot_by_id", {id: "ss_1_..."}).',
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
                    scope: { type: 'string', description: 'Application scope for the record. Use "global" for global scope, or a sys_id for a scoped app. Required for POST/PUT/PATCH/DELETE (write methods); not needed for GET.' },
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
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name (e.g. "dev12345") or URL. Use list_instances to see available instances.' },
                    confirm: { type: 'boolean', description: 'Set to true for write operations (POST/PUT/PATCH/DELETE) that you think the user should review before execution. When true, the user will be prompted to approve. Omit or set false for routine operations.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['method', 'table', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_run_script',
            description: 'Execute a server-side JavaScript snippet on the ServiceNow instance. Runs synchronously, captures gs.print/gs.info output, and returns the response. Each execution is logged in sys_script_execution_history. DO NOT use this as a replacement for multiple Table API calls — if the work is just "fetch N records, update each", chain servicenow_api calls inside js_eval instead. ONLY use servicenow_run_script for things the Table API genuinely cannot do: server-only globals (gs.*), GlideRecord-only APIs, transactions, system operations, or logic that must run server-side. REQUIRES THE ADMIN ROLE on the target instance: it executes server-side via /sys.scripts.do, which is restricted to admins — if the signed-in user lacks the admin role the call will fail (use list_instances to see the user roles on the instance).',
            parameters: {
                type: 'object',
                properties: {
                    script: { type: 'string', description: 'Server-side JavaScript to execute. Use gs.print(...) or gs.info(...) for output.' },
                    scope: { type: 'string', description: 'Application scope to execute in (e.g. "global" or a scope name like "x_snc_myapp"). Default: global.' },
                    record_for_rollback: { type: 'boolean', description: 'If true (default), records changes for rollback via sys_script_execution_history.' },
                    sandbox: { type: 'boolean', description: 'If true, runs in sandboxed mode (limits some operations). Default: false.' },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name. Use list_instances to see available instances.' },
                    confirm: { type: 'boolean', description: 'Set to true when you think the user should review before execution. Often appropriate for this tool.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['script', 'instance']
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
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name (e.g. "dev12345") or URL. Use list_instances to see available instances.' },
                    confirm: { type: 'boolean', description: 'Set to true when you think the user should review this code edit before execution. Omit or set false for routine changes.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['table', 'sys_id', 'field', 'edits', 'instance']
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
                        description: 'Action to perform: navigate (load URL - not for widgets), get_visible_text (extract visible text content from page - use take_screenshot tool for actual images), get_dom (get HTML), click (click element), fill (fill input - one-shot, fires full keydown→input→keyup→change chain so frameworks/client-scripts see real user input), type (per-character typing with key events - slower but reliably triggers debounced/autocomplete handlers; supports delay, append), wait_for (block until a condition is met: selector_visible, selector_gone, text, or url_matches), get_console_logs, get_network_requests, close (close panel - not for widgets), open_widget (open widget in panel for debugging - requires widget_id), edit_html (edit widget HTML using find/replace - requires widget_id and edits), dispatch_event (trigger a DOM event on element - requires selector and event; mouse events fire a real MouseEvent, and a mousedown+mouseup pair reliably opens/commits select2 & jQuery widgets), select_option (select dropdown option - requires selector and value or text), scroll (scroll page to position/element/coordinates), resize (resize viewport - use preset or width/height), get_properties (get computed styles, dimensions, values, className/classList of elements; a no-match returns success with match_count:0, not an error), set_style (apply CSS styles or toggle classes on elements), impersonate (impersonate a ServiceNow user - requires user param with username/name/sys_id, use "stop" to end), get_page_info (get current page URL, title, and viewport dimensions)'
                    },
                    url: { type: 'string', description: 'URL path to navigate to (for navigate action, not applicable for widgets). Same-origin only.' },
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
                    event: { type: 'string', enum: ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'contextmenu', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'], description: 'For dispatch_event action: DOM event to trigger. Mouse events (click/mousedown/mouseup/mousemove/dblclick/contextmenu/mouseenter/mouseleave/mouseover/mouseout) fire a real MouseEvent with button + viewport coordinates; a mousedown then mouseup pair is the reliable way to drive select2 / jQuery-UI style widgets (open on mousedown, commit on mouseup).' },
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
                    include: { type: 'array', items: { type: 'string', enum: ['rect', 'styles', 'value', 'attributes'] }, description: 'For get_properties action: which extra detail to include. Default: all. NOTE: tagName, id, className, classList[], value, checked, disabled, visible and rect are ALWAYS returned regardless of include — use classList[] to assert CSS classes without scraping get_dom. A valid selector that matches nothing is NOT an error: it returns success:true with match_count:0 and properties:null.' },
                    styles: { type: 'object', description: 'For set_style action: CSS properties to set, e.g. {"display": "none", "color": "red"}' },
                    className: { type: 'string', description: 'For set_style action: add/remove/toggle a class - "add:className", "remove:className", or "toggle:className"' },
                    widget_id: { type: 'string', description: 'Target a specific html_widget by its ID. Required for open_widget, edit_html. Optional for get_visible_text, get_dom, click, fill to target widget instead of browser.' },
                    user: { type: 'string', description: 'For impersonate action: username, display name, or sys_id of user to impersonate. Use "stop" to end impersonation.' },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name. For navigate, the tab is found/created/reused on this instance. Use list_instances to see available instances.' },
                    tab_id: { type: 'number', description: 'Optionally target a specific open Chrome tab by id (from list_instances activeTabs[].id). For navigate: navigates THAT exact tab, bypassing the safeguard that avoids reusing a tab already in use. For other actions: pins subsequent browser actions in this chat to that tab. A non-existent id is an error.' },
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
                required: ['action', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_chat_title',
            description: 'Set the title of the current chat (a descriptive, concise title summarizing what was accomplished). Do NOT call this on your own while working on a task — an after-response hook automatically asks for it (grouped with set_tldr / set_links) once your final answer is complete. Only call it earlier if the user explicitly asks to rename the chat.',
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
            name: 'set_tldr',
            description: 'Set a short TL;DR summary card for your final answer. Do NOT call this on your own — the TLDR hook automatically asks for it after your final answer; wait for that explicit hook instruction.',
            parameters: {
                type: 'object',
                properties: {
                    tldr: { type: 'string', description: '1-2 short sentences (max 280 chars) summarizing the outcome of your answer.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['tldr']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_links',
            description: 'Provide a list of relevant links (each with a title) the user may want to look into as part of this conversation — e.g. a PR link, a diff link, a link to a ServiceNow record, or a documentation page. Do NOT call this on your own while working on a task — the Links hook automatically asks for it after your final answer; wait for that explicit hook instruction. Only include genuinely useful links; pass an empty array if there is nothing worth linking.',
            parameters: {
                type: 'object',
                properties: {
                    links: {
                        type: 'array',
                        description: 'Array of links to surface to the user, most relevant first. Each item is an object with a title and a url.',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', description: 'Short, descriptive title for the link (what the user will click).' },
                                url: { type: 'string', description: 'The URL — an absolute http(s) link, or a ServiceNow record/instance URL.' }
                            },
                            required: ['title', 'url']
                        }
                    },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['links']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_caveat',
            description: 'Flag a single must-read caveat/warning about your final answer, shown to the user as a prominent amber warning card next to the TL;DR. Do NOT call this on your own or spontaneously — the after-response hook asks for it. Call it ONLY when your answer contains something the user must not miss: you deviated from the plan or the user\'s instructions, you made an assumption that needs double-checking, you left the work partially incomplete, or you ended with a question or requested action the user might overlook. Do NOT flag routine always-visible follow-ups — e.g. "the extension needs to be reloaded" or "the PR is not merged yet" — those are already shown to the user; only flag things the user would otherwise miss. If there is nothing like that, do NOT call it.',
            parameters: {
                type: 'object',
                properties: {
                    caveat: { type: 'string', description: 'A short must-read warning (1-2 sentences, max ~300 chars): what the user must not miss — an off-plan deviation, an unverified assumption, incomplete work, or a trailing question/requested action.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['caveat']
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
            description: 'Read specific parts of large cached tool results. Navigate to a path and optionally read line ranges for code fields. Each read is capped at ~16KB — for big string/code fields use start_line/end_line; if a read is rejected, narrow the range or search first.',
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
            description: 'Retrieve AI skill content and files. Actions: "get" returns SKILL.md content and lists available files. "read_file" reads a specific file from the skill. IMPORTANT — before starting any task, check whether a relevant skill exists and read it first: skills contain best practices, patterns, and learnings that improve work quality.',
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
            description: 'Create, update, or manage AI skills and their files (create skills with custom tool JS files or content MD/XML; action="edit" does search-and-replace on the skill body or a named file — same shape as servicenow_diff_edit / workspace edit / document edit). ⚠️ IMPORTANT — this mutates ONLY the live/runtime copy of a skill. If you are doing extension development from the cloned AppAgent repo (extension-dev skill active with a deploy folder connected — i.e. Reload rebuilds from the workspace — including tasks like "improve/test/edit the <name> skill"), the skill SOURCE lives at skills/<name>/ in that repo: edit those files with the workspace tool (write/edit) and have the user click Reload. manage_skill edits in that mode are EPHEMERAL and get overwritten by the next extension build/reload — so do NOT use manage_skill for skill changes when the repo is cloned. Use manage_skill only when you are NOT working from the cloned extension repo.',
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
            description: 'Display an interactive HTML widget inline in the chat. The widget runs inside an isolated iframe with its own document context - all scripts, CSS, and DOM are fully isolated. You can include ANY interactive content: click handlers, dynamic rendering, forms, animations, API calls, etc. There is NO session token exposed inside the sandbox (no window.sessionToken, no X-UserToken shim), so ServiceNow requests MUST go through the agent tool. Widgets call agent tools via: await executeTool(name, args) - e.g. await executeTool("servicenow_api", {method:"GET", table:"incident", limit:5}). To embed a previously taken screenshot inside a widget, use: executeTool("screenshot_by_id", {id: screenshotId}).then(function(r){ img.src = r.base64; }) — the screenshot_id is returned by take_screenshot. Widget buttons can also hand a question off to a fresh chat with await executeTool("start_chat", {message: "...", mode: "send"|"draft", include_widget: true}) — an "Ask the agent" button; include_widget references THIS widget automatically, mode "draft" only prefills the composer, and background:true keeps the widget on screen. The app design tokens are auto-injected into every widget (colors, spacing, radii, fonts) and follow the user light/dark theme live - use var(--bg-main), var(--text-primary), var(--primary), var(--space-8), var(--radius-md); see the widget-best-practices skill for the full token table. The response includes a widgetId that can be used with iframe_tool for debugging (get_visible_text, get_dom, click, fill actions) or take_screenshot for visual analysis. DO NOT use this tool unless the user asked for a visualization/dashboard/interactive UI, or the data is too large or structured for a plain-text answer. For short answers, reply in plain text instead.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title for the widget (shown in header and sidebar)' },
                    html: { type: 'string', description: 'Complete HTML document including styles and scripts. Use <style> for CSS and <script> for JS. Scripts run in isolated iframe with access to executeTool(name, args) for calling agent tools. For ServiceNow API calls, use: await executeTool("servicenow_api", {method:"GET", table:"incident", ...})' },
                    height: { type: 'string', description: 'Initial height of the widget (e.g., "400px", "auto"). Default: "400px"' },
                    width: { type: 'string', description: 'Width of the widget (e.g., "400px", "500px"). Default: "400px"' },
                    pin: { type: 'string', enum: ['main', 'home'], description: 'Optionally pin the widget to a dashboard at creation: "home" (home page, above Active chats) or "main" (dashboard page). Omit to leave the widget unpinned (inline in chat only).' },
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
            name: 'pin_widget',
            description: 'Pin, move, or unpin an EXISTING html_widget on a dashboard. dashboard="main" pins to the dashboard page, "home" pins to the home page dashboard (above Active chats), "none" unpins. Use the widget id returned by html_widget.',
            parameters: {
                type: 'object',
                properties: {
                    widget_id: { type: 'string', description: 'The widget id (returned by html_widget as id/widgetId)' },
                    dashboard: { type: 'string', enum: ['main', 'home', 'none'], description: "Target dashboard: 'main' (dashboard page), 'home' (home page), or 'none' to unpin" },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['widget_id', 'dashboard']
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
                    max_width: { type: 'number', description: 'Max width in pixels to resize the screenshot (for token efficiency). Default: 1568 (Anthropic vision long-edge limit). Captures are taken at full native device resolution and downscaled to this cap with high-quality resampling so text stays sharp. Height is allowed up to 2x this value; the width is never scaled below 1024px so tall captures stay readable.' },
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
            description: 'Maintain a live progress card with a state and todo list, visible to the user as either an action-button (background chats) or a sidebar timeline (foreground chats).\n\nWHEN TO CALL (concrete triggers — do not wait to be asked):\n  • Background Action chat (user message starts with "Run action: <name>") — ALWAYS, on the very first response. The PM only sees the button, not the chat transcript.\n  • Foreground chat — call as soon as ANY of these is true: (a) you expect to make 3+ tool calls before your final reply; (b) the user\'s request has 2+ named phases (e.g. implement → test → push, audit → fix → verify, build → embed → walkthrough); (c) the work spans multiple turns of a conversation working toward one goal; (d) you would naturally write a numbered plan in your reply.\n\nForeground triggers apply EQUALLY to background — "foreground" does not mean "optional". If you find yourself partway through a multi-phase task with no progress card, you already missed the trigger; create one now and backfill the completed steps as `done` tasks.\n\nFREQUENCY after the first call: every new step, task change, or result. State transitions: running (working), waiting (idle until dispatched sub-agents report back — non-terminal), stuck (blocked/need input), done (success), error (failed). Terminal success variants (all treated like done): finished = task fully completed; pr_opened = task completed AND a PR was opened/pushed; finished_with_caveat = completed but a caveat was flagged (pairs with set_caveat). Call with a terminal state as soon as the work succeeds. GUARD: terminal SUCCESS states (done/finished/pr_opened/finished_with_caveat) are REJECTED while this chat still has RUNNING (unsettled) sub-agents — the call fails with an error listing them. Use state "waiting" (or "running") until they report, or stop them first; `error` is always accepted. Always pass the FULL `tasks` array (not a delta). On done/error always include `output` (markdown) — that is the headline summary the user sees.\n\nALWAYS also set `status_message` — a short human-friendly description of what THIS specific call is doing (e.g. "Marking audit complete", "Queuing render step"). `label` is the sticky card text; `status_message` is the per-call narration shown in the chat transcript. They are different fields.',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', enum: ['running', 'waiting', 'stuck', 'done', 'error', 'finished', 'pr_opened', 'finished_with_caveat'], description: 'running = working, waiting = idle until dispatched sub-agents report back (non-terminal, the task is still in progress), stuck = blocked or needs user attention, done = success, error = failed. Terminal success variants (treated like done): finished = task fully completed, pr_opened = task completed and a PR was opened/pushed, finished_with_caveat = completed but a caveat was flagged (pairs with set_caveat). Terminal success states are rejected while this chat has running sub-agents — use waiting, or stop them first.' },
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
            description: 'Show an inline form to collect structured input from the user. ALWAYS PREFERRED over asking questions in plain text. BLOCKING — the agent waits until the user submits or cancels. Use this when you need specific parameters before proceeding (e.g. which format to export, which specs to include, date range). Generate the form dynamically based on context — options should come from the instance or conversation, not be hardcoded.\n\nField types: text, textarea, select, multi-select, date, boolean, number.\nModes:\n- Empty: you need info ("which specs to export?")\n- Prefilled: confirming ("here\'s what I understood, correct?")\n- Partially filled: you know some, need the rest\n\nPLAN CONFIRMATION: before a long or risky sequence of WRITE operations (building apps/dashboards, bulk changes, multi-record modifications), present your plan here and get approval — do not silently execute it. Read-only or exploratory work needs NO plan confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Form title shown in the header' },
                    description: { type: 'string', description: 'Optional description text below the title. Rendered as MARKDOWN (paragraphs, bold, lists, inline/fenced code, links) — write it in markdown.' },
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
                                widget: { type: 'string', enum: ['checkboxes'], description: 'For multi-select: render as a vertical checkbox list instead of toggle chips (better for long option labels)' },
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
            description: 'Fetch content from any URL. Returns raw response body. For JSON APIs: JSON.parse(result.body). For HTML responses the result ALSO includes page_title, meta_description and extracted_text (script/style-stripped visible text) — read those instead of slicing the raw HTML. IMPORTANT: For HTML pages, do NOT call this tool directly — instead use js_eval to fetch AND parse in one step:\nvar res = await executeTool("web_fetch", {url: "..."});\nvar doc = new DOMParser().parseFromString(res.body, "text/html");\nreturn { text: doc.body.innerText, title: doc.querySelector("title")?.textContent, links: [...doc.querySelectorAll("a[href]")].map(a => ({text: a.textContent.trim(), href: a.href})) };\nThis avoids returning raw HTML which wastes tokens.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to fetch' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET' },
                    headers: { type: 'object', description: 'Additional HTTP headers as key-value pairs' },
                    body: { type: 'string', description: 'Request body (for POST/PUT)' },
                    save_file: { type: 'boolean', description: 'If true, saves the response as a file and returns a file_id instead of the body. Use for binary content (images, PDFs, archives) or any file you want to reference later, copy to workspace, or provide as a download.' },
                    confirm: { type: 'boolean', description: 'Set to true for requests that modify external resources (POST/PUT/DELETE) and you think the user should review. Omit or set false for GET requests. NOTE: web_fetch normally prompts on every call, EXCEPT requests to the connected GitHub REST API base — those are agent-governed by this confirm flag (reads run silently; set confirm:true for writes like merging a PR or posting a comment).' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_cookie',
            description: 'Read browser cookies for a URL from the extension background context (chrome.cookies). Use this to perform AUTHENTICATED fetches against cookie-gated sites from js_eval: the js_eval sandbox has a null origin and cannot read document.cookie or chrome.cookies itself. Typical pattern - grab a cookie and echo it as a header (some sites require the cookie value repeated in a request header):\nvar c = await executeTool("get_cookie", {url: "https://example.com", name: "session_id"});\nvar res = await executeTool("web_fetch", {url: "https://example.com/api/...", headers: {"x-session-token": c.cookies.session_id}});\nReturns { cookies: { name: value, ... } }. With neither name nor names, returns ALL cookies visible for that URL. Cookie values ARE session credentials - handle them carefully and never echo them into chat output. This tool is allowed by default and runs without prompting; the user can restrict it to Ask or Off in Settings > Tool permissions.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute URL whose cookies to read, including scheme (e.g. "https://example.com"). Cookie visibility follows the URL host + path, exactly like chrome.cookies.getAll({url}).' },
                    name: { type: 'string', description: 'Single cookie name to return (e.g. "session_id").' },
                    names: { type: 'array', items: { type: 'string' }, description: 'Multiple cookie names to return. Combined with name if both are given.' },
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
            description: 'Work with GitHub repositories: clone, browse, edit files, and push PRs. All data is stored locally in IndexedDB.\n\nWorkflow: clone a repo → browse/read/edit files → push changes as a PR.\n\nActions:\n- clone: Clone a repo (replaces existing clone). Fetches full tree + blobs.\n- list: List all cloned workspaces (branches, dirty counts, pinned flag) with a lean PR summary: each PR entry has only {number, title, state, url, branch, merged_at?}; all open PRs are listed but merged PRs are capped to the 3 most recent (merged_prs_omitted gives the count of older ones).\n- ls: List files/directories at a path.\n- read: Read file content (optional offset/limit for large files).\n- write: Create or overwrite a file.\n- edit: Search-and-replace edits (same as servicenow_diff_edit — each find must be unique).\n- copy: Copy a file within the workspace (args: path, dest).\n- delete: Delete a file from the workspace.\n- grep: Regex search across files. Returns up to 5 matches by default — pass `limit` (max 100) for more.\n- status: List all modified files.\n- diff: Show diffs of modified files.\n- push: Commit dirty files and push them to a PR. Pass `files` (array of workspace paths) to push ONLY those dirty files — other dirty files stay modified locally and are left out of the commit/PR (use this to keep unrelated changes, e.g. from another chat, out of your PR). If branch_name does NOT exist yet, a new branch is created and a new PR is opened against the base branch we worked from. If branch_name ALREADY exists (a previous push), the commit is appended to that branch and the existing open PR is reused (its title is refreshed; the body is updated only when you pass a non-empty pr_body, so an append without pr_body keeps the existing description) — this is how you add more commits to the same PR. Each commit contains the full current changes against the base. Files stay modified locally on the base branch. Do NOT set base_branch — it auto-defaults to the source branch. The return value includes pr_reused (true when an existing PR was updated), a per-file `files` list with the same ownership fields as status (who edited each committed file, prior pushed_pr), and prominent `cross_chat_warnings` when a committed file belonged to ANOTHER chat or was already pushed to a DIFFERENT PR.\n- discard: Discard changes to a file (or all files if no path given). Resets to original cloned content. New files are removed, deleted files are restored.\n- pin: Pin a workspace (pass `workspace`; `{unpin: true}` to clear). At most ONE pinned workspace per owner/repo — pinning clears any sibling pin. The pinned workspace wins default-workspace resolution (over MRU) and extension_build auto-detect, so Reload builds it. `list` exposes `pinned`/`forked_from`; `status` adds a `pin_notice` when a sibling holds the pin.\n- branch: LOCAL fork — creates workspace owner/repo::<branch> by cheaply copying the source workspace (args: `branch` = new branch name; optional `workspace` = source; `move_dirty` default true moves dirty edits to the fork and reverts the source clean, false copies them to both). The remote branch does NOT exist until the first push from the fork, which cuts it from the fork base. The fork is pinned automatically.\n- move: Move dirty edits between workspaces (args: `to` = target workspace key; optional `files` = paths, default all dirty; `workspace` = source). Writes the source content onto the target row (dirty recomputed vs the target own original) then discards the source. Blocks the WHOLE move when a target file is itself dirty with different content (unless `force`); reports `base_diverged` paths when the two bases differ.\n- hydrate: Pre-fetch lazy-clone file contents from GitHub (optionally limited to a `path` prefix). read/grep/edit hydrate on demand automatically — use this only to bulk-prefetch before many reads.\n\nMerge lifecycle: when the branch of a workspace is the head of a MERGED PR and its base branch is cloned locally, sync auto-deletes the workspace — dirty files are moved to the base first (a blocked move keeps the workspace with a warning), the base is synced, and the pin follows the merge onto the base when the deleted workspace held it.\n\nCross-chat safety: every mutating action (write/edit/delete/copy/discard) is stamped with the current chat id. If a *currently running* chat has uncommitted changes on the same file, the next mutation from a different chat is blocked with a cross_chat_conflict error so two live agents do not silently clobber each other. On a cross_chat_conflict, fork your own branch with the `branch` action and continue there — your dirty files travel to the fork; dirty files hard-locked by other chats stay behind in the source (listed in `left_behind`). If the other chat is dormant/closed, the mutation proceeds and a `cross_chat_warning` is attached to the response. Gitignored paths (dist/, .env, etc.) are exempt from the lock entirely — generated artefacts never block cross-chat work. After a successful push, ownership stamps are released. Read-only actions surface ownership too: read and status include ownership metadata, and ls, grep, and diff attach cross_chat_warnings / per-entry flags when a listed, matched, or diffed file has uncommitted changes owned by another chat. Pass {"force": true} to override a hard block.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['clone', 'list', 'ls', 'read', 'write', 'edit', 'copy', 'delete', 'grep', 'status', 'diff', 'push', 'discard', 'pin', 'branch', 'move', 'hydrate'],
                        description: 'Action to perform'
                    },
                    repo: { type: 'string', description: 'Repository in "owner/repo" format (for clone action)' },
                    workspace: { type: 'string', description: 'Workspace identifier (owner/repo::branch). Optional — defaults to the current workspace if omitted.' },
                    branch: { type: 'string', description: 'Branch name (for clone: branch to clone; for branch action: the NEW branch name to fork to; for push: ignored — use branch_name to control the push target)' },
                    to: { type: 'string', description: 'For move action: target workspace key (owner/repo::branch) the dirty edits are moved onto.' },
                    unpin: { type: 'boolean', description: 'For pin action: true clears the pin on the given workspace instead of setting it. Default: false.' },
                    move_dirty: { type: 'boolean', description: 'For branch action: true (default) moves dirty edits to the fork (source is reverted clean); false copies them so both workspaces keep the edits.' },
                    path: { type: 'string', description: 'File or directory path (for ls, read, write, edit, diff)' },
                    content: { type: 'string', description: 'File content (for write action). Not needed if file_id is provided.' },
                    file_id: { type: 'string', description: 'Write a file from the file store (for write action). Use instead of content to copy a screenshot, attachment, or fetched file into the workspace.' },
                    dest: { type: 'string', description: 'Destination path (for copy action)' },
                    offset: { type: 'number', description: 'Start line for read (1-indexed). Default: 1' },
                    limit: { type: 'number', description: 'For read: max lines to return (default: all). For grep: max matches to return (default: 5, max: 100) — raise it when you need more results.' },
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
                    files: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'For push action: only commit these workspace paths (must all be dirty); omit to push all dirty files. For move action: only move these dirty paths; omit to move all dirty files.'
                    },
                    branch_name: { type: 'string', description: 'Branch name for push. A new branch+PR are created if it does not exist; reuse the SAME branch_name from a prior push to append another commit to that existing PR.' },
                    commit_message: { type: 'string', description: 'Commit message (for push action)' },
                    pr_title: { type: 'string', description: 'Pull request title (for push action)' },
                    pr_body: { type: 'string', description: 'Pull request body (for push action). Supports full GitHub markdown. Use actual newlines in the string value for multi-line content — do NOT use backslash-n escape sequences.' },
                    base_branch: { type: 'string', description: 'Base branch for PR (for push action, defaults to cloned branch). Omit this unless you need to override — the default is almost always correct.' },
                    include_git_ignored: { type: 'boolean', description: 'If true, includes gitignored files (e.g. dist/) in ls, grep, status, diff results. Default: false.' },
                    force: { type: 'boolean', description: 'For mutating actions (write, edit, delete, copy, discard): override the cross-chat conflict block and clobber another chat\'s uncommitted changes. Use only when you have intentionally decided to take over the file. For grep: bypass the slow-hydration guard (a grep whose lazy-clone content fetch is estimated > 60s is refused with a scope_breakdown — prefer narrowing `path`). Default: false.' },
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
            description: 'Create, read, update, and manage Smart Documents. Documents are persistent, versioned markdown files that render inline in chat. They support embedded display templates (table, chart, etc.) and non-blocking user prompts. Multiple references to the same document always show the latest version.\n\nVisibility: \'scope\' is \'shared\' by default (global) or \'chat\' (private to the creating chat); fixed at creation.\n\nSCRATCHPAD: a private `scope: "chat"` document is your working scratchpad — it is also shared between a sub-agent and its parent agent without crowding the shared document list.\n\nActions:\n- create: Create a new document. Args: title, content (markdown), scope? (\'shared\' default | \'chat\'), prompts? (non-blocking questions).\n- update: Update document content/title (creates new version). Args: doc_id, content?, title?, prompts?.\n- edit: Search-and-replace edits on document content (creates new version). Args: doc_id, edits (array of {find, replace}). Each find must be unique in the document.\n- read: Read current version + prompt responses. Args: doc_id.\n- list: List documents visible to you.\n- list_versions: List version history. Args: doc_id.\n- read_version: Read a specific version. Args: doc_id, version.\n- delete: Delete a document. Args: doc_id.\n\nTo embed display templates: call the display tool first, get the placeholder, include it in the document content.\nTo add prompts: pass a prompts array with fields (same schema as prompt_user fields).\nThe user can edit documents inline — read the document to see their changes.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'update', 'edit', 'read', 'list', 'list_versions', 'read_version', 'delete'], description: 'Action to perform' },
                    doc_id: { type: 'string', description: 'Document ID (for update, read, list_versions, read_version, delete)' },
                    title: { type: 'string', description: 'Document title (for create, update)' },
                    content: { type: 'string', description: 'Markdown content (for create, update)' },
                    scope: { type: 'string', enum: ['shared', 'chat'], description: 'Create visibility: \'shared\' (default, global) or \'chat\' (private to the creating chat). Fixed at creation.' },
                    version: { type: 'number', description: 'Version number (for read_version)' },
                    edits: { type: 'array', description: 'For edit action: search-and-replace operations. Each find must be unique in the document.', items: { type: 'object', properties: { find: { type: 'string', description: 'Unique text to find' }, replace: { type: 'string', description: 'Replacement text' } }, required: ['find', 'replace'] } },
                    prompts: { type: 'array', description: 'Non-blocking prompts below document. Array of {title?, description?, fields: [{name, type, label, options?, placeholder?, value?}]}. The description is rendered as MARKDOWN (bold, lists, inline/fenced code, links) — write it in markdown.', items: { type: 'object' } },
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
            description: 'List all connected ServiceNow instances with their connection status, user info, and short names. Use this to discover which instances are available before targeting them with servicenow_api or iframe_tool. Instances the user has DISABLED for agent use (via the header instance picker) are EXCLUDED from the targetable list and returned separately in a `disabledInstances` field \u2014 never target those: any tool call against a disabled instance (explicit `instance` arg or the active instance) is refused with an error until the user re-enables it.',
            parameters: {
                type: 'object',
                properties: {
                    refresh: { type: 'boolean', description: 'Deprecated — the tool now ALWAYS re-probes open tabs for fresh token/user data (same live probe as the header instance pill), so this flag is a no-op kept for backward compatibility.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                }
            }
        }
    },
    // ─── Handle collection (Sub-Agent spec §4) ──────────────────────────
    // Handles are issued by sub-agent operations — spawn_sub_agent,
    // wake_sub_agent, and agent_message return `{ handle: "h_..." }`
    // receipts that settle when the sub reports. Use the tools below to
    // collect them.
    {
        type: 'function',
        function: {
            name: 'await_handle',
            description: 'Block (on the scheduler, not the model) until an async handle resolves. Handles are issued by sub-agent operations — spawn_sub_agent, wake_sub_agent, and agent_message return {handle} receipts that settle when the sub reports. Returns the snapshot {status: done|error|cancelled|pending, result?, error?}. If status is still "pending" after timeout_ms, the handle is left in-flight — you can await it again. Handles are per-chat and do not survive a page reload.',
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
            name: 'await_any',
            description: 'Wait for the FIRST of several async handles to settle. Returns {handle, snapshot, timeout:false} on win, or {handle:null, snapshot:null, timeout:true, pendingSnapshots:[...]} on timeout. Useful when several sub-agents are in flight (spawn_sub_agent / wake_sub_agent handles) and you want whichever reports first.',
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
            description: 'Wait for ALL of several async handles to settle. Returns {snapshots: [...], timedOut} in the same order as the input. `timedOut` is true when at least one handle never settled within timeout_ms (its snapshot is still status:"pending") — a single flag for detecting a partial result without scanning every snapshot. Useful to fan out several sub-agents and collect when every spawn handle is done.',
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
    // ─── Sub-agent runtime (Sub-Agent spec §3 / Phase 2) ────────────────
    // Spawn background sub-agents to offload context-heavy work (file scans,
    // multi-record audits, log scraping). Each sub gets its own chat + context
    // window, runs to completion, and reports back a distilled summary via
    // `report_to_parent`. Pool limits are per connection group (Orchestrator
    // §5): 2 concurrent for Anthropic-OAuth-backed subs, 4 per endpoint for
    // other providers, 6 overall; excess spawns queue.
    {
        type: 'function',
        function: {
            name: 'spawn_sub_agent',
            description: 'Spawn a background sub-agent in a fresh chat to do focused, context-heavy work without polluting your context window. Returns immediately with {agent_id, chat_id, handle}. The sub runs in its own chat with its own context, calls `report_to_parent` when done, and the spawn handle resolves with the distilled summary — collect via `await_handle(handle)`. If the sub reports `status:"error"` or crashes (auto_report fallback), the OUTER handle settles as `status:"error"` too (snapshot.error = headline, snapshot.result = full report). Use for: ALL substantive work — file/grep dumps, multi-record audits, deep log scans, iterative debugging, and EVERY workspace file edit or implementation task no matter how small (a 2-line edit is still implementation). Do NOT use for: orchestration mechanics (reviewing deliverables, progress cards, user prompts, rendering reviewed results) or work whose result must flow into the very next tool call. Pass `output_schema` to declare the exact shape the sub must return in report_to_parent\'s `data` — handy when you spawn and parse the result programmatically (e.g. inside js_eval). ALWAYS pick a model explicitly via `tier` (small|medium|large|same) — never omit it (omitting silently inherits the default tier); see the `tier` param for which tier fits which work.',
            parameters: {
                type: 'object',
                properties: {
                    instructions: { type: 'string', description: 'The task. Becomes the sub\'s first user message. Be specific about what should be returned (e.g. "return only sys_ids and names, no script bodies"). Write in markdown — it is rendered as markdown in the parent chat\'s sub-agent panel. If any active skills are relevant to the task, name them here and tell the sub to read them with get_skill before starting (e.g. "Read the atf-testing skill first").' },
                    name: { type: 'string', description: 'Short label shown in the sidebar / Workers strip. Defaults to a generated id.' },
                    allow_nested: { type: 'boolean', description: 'If true, the sub may spawn/stop/wake its own sub-agents (default: false). Use only when you genuinely need the sub to delegate further — multi-stage research, recursive audits, etc. Max nesting depth is 5. When you ALSO pass `profiles`, include "orchestrator" in the list — otherwise the spawn/await tools are filtered out of the roster by the profiles before this flag can allow them.' },
                    context_seed: { type: 'object', description: 'Small JSON blob copied into the sub\'s first message (record ids, queries, etc.).' },
                    output_schema: { type: 'object', description: 'Optional JSON-Schema-ish object describing the EXACT shape the sub must return in report_to_parent\'s `data` field. Injected into the sub\'s first message with a directive to conform (same keys/types, no extras). Use when you spawn + parse the result programmatically (e.g. inside one js_eval) and want a predictable structure to destructure. The root should be an object (report_to_parent\'s `data` is itself an object) — wrap arrays in a named property, e.g. {items:[...]}, rather than using a root-level array.' },
                    auto_report: { type: 'boolean', description: 'If true (default), a fallback report is synthesized from the last assistant message if the sub finishes without calling report_to_parent.' },
                    wake_parent: { type: 'boolean', description: 'If true (DEFAULT), the parent chat is woken when this sub reports (report_to_parent, auto-report, crash): an idle parent gets a notice row and a run STARTS so the agent can act on the report immediately; a running parent gets the notice injected mid-run at a safe point. Skipped automatically while you are blocked in await_handle on the spawn handle (the settle already delivers — no double notification). Keeping the DEFAULT true is the RECOMMENDED pattern for fan-outs — end your turn and react to each report as it wakes you. Pass false ONLY for fire-and-forget spawns you will collect manually via await_handle / agent_status.' },
                    profiles: { type: 'array', items: { type: 'string', enum: ['servicenow', 'browser', 'research', 'code', 'extension-dev', 'skill-manager', 'eval-runner', 'audit-runner', 'orchestrator'] }, description: 'Tool profiles for the sub — the sub\'s tool list is narrowed to the base tools plus ONLY these profiles, cutting its context size. Mix freely, e.g. ["servicenow","browser"]. Omit = full legacy toolset. Choices: servicenow (ServiceNow record CRUD, server scripts, code edits); browser (drive/inspect the ServiceNow UI in the iframe, screenshots); research (web_fetch — all HTTP methods — plus docs/web search; NO workspace access); code (GitHub repo work: clone/read/edit/diff/push via workspace, plus web_fetch for the GitHub REST API); extension-dev (the code tools plus runtime_inspect and screenshots); skill-manager (create/update/manage AI skills); eval-runner (ServiceNow eval grader + the ServiceNow tools the eval tasks need); audit-runner (instance audits: audit tool + ServiceNow read access); orchestrator (spawning/managing its own subs, async handles, prompts, rendering — pair with allow_nested). NOTE: some profile tools are SKILL-provided (web_search, search_docs, run_audit) — the sub only gets them when the corresponding skill is active in the spawning chat. The core toolset (js_eval, cached-result readers, get_file, get_skill, progress card), the sub-agent reporting tools, and `document` (scratchpad docs) are ALWAYS included — never list them.' },
                    tier: { type: 'string', enum: ['small', 'medium', 'large', 'same'], description: 'Pick the sub\'s model size tier. There are three size tiers — small | medium | large (plus `same`) — which the user maps to concrete models in Settings → Sub-Agent Model Tiers; the agent never sees or chooses model/provider names. small = cheap fan-outs (searches, summaries, discovery/scoping); medium = code-review passes and synthesis/triage/moderate implementation; large = heavy implementation or subtle reasoning. same = the sub DYNAMICALLY follows the spawner\'s current model (resolved per LLM call, so it tracks later model switches), bypassing the tier→model mapping — use when the sub must always run on exactly the model you are on, e.g. a self-evaluation. Set this explicitly on EVERY spawn.' },
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
            description: 'SUB-AGENT ONLY. Push a distilled result up to the parent agent. Settles the parent\'s spawn handle (if still pending) and parks you (state=sleeping) — the parent can `wake_sub_agent` you with a follow-up or `stop_sub_agent` to terminate. `status` is informational (UI badge color, parent decision logic). Unless the parent spawned you with wake_parent:false, reporting also WAKES the parent: an idle parent chat starts a run with a notice of your report, and a running parent gets the notice injected at a safe point (skipped when the parent is already blocked in await_handle — the settle delivers there). For mid-flight progress that should NOT settle the handle, use `agent_message({to:"parent", content:"..."})` instead. The summary is what the parent SEES — it never reads your raw transcript — and MUST be written in markdown (it is rendered as markdown in the parent chat\'s sub-agent output panel). Optionally start markdown section headings with an emoji or a GitHub-style shortcode (e.g. :mag:, :wrench:) — it renders as the section\'s icon. Cap: 4 KB summary, 32 artifacts.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['done', 'error', 'need_input'], description: 'Informational status. done=task complete, error=failed, need_input=parked waiting for parent. All three settle the spawn handle and park you.' },
                    summary: { type: 'string', description: '1-3 sentence distilled result, written in MARKDOWN (it is rendered as markdown in the parent\'s sub-agent output panel). THIS is what the parent reads. Soft-capped at 4 KB.' },
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
            description: 'Read-only snapshot of sub-agents. By default lists every sub spawned by the current chat (running, sleeping, stopped, errored) in a COMPACT shape: agent_id, name, state, tier, timestamps, tool_calls_used (display-only lifetime counter — no limit), context_pct/saturated gauges (FIXED assumed 200k window; threshold 100k = 50% — check before re-tasking a sub), review_state, a truncated last_report (status + first ~200 chars of summary), action_state {state, label} (the sub\'s live progress-card headline), and compact usage {calls, input_tokens, output_tokens, cost, tier} — cost is null when the endpoint never reported one (only OpenRouter does; there is no client-side pricing). Diagnostic fields (last_error, crash_cause, pending_approvals, awaiting_approval, escalation_suggestion, resurrectable, inbox_size, pending_handles) appear ONLY when meaningful. Pass verbose:true for the FULL per-agent detail: full last_report, last_assistant_message ({text, at} — what the sub last said in its own chat, ~600 chars list / ~2000 single), full action_state ({state, label, tasks[], output} — the sub\'s todo list), usage.by_tier breakdown, pool position, wake_parent, retries, and user_interactions {last_user_message_at, last_user_approval_at, opened_by_user_at}. Passing agent_id returns ONE sub in full detail (verbose implied). parent_chat_id:"*" lists every sub in every chat. Cheap, synchronous — use freely.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Specific sub agent_id. Omit to list. Single-agent results are always full-detail.' },
                    parent_chat_id: { type: 'string', description: 'Filter list by parent chat. Pass "*" to list every sub on the instance.' },
                    verbose: { type: 'boolean', description: 'List mode only: true returns the full per-agent snapshot (last_assistant_message, full action_state tasks, usage.by_tier, lifecycle diagnostics). Default false = compact entries.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'wake_sub_agent',
            description: 'Resume a sleeping sub-agent — or RESURRECT an errored/stopped one — optionally with a new instruction. Resurrection revives the sub with its FULL prior chat context (a crashed sub continues where it left off instead of redoing the work), as long as its record/transcript still exists (terminal subs are garbage-collected ~1h after settling). If the sub has queued inbox messages, they are drained into a combined user turn on wake. Returns `{handle}` — an awaitable spawn handle for the resumed run (a fresh handle if the previous one already settled, or the existing one if it\'s still pending), plus `resurrected_from` when a terminal sub was revived. The parent should `await_handle(result.handle)` to collect the next `report_to_parent` payload. No-op if the sub is already running. After 2 `revision_requested` verdicts the result also carries `escalation_suggestion` (next tier up, or an independent fresh-context reviewer sub when already at the top tier) — a suggestion only, never auto-applied. The result may also carry a non-blocking `saturation_warning` when the woken sub is saturated (see agent_status for the gauges) — let it wrap up and spawn a FRESH successor instead of piling on more work.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Sub agent_id to wake.' },
                    instruction: { type: 'string', description: 'Optional new user message. Drained with any pending inbox into the sub\'s next turn.' },
                    tier: { type: 'string', enum: ['small', 'medium', 'large', 'same'], description: 'Optional escalation by size tier (small | medium | large | same) — e.g. escalate a failing small-model sub to large for its next phase. `same` switches the sub to DYNAMICALLY follow the waking agent\'s current model (tracked per call). By default a woken/resurrected sub stays on its spawn-time tier.' },
                    review_state: { type: 'string', enum: ['accepted', 'revision_requested'], description: 'Optional review verdict for the sub\'s LAST reported deliverable (Orchestrator review flow): "accepted" = the parent accepts it as-is, "revision_requested" = the accompanying `instruction` asks for changes. Applied even when the wake is otherwise a no-op. ("pending" is stamped automatically on every report; "cross_checked" automatically when an independent reviewer sub is aimed at it.) Read back via agent_status.review_state.' },
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
            description: 'Send a message between agents. From a parent: `to:"sub_xxx"` pushes to that sub (auto-wakes if sleeping unless wake:false; the response includes a fresh `handle` the parent can `await_handle` for the resumed run\'s next report). The result may carry a non-blocking `saturation_warning` when the recipient sub is saturated (see agent_status for the gauges) — have it wrap up and spawn a fresh successor instead of piling on more work. From a sub: `to:"parent"` pushes a mid-flight status update to the parent chat (renders as an inline callout, does NOT settle the spawn handle, the sub keeps running). For terminal sub→parent results that should settle the handle, use `report_to_parent`.',
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
    },
    {
        type: 'function',
        function: {
            name: 'eval_runner',
            description: 'Built-in sandboxed grader for the ServiceNow Eval (servicenow-eval skill). Handles ALL access to task setup/verifier/cleanup scripts so they never enter model context. Actions: \'init\' (reset session, returns the 20 task prompts), \'setup\' (seed one task, duplicate-locked), \'verify\' (single-use atomic verify+cleanup+audit for one task, returns {pass,expected,actual}), \'teardown\' (returns the server-side audit verdicts, then deletes all session state). The agent must NEVER read tasks.md directly — only this tool may.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['init', 'setup', 'verify', 'teardown'], description: 'Lifecycle phase to run.' },
                    task_id: { type: 'string', description: 'Task ID (e.g. \'T6\'). Required for setup and verify.' },
                    instance: { type: 'string', description: 'Target ServiceNow instance by short name or URL. Optional — defaults to the active instance.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_setup',
            description: 'Open the GitHub setup popup in the extension UI to help the user connect a GitHub account and/or add (clone) repositories. If no account is connected yet, the popup shows the Personal Access Token form with a direct link to the GitHub token-creation page (pre-scoped to repo); pass open_token_page:true to also open that page in a new tab immediately. Pass repo (owner/repo) and optional branch to prefill the clone form so the user only has to click Clone. NON-BLOCKING: returns immediately after opening the popup — it does NOT wait for the user. Verify the outcome afterwards with workspace {action:"list"} or by asking the user.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Repository to prefill in the clone form, e.g. "owner/repo". Optional.' },
                    branch: { type: 'string', description: 'Branch to prefill in the clone form. Optional.' },
                    open_token_page: { type: 'boolean', description: 'If true and no GitHub account is connected yet, also opens the GitHub personal-access-token creation page (repo scope preselected) in a new tab. Default: false.' },
                    instance_url: { type: 'string', description: 'GitHub instance URL to prefill for GitHub Enterprise (default: https://github.com or the previously saved instance).' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'runtime_inspect',
            description: 'DEV-MODE ONLY: introspect and drive the AppAgent extension\'s OWN runtime (panel page, IndexedDB, service worker) while developing the extension. Available only when Reload rebuilds from the workspace (extension-dev skill active AND deploy folder connected); every call errors otherwise. Actions: \'ui_state\' (snapshot of page state: current chat/view, running+paused chats, chat list summary, pending tool approvals, widgets, lastApiError, LLM connection status, theme, active skills, dev-mode flag); \'get\' {path} (CSP-safe read of any page global/path, e.g. "chats[\'chat_123\'].messages[0]" or "currentChatId"); \'call\' {path, args} (CSP-safe invocation of an existing page function with its parent object as `this`, e.g. path:"renderChatList"); \'set\' {path, value, call_after} (CSP-safe UI-state WRITE + re-render path: resolves the PARENT of the path and assigns the final segment to value — any JSON value; optional call_after is a function path invoked with no args afterwards, e.g. "renderChatList", so the UI re-renders from the new state); \'dispatch\' {target, event, payload, selector, options} (event-trigger path with three targets. target:\'bus\' — the default — emits on the page AgentEvents bus: AgentEvents.emit(event, payload), invoking the REAL page-side handlers (event names are the AgentEvents.emit vocabulary, e.g. messagesAppended, actionStateChanged, runFinished); target:\'sw\' posts {type: event, ...payload} to the service worker over the agent bus port, hitting the SW inbound handlers (port-bridge switch: pull-chat, toggle-pause, interrupt, focus-chat, update-chat, …); target:\'dom\' {selector, event, options} fires a DOM event on an element of the PANEL PAGE\'s own document — NOT the ServiceNow iframe (plain click uses el.click(); otherwise the proper class: MouseEvent, KeyboardEvent with options.key, InputEvent/Event with bubbles:true; matched:false — success, not an error — when the selector matches nothing). WARNING: bus/sw dispatch invokes REAL handlers and can mutate run state (interrupt / toggle-pause are live controls). Together with \'get\'/\'call\', set + dispatch cover CSP-safe state reads, writes and event triggering); \'db\' {op:\'list\'|\'get\'|\'query\'|\'count\'|\'grep\', store, key, path, pattern, flags, limit} (inspect the extension\'s own IndexedDB: list store names; get one record by key — optional path drills into the record with the same dot/bracket syntax (e.g. "messages[3].content") and returns {exists, value}, exists:false for a missing intermediate; query up to `limit` records; count all records; or grep {store, pattern, flags?, key?, path?, limit?} — regex-search STRING leaves record-by-record via an IDB cursor, each match {key, path, excerpt: match ±60 chars}, default flags \'i\', limit = max matches (default 20, cap 100), ~1MB of string scanned per record, returns {matches, truncated, records_scanned, records_capped} — plus key_found when key was passed — e.g. read past chat transcripts/history from the \'chats\' store); \'sw_state\' (pull live service-worker state over the port: running chats, pending/parked tool calls, connected panel count, resume-scan flag); \'screenshot\' (capture the panel via chrome.tabs.captureVisibleTab — LIMITATION: fails with an explanatory error when the panel runs in the side panel, because it has no tab of its own; open the panel as a full tab first); \'new_chat\' {focus} (create a chat; focus:false creates in background); \'focus_chat\' {chatId} (navigate to a chat from anywhere); \'set_view\' {view} (switch main view: home|chat|dashboard|skills|documents|history|docs|settings). All results are safe-serialized (depth 6, 4KB per string, 64KB total) — except \'screenshot\', whose base64 is returned in full.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['ui_state', 'get', 'call', 'set', 'dispatch', 'db', 'sw_state', 'screenshot', 'new_chat', 'focus_chat', 'set_view'], description: 'What to inspect or do.' },
                    path: { type: 'string', description: 'For get/call/set: dot/bracket path resolved from window, e.g. "chats[\'id\'].title" or "SubAgents.getById". For db get/grep: sub-path INSIDE the record to drill into / search under (walked over the plain record, not window).' },
                    args: { type: 'array', description: 'For call: arguments array applied to the resolved function.' },
                    value: { description: 'For set: the new value to assign at the path (any JSON value).' },
                    call_after: { type: 'string', description: 'For set: optional function path invoked with no args after the write (e.g. "renderChatList") so the UI re-renders from the new state.' },
                    target: { type: 'string', enum: ['bus', 'sw', 'dom'], description: 'For dispatch: where to send the event — bus (AgentEvents page bus, default), sw (service-worker port message), dom (panel-page DOM element).' },
                    event: { type: 'string', description: 'For dispatch: event name. bus: an AgentEvents type (e.g. messagesAppended); sw: an SW port message type (e.g. pull-chat, toggle-pause); dom: a DOM event (click, keydown, input, …).' },
                    payload: { type: 'object', description: 'For dispatch bus/sw: event payload — bus: passed as the emit detail; sw: merged into the port message beside type (e.g. {chatId: "chat_123"}).' },
                    selector: { type: 'string', description: 'For dispatch target dom: CSS selector of the panel-page element (document.querySelector).' },
                    options: { type: 'object', description: 'For dispatch target dom: event init options (e.g. {key: "Enter"} for keydown). bubbles/cancelable default to true.' },
                    op: { type: 'string', enum: ['list', 'get', 'query', 'count', 'grep'], description: 'For db: operation. Default: list.' },
                    pattern: { type: 'string', description: 'For db grep: regex source tested against every string leaf of each record.' },
                    flags: { type: 'string', description: "For db grep: regex flags (default 'i')." },
                    store: { type: 'string', description: 'For db get/query: object store name (see op:list).' },
                    key: { type: ['string', 'number'], description: 'For db get/grep: record key — string OR numeric (IDB keys can be numeric); passed as-is to store.get (grep: restricts the search to that one record).' },
                    limit: { type: 'number', description: 'For db query: max records; for db grep: max matches (default 20, cap 100).' },
                    chatId: { type: 'string', description: 'For focus_chat: chat id to open.' },
                    view: { type: 'string', enum: ['home', 'chat', 'dashboard', 'skills', 'documents', 'history', 'docs', 'settings'], description: 'For set_view: target view.' },
                    focus: { type: 'boolean', description: 'For new_chat: false creates the chat without navigating to it. Default: true.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_tool_schema',
            description: 'Fetch the full JSON schema + description for one or more tools listed in the deferred tool catalog (system prompt). Read this BEFORE calling a catalog tool whose parameters you do not already know — the schema arrives in this tool_result and stays in the conversation history for the rest of the chat. Nothing is loaded or registered: this is a read, not a setup step. Batch several names in one call to save round-trips.',
            parameters: {
                type: 'object',
                properties: {
                    names: {
                        description: 'Tool name(s) from the catalog to fetch — an array of names (a single name string is also accepted).',
                        type: 'array',
                        items: { type: 'string' }
                    },
                    status_message: {
                        description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)',
                        type: 'string'
                    }
                },
                required: ['names']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'start_chat',
            description: 'Open a NEW chat pre-loaded with a message. The main use case is a BUTTON INSIDE AN html_widget: the button calls await executeTool("start_chat", {message, mode, include_widget}) so the user can hand a question off to the agent straight from the widget — either answered immediately (mode:"send") or dropped into the composer for them to edit and submit (mode:"draft"). Returns {success, chat_id, mode, sent, widget_id, message}. IMPORTANT: in foreground modes (mode:"send" without background, and mode:"draft") the view switches to the new chat, which tears down the calling widget\'s iframe — so a widget cannot rely on receiving the return value there; pass background:true if the widget must stay alive to show feedback. Do NOT use this to talk to yourself mid-answer: it starts a SEPARATE conversation.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'REQUIRED. The chat message text to pre-load.' },
                    mode: { type: 'string', enum: ['send', 'draft'], description: '"send" (default) auto-submits the message so the agent answers immediately. "draft" only prefills and focuses the composer — nothing is sent, the user presses enter themselves.' },
                    background: { type: 'boolean', description: 'send mode only. true = run the new chat in the background: the user\'s view does NOT switch, the chat shows in the jobs badge while it runs and rings the finished-chat bell when done. IGNORED in draft mode (a draft has to be visible to be edited). Default false.' },
                    include_widget: { type: 'boolean', description: 'Prepend a widget-context reference to the message so the new chat knows which widget the question is about ("Context: widget <id> ("<title>") — read it with iframe_tool get_visible_text or take_screenshot."). Uses widget_id, or the CALLING widget when invoked from inside one. Omitted (with a note in the return payload) if no widget id can be resolved. Default false.' },
                    widget_id: { type: 'string', description: 'Explicit widget id to reference. Omit when calling from inside a widget — the calling widget is used automatically.' },
                    title: { type: 'string', description: 'Optional title for the new chat. Omit to let the usual first-message/auto-title logic name it.' },
                    status_message: { type: 'string', description: 'Human-friendly status message describing what this tool call is doing (shown in UI header)' }
                },
                required: ['message']
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
    set_tldr: true,
    set_links: true,
    set_caveat: true,
    cached_content_outline: true,
    cached_content_search: true,
    cached_content_read: true,
    // get_tool_schema is pure metadata (reads TOOLS + the skillTools
    // registry, both present in the SW bundle) — fully headless.
    get_tool_schema: true,
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
    // get_cookie calls chrome.cookies in the SW (background) context - the
    // ONLY context where that API exists. Impl: executeGetCookie at the end of
    // tools/020-tool-execution.js, which is in WORKER_SHARED_FILES, so the
    // function is present in BOTH the page bundle and the SW bundle.
    get_cookie: true,
    workspace: true,
    read_attached_file: true,
    document: true,
    list_instances: true,
    // Handle-await helpers — pure in-memory registry reads, fully headless
    await_handle: true,
    await_any: true,
    await_all: true,
    // Sub-agent runtime tools — the registry is in-memory + IDB, fully
    // headless. All seven dispatch through tools/020-tool-execution.js to
    // SubAgents.* helpers. Side-effects (chat creation, runAgent kick) work
    // identically in SW and page contexts because runAgent + the chats map
    // are shared globals in WORKER_SHARED_FILES.
    // eval_runner only needs executeTool (servicenow_run_script) + getSkillAsset,
    // both available in WORKER_SHARED_FILES — fully headless.
    eval_runner: true,
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
    // pin_widget mutates dashboardWidgets + re-renders the dashboard/home grids — page only.
    pin_widget: false,
    display: false,
    prompt_user: false,
    // github_setup opens a modal in the side panel DOM (impl in
    // tools/130-github-setup.js, page bundle only — not in WORKER_SHARED_FILES).
    github_setup: false,
    // runtime_inspect reads page globals + drives the panel UI (impl in
    // tools/140-runtime-inspect.js, page bundle only) — must be routed to a
    // connected panel executor, never run headless in the SW.
    runtime_inspect: false,
    // start_chat drives newChat/sendMessage/#message-input + the chat lists
    // (impl in tools/150-start-chat.js, page bundle only — not in
    // WORKER_SHARED_FILES). Route it to the panel.
    start_chat: false
};
// ─── short catalog descriptions ─────────────────────────────────────────────
// One-liners for the deferred-tool catalog ({{TOOL_CATALOG}} in the system
// prompt): "what + when to use me" in ≤ ~20 words. Co-located map (same
// pattern as HEADLESS_TOOLS above) stamped onto each entry as `.short`.
// Render-time fallback: first sentence of the full description
// (getToolShortDescription below). NON-WIRE: `short` is stripped from the
// request array by prepareToolsForRequest — it must never ship to the API.
var TOOL_SHORT_DESCRIPTIONS = {
    js_eval: 'Run JavaScript in a sandbox to chain multiple tool calls (executeTool) in one step.',
    servicenow_api: 'Read/write ServiceNow records via the Table API — the preferred path for record CRUD.',
    servicenow_run_script: 'Run server-side JavaScript on a ServiceNow instance (admin only) for things the Table API cannot do.',
    servicenow_diff_edit: 'Edit a ServiceNow record field with search-and-replace — for surgical script/code changes.',
    iframe_tool: 'Drive the instance UI in an iframe — navigate, click, fill, inspect — for genuine UI work only.',
    set_chat_title: 'Set the chat title; normally requested by the after-response hook.',
    set_tldr: 'Set the TL;DR summary card for the final answer; requested by the after-response hook.',
    set_links: 'Provide relevant links for the answer card; requested by the after-response hook.',
    set_caveat: 'Flag one must-read caveat about the final answer; requested by the after-response hook.',
    cached_content_outline: 'View the structural outline of a large cached tool result.',
    cached_content_search: 'Regex-search inside a large cached tool result.',
    cached_content_read: 'Read a specific path or line range of a large cached tool result.',
    get_skill: 'Read an AI skill body or one of its files before starting related work.',
    manage_skill: 'Create, update, edit, activate, or delete AI skills and their files (live runtime copy).',
    html_widget: 'Render a custom interactive HTML widget inline in chat when no display template fits.',
    pin_widget: 'Pin, move, or unpin an existing widget on the main or home dashboard.',
    take_screenshot: 'Capture a PNG screenshot of the browser panel, a widget, or an element for visual analysis.',
    screenshot_by_id: 'Retrieve a previously taken screenshot by its ID.',
    get_file: 'Retrieve any stored file by ID — view it (attach) or hand the user a download.',
    display: 'Render structured data with a predefined template: table, chart, code, diff, timeline, cards, checklist.',
    update_action_state: 'Maintain the live progress card (state + todo list) for multi-step work.',
    show_action_button: 'Render a one-click skill Action button inline in chat.',
    prompt_user: 'Show a blocking inline form to collect structured user input or confirm a plan.',
    web_fetch: 'Fetch a URL (GET/POST); for HTML pages, fetch and parse via js_eval instead.',
    get_cookie: 'Read browser cookies for a URL (chrome.cookies) so js_eval can do authenticated, cookie-gated fetches.',
    workspace: 'Clone, browse, edit, and push GitHub repos — the code-editing workspace.',
    read_attached_file: 'Read a text file the user attached to this conversation.',
    document: 'Create, read, edit, and manage persistent versioned Smart Documents rendered inline.',
    list_instances: 'List connected ServiceNow instances with status and user info.',
    await_handle: 'Block until one sub-agent handle settles and return its snapshot.',
    await_any: 'Wait for the first of several sub-agent handles to settle.',
    await_all: 'Wait for all of several sub-agent handles to settle.',
    spawn_sub_agent: 'Spawn a sub-agent chat on a chosen tier to do focused delegated work.',
    report_to_parent: 'Sub-agent only: push the distilled result to the parent and park.',
    agent_status: 'Read-only snapshot of sub-agents: progress, saturation, reports, last chat output, approvals.',
    wake_sub_agent: 'Wake a parked sub-agent with follow-up instructions; returns a fresh handle.',
    stop_sub_agent: 'Terminate a sub-agent and cancel its pending work.',
    sleep_self: 'Sub-agent only: park yourself until the parent wakes you.',
    start_chat: 'Open a new chat pre-loaded with a message (auto-send or draft) — for hand-off buttons inside widgets.',
    agent_message: 'Send a message between agents (parent↔sub) without settling the spawn handle.',
    eval_runner: 'Sandboxed grader for the ServiceNow eval skill lifecycle (init, setup, verify, teardown).',
    github_setup: 'Open the GitHub setup popup to connect an account or clone a repo.',
    runtime_inspect: 'Dev-mode only: introspect and drive the AppAgent extension runtime itself — page state, service worker, and IndexedDB incl. past chat transcripts.',
    get_tool_schema: 'Fetch full JSON schemas for catalog tools before calling one whose parameters you do not know.'
};
for (var _ti = 0; _ti < TOOLS.length; _ti++) {
    var _tn = TOOLS[_ti].function && TOOLS[_ti].function.name;
    TOOLS[_ti].headless = !!HEADLESS_TOOLS[_tn];
    TOOLS[_ti].short = TOOL_SHORT_DESCRIPTIONS[_tn] || '';
}
function isHeadlessTool(name) { return !!HEADLESS_TOOLS[name]; }

// ─── Deferred tool loading (tools-as-skills) ─────────────────────────────────
// Shared by BOTH getEnabledTools twins (page: ui/140-dropdowns.js, worker:
// worker/025-permissions-helpers.js), the {{TOOL_CATALOG}} renderer
// (core/110-system-prompt.js) and the get_tool_schema meta-tool. This file
// is loaded in both bundles (core tier + WORKER_SHARED_FILES) — the split
// is implemented HERE ONLY; never fork it into the twins.
//
// CORE_TOOL_NAMES = tools whose full schemas are always declared in the
// request when deferred mode is ON: js_eval, the deferred-mode bootstrap
// pair (get_tool_schema, get_skill), the after-response hook tools
// (set_tldr, set_chat_title), progress (update_action_state), and the
// orchestrator loop (spawn_sub_agent, await_handle; + report_to_parent on
// the sub-agent side — parent chats filter it out of the enabled list
// anyway). EVERYTHING else — including active-skill tools — is deferred:
// cataloged by name + one-liner, schema fetched on demand via
// get_tool_schema, then called natively (dispatch in
// tools/020-tool-execution.js routes by name, not by the declared array).
// NOTE: this file ships in BOTH the page and SW bundles (WORKER_SHARED_FILES).
var CORE_TOOL_NAMES = {
    js_eval: true,
    get_tool_schema: true,
    get_skill: true,
    set_tldr: true,
    set_chat_title: true,
    update_action_state: true,
    spawn_sub_agent: true,
    await_handle: true,
    report_to_parent: true
};

function isDeferredToolName(name) {
    return !CORE_TOOL_NAMES[name];
}

// Split an (already permission/hook/dev-mode/roster-filtered) tool list
// into { core, deferred }, PRESERVING input order — determinism matters
// for prompt-cache byte-stability across turns.
function getDeferredSplit(allTools) {
    var core = [], deferred = [];
    for (var i = 0; i < allTools.length; i++) {
        var t = allTools[i];
        var n = t && t.function && t.function.name;
        if (n && CORE_TOOL_NAMES[n]) core.push(t); else deferred.push(t);
    }
    return { core: core, deferred: deferred };
}

// Strip non-wire fields before entries are serialized into a request.
// `short` is ALWAYS stripped (new field — must never ship). `headless` is
// stripped only in deferred mode: the legacy (flag OFF) request must stay
// BYTE-IDENTICAL to today's wire shape, and today's requests already ship
// the stamped `headless` key. Shallow copies — the TOOLS source objects
// are never mutated.
//
// Flag OFF also excludes get_tool_schema from the DECLARED array — the
// meta-tool is a new TOOLS entry, so shipping it would make the flag-OFF
// request differ from the pre-upgrade wire shape (43 tools instead of 42,
// and the Anthropic cache_control tail landing on a new last entry). The
// IMPLEMENTATION stays callable regardless (executor routes by name;
// js_eval executeTool falls through the same dispatch). Gate lives HERE
// ONLY — both getEnabledTools twins call this; never fork it into them.
function prepareToolsForRequest(allTools, deferredActive) {
    if (!deferredActive) {
        allTools = allTools.filter(function(t) {
            return !(t && t.function && t.function.name === 'get_tool_schema');
        });
    }
    return allTools.map(function(t) {
        var copy = Object.assign({}, t);
        delete copy.short;
        if (deferredActive) delete copy.headless;
        return copy;
    });
}

// One-liner for a tool: curated map first (survives prepareToolsForRequest
// stripping), then a stamped/skill-def `short`, then the first sentence of
// the full description.
function getToolShortDescription(tool) {
    var fn = tool && tool.function;
    var name = fn && fn.name;
    if (name && TOOL_SHORT_DESCRIPTIONS[name]) return TOOL_SHORT_DESCRIPTIONS[name];
    if (tool && tool.short) return tool.short;
    if (fn && fn.short) return fn.short;
    var desc = (fn && fn.description) || '';
    var m = desc.match(/^[\s\S]*?[.!?](?=\s|$)/);
    var s = (m ? m[0] : desc).replace(/\s+/g, ' ').trim();
    if (s.length > 200) s = s.slice(0, 197) + '...';
    return s;
}

// Render the {{TOOL_CATALOG}} block from a DEFERRED tool list. Returns ''
// for an empty list. The heading doubles as the dedupe marker for the
// custom-system-prompt auto-append (_maybeAppendToolCatalog in
// core/110-system-prompt.js) — keep them in sync.
var TOOL_CATALOG_HEADING = 'ADDITIONAL AVAILABLE TOOLS (deferred schemas):';
function buildToolCatalog(tools) {
    if (!tools || tools.length === 0) return '';
    var lines = [];
    for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        var n = t && t.function && t.function.name;
        if (!n) continue;
        lines.push('- ' + n + ' — ' + getToolShortDescription(t));
    }
    if (lines.length === 0) return '';
    return TOOL_CATALOG_HEADING + '\n'
        + 'The tools below exist and are callable, but their schemas are not loaded into this request. '
        + 'Before calling any tool below whose parameters you do not already know, call get_tool_schema '
        + 'with its name(s) — the full schema arrives in the tool_result and stays in the conversation '
        + 'history for the rest of the chat (nothing is loaded or registered). Then call the tool '
        + 'directly, exactly like a declared tool. Once the schema is fetched (or when you already '
        + 'know the parameters), call these tools NATIVELY as top-level tool calls, exactly like '
        + 'any other tool.\n'
        + lines.join('\n');
}

// Shared catalog renderer for the system prompt. Empty string when the
// deferred flag is OFF (so the {{TOOL_CATALOG}} placeholder renders to
// nothing) or when nothing is deferred. Uses the SAME filtered list as the
// request build — the getEnabledTools twin of the current realm, with
// includeDeferred so the split happens here — which means permission/
// hook/dev-mode disabled tools appear in neither the slim array nor the
// catalog, and sub-agent rosters scope the catalog too.
function getToolCatalogForPrompt(chatId) {
    try {
        if (typeof isDeferredToolsActive !== 'function' || !isDeferredToolsActive()) return '';
        if (typeof getEnabledTools !== 'function') return '';
        var all = getEnabledTools(chatId, { includeDeferred: true });
        return buildToolCatalog(getDeferredSplit(all).deferred);
    } catch (e) {
        // A silent '' here would make every deferred tool undiscoverable
        // with no trace — always leave a breadcrumb.
        console.warn('[deferred-tools] catalog render failed', e);
        return '';
    }
}

// get_tool_schema implementation (dispatch arm in
// tools/020-tool-execution.js; headless — runs SW-local). Read-only
// metadata: returns the full JSON schema + description for cataloged
// tools. Only exposes tools that pass the same permission/enabled filters
// as the request build — a disabled tool is absent from the catalog AND
// from here.
function executeGetToolSchema(args, options) {
    var names = args && (args.names !== undefined && args.names !== null ? args.names : args.name);
    if (typeof names === 'string') names = [names];
    if (!Array.isArray(names) || names.length === 0) {
        return { success: false, error: 'Provide `names`: an array of tool names from the tool catalog (a single name string is also accepted).' };
    }
    var chatId = (options && options.chatId)
        || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
        || (typeof currentChatId !== 'undefined' ? currentChatId : null);
    // FAIL CLOSED: resolve against the chat's enabled/filtered list only.
    // Never fall back to the raw TOOLS array — that would expose schema
    // text of permission-disabled or roster-excluded tools.
    if (typeof getEnabledTools !== 'function') {
        return { success: false, error: 'Could not resolve enabled tools: getEnabledTools is unavailable in this context.' };
    }
    var enabled;
    try {
        enabled = getEnabledTools(chatId, { includeDeferred: true });
    } catch (e) {
        return { success: false, error: 'Could not resolve enabled tools: ' + (e && e.message ? e.message : String(e)) };
    }
    var byName = {};
    for (var i = 0; i < enabled.length; i++) {
        var t = enabled[i];
        if (t && t.function && t.function.name) byName[t.function.name] = t;
    }
    var schemas = [];
    var errors = [];
    for (var j = 0; j < names.length; j++) {
        var n = names[j];
        if (typeof n !== 'string' || !n) { errors.push('Invalid name at index ' + j + '.'); continue; }
        var hit = byName[n];
        if (hit) {
            schemas.push({
                name: n,
                description: (hit.function && hit.function.description) || '',
                parameters: (hit.function && hit.function.parameters) || { type: 'object', properties: {} }
            });
        } else {
            var lower = n.toLowerCase();
            var close = Object.keys(byName).filter(function(k) {
                var kl = k.toLowerCase();
                return kl.indexOf(lower) !== -1 || lower.indexOf(kl) !== -1;
            });
            errors.push('Unknown or unavailable tool "' + n + '".'
                + (close.length ? ' Close matches: ' + close.join(', ') + '.' : '')
                + ' Check the tool catalog in the system prompt for the available tools.');
        }
    }
    var result = { success: errors.length === 0, schemas: schemas };
    if (errors.length > 0) result.error = errors.join(' ');
    if (schemas.length > 0) {
        result.note = 'These schemas are now part of the conversation history — CALL THE TOOL(S) NATIVELY as top-level tool calls with these parameters. No loading or registration step is needed. If a native call fails validation, fix the arguments and retry natively.';
    }
    return result;
}

// Lightweight argument validation for NATIVE calls to deferred tools
// (required params present + primitive type check). Returns null when OK,
// else { error, schema } — the executeTool caller returns the FULL schema
// in the failure so the model self-corrects from the tool_result without a
// get_tool_schema round-trip. Deliberately shallow: no nested/enum/format
// checks — the executor + provider remain the real validators.
// LENIENT COERCION: some providers/harnesses stringify scalar args (e.g.
// start_line: "200"). On a type mismatch we first try to coerce the string
// to the declared type and MUTATE the args object in place so downstream
// execution receives the proper type — only impossible coercions error.
// `options.chatId` (optional) pins the enabled-tools resolution to the
// caller's chat — preferred over the global fallback, which can point at a
// different chat when several agents run concurrently.
function validateArgsAgainstToolSchema(name, args, options) {
    try {
        // FAIL CLOSED: resolve the definition ONLY from the same enabled/
        // filtered list executeGetToolSchema uses — never raw TOOLS or the
        // skillTools registry, which would echo schema text of permission-
        // disabled / roster-excluded tools into the validation error
        // payload. If the enabled list can't be resolved, skip validation
        // (return null) and let normal dispatch continue.
        if (typeof getEnabledTools !== 'function') return null;
        var chatId = (options && options.chatId)
            || (typeof activeStreamingChatId !== 'undefined' ? activeStreamingChatId : null)
            || (typeof currentChatId !== 'undefined' ? currentChatId : null);
        var enabled = getEnabledTools(chatId, { includeDeferred: true });
        var def = null;
        for (var i = 0; i < enabled.length; i++) {
            var t = enabled[i];
            if (t && t.function && t.function.name === name) { def = t.function; break; }
        }
        if (!def || !def.parameters || typeof def.parameters !== 'object') return null;
        var params = def.parameters;
        var a = (args && typeof args === 'object') ? args : {};
        var problems = [];
        var required = Array.isArray(params.required) ? params.required : [];
        for (var r = 0; r < required.length; r++) {
            if (a[required[r]] === undefined || a[required[r]] === null) {
                problems.push('Missing required parameter "' + required[r] + '".');
            }
        }
        var props = (params.properties && typeof params.properties === 'object') ? params.properties : {};
        Object.keys(a).forEach(function(k) {
            var p = props[k];
            if (!p || !p.type || typeof p.type !== 'string') return;
            var v = a[k];
            if (v === undefined || v === null) return;
            var actual = Array.isArray(v) ? 'array' : typeof v;
            var expected = (p.type === 'integer') ? 'number' : p.type;
            if (expected === 'array' || expected === 'object' || expected === 'string'
                || expected === 'number' || expected === 'boolean') {
                if (actual !== expected) {
                    // Try lenient coercion of stringified values before failing.
                    // Successful coercions write back into `a` (=== args) so
                    // the executor sees the properly typed value.
                    if (actual === 'string') {
                        var s = v.trim();
                        if (expected === 'number' && s !== '') {
                            var num = Number(s);
                            if (isFinite(num) && (p.type !== 'integer' || num % 1 === 0)) {
                                a[k] = num;
                                return;
                            }
                        } else if (expected === 'boolean') {
                            var lc = s.toLowerCase();
                            if (lc === 'true' || lc === 'false') {
                                a[k] = (lc === 'true');
                                return;
                            }
                        } else if (expected === 'array' || expected === 'object') {
                            try {
                                var parsed = JSON.parse(s);
                                var parsedActual = Array.isArray(parsed)
                                    ? 'array'
                                    : (parsed !== null ? typeof parsed : 'null');
                                if (parsedActual === expected) {
                                    a[k] = parsed;
                                    return;
                                }
                            } catch (coerceErr) { /* fall through to error */ }
                        }
                    }
                    problems.push('Parameter "' + k + '" should be ' + p.type + ' but got ' + actual + '.');
                }
            }
        });
        if (problems.length === 0) return null;
        return {
            error: problems.join(' '),
            schema: {
                name: name,
                description: def.description || '',
                parameters: params
            }
        };
    } catch (e) {
        return null;
    }
}
