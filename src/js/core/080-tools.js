// Default token limits (overridden by provider-specific settings)
var MAX_TOKENS = 16000;
var THINKING_BUDGET = 10000;

var TOOLS = [
    {
        type: 'function',
        function: {
            name: 'js_eval',
            description: 'Execute JavaScript in an isolated sandbox. Preferred for chaining several tool calls in one step (fewer API round-trips): call tools sequentially, process intermediate results, return a summary.\n\n- Call tools via `await executeTool(name, args)`; each returns its full result object. Always return the key metadata from chained calls (widget IDs, screenshot IDs, sys_ids) so you can reference it later.\n- No access to page globals or sessionToken.\n- Waiting/polling: `await sleep(ms)` (alias `delay`) is service-worker-backed and unthrottled. Raw setTimeout chains here are throttled by Chrome to 1/minute; delays >= 1000ms are auto-rerouted through sleep, but call sleep directly.\n- Widgets: fetch/prepare all data here FIRST and embed it in the widget HTML; use executeTool inside the widget only for live data. Example:\nvar data = await executeTool("servicenow_api", {method:"GET", table:"incident", limit:5});\nvar rows = data.data.result.map(function(i){return "<tr><td>"+i.number+"</td><td>"+i.short_description+"</td></tr>";}).join("");\nvar widget = await executeTool("html_widget", {title:"Incidents", html:"<table>"+rows+"</table>"});\nreturn {widgetId: widget.widgetId, count: data.data.result.length};\n- Images: base64 values are complete data URLs (usable directly as img.src). To have vision READ an image, return {_images: [{base64: ..., name: "page"}]}. To CREATE one, draw on a canvas (document.createElement("canvas")) and return canvas.toDataURL("image/png") the same way. take_screenshot (when available) returns {base64, width, height, screenshot_id}; fetch an earlier screenshot with executeTool("screenshot_by_id", {id: "ss_1_..."}).',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'JavaScript code to execute.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_api',
            description: 'Call the ServiceNow Table API: GET, POST, PUT, PATCH, DELETE on any table. Preferred for any read or write of ServiceNow records — including test data setup/teardown and backend verification — use it instead of driving the UI (iframe_tool, when available) whenever the Table API can do the job. Attachment upload: method "POST", table "attachment", plus attachment_data, attachment_file_name, attachment_table_name and attachment_table_sys_id.',
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                    table: { type: 'string', description: 'Table name, e.g. incident, sys_user. Use "attachment" to upload a file.' },
                    scope: { type: 'string', description: 'Application scope: "global" or a scoped app sys_id. Required for writes (POST/PUT/PATCH/DELETE); not needed for GET.' },
                    sys_id: { type: 'string', description: 'Record sys_id (single-record GET/PUT/PATCH/DELETE).' },
                    query: { type: 'string', description: 'Encoded query for filtering (GET).' },
                    fields: { type: 'string', description: 'Comma-separated fields to return.' },
                    limit: { type: 'number', description: 'Max records to return.' },
                    data: { type: 'object', description: 'Record data for POST/PUT/PATCH.' },
                    url_params: { type: 'object', description: 'Extra URL parameters, e.g. {"sysparm_display_value": "true", "sysparm_exclude_reference_link": "true"}.' },
                    attachment_data: { type: 'string', description: 'Attachment upload: base64 file content (data URL like "data:image/png;base64,..." or raw base64).' },
                    attachment_file_name: { type: 'string', description: 'Attachment upload: file name, e.g. "screenshot.png".' },
                    attachment_table_name: { type: 'string', description: 'Attachment upload: table of the target record, e.g. "incident".' },
                    attachment_table_sys_id: { type: 'string', description: 'Attachment upload: sys_id of the target record.' },
                    attachment_content_type: { type: 'string', description: 'Attachment upload: MIME type, e.g. "image/png". Auto-detected from the file name if omitted.' },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name (e.g. "dev12345") or URL. See list_instances.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['method', 'table', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_run_script',
            description: 'Execute a server-side JavaScript snippet on a ServiceNow instance. Runs synchronously, captures gs.print/gs.info output and returns it; each run is logged in sys_script_execution_history.\nUse ONLY for what the Table API genuinely cannot do: server-only globals (gs.*), GlideRecord-only APIs, transactions, system operations, or logic that must run server-side. It is not a replacement for multiple Table API calls — for "fetch N records, update each", chain servicenow_api calls in js_eval.\nRequires the admin role: it runs via /sys.scripts.do, which is admin-only, so the call fails for non-admin users. BEFORE calling, check the target instance\'s roles in list_instances (instances[].roles; reuse a result from earlier in this chat for the same instance). If `admin` is not listed, do NOT call this tool — use servicenow_api instead or tell the user admin is required. Enforced in code: the call is refused (success:false) unless the user has effective admin (direct or inherited) on the target instance. Empty roles = unknown (probe failed): verify with servicenow_api GET sys_user_has_role, query user=javascript:gs.getUserID()^role.name=admin.',
            parameters: {
                type: 'object',
                properties: {
                    script: { type: 'string', description: 'Server-side JavaScript. Use gs.print(...) or gs.info(...) for output.' },
                    scope: { type: 'string', description: 'Application scope to run in, e.g. "global" or "x_snc_myapp". Default: global.' },
                    record_for_rollback: { type: 'boolean', description: 'If true (default), records changes for rollback via sys_script_execution_history.' },
                    sandbox: { type: 'boolean', description: 'If true, runs in sandboxed mode (limits some operations). Default: false.' },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name. See list_instances.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations. Often appropriate for this tool.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['script', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'servicenow_diff_edit',
            description: 'Edit a ServiceNow record field with search-and-replace — no line numbers. Each edit is {find, replace}; edits apply in sequence and the call fails safely if a find is missing or not unique. find must match exactly, including whitespace (spaces, tabs, newlines); include 2-3 lines of context for uniqueness. Example: {"table": "sys_script_include", "sys_id": "abc123", "field": "script", "edits": [{"find": "function oldFunc() {\\n    return false;", "replace": "function newFunc() {\\n    return true;"}]}',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: 'Table name, e.g. sys_script_include, sys_ui_page.' },
                    sys_id: { type: 'string', description: 'Record sys_id.' },
                    field: { type: 'string', description: 'Field to edit, e.g. script, html, client_script.' },
                    edits: {
                        type: 'array',
                        description: 'Search-and-replace operations, applied in order.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find (unless replace_all or occurrence is set). Include a few lines of context.' },
                                replace: { type: 'string', description: 'Replacement text; empty string deletes the match.' },
                                replace_all: { type: 'boolean', description: 'Replace EVERY occurrence of find (skips the uniqueness check). Default false. Mutually exclusive with occurrence.' },
                                occurrence: { type: 'integer', description: 'Replace only the n-th occurrence (1-based) when find matches several times. Mutually exclusive with replace_all.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name (e.g. "dev12345") or URL. See list_instances.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['table', 'sys_id', 'field', 'edits', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'iframe_tool',
            description: 'Drive the instance UI in an iframe: navigate, interact with elements, extract visible text/DOM, debug pages, and debug/edit html_widgets (pass widget_id to target one). Use for UI rendering tests, exercising client scripts, and interactions with no API equivalent.\nUI IS A LAST RESORT: drive the UI ONLY when the UI itself is under test/inspection (a specific form, page, portal or workspace) or no API path exists — say why when you fall back to it. Do NOT use it to read or modify records that servicenow_api (Table API) can handle — the API is faster, more reliable and the preferred CRUD path. Never create prerequisite/test-setup records through forms (seed and verify via servicenow_api) unless that form is what is being tested.\nImpersonation: use action "impersonate" (it calls the impersonation REST API directly and reloads the frame) — never click through the UI impersonation menu/dialog; end with user:"stop". For work normally done by clicking a UI Action, read the UI Action source (sys_ui_action.script + condition) and replicate it via servicenow_api or servicenow_run_script instead of clicking — the UI is slower and more brittle.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['navigate', 'get_visible_text', 'get_dom', 'click', 'fill', 'type', 'wait_for', 'get_console_logs', 'get_network_requests', 'close', 'open_widget', 'edit_html', 'dispatch_event', 'select_option', 'scroll', 'resize', 'get_properties', 'set_style', 'impersonate', 'get_page_info'],
                        description: 'navigate (load url; not for widgets); get_visible_text (text content; use take_screenshot for images); get_dom (HTML); click; fill (one-shot; fires keydown→input→keyup→change so frameworks/client scripts see real input); type (per-character key events; slower but reliably triggers debounced/autocomplete handlers; supports delay, append); wait_for (block until selector_visible, selector_gone, text, or url_matches); get_console_logs; get_network_requests; close (close panel; not for widgets); open_widget (open a widget in the panel for debugging; needs widget_id); edit_html (find/replace on widget HTML; needs widget_id and edits); dispatch_event (needs selector and event); select_option (needs selector and value or text); scroll (to position/element/coordinates); resize (preset or width/height); get_properties (computed styles, dimensions, values, className/classList; a no-match returns success with match_count:0, not an error); set_style (apply CSS or toggle classes); impersonate (needs user; "stop" ends it; REST-based — never use the UI impersonation menu); get_page_info (URL, title, viewport size).'
                    },
                    url: { type: 'string', description: 'For navigate: URL path to load (not for widgets). Same-origin only.' },
                    wait: { type: 'boolean', description: 'For navigate: if true, waits up to 15s for the page (and any nested gsft_main iframe) to fully load before returning — useful before a screenshot or immediate interaction. Default: false.' },
                    selector: { type: 'string', description: 'CSS selector for click/fill/dispatch_event/select_option/scroll/get_properties/set_style. For click/fill, x+y coordinates may be given instead.' },
                    value: { type: 'string', description: 'Value to fill/type, or option value for select_option.' },
                    delay: { type: 'number', description: 'For type: ms between keystrokes. Default 30; 0 = fastest, 50-100 for stubborn debounced inputs.' },
                    append: { type: 'boolean', description: 'For type: if true, types after the existing value instead of clearing it. Default: false.' },
                    timeout: { type: 'number', description: 'For wait_for: max ms to wait. Default: 10000.' },
                    poll: { type: 'number', description: 'For wait_for: polling interval in ms. Default: 100.' },
                    selector_visible: { type: 'string', description: 'For wait_for: wait until this selector matches an element with non-zero size.' },
                    selector_gone: { type: 'string', description: 'For wait_for: wait until this selector no longer matches a visible element.' },
                    url_matches: { type: 'string', description: 'For wait_for: wait until window.location.href contains this substring.' },
                    event: { type: 'string', enum: ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'contextmenu', 'change', 'input', 'focus', 'blur', 'submit', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'keydown', 'keyup'], description: 'For dispatch_event: DOM event name. Mouse events (click/mousedown/mouseup/mousemove/dblclick/contextmenu/mouseenter/mouseleave/mouseover/mouseout) fire a real MouseEvent with button + viewport coordinates; a mousedown then mouseup pair reliably drives select2 / jQuery-UI widgets (open on mousedown, commit on mouseup).' },
                    key: { type: 'string', description: 'For dispatch_event keydown/keyup: key value, e.g. "Enter", "Escape", "Tab".' },
                    text: { type: 'string', description: 'For select_option: visible option text (alternative to value).' },
                    deep: { type: 'boolean', description: 'For get_visible_text: false (default) returns text only; true adds rect, selector, id, etc.' },
                    position: { type: 'string', enum: ['top', 'bottom'], description: 'For scroll: top or bottom of the page.' },
                    x: { type: 'number', description: 'scroll: horizontal position. click/fill: x coordinate of the target element (with y, instead of selector).' },
                    y: { type: 'number', description: 'scroll: vertical position. click/fill: y coordinate of the target element (with x, instead of selector).' },
                    behavior: { type: 'string', enum: ['smooth', 'instant'], description: 'For scroll: scroll behavior. Default: instant.' },
                    preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'fullhd'], description: 'For resize: mobile=375x812, tablet=768x1024, desktop=1440x900, fullhd=1920x1080.' },
                    width: { type: 'number', description: 'For resize: custom viewport width in pixels.' },
                    height: { type: 'number', description: 'For resize: custom viewport height in pixels.' },
                    max_length: { type: 'number', description: 'Max chars of get_dom output. Default 200000.' },
                    include: { type: 'array', items: { type: 'string', enum: ['rect', 'styles', 'value', 'attributes'] }, description: 'For get_properties: extra detail to include. Default: all. tagName, id, className, classList[], value, checked, disabled, visible and rect are ALWAYS returned — assert CSS classes via classList[] instead of scraping get_dom. A valid selector that matches nothing returns success:true, match_count:0, properties:null.' },
                    styles: { type: 'object', description: 'For set_style: CSS properties to set, e.g. {"display": "none", "color": "red"}.' },
                    className: { type: 'string', description: 'For set_style: "add:className", "remove:className", or "toggle:className".' },
                    expected_version: { type: 'integer', description: 'Required for edit_html: the saved widget version, read first via html_widget action=read.' },
                    operation_id: { type: 'string', description: 'Stable retry key for edit_html; reuse only with identical edits and expected_version.' },
                    widget_id: { type: 'string', description: 'Target an html_widget by ID. Required for open_widget and edit_html; optional for get_visible_text, get_dom, click, fill (targets the widget instead of the browser).' },
                    user: { type: 'string', description: 'For impersonate: username, display name, or sys_id; "stop" ends impersonation.' },
                    instance: { type: 'string', description: 'REQUIRED. Target ServiceNow instance by short name; for navigate, a tab on this instance is found/created/reused. See list_instances.' },
                    tab_id: { type: 'number', description: 'Optional Chrome tab id (from list_instances activeTabs[].id). navigate: navigates THAT tab, bypassing the safeguard against reusing a tab already in use. Other actions: pins this chat\'s subsequent browser actions to that tab. A non-existent id is an error.' },
                    edits: {
                        type: 'array',
                        description: 'For edit_html: find/replace operations on the widget HTML.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Text to find in the widget HTML. Must be unique (unless replace_all or occurrence is set).' },
                                replace: { type: 'string', description: 'Replacement text; empty string deletes the match.' },
                                replace_all: { type: 'boolean', description: 'Replace EVERY occurrence of find (skips the uniqueness check). Default false. Mutually exclusive with occurrence.' },
                                occurrence: { type: 'integer', description: 'Replace only the n-th occurrence (1-based) when find matches several times. Mutually exclusive with replace_all.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations. Instance-modifying actions: click, fill, impersonate, dispatch_event, select_option.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action', 'instance']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_chat_title',
            description: 'Set the chat title (concise, summarizing what was accomplished). Do NOT call it on your own while working — an after-response hook requests it (with set_tldr / set_links) once your final answer is done. Call it earlier only if the user asks to rename the chat.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Concise title (max 60 chars) summarizing the main task or outcome.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_tldr',
            description: 'Set the TL;DR summary card for your final answer. Do NOT call it on your own — wait for the after-response hook to request it.',
            parameters: {
                type: 'object',
                properties: {
                    tldr: { type: 'string', description: '1-2 short sentences (max 280 chars) summarizing the outcome.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['tldr']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_links',
            description: 'Surface relevant titled links for this conversation (e.g. a PR, a diff, a ServiceNow record, a docs page). Do NOT call it on your own — wait for the after-response hook to request it. Include only genuinely useful links; pass an empty array if there are none.',
            parameters: {
                type: 'object',
                properties: {
                    links: {
                        type: 'array',
                        description: 'Links to surface, most relevant first; each {title, url}.',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', description: 'Short, descriptive link text (what the user clicks).' },
                                url: { type: 'string', description: 'Absolute http(s) URL, or a ServiceNow record/instance URL.' }
                            },
                            required: ['title', 'url']
                        }
                    },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['links']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_caveat',
            description: 'Flag one must-read caveat about your final answer, shown as an amber warning card next to the TL;DR. Do NOT call it on your own — the after-response hook asks for it. Call it ONLY when the user must not miss something: you deviated from the plan or their instructions, made an assumption that needs double-checking, left work partly incomplete, or ended with a question/requested action they might overlook. Do NOT flag routine always-visible follow-ups (e.g. "the extension needs a reload", "the PR is not merged yet"). If nothing qualifies, do not call it.',
            parameters: {
                type: 'object',
                properties: {
                    caveat: { type: 'string', description: 'Short must-read warning (1-2 sentences, max ~300 chars): the deviation, unverified assumption, incomplete work, or trailing question/requested action.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['caveat']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_outline',
            description: 'View the structural outline of a large cached tool result (results over ~4k tokens are cached and replaced by an outline). Explore at different detail levels or focus on a path.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'Cached content ID (from _cached.content_id in the tool result).' },
                    detail_level: { type: 'number', description: '1=minimal, 3=medium (default), 5+=detailed. Affects depth and array sample count.' },
                    path: { type: 'string', description: 'JSON path to focus on, e.g. "result.data" or "items[0].details". Omit for root.' },
                    array_offset: { type: 'number', description: 'Array pagination: skip the first N items (default 0). Use when a result shows "_more" items.' },
                    array_limit: { type: 'number', description: 'Array pagination: max items to show (default depends on detail_level). Rejected if the result exceeds ~16KB.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['content_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_search',
            description: 'Regex-search all string values of a large cached tool result; returns matches with surrounding context lines.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'Cached content ID (from _cached.content_id in the tool result).' },
                    query: { type: 'string', description: 'Regex pattern, e.g. "function\\\\s+\\\\w+", "error|warning", or "(?i)todo" for case-insensitive.' },
                    path: { type: 'string', description: 'JSON path to limit the search (e.g. "result.script"). Omit to search all fields.' },
                    offset: { type: 'number', description: 'Skip the first N matches (default 0) — page on when the previous search hit max_matches or the size limit.' },
                    max_matches: { type: 'number', description: 'Max matches per page (default 20).' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['content_id', 'query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cached_content_read',
            description: 'Read part of a large cached tool result: a JSON path, optionally a line range of a string/code field. Each read is capped at ~16KB — for big strings use start_line/end_line; if a read is rejected, narrow the range or search first.',
            parameters: {
                type: 'object',
                properties: {
                    content_id: { type: 'string', description: 'Cached content ID (from _cached.content_id in the tool result).' },
                    path: { type: 'string', description: 'JSON path, e.g. "result.script" or "items[0]". Omit for root.' },
                    start_line: { type: 'number', description: 'For strings: first line (1-indexed). Default: 1.' },
                    end_line: { type: 'number', description: 'For strings: last line. Default: start_line + 99.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['content_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_skill',
            description: 'Retrieve an AI skill: action "get" returns SKILL.md content and lists its files; "read_file" reads one file. Before starting any task, check whether a relevant skill exists and read it first — skills hold best practices, patterns and learnings.',
            parameters: {
                type: 'object',
                properties: {
                    skill_id: { type: 'string', description: 'Skill ID (from the ACTIVE SKILLS list).' },
                    action: { type: 'string', enum: ['get', 'read_file'], description: 'Default: "get".' },
                    filename: { type: 'string', description: 'File to read (required for read_file).' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['skill_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'manage_skill',
            description: 'Create, update or manage AI skills and their files (custom tool JS files, content MD/XML). action="edit" does search-and-replace on the skill body or a named file (same shape as servicenow_diff_edit / workspace edit / document edit).\n⚠️ This mutates ONLY the live runtime copy of a skill. When doing extension development from the cloned AppAgent repo (extension-dev active with a deploy folder connected, i.e. Reload rebuilds from the workspace — including "improve/test/edit the <name> skill" tasks), the source lives at skills/<name>/: edit it with the workspace tool and have the user click Reload. manage_skill edits in that mode are EPHEMERAL (overwritten by the next build/reload). Use manage_skill only when NOT working from the cloned repo.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'update', 'edit', 'add_file', 'update_file', 'delete_file', 'activate', 'deactivate', 'delete'], description: 'Action to perform. "delete" permanently removes the whole skill and cascades to all its files/assets — destructive, confirm recommended.' },
                    skill_id: { type: 'string', description: 'Skill ID (required for all actions except create).' },
                    name: { type: 'string', description: 'Skill name, lowercase-with-hyphens (create/update).' },
                    description: { type: 'string', description: 'Brief description of what the skill does (create/update).' },
                    body: { type: 'string', description: 'Skill instructions in markdown (create/update).' },
                    actions: {
                        type: 'array',
                        description: 'Optional Action buttons that surface this skill in the UI (create/update); each is a one-click button running the skill in a background chat. Pass [] to clear on update; omit to leave unchanged.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Action label, max 48 chars. The skill body should contain a matching "## Action Lifecycle: <name>" section with the steps to run.' },
                                icon: { type: 'string', description: 'One of: search, shield, eye, play, check, close, spinner, lock, pause, stop, bell, code, database, stats, zap, alert, list, clipboard, rocket, bug, browser, clock, skill, tool, widget, api, download, upload, refresh, edit, trash. Default: play.' },
                                show: {
                                    type: 'array',
                                    description: 'Where the button renders: one or more of home (home view), chat (above chat input), sidebar (left rail). Default: ["home"]. The top bar is reserved for live (running / not-yet-dismissed) actions and filled automatically — it cannot be configured.',
                                    items: { type: 'string', enum: ['home', 'chat', 'sidebar'] }
                                }
                            },
                            required: ['name']
                        }
                    },
                    filename: { type: 'string', description: 'File name for file operations, e.g. "tool.js", "config.xml".' },
                    file_content: { type: 'string', description: 'File content for add_file/update_file. JS tools run in an isolated sandbox with only executeTool access; format: var TOOL_DEFINITION = { type: "function", function: { name: "tool_name", description: "...", parameters: {...} } };\nasync function tool_name(args) { await executeTool("servicenow_api", {...}); return {...}; }' },
                    edits: {
                        type: 'array',
                        description: 'For action="edit": search-and-replace operations applied in order to the skill body, or to the file named by filename. Each find must occur exactly once; the call fails before mutating anything if a find is missing or non-unique. Add 2-3 lines of context to disambiguate.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find in the target.' },
                                replace: { type: 'string', description: 'Replacement text; empty string deletes the match.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'widget_eval',
            description: 'Run an async JavaScript body inside one exact LIVE widget render — never a saved widget or offscreen clone; no implicit target or saved-id fallback. action:list discovers connected renders (IDs expire on rerender/close); action:eval needs instance_id and code. Returns {success, instance_id, result} or {success:false, error, code}.\n- Execution works only in identified top-level chats (including start_chat background chats); sub-agents may list but cannot execute, even with a full roster.\n- Existing widget tool permissions apply to callbacks; there is no per-callback agent provenance or cancellation guarantee.\n- Results must be JSON-compatible, max 65536 characters; undefined becomes null.\n- The timeout bounds waiting, NOT execution: a synchronous infinite loop can freeze the iframe and async side effects may continue.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'eval'] },
                    instance_id: { type: 'string', description: 'Exact live render ID from list or the start_chat origin context; required for eval.' },
                    code: { type: 'string', description: 'Async function body; return a JSON-compatible result. Runs in the widget sandbox, not the extension panel.' },
                    timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, description: 'Response timeout, default 10000ms. Does not cancel script execution.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'html_widget',
            description: 'Render an interactive HTML widget inline in chat, in an isolated iframe (own document; scripts, CSS and DOM fully isolated — handlers, forms, animations, API calls all work). Use ONLY when the user asked for a visualization/dashboard/interactive UI or the data is too large/structured for plain text; for short answers reply in text, and prefer display when a template fits.\n\nOne permanent widget per task:\n- Each save creates a DISTINCT widget or appends a version to an EXISTING widget_id. When iterating/fixing/regenerating, ALWAYS reuse widget_id; NEVER create a second widget for the same task.\n- Edit flow: action=read (latest_version + HTML), then save with expected_version and a stable operation_id (reuse it only to retry identical content).\n- Omitted widget_id uses the explicit widget-edit target of the current user request only; later ordinary user turns do not inherit it. create_new=true deliberately creates an unrelated artifact.\n- action=list finds all saved widgets, even after unpin or chat deletion. Selecting history is per-view and never overwrites latest.\n\nInside the widget:\n- No session token (no window.sessionToken, no X-UserToken shim): ServiceNow requests MUST go through agent tools via await executeTool(name, args), e.g. executeTool("servicenow_api", {method:"GET", table:"incident", limit:5}).\n- Embed an earlier screenshot: executeTool("screenshot_by_id", {id: screenshotId}).then(function(r){ img.src = r.base64; }).\n- "Ask the agent" button: await executeTool("start_chat", {message: "...", mode: "send"|"draft", include_widget: true}) — include_widget references THIS widget, "draft" only prefills the composer, background:true keeps the widget on screen.\n- App design tokens (colors, spacing, radii, fonts) are auto-injected and follow the light/dark theme live: var(--bg-main), var(--text-primary), var(--primary), var(--space-8), var(--radius-md); full table in the widget-best-practices skill.\n\nReturns a widgetId, usable for debugging with iframe_tool (get_visible_text, get_dom, click, fill) or take_screenshot when those are available.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['save', 'read', 'list'], description: 'Default save. read returns HTML and version history; list discovers saved widgets.' },
                    widget_id: { type: 'string', description: 'EXISTING permanent ID to revise/read. Reuse it for every iteration.' },
                    expected_version: { type: 'integer', description: 'Required for updates: the version read before editing. A stale version returns VERSION_CONFLICT without writing.' },
                    operation_id: { type: 'string', description: 'Stable unique operation key; reuse only for an identical retry. Required for reliable sandbox/js_eval retries.' },
                    create_new: { type: 'boolean', description: 'Explicitly create a distinct artifact instead of using the widget edit target. Never use for iteration.' },
                    version: { type: 'integer', description: 'Read a historical version; omitted = latest.' },
                    title: { type: 'string', description: 'Widget title (shown in header and sidebar).' },
                    html: { type: 'string', description: 'Complete HTML document: <style> for CSS, <script> for JS. Scripts call agent tools via executeTool(name, args), e.g. await executeTool("servicenow_api", {method:"GET", table:"incident", ...}).' },
                    height: { type: 'string', description: 'Initial height, e.g. "400px", "auto". Default: "400px".' },
                    width: { type: 'string', description: 'Width, e.g. "400px", "500px". Default: "400px".' },
                    pin: { type: 'string', enum: ['main', 'home'], description: 'Optionally pin at creation: "home" (home page, above Active chats) or "main" (dashboard page). Omit to keep it inline in chat only.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations. Relevant for widgets that modify instance data; display-only widgets need none.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'pin_widget',
            description: 'Pin, move, or unpin an EXISTING html_widget on a dashboard: "main" (dashboard page), "home" (home page, above Active chats), or "none" (unpin).',
            parameters: {
                type: 'object',
                properties: {
                    widget_id: { type: 'string', description: 'Widget id returned by html_widget (id/widgetId).' },
                    dashboard: { type: 'string', enum: ['main', 'home', 'none'], description: 'Target: \'main\' (dashboard page), \'home\' (home page), or \'none\' to unpin.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['widget_id', 'dashboard']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'take_screenshot',
            description: 'Capture a real PNG screenshot and send it to the vision model, to SEE what is actually rendered — UI elements, layouts, colors, charts, errors. Best for debugging visual issues, verifying UI changes, and analyzing widgets or page layouts. Returns a screenshot_id for later retrieval with screenshot_by_id (e.g. to embed in a widget or process in js_eval).',
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        enum: ['browser', 'widget', 'element'],
                        description: '"browser" (iframe panel content), "widget" (an html_widget by ID), or "element" (a DOM element by selector).'
                    },
                    widget_id: { type: 'string', description: 'For target="widget": the widget ID.' },
                    selector: { type: 'string', description: 'For target="element": CSS selector of the element.' },
                    max_width: { type: 'number', description: 'Max width in px, for token efficiency. Default 1568 (Anthropic vision long-edge limit). Captured at native device resolution and downscaled with high-quality resampling so text stays sharp; height may reach 2x this value; width is never scaled below 1024px.' },
                    grid: { type: 'boolean', description: 'If true, overlays a labeled coordinate grid — to find x,y for click/fill when CSS selectors are hard to determine. Default: false.' },
                    name: { type: 'string', description: 'Short name, max 3-4 words (e.g. "Users list", "Form error", "Dashboard"); used for display and download.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['target', 'name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'screenshot_by_id',
            description: 'Retrieve a previously taken screenshot by its ID: returns the base64 data URL, dimensions and name. Also callable as executeTool("screenshot_by_id", {id}) from widgets (to embed/display it) and js_eval (to process or send the image).',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Screenshot ID returned by take_screenshot.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_file',
            description: 'Retrieve any file by its file_id — screenshots, user attachments (images, PDFs, text), fetched files, smart documents. Returns content, metadata and a download URL. To view/analyze an image or PDF yourself, use attach=true, not download.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The file_id (from take_screenshot, read_attached_file, web_fetch with save_file, document, etc.).' },
                    download: { type: 'boolean', description: 'Return only metadata and a download button for the user; you do not see the file.' },
                    attach: { type: 'boolean', description: 'Attach the file to the conversation so you can see/analyze it (images and PDFs).' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'display',
            description: 'Render structured data with a predefined template as a consistent, interactive inline widget. Preferred over html_widget whenever the data fits a template — polished UI without writing HTML.\n\nTemplates:\n- table: sortable, filterable. Args: columns (string[]), rows (object[] or array[]).\n- card_list: grid of expandable cards. Args: cards ({title, subtitle?, icon?, badge?, badge_color?, detail?}[]).\n- checklist: checkable items. Args: items (string[] or {label, description?, checked?}[]).\n- status_summary: metric cards with counts. Args: items ({label, count, icon?, color?}[]).\n- code: syntax-highlighted block with line numbers and copy. Args: code (string), language? (string).\n- timeline: ordered events. Args: events ({title, time?, detail?, color?}[]).\n- chart: bar or pie. Args: chart_type ("bar"|"pie"), data ({label, value}[]) OR labels (string[]) + values (number[]).\n- diff: code diff view. Args: changes (string[] with +/- prefixes, or {type,text}[]) OR old_text + new_text. Optional: file/header (string).',
            parameters: {
                type: 'object',
                properties: {
                    template: { type: 'string', enum: ['table', 'card_list', 'checklist', 'status_summary', 'code', 'timeline', 'chart', 'diff'], description: 'Display template to use.' },
                    title: { type: 'string', description: 'Title (shown in header).' },
                    columns: { type: 'array', items: { type: 'string' }, description: 'table: column headers.' },
                    rows: { type: 'array', items: {}, description: 'table: row objects or arrays.' },
                    cards: { type: 'array', items: { type: 'object' }, description: 'card_list: card objects {title, subtitle, icon, badge, badge_color, detail}.' },
                    items: { type: 'array', items: {}, description: 'checklist: items. status_summary: {label, count, icon, color} objects.' },
                    code: { type: 'string', description: 'code: the source code string.' },
                    language: { type: 'string', description: 'code: programming language name.' },
                    events: { type: 'array', items: { type: 'object' }, description: 'timeline: {title, time, detail, color} objects.' },
                    chart_type: { type: 'string', enum: ['bar', 'pie'], description: 'chart: chart type.' },
                    data: { type: 'array', items: { type: 'object' }, description: 'chart: {label, value} objects.' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'chart: label strings (alternative to data).' },
                    values: { type: 'array', items: { type: 'number' }, description: 'chart: numeric values (alternative to data).' },
                    changes: { type: 'array', items: {}, description: 'diff: diff lines ("+added", "-removed", or "context").' },
                    old_text: { type: 'string', description: 'diff: original text.' },
                    new_text: { type: 'string', description: 'diff: modified text.' },
                    file: { type: 'string', description: 'diff: filename header.' },
                    width: { type: 'string', description: 'Widget width. Default: "100%".' },
                    height: { type: 'string', description: 'Widget height. Default: "auto".' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['template']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_action_state',
            description: 'Maintain a live progress card (state + todo list): an action button in background chats, a sidebar timeline in foreground chats.\n\nWHEN TO CALL (don\'t wait to be asked):\n- Background Action chat (user message starts with "Run action: <name>"): ALWAYS, on the very first response — the PM only sees the button, not the transcript.\n- Any chat, background or foreground, as soon as ANY is true: (a) you expect 3+ tool calls before your final reply; (b) the request has 2+ named phases (e.g. implement → test → push, audit → fix → verify, build → embed → walkthrough); (c) the work spans multiple turns toward one goal; (d) you would naturally write a numbered plan.\n- Already partway through a multi-phase task without a card? You missed the trigger — create it now and backfill completed steps as done tasks.\n\nAfter that, update on every new step, task change, or result, and switch to a terminal state as soon as the work succeeds. Always pass the FULL tasks array (not a delta); on done/error always include output.',
            parameters: {
                type: 'object',
                properties: {
                    state: { type: 'string', enum: ['running', 'waiting', 'stuck', 'done', 'error', 'finished', 'pr_opened', 'finished_with_caveat'], description: 'running = working; waiting = idle until dispatched sub-agents report back (non-terminal); stuck = blocked / needs user attention; done = success; error = failed. Terminal success variants (treated like done): finished = fully completed; pr_opened = completed and a PR was opened/pushed; finished_with_caveat = completed with a caveat flagged (pair with set_caveat). Terminal SUCCESS states are REJECTED (the error lists them) while this chat still has running sub-agents — use waiting/running until they report, or stop them first; error is always accepted.' },
                    icon: { type: 'string', enum: ['search','shield','eye','play','check','close','spinner','lock','pause','stop','bell','code','database','stats','zap','alert','list','clipboard','rocket','bug'], description: 'Icon shown on the action button.' },
                    label: { type: 'string', description: 'Sticky card/button text (<= 60 chars). Distinct from status_message, which narrates this one call in the transcript.' },
                    tasks: {
                        type: 'array',
                        description: 'Live todo list (progress card / button hover). Pass the SAME full array every time — each call replaces the previous one.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'Task label.' },
                                status: { type: 'string', enum: ['pending', 'running', 'done', 'error'], description: 'Task status.' }
                            },
                            required: ['label', 'status']
                        }
                    },
                    output: { type: 'string', description: 'Markdown headline summary shown on done/error (progress card / button click): summaries, links, key numbers. Keep short — full details belong in the transcript.' },
                    auto_dismiss_ms: { type: 'number', description: 'Action chats only: auto-dismiss the done/error button after N ms, for short confirmations that need no review (e.g. 3000). 0/omit = the user dismisses it. No effect in foreground chats.' },
                    status_message: { type: 'string', description: 'REQUIRED. Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['state', 'icon', 'label', 'status_message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'show_action_button',
            description: 'Render a one-click Action button inline in chat that runs a specific skill action in a background chat (the PM keeps their place), with context from this conversation passed via `context`.',
            parameters: {
                type: 'object',
                properties: {
                    skill: { type: 'string', description: 'Skill id that owns the action (e.g. "instance-audit").' },
                    action: { type: 'string', description: 'Action name exactly as declared in the skill (e.g. "Quick Audit").' },
                    label: { type: 'string', description: 'Optional button label. Defaults to the action name.' },
                    context: { type: 'string', description: 'Extra context injected into the synthetic "Run action: <name>" user message — pre-fill parameters or narrow the scope (e.g. "Audit this record: incident sys_id abc123").' },
                    status_message: { type: 'string', description: 'REQUIRED. Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['skill', 'action', 'status_message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'prompt_user',
            description: 'Show an inline form to collect structured input from the user. BLOCKING — the agent waits until the user submits or cancels. Preferred when you need structured input (specific parameters before proceeding, e.g. export format, which specs, date range) or plan confirmation; not for casual one-line offers in chat. Build the form from context — options should come from the instance or conversation, not be hardcoded.\n\nField types: text, textarea, select, multi-select, date, boolean, number. Modes: empty (you need info), prefilled (confirming "here\'s what I understood"), partially filled (you know some, need the rest).\n\nPLAN CONFIRMATION: before a long or risky sequence of WRITE operations (building apps/dashboards, bulk or multi-record changes), present the plan here and get approval — do not execute it silently. Read-only or exploratory work needs no plan confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Form title (header).' },
                    description: { type: 'string', description: 'Optional text below the title. Rendered as MARKDOWN (paragraphs, bold, lists, inline/fenced code, links) — write markdown.' },
                    fields: {
                        type: 'array',
                        description: 'Form fields.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Field name (key in the returned values).' },
                                type: { type: 'string', enum: ['text', 'textarea', 'select', 'multi-select', 'date', 'boolean', 'number'], description: 'Field type.' },
                                label: { type: 'string', description: 'Display label.' },
                                value: { description: 'Default/prefilled value.' },
                                options: { type: 'array', items: {}, description: 'select/multi-select: option strings or {value, label} objects.' },
                                widget: { type: 'string', enum: ['checkboxes'], description: 'multi-select: render as a vertical checkbox list instead of toggle chips (better for long labels).' },
                                required: { type: 'boolean', description: 'Whether the field is required.' },
                                placeholder: { type: 'string', description: 'Placeholder text.' }
                            },
                            required: ['name', 'type', 'label']
                        }
                    },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['fields']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch any URL; returns the raw response body (JSON APIs: JSON.parse(result.body)). HTML responses also include page_title, meta_description and extracted_text (script/style-stripped visible text) — read those instead of slicing raw HTML. For HTML pages, do NOT call this tool directly; fetch AND parse in one js_eval step so raw HTML never enters context:\nvar res = await executeTool("web_fetch", {url: "..."});\nvar doc = new DOMParser().parseFromString(res.body, "text/html");\nreturn { text: doc.body.innerText, title: doc.querySelector("title")?.textContent, links: [...doc.querySelectorAll("a[href]")].map(a => ({text: a.textContent.trim(), href: a.href})) };',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch.' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET.' },
                    headers: { type: 'object', description: 'Extra HTTP headers (key-value pairs).' },
                    body: { type: 'string', description: 'Request body (POST/PUT).' },
                    save_file: { type: 'boolean', description: 'If true, saves the response as a file and returns a file_id instead of the body — for binary content (images, PDFs, archives) or files to reference later, copy into a workspace, or offer as a download.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations. Note: web_fetch normally prompts on every call EXCEPT requests to the connected GitHub REST API base, which this flag governs — reads run silently; set confirm:true for writes such as merging a PR or posting a comment.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_cookie',
            description: 'Read browser cookies for a URL from the extension background (chrome.cookies), to make AUTHENTICATED fetches against cookie-gated sites from js_eval (its sandbox has a null origin and cannot read document.cookie or chrome.cookies). Typical pattern — some sites need the cookie value echoed in a request header:\nvar c = await executeTool("get_cookie", {url: "https://example.com", name: "session_id"});\nvar res = await executeTool("web_fetch", {url: "https://example.com/api/...", headers: {"x-session-token": c.cookies.session_id}});\nReturns { cookies: { name: value, ... } }; with neither name nor names, ALL cookies visible for the URL. Cookie values ARE session credentials — handle carefully and never echo them into chat output. Allowed by default (no prompt); the user can set it to Ask or Off in Settings > Tool permissions.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute URL including scheme (e.g. "https://example.com"). Visibility follows host + path, exactly like chrome.cookies.getAll({url}).' },
                    name: { type: 'string', description: 'Single cookie name (e.g. "session_id").' },
                    names: { type: 'array', items: { type: 'string' }, description: 'Multiple cookie names; combined with name if both are given.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_js_file',
            description: 'Load or run a workspace JavaScript file INSIDE the js_eval sandbox.\n- mode "module" (default): evaluates CommonJS-style and returns the exported value — a top-level `return X`, else module.exports, else a namespace of the file\'s top-level function/var declarations (works for browser-global src files); `args` is available to the file.\n- mode "script": the file body IS the js_eval code (may `return`, call executeTool/sleep).\n- mode "source": returns the raw text without executing.\nModule/script results must be JSON-serializable. Inside js_eval the same bridge is `await loadFile(path)` (source string) and `await runFile(path, args)` (exported value, evaluated in the calling sandbox so returned functions stay callable).\nCAVEAT (script mode): the body travels as js_eval code, so the js_eval Unicode-quote sanitizer rewrites curly quotes \u2018\u2019\u201c\u201d and backtick lookalikes to ASCII even inside string literals — use module mode (or loadFile) for files whose string contents must survive byte-for-byte.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/js/core/030-config.js" or "test/harness.js".' },
                    mode: { type: 'string', enum: ['module', 'script', 'source'], description: 'module (default) | script | source.' },
                    args: { type: 'object', description: 'Module mode: object passed to the file as `args`.' },
                    workspace: { type: 'string', description: 'Workspace key (owner/repo::branch). Default: the current/pinned workspace.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_tests',
            description: 'Run the workspace\'s test/*.test.js files (with test/harness.js) in a host-guarded, read-only js_eval sandbox. Top-level callers only — never from inside js_eval. Call after editing, and state the exact verification and any unsupported/skipped coverage in the PR.\n- Tests read source with loadFile/runFile (pinned workspace).\n- Forbidden during a run: every real mutation, INCLUDING scratch writes, cookies, nested js_eval/run_tests, and run_js_file module/script. allow_tools can grant only constrained safe actions, not legacy tool-name strings.\n- Layers: default tags unit, contract, canary. Contract and runtime layers are temporarily unsupported — explicitly skipped, never reported as live passes.\n- Fail-closed: host snapshots fail on missing/failed/capped reads; host denials cannot be erased by sandbox results; every timeout revokes authority and destroys the frame.\n- Returns: success, summary, per-file results, host isolation info, and denied_calls.\n- This is a tool boundary, NOT hostile-JavaScript isolation: direct JS network/fetch and the global sandbox CSP are unchanged.',
            parameters: {
                type: 'object',
                properties: {
                    files: { type: 'array', items: { type: 'string' }, description: 'Test files to run (workspace paths). Default: every test/*.test.js.' },
                    pattern: { type: 'string', description: 'Regex on file paths to narrow the selection, e.g. "harness|canary".' },
                    tags: { type: 'array', items: { type: 'string', enum: ['unit', 'contract', 'runtime', 'canary'] }, description: 'Test layers to run. Default: ["unit","contract","canary"].' },
                    timeout_ms: { type: 'number', description: 'Overall wall-clock cap for the run. Default 120000.' },
                    test_timeout_ms: { type: 'number', description: 'Per-test timeout. Default 30000. Any timeout aborts all remaining tests/files.' },
                    allow_tools: { type: 'array', description: 'Top-level opt-in safe actions only, e.g. [{name:"workspace", actions:["status"]}]. Legacy strings and mutation grants are rejected.', items: { type: 'object', properties: { name: { type: 'string', enum: ['workspace'] }, actions: { type: 'array', items: { type: 'string', enum: ['status', 'diff'] } } }, required: ['name', 'actions'], additionalProperties: false } },
                    workspace: { type: 'string', description: 'Workspace key (owner/repo::branch). Default: the current/pinned workspace.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'workspace',
            description: 'Work with GitHub repositories stored locally in IndexedDB: clone → browse/read/edit → push as a PR.\n\nActions:\n- clone: clone a repo (replaces an existing clone); fetches full tree + blobs.\n- list: all cloned workspaces (branches, dirty counts, pinned/forked_from) plus a lean PR summary {number, title, state, url, branch, merged_at?}: all open PRs, merged PRs capped to the 3 most recent (merged_prs_omitted counts the rest).\n- ls / read (offset/limit for large files) / write / copy (path → dest) / delete.\n- edit: search-and-replace; each find must be unique (same shape as servicenow_diff_edit).\n- grep: regex search; 5 matches by default, pass limit (max 100) for more.\n- status: dirty_files with per-file ownership + pushed_pr, the same lean prs summary as list, and a pin_notice when a sibling workspace holds the pin; include_prs:\'full\' returns every stored PR entry with files[].\n- diff: diffs of modified files.\n- push: commit dirty files to a PR — see branch_name / files. Returns pr_reused, a per-file files list with ownership fields (who edited each file, prior pushed_pr), and prominent cross_chat_warnings when a committed file belonged to ANOTHER chat or was already pushed to a DIFFERENT PR. Each commit contains the full current changes against the base; files stay modified locally on the base branch.\n- discard: reset a file (or all files if no path) to the cloned content; new files are removed, deleted files restored.\n- pin: pin a workspace ({unpin:true} clears). At most ONE pin per owner/repo (pinning clears sibling pins). The pin wins default-workspace resolution (over most-recently-used) and extension_build auto-detect, so Reload builds it.\n- branch: LOCAL fork into owner/repo::<branch> (cheap copy; see move_dirty). The remote branch is created on the first push from the fork, cut from the fork base. The fork is pinned automatically. Only for deliberately starting a SEPARATE line of work — never to append to an existing PR.\n- move: move dirty edits to another workspace (to, optional files; content written against the target\'s own base, then the source is discarded). A target file that is itself dirty with different content blocks the WHOLE move unless force; differing bases are reported in base_diverged.\n- hydrate: bulk-prefetch lazy-clone contents (optional path prefix); read/grep/edit hydrate on demand, so use it only before many reads.\n\nMerge lifecycle: when a workspace\'s branch is the head of a MERGED PR and its base is cloned locally, sync auto-deletes the workspace — dirty files move to the base first (a blocked move keeps the workspace, with a warning), the base is synced, and the pin follows onto the base if the deleted workspace held it.\n\nCross-chat safety: mutations (write/edit/delete/copy/discard) are stamped with the chat id. If a *currently running* chat has uncommitted changes on the same file, a mutation from another chat fails with cross_chat_conflict; if the other chat is dormant/closed it proceeds with a cross_chat_warning. On a conflict: if the file is one you already pushed to YOUR PR, or the other chat is dormant/closed, pass force:true (and files:[...] on push) and keep pushing to the same branch_name from the current workspace. Forking with branch is a LAST resort and needs a NEW branch name that is not an existing PR head; files hard-locked by other chats stay in the source (listed in left_behind). Gitignored paths (dist/, .env, ...) are exempt from the lock. Ownership stamps are released after a successful push. read/status include ownership metadata; ls/grep/diff flag files with uncommitted changes owned by another chat.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['clone', 'list', 'ls', 'read', 'write', 'edit', 'copy', 'delete', 'grep', 'status', 'diff', 'push', 'discard', 'pin', 'branch', 'move', 'hydrate'],
                        description: 'Action to perform.'
                    },
                    repo: { type: 'string', description: 'Repository as "owner/repo" (clone).' },
                    workspace: { type: 'string', description: 'Workspace identifier (owner/repo::branch). Default: the current workspace. Never point it at a PR head branch to append to that PR (see branch_name).' },
                    branch: { type: 'string', description: 'clone: branch to clone. branch action: the NEW local branch to fork to (never an existing PR head). Ignored by push — use branch_name.' },
                    to: { type: 'string', description: 'For move: target workspace key (owner/repo::branch).' },
                    unpin: { type: 'boolean', description: 'For pin: true clears the pin on the given workspace. Default: false.' },
                    move_dirty: { type: 'boolean', description: 'For branch: true (default) moves dirty edits to the fork and reverts the source clean; false copies them to both.' },
                    path: { type: 'string', description: 'File or directory path (ls, read, write, edit, diff; hydrate prefix).' },
                    content: { type: 'string', description: 'File content (write). Not needed if file_id is given.' },
                    file_id: { type: 'string', description: 'For write: copy a file-store file (screenshot, attachment, fetched file) into the workspace instead of passing content.' },
                    dest: { type: 'string', description: 'Destination path (copy).' },
                    offset: { type: 'number', description: 'Start line for read (1-indexed). Default: 1.' },
                    limit: { type: 'number', description: 'read: max lines (default all). grep: max matches (default 5, max 100).' },
                    edits: {
                        type: 'array',
                        description: 'For edit: search-and-replace operations. Each find must be unique in the file.',
                        items: {
                            type: 'object',
                            properties: {
                                find: { type: 'string', description: 'Unique text to find (unless replace_all or occurrence is set).' },
                                replace: { type: 'string', description: 'Replacement text.' },
                                replace_all: { type: 'boolean', description: 'Replace EVERY occurrence of find (skips the uniqueness check). Default false. Mutually exclusive with occurrence.' },
                                occurrence: { type: 'integer', description: 'Replace only the n-th occurrence (1-based) when find matches several times. Mutually exclusive with replace_all.' }
                            },
                            required: ['find', 'replace']
                        }
                    },
                    pattern: { type: 'string', description: 'Regex pattern (grep).' },
                    files: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'push: commit ONLY these dirty paths — other dirty files stay local and out of the PR (keeps other chats\' work out). move: only these dirty paths. Omit for all dirty files.'
                    },
                    branch_name: { type: 'string', description: 'Push target branch. If it does not exist, a new branch + PR are opened against the base you worked from. If it exists (a previous push), the commit is appended and the open PR reused (title refreshed; body updated only when pr_body is non-empty); pr_reused:true confirms. To APPEND to your PR, run push again FROM THE SAME WORKSPACE you are on (e.g. owner/repo::main) with the SAME branch_name — the workspace never switches branch. Do NOT clone the PR branch, use the branch action, or pass workspace: owner/repo::<pr-branch> (that creates a needless fork, moves the pin and scrambles local branches).' },
                    commit_message: { type: 'string', description: 'Commit message (push).' },
                    pr_title: { type: 'string', description: 'Pull request title (push).' },
                    pr_body: { type: 'string', description: 'Pull request body (push), GitHub markdown. Use real newlines in the string, not backslash-n escapes.' },
                    base_branch: { type: 'string', description: 'Base branch for the PR (push). Omit — it auto-defaults to the source/cloned branch, which is almost always correct.' },
                    include_git_ignored: { type: 'boolean', description: 'If true, includes gitignored files (e.g. dist/) in ls, grep, status, diff. Default: false.' },
                    include_prs: { type: 'string', enum: ['lean', 'full'], description: 'For status: \'lean\' (default) = {number,title,state,url,branch,merged_at?} per PR, merged capped to the 3 most recent; \'full\' = every stored PR entry with files[] (large).' },
                    ignore_case: { type: 'boolean', description: 'For grep: case-insensitive (default true; a leading (?i) is also accepted and stripped). false = case-sensitive.' },
                    force: { type: 'boolean', description: 'Mutations (write, edit, delete, copy, discard): override the cross-chat conflict block and clobber another chat\'s uncommitted changes — only when intentionally taking over the file. grep: bypass the slow-hydration guard (a grep whose lazy-clone fetch is estimated > 60s is refused with a scope_breakdown; prefer narrowing path). Default: false.' },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_attached_file',
            description: 'Read a text file (CSV, etc.) the user attached to this conversation. Large content is cached and searchable.',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: 'Attached file name, as shown in the attachment message.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['filename']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'document',
            description: 'Create and manage Smart Documents: persistent, versioned markdown that renders inline in chat (every reference shows the latest version), with embedded display templates and non-blocking user prompts. The user can edit documents inline — read to see their changes.\n\nVisibility (fixed at creation): scope \'shared\' (default, global) or \'chat\' (private). A \'chat\' doc is your scratchpad and is also shared between a sub-agent and its parent without crowding the shared list.\n\nActions: create (title, content, scope?, prompts?); update (doc_id, content?, title?, prompts? — new version); edit (doc_id, edits [{find, replace}], each find unique — new version); read (current version + prompt responses); list; list_versions (doc_id); read_version (doc_id, version); delete (doc_id).\nEmbed a template: call display first and include its placeholder in content. Prompts use the prompt_user field schema.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'update', 'edit', 'read', 'list', 'list_versions', 'read_version', 'delete'], description: 'Action to perform.' },
                    doc_id: { type: 'string', description: 'Document ID (update, edit, read, list_versions, read_version, delete).' },
                    title: { type: 'string', description: 'Document title (create, update).' },
                    content: { type: 'string', description: 'Markdown content (create, update).' },
                    scope: { type: 'string', enum: ['shared', 'chat'], description: 'create only: \'shared\' (default, global) or \'chat\' (private to the creating chat). Fixed at creation.' },
                    version: { type: 'number', description: 'Version number (read_version).' },
                    edits: { type: 'array', description: 'For edit: search-and-replace operations. Each find must be unique in the document.', items: { type: 'object', properties: { find: { type: 'string', description: 'Unique text to find.' }, replace: { type: 'string', description: 'Replacement text.' } }, required: ['find', 'replace'] } },
                    prompts: { type: 'array', description: 'Non-blocking prompts below the document: [{title?, description?, fields: [{name, type, label, options?, placeholder?, value?}]}]. description is rendered as MARKDOWN.', items: { type: 'object' } },
                    confirm: { type: 'boolean', description: 'Set true to have the user approve before execution (destructive, bulk, or significant changes). Omit for reads and routine operations.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_instances',
            description: 'List connected ServiceNow instances with connection status, user info (incl. roles — the user\'s directly-granted roles; check for `admin` before servicenow_run_script; empty = unknown/probe failed) and short names — use it before targeting an instance with servicenow_api or iframe_tool. Instances the user DISABLED for agent use (header instance picker) are excluded and returned in disabledInstances: never target them — any call against a disabled instance (explicit instance arg or the active instance) is refused until re-enabled.',
            parameters: {
                type: 'object',
                properties: {
                    refresh: { type: 'boolean', description: 'Deprecated no-op: the tool always re-probes open tabs for fresh token/user data (same live probe as the header instance pill).' },
                    include_roles: { type: 'boolean', description: 'Optional. true = re-fetch each connected instance\'s roles live (DIRECT only: sys_user_has_role inherited=false) and return them with rolesSource:"direct" (rolesError on lookup failure). Default false returns the cached probe roles.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
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
            description: 'Block (on the scheduler, not the model) until an async handle settles. Handles come from spawn_sub_agent, wake_sub_agent and agent_message and settle when the sub reports. Returns {status: done|error|cancelled|pending, result?, error?}. Sub-agent handles: done → result is the full report {status (done|need_input), summary, data, artifacts, from, from_name, at}; error → error is the headline (report summary) AND result is the full report; cancelled → error is the stop reason (no result). Still pending after timeout_ms → left in flight; await it again. Handles are per-chat and do not survive a page reload.',
            parameters: {
                type: 'object',
                properties: {
                    handle: { type: 'string', description: 'Handle id from a previous async call (e.g. "h_xxx").' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['handle']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'await_any',
            description: 'Wait for the FIRST of several handles (e.g. several in-flight sub-agents) to settle. Returns {handle, snapshot, timeout:false}, or on timeout {handle:null, snapshot:null, timeout:true, pendingSnapshots:[...]}.',
            parameters: {
                type: 'object',
                properties: {
                    handles: { type: 'array', items: { type: 'string' }, description: 'Handle ids to race.' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['handles']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'await_all',
            description: 'Wait for ALL of several handles to settle (e.g. collect a fan-out). Returns {snapshots: [...], timedOut} in input order; timedOut is true when at least one handle did not settle within timeout_ms (its snapshot is still status:"pending").',
            parameters: {
                type: 'object',
                properties: {
                    handles: { type: 'array', items: { type: 'string' }, description: 'Handle ids to wait on.' },
                    timeout_ms: { type: 'number', description: 'Max ms to wait. 0 / omitted = wait indefinitely.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
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
            description: 'Spawn a background sub-agent in a fresh chat with its own context. Returns immediately with {agent_id, chat_id, handle}; the sub calls report_to_parent when done and the handle settles with the distilled result (collect via await_handle, or let wake_parent notify you). If the sub reports status:"error" or crashes (auto_report fallback), the handle settles as status:"error" too (snapshot.error = headline, snapshot.result = full report). When to delegate is governed by the orchestration policy: use it for substantive, heavy or multi-step work (file/grep dumps, multi-record audits, deep log scans, iterative debugging, non-trivial implementation); quick single-file/single-record work may be done inline. Not for orchestration mechanics (reviewing deliverables, progress cards, user prompts, rendering results) or work whose result must feed the very next tool call. ALWAYS set tier explicitly (omitting silently inherits the default).',
            parameters: {
                type: 'object',
                properties: {
                    instructions: { type: 'string', description: 'The task, sent as the sub\'s first user message (markdown; rendered in the parent\'s sub-agent panel). Be specific about what to return (e.g. "only sys_ids and names, no script bodies"). Name any relevant active skills and tell the sub to read them with get_skill first.' },
                    name: { type: 'string', description: 'Short label for the sidebar / Workers strip. Defaults to a generated id.' },
                    allow_nested: { type: 'boolean', description: 'If true, the sub may spawn/stop/wake its own subs (default false) — only for genuine further delegation (multi-stage research, recursive audits). Max nesting depth 5. With profiles, include "orchestrator" or the spawn/await tools are filtered out before this flag applies.' },
                    context_seed: { type: 'object', description: 'Small JSON blob copied into the sub\'s first message (record ids, queries, etc.).' },
                    output_schema: { type: 'object', description: 'Optional JSON-Schema-ish object for the EXACT shape of report_to_parent\'s data; injected into the sub\'s first message with a directive to conform (same keys/types, no extras). Use when parsing the result programmatically (e.g. in js_eval). Root must be an object — wrap arrays in a named property ({items:[...]}).' },
                    auto_report: { type: 'boolean', description: 'If true (default), a fallback report is synthesized from the sub\'s last assistant message if it finishes without calling report_to_parent.' },
                    wake_parent: { type: 'boolean', description: 'If true (DEFAULT), the parent is woken when the sub reports (report_to_parent, auto-report, crash): an idle parent gets a notice row and a new run STARTS; a running parent gets the notice injected at a safe point. Skipped while you are blocked in await_handle on this handle (no double notification). Keep true for fan-outs — end your turn and react as reports arrive. false ONLY for fire-and-forget spawns you will collect via await_handle / agent_status: the parent is never woken and its context is unchanged, but each report still appends a passive UI-only notice row (name, status, headline, View agent) to the parent chat so the user sees it — skipped while you are blocked in await_handle / await_any / await_all on this handle. Change it later with wake_sub_agent({wake_parent}).' },
                    profiles: { type: 'array', items: { type: 'string', enum: ['servicenow', 'browser', 'research', 'code', 'extension-dev', 'skill-manager', 'eval-runner', 'audit-runner', 'orchestrator'] }, description: 'Tool profiles: the sub gets the base tools plus ONLY these (smaller context). Mix freely, e.g. ["servicenow","browser"]. Omit = full legacy toolset. servicenow (record CRUD, server scripts, code edits); browser (drive/inspect the ServiceNow UI iframe, screenshots); research (web_fetch — all HTTP methods — plus docs/web search; NO workspace); code (workspace clone/read/edit/diff/push, plus web_fetch for the GitHub REST API); extension-dev (code tools plus runtime_inspect and screenshots); skill-manager (manage AI skills); eval-runner (ServiceNow eval grader + the ServiceNow tools its tasks need); audit-runner (audit tool + ServiceNow read access); orchestrator (own subs, async handles, prompts, rendering — pair with allow_nested). SKILL-provided profile tools (web_search, search_docs, run_audit) are included only when that skill is active in the spawning chat. Always included, never list them: core tools (js_eval, cached-result readers, get_file, get_skill, progress card), the sub-agent reporting tools, and document.' },
                    tier: { type: 'string', enum: ['small', 'medium', 'large', 'same'], description: 'Model size tier, set on EVERY spawn: small | medium | large | same (the user maps tiers to models in Settings → Sub-Agent Model Tiers; you never pick model/provider names). small = cheap fan-outs (searches, summaries, discovery/scoping); medium = code-review passes, synthesis/triage, moderate implementation; large = heavy implementation or subtle reasoning; same = DYNAMICALLY follows the spawner\'s current model (resolved per LLM call, tracks later switches, bypasses the tier mapping) — e.g. for a self-evaluation.' },
                    summary_cap_kb: { type: 'integer', description: 'Max KB of the sub\'s report_to_parent summary (default 4, clamped 1–16); longer summaries are truncated with a "[truncated by registry]" marker. Raise only when a long structured result must come back inline; prefer artifacts (docs/files).' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['instructions']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'report_to_parent',
            description: 'SUB-AGENT ONLY. Push your distilled result to the parent: settles the spawn handle (if pending) and parks you (state=sleeping) until the parent wakes (wake_sub_agent) or stops (stop_sub_agent) you. Unless spawned with wake_parent:false, it also WAKES the parent (idle: a run starts with a notice; running: notice injected at a safe point; skipped when the parent is blocked in await_handle, which receives the settle). For mid-flight progress that must NOT settle the handle, use agent_message({to:"parent"}). The parent never reads your transcript — only this report. Summary cap: 4 KB by default (spawn summary_cap_kb), 32 artifacts.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['done', 'error', 'need_input'], description: 'Informational (UI badge, parent decision logic): done = complete, error = failed, need_input = parked waiting for the parent. All three settle the handle and park you.' },
                    summary: { type: 'string', description: 'The distilled result the parent reads, in MARKDOWN (rendered in the parent\'s sub-agent panel; section headings may start with an emoji or shortcode like :mag: as their icon). Soft-capped at 4 KB by default.' },
                    data: { type: 'object', description: 'Optional small structured payload (counts, ids, etc.).' },
                    artifacts: { type: 'array', items: { type: 'string' }, description: 'file_ids / doc_ids / widget_ids the parent can reference without inlining the content.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['status', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_status',
            description: 'Read-only, cheap, synchronous snapshot of sub-agents — use freely. Default: every sub of the current chat (running, sleeping, stopped, errored) in a COMPACT shape: agent_id, name, state, tier, timestamps, tool_calls_used (display-only lifetime counter, no limit), context_pct/saturated gauges (FIXED assumed 200k window; saturated at 100k = 50% — check before re-tasking a sub), review_state, truncated last_report (status + ~200 chars of summary), action_state {state, label}, and usage {calls, input_tokens, output_tokens, cost, tier} (cost is null unless the endpoint reports one — only OpenRouter does; no client-side pricing). Diagnostics (last_error, crash_cause, pending_approvals, awaiting_approval, escalation_suggestion, resurrectable, inbox_size, pending_handles) appear only when meaningful. verbose:true adds full last_report, last_assistant_message {text, at} (~600 chars in lists / ~2000 single), full action_state {state, label, tasks[], output}, usage.by_tier, pool position, wake_parent, retries, and user_interactions {last_user_message_at, last_user_approval_at, opened_by_user_at}.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'One sub, always in full detail. Omit to list.' },
                    parent_chat_id: { type: 'string', description: 'Filter the list by parent chat; "*" lists every sub on the instance.' },
                    verbose: { type: 'boolean', description: 'List mode: true = full per-agent snapshot (see description). Default false = compact.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'wake_sub_agent',
            description: 'Resume a sleeping sub-agent — or RESURRECT an errored/stopped one with its FULL prior chat context (it continues where it left off) while its record/transcript exists (terminal subs are garbage-collected ~1h after settling) — optionally with a new instruction. Queued inbox messages are drained into a combined user turn. No-op if already running. Returns {handle} (fresh if the previous one settled, else the pending one; await_handle it for the next report) plus resurrected_from when a terminal sub was revived. After 2 revision_requested verdicts the result carries escalation_suggestion (next tier up, or an independent fresh-context reviewer sub at the top tier) — a suggestion, never auto-applied. May carry a non-blocking saturation_warning when the sub is saturated (gauges: agent_status) — let it wrap up and spawn a FRESH successor instead of piling on work. Reviving a sub KEEPS its spawn-time wake_parent setting unless you pass wake_parent to override it (e.g. wake_parent:true so a revived fire-and-forget sub wakes you when it reports).',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Sub agent_id to wake.' },
                    instruction: { type: 'string', description: 'Optional new user message, drained with any pending inbox into the sub\'s next turn.' },
                    tier: { type: 'string', enum: ['small', 'medium', 'large', 'same'], description: 'Optional tier change (small | medium | large | same), e.g. escalate a failing small sub to large. same = DYNAMICALLY follow the waking agent\'s current model. Default: the spawn-time tier.' },
                    wake_parent: { type: 'boolean', description: 'Optional override of the sub\'s wake_parent setting (default: KEEP the spawn-time value). true = its next report wakes you (idle parent: notice row + new run; running parent: notice injected at a safe point). false = passive UI-only notice row, no wake. Applied even if the wake is otherwise a no-op; read back via agent_status.wake_parent.' },
                    review_state: { type: 'string', enum: ['accepted', 'revision_requested'], description: 'Optional verdict on the sub\'s LAST deliverable: "accepted" (as-is) or "revision_requested" (the instruction asks for changes). Applied even if the wake is otherwise a no-op. "pending" is stamped on every report and "cross_checked" when an independent reviewer sub targets it. Read back via agent_status.review_state.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['agent_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'stop_sub_agent',
            description: 'Terminate a sub-agent when its result is no longer needed (you changed course, the user redirected, it is stuck). Its pending tool handles are cancelled; the spawn handle resolves with status:"cancelled".',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: { type: 'string', description: 'Sub agent_id to stop.' },
                    reason: { type: 'string', description: 'Optional reason recorded on the sub\'s final report.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['agent_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'sleep_self',
            description: 'SUB-AGENT ONLY. Park yourself until the parent wakes you (wake_sub_agent) or messages you (agent_message), freeing your worker-pool slot. Prefer report_to_parent (it parks you AND tells the parent why); use sleep_self only when you have nothing to report but must wait. An unsettled spawn handle is auto-settled with status="need_input" so the parent does not hang.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional reason recorded for diagnostics.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'agent_message',
            description: 'Send a message between agents. Parent → to:"sub_xxx": pushes to that sub (auto-wakes it if sleeping unless wake:false) and returns a fresh handle to await_handle for its next report; may carry a non-blocking saturation_warning when the sub is saturated (gauges: agent_status) — have it wrap up and spawn a fresh successor. Sub → to:"parent": mid-flight status update shown as an inline callout; does NOT settle the spawn handle (use report_to_parent for terminal results).',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient: an agent_id, or "parent" (sub-only).' },
                    content: { type: 'string', description: 'Message text.' },
                    wake: { type: 'boolean', description: 'Wake a sleeping recipient. Default: true.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['to', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'eval_runner',
            description: 'Built-in sandboxed grader for the ServiceNow Eval (servicenow-eval skill); it alone handles the task setup/verifier/cleanup scripts so they never enter model context — NEVER read tasks.md directly. Actions: init (reset session, returns the 20 task prompts); setup (seed one task, duplicate-locked); verify (single-use atomic verify + cleanup + audit for one task, returns {pass, expected, actual}); teardown (returns the server-side audit verdicts, then deletes all session state).',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['init', 'setup', 'verify', 'teardown'], description: 'Lifecycle phase to run.' },
                    task_id: { type: 'string', description: 'Task ID (e.g. \'T6\'). Required for setup and verify.' },
                    instance: { type: 'string', description: 'Target ServiceNow instance by short name or URL. Optional — defaults to the active instance.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_setup',
            description: 'Open the GitHub setup popup so the user can connect an account and/or clone repositories. With no account connected it shows the Personal Access Token form with a link to GitHub token creation (repo scope preselected). NON-BLOCKING: returns right after opening — verify afterwards with workspace {action:"list"} or by asking the user.',
            parameters: {
                type: 'object',
                properties: {
                    repo: { type: 'string', description: 'Optional "owner/repo" to prefill the clone form (the user just clicks Clone).' },
                    branch: { type: 'string', description: 'Optional branch to prefill in the clone form.' },
                    open_token_page: { type: 'boolean', description: 'If true and no account is connected, also opens the GitHub token-creation page (repo scope preselected) in a new tab. Default: false.' },
                    instance_url: { type: 'string', description: 'GitHub Enterprise instance URL to prefill (default: https://github.com or the previously saved instance).' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'runtime_inspect',
            description: 'DEV-MODE ONLY: introspect and drive the AppAgent extension\'s OWN runtime (panel page, IndexedDB, service worker) while developing it. Works only when Reload rebuilds from the workspace (extension-dev active AND a deploy folder connected); errors otherwise. Results are safe-serialized (depth 6, 4KB per string, 64KB total), except screenshot base64, which is returned in full.\nActions:\n- ui_state: page snapshot — current chat/view, running+paused chats, chat list summary, pending approvals, widgets, lastApiError, LLM connection status, theme, active skills, dev-mode flag.\n- get {path}: CSP-safe read of any page global/path, e.g. "chats[\'chat_123\'].messages[0]".\n- call {path, args}: CSP-safe call of an existing page function with its parent object as this, e.g. "renderChatList".\n- set {path, value, call_after}: CSP-safe UI-state WRITE — assigns value (any JSON) to the path\'s final segment on its resolved parent; call_after re-renders.\n- dispatch {target, event, payload | selector, options}: bus (default) = AgentEvents.emit(event, payload) on the page bus, invoking the REAL handlers (e.g. messagesAppended, actionStateChanged, runFinished); sw = posts {type: event, ...payload} to the service worker port (pull-chat, toggle-pause, interrupt, focus-chat, update-chat, …); dom = fires an event on a PANEL-PAGE element, NOT the ServiceNow iframe (plain click uses el.click(); otherwise MouseEvent / KeyboardEvent with options.key / InputEvent or Event with bubbles:true; no match → matched:false, success). WARNING: bus/sw dispatch can mutate live run state (interrupt / toggle-pause are live controls).\n- db {op, store, key, path, pattern, flags, limit}: the extension\'s own IndexedDB — list (store names), get (one record by key; optional path drills in, returns {exists, value}, exists:false for a missing intermediate), query (up to limit records), count, grep (regex over STRING leaves record-by-record via a cursor; each match {key, path, excerpt ±60 chars}; ~1MB of strings scanned per record; returns {matches, truncated, records_scanned, records_capped}, plus key_found when key was passed) — e.g. read past chat transcripts from the \'chats\' store.\n- sw_state: live service-worker state — running chats, pending/parked tool calls, connected panel count, resume-scan flag.\n- sandbox_registry: js_eval sandbox registry — per-chat live eval counts, in-flight inner tool-call holds, last-activity timestamps, generation counters, plus offscreen-document state (hasDocument, keep-alive port, idleSince, creating, ready waiters) for stuck/zombie sandboxes.\n- screenshot: captures the panel via chrome.tabs.captureVisibleTab; fails with an explanatory error in the side panel (no tab of its own) — open the panel as a full tab first.\n- new_chat {focus}; focus_chat {chatId}; set_view {view}: home|chat|dashboard|skills|documents|history|docs|settings.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['ui_state', 'get', 'call', 'set', 'dispatch', 'db', 'sw_state', 'sandbox_registry', 'screenshot', 'new_chat', 'focus_chat', 'set_view'], description: 'What to inspect or do.' },
                    path: { type: 'string', description: 'get/call/set: dot/bracket path from window, e.g. "chats[\'id\'].title" or "SubAgents.getById". db get/grep: sub-path INSIDE the record (walked over the plain record, not window).' },
                    args: { type: 'array', description: 'call: arguments array for the resolved function.' },
                    value: { description: 'set: new value to assign (any JSON value).' },
                    call_after: { type: 'string', description: 'set: optional function path invoked with no args after the write (e.g. "renderChatList") so the UI re-renders.' },
                    target: { type: 'string', enum: ['bus', 'sw', 'dom'], description: 'dispatch: bus (AgentEvents page bus, default), sw (service-worker port message), or dom (panel-page element).' },
                    event: { type: 'string', description: 'dispatch: event name — bus: AgentEvents type (e.g. messagesAppended); sw: port message type (e.g. pull-chat, toggle-pause); dom: DOM event (click, keydown, input, …).' },
                    payload: { type: 'object', description: 'dispatch bus/sw: bus = emit detail; sw = merged into the port message beside type (e.g. {chatId: "chat_123"}).' },
                    selector: { type: 'string', description: 'dispatch dom: CSS selector of the panel-page element (document.querySelector).' },
                    options: { type: 'object', description: 'dispatch dom: event init options (e.g. {key: "Enter"}); bubbles/cancelable default to true.' },
                    op: { type: 'string', enum: ['list', 'get', 'query', 'count', 'grep'], description: 'db operation. Default: list.' },
                    pattern: { type: 'string', description: 'db grep: regex source tested against every string leaf.' },
                    flags: { type: 'string', description: 'db grep: regex flags (default \'i\').' },
                    store: { type: 'string', description: 'db get/query: object store name (see op:list).' },
                    key: { type: ['string', 'number'], description: 'db get/grep: record key, string OR number (passed as-is to store.get); grep restricts the search to that record.' },
                    limit: { type: 'number', description: 'db query: max records; db grep: max matches (default 20, cap 100).' },
                    chatId: { type: 'string', description: 'focus_chat: chat id to open.' },
                    view: { type: 'string', enum: ['home', 'chat', 'dashboard', 'skills', 'documents', 'history', 'docs', 'settings'], description: 'set_view: target view.' },
                    focus: { type: 'boolean', description: 'new_chat: false creates it without navigating. Default: true.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
                },
                required: ['action']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_tool_schema',
            description: 'Fetch the full JSON schema + description for tools in the deferred tool catalog (system prompt). Call it BEFORE using a catalog tool whose parameters you do not know; the schema stays in the conversation for the rest of the chat. Pure read — nothing is loaded or registered. Batch several names per call.',
            parameters: {
                type: 'object',
                properties: {
                    names: {
                        description: 'Catalog tool name(s): an array (a single string is also accepted).',
                        type: 'array',
                        items: { type: 'string' }
                    },
                    status_message: {
                        description: 'Short human-friendly description of this call, shown in the UI header.',
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
            description: 'Open a NEW, separate chat pre-loaded with a message — mainly for an "Ask the agent" BUTTON INSIDE AN html_widget: await executeTool("start_chat", {message, mode, include_widget}) either answers at once (mode:"send") or drops the text into the composer (mode:"draft"). Returns {success, chat_id, mode, sent, widget_id, message}. In foreground modes (send without background, and draft) the view switches to the new chat and tears down the calling widget\'s iframe, so the widget will not receive the return value — pass background:true if it must stay alive to show feedback. Do NOT use it to talk to yourself mid-answer.',
            parameters: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'REQUIRED. Message text to pre-load.' },
                    mode: { type: 'string', enum: ['send', 'draft'], description: '"send" (default) auto-submits so the agent answers immediately; "draft" only prefills and focuses the composer — the user presses enter.' },
                    background: { type: 'boolean', description: 'send mode only: true runs the new chat in the background — the view does NOT switch; it shows in the jobs badge and rings the finished-chat bell when done. Ignored for draft (a draft must be visible). Default false.' },
                    include_widget: { type: 'boolean', description: 'Prepend a widget-context reference (widget id + title, with a hint to inspect it) so the new chat knows which widget the question is about. Uses widget_id, or the CALLING widget from inside one; omitted (with a note in the return payload) if none resolves. Default false.' },
                    widget_id: { type: 'string', description: 'Explicit widget id to reference. Omit inside a widget — the calling widget is used.' },
                    title: { type: 'string', description: 'Optional chat title. Omit to use the usual auto-title logic.' },
                    status_message: { type: 'string', description: 'Short human-friendly description of this call, shown in the UI header.' }
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
    // run_js_file / run_tests (tools/160-run-tests.js, WORKER_SHARED_FILES) only
    // touch the workspace store (wsReadRaw/wsLs, headless like `workspace`) and
    // call executeTool('js_eval'), which is headless itself (offscreen sandbox)
    // — so they run wherever js_eval runs.
    run_js_file: true,
    run_tests: true,
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
    widget_eval: false,
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
    iframe_tool: 'Drive the instance UI in an iframe — navigate, click, fill, inspect — for genuine UI work only (sub-agent browser profile).',
    set_chat_title: 'Set the chat title; normally requested by the after-response hook.',
    set_tldr: 'Set the TL;DR summary card for the final answer; requested by the after-response hook.',
    set_links: 'Provide relevant links for the answer card; requested by the after-response hook.',
    set_caveat: 'Flag one must-read caveat about the final answer; requested by the after-response hook.',
    cached_content_outline: 'View the structural outline of a large cached tool result.',
    cached_content_search: 'Regex-search inside a large cached tool result.',
    cached_content_read: 'Read a specific path or line range of a large cached tool result.',
    get_skill: 'Read an AI skill body or one of its files before starting related work.',
    manage_skill: 'Create, update, edit, activate, or delete AI skills and their files (live runtime copy).',
    html_widget: 'Render (or version) a custom interactive HTML widget inline in chat when no display template fits.',
    pin_widget: 'Pin, move, or unpin an existing widget on the main or home dashboard.',
    take_screenshot: 'Capture a PNG screenshot of the browser panel, a widget, or an element for visual analysis (browser/extension-dev profiles).',
    screenshot_by_id: 'Retrieve a previously taken screenshot by its ID.',
    get_file: 'Retrieve any stored file by ID — view it (attach) or hand the user a download.',
    display: 'Render structured data with a predefined template: table, chart, code, diff, timeline, cards, checklist.',
    update_action_state: 'Maintain the live progress card (state + todo list) for multi-step work.',
    show_action_button: 'Render a one-click skill Action button inline in chat.',
    prompt_user: 'Show a blocking inline form to collect structured user input or confirm a plan.',
    web_fetch: 'Fetch a URL (GET/POST); for HTML pages, fetch and parse via js_eval instead.',
    get_cookie: 'Read browser cookies for a URL (chrome.cookies) so js_eval can do authenticated, cookie-gated fetches (browser/research profiles).',
    workspace: 'Clone, browse, edit, and push GitHub repos — the code-editing workspace.',
    run_js_file: 'Load (source) or run (module/script) a workspace JS file inside the js_eval sandbox; loadFile/runFile inside js_eval.',
    run_tests: 'Run test/*.test.js with test/harness.js in a host-guarded, read-only sandbox (default tags unit/contract/canary); call after editing, before pushing.',
    read_attached_file: 'Read a text file the user attached to this conversation.',
    document: 'Create, read, edit, and manage persistent versioned Smart Documents rendered inline.',
    list_instances: 'List connected ServiceNow instances with status and user info.',
    await_handle: 'Block until one sub-agent handle settles and return its snapshot.',
    await_any: 'Wait for the first of several sub-agent handles to settle.',
    await_all: 'Wait for all of several sub-agent handles to settle.',
    spawn_sub_agent: 'Spawn a sub-agent chat on an explicit tier for substantive, heavy, or multi-step delegated work.',
    report_to_parent: 'Sub-agent only: push the distilled result to the parent and park.',
    agent_status: 'Read-only snapshot of sub-agents: progress, saturation, reports, last chat output, approvals.',
    wake_sub_agent: 'Wake a parked sub-agent with follow-up instructions; returns a fresh handle.',
    stop_sub_agent: 'Terminate a sub-agent and cancel its pending work.',
    sleep_self: 'Sub-agent only: park yourself until the parent wakes you.',
    start_chat: 'Open a new chat pre-loaded with a message (auto-send or draft) — for hand-off buttons inside widgets.',
    agent_message: 'Send a message between agents (parent↔sub) without settling the spawn handle.',
    eval_runner: 'Sandboxed grader for the ServiceNow eval skill lifecycle (init, setup, verify, teardown).',
    github_setup: 'Open the GitHub setup popup to connect an account or clone a repo.',
    runtime_inspect: 'Dev-mode only: introspect and drive the AppAgent extension runtime — page state, service worker, and IndexedDB incl. past chat transcripts.',
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
