// Skill Assets Management (XML/MD files stored in IndexedDB)
// Asset format: { id: 'skillId_filename', skillId: string, filename: string, type: 'xml'|'md', content: string }

async function saveSkillAsset(skillId, filename, type, content) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillAssetsStoreName], 'readwrite');
        var store = transaction.objectStore(skillAssetsStoreName);
        var asset = { id: skillId + '_' + filename, skillId: skillId, filename: filename, type: type, content: content };
        store.put(asset);
    } catch (e) {
        console.error('Failed to save skill asset:', e);
    }
}

async function getSkillAssets(skillId) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillAssetsStoreName], 'readonly');
        var store = transaction.objectStore(skillAssetsStoreName);
        var request = store.getAll();
        return new Promise(function(resolve) {
            request.onsuccess = function() {
                var results = (request.result || []).filter(function(a) { return a.skillId === skillId; });
                resolve(results);
            };
            request.onerror = function() { resolve([]); };
        });
    } catch (e) {
        console.error('Failed to get skill assets:', e);
        return [];
    }
}

async function getSkillAsset(skillId, filename) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillAssetsStoreName], 'readonly');
        var store = transaction.objectStore(skillAssetsStoreName);
        var request = store.get(skillId + '_' + filename);
        return new Promise(function(resolve) {
            request.onsuccess = function() { resolve(request.result || null); };
            request.onerror = function() { resolve(null); };
        });
    } catch (e) {
        return null;
    }
}

async function deleteSkillAsset(skillId, filename) {
    try {
        var database = await openDatabase();
        var transaction = database.transaction([skillAssetsStoreName], 'readwrite');
        var store = transaction.objectStore(skillAssetsStoreName);
        store.delete(skillId + '_' + filename);
    } catch (e) {
        console.error('Failed to delete skill asset:', e);
    }
}

async function deleteSkillAssets(skillId) {
    try {
        var assets = await getSkillAssets(skillId);
        var database = await openDatabase();
        var transaction = database.transaction([skillAssetsStoreName], 'readwrite');
        var store = transaction.objectStore(skillAssetsStoreName);
        assets.forEach(function(a) { store.delete(a.id); });
    } catch (e) {
        console.error('Failed to delete skill assets:', e);
    }
}

// Skill Tools - JS tools loaded from skill assets (run in isolated sandbox)
// JS Tool File Format (valid JS):
// ```
// var TOOL_DEFINITION = {
//     type: 'function',
//     function: {
//         name: 'tool_name',
//         description: 'Tool description',
//         parameters: { type: 'object', properties: {...}, required: [...] }
//     }
// };
//
// async function tool_name(args) {
//     // Runs in isolated sandbox - only executeTool() is available
//     // Call other tools via: await executeTool('servicenow_api', {...})
//     return { success: true, result: ... };
// }
// ```

var skillTools = {}; // { skillId: { toolName: { definition: {...}, code: string, name: string } } }

// Convert a JS object literal source string into JSON-parseable text.
// String-aware: it only quotes unquoted keys and strips trailing commas in
// CODE regions, never inside string literals. The previous naive regex pass
// corrupted any TOOL_DEFINITION whose description contained JS-like fragments
// (e.g. `{ results: [...] }`), because the regex would inject `"` chars into
// the middle of a string and break JSON.parse.
function jsObjectLiteralToJson(s) {
    var out = '';
    var i = 0;
    var n = s.length;
    var inStr = false;
    var strCh = '';
    var segStart = 0;

    function flushCode(end) {
        var seg = s.slice(segStart, end);
        seg = seg
            .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/,(\s*[}\]])/g, '$1');
        out += seg;
    }

    function reencodeStringLiteral(lit) {
        var ch = lit.charAt(0);
        if (ch === '"') return lit; // already JSON-style
        // Single-quoted literal: convert to double-quoted, preserving escapes.
        var inner = lit.slice(1, -1);
        var res = '"';
        var k = 0;
        while (k < inner.length) {
            var c = inner.charAt(k);
            if (c === '\\') {
                var nxt = inner.charAt(k + 1);
                if (nxt === "'") { res += "'"; k += 2; continue; }
                res += '\\' + nxt;
                k += 2;
                continue;
            }
            if (c === '"') { res += '\\"'; k++; continue; }
            if (c === '\n') { res += '\\n'; k++; continue; }
            if (c === '\r') { res += '\\r'; k++; continue; }
            if (c === '\t') { res += '\\t'; k++; continue; }
            res += c;
            k++;
        }
        return res + '"';
    }

    while (i < n) {
        var c = s.charAt(i);
        if (inStr) {
            if (c === '\\') { i += 2; continue; }
            if (c === strCh) {
                out += reencodeStringLiteral(s.slice(segStart, i + 1));
                inStr = false;
                segStart = i + 1;
            }
            i++; continue;
        }
        if (c === '"' || c === "'") {
            flushCode(i);
            inStr = true;
            strCh = c;
            segStart = i;
            i++; continue;
        }
        i++;
    }
    flushCode(n);
    return out;
}

function parseSkillToolFile(content) {
    // Try multiple formats:
    // 1. var TOOL_DEFINITION = {...};
    // 2. // TOOL_DEFINITION\n{...}\n// END_TOOL_DEFINITION
    // 3. const TOOL_DEFINITION = {...};
    var defMatch = content.match(/(?:var|const|let)\s+TOOL_DEFINITION\s*=\s*(\{[\s\S]*?\n\});?/);
    if (!defMatch) {
        // Try comment format
        defMatch = content.match(/\/\/\s*TOOL_DEFINITION\s*\n([\s\S]*?)\n\s*\/\/\s*END_TOOL_DEFINITION/);
    }
    if (!defMatch) {
        console.warn('Skill tool file: No TOOL_DEFINITION found');
        return null;
    }

    try {
        var defStr = defMatch[1].trim();
        // Remove trailing semicolon if present
        if (defStr.endsWith(';')) defStr = defStr.slice(0, -1);
        // Try eval first (works on ServiceNow), fall back to JSON parse for extension CSP
        var definition;
        try {
            definition = eval('(' + defStr + ')');
        } catch (evalErr) {
            // Extension CSP blocks eval — convert JS object literal to JSON.
            // Uses a string-aware tokenizer so that JS-like text inside
            // string literals (descriptions, etc.) is not corrupted.
            var json = jsObjectLiteralToJson(defStr);
            definition = JSON.parse(json);
        }
        var toolName = definition.function && definition.function.name;
        if (!toolName) {
            console.warn('Skill tool file: No function name in definition');
            return null;
        }

        // Verify the function exists in the content
        var fnMatch = content.match(new RegExp('async\\s+function\\s+' + toolName + '\\s*\\('));
        if (!fnMatch) {
            fnMatch = content.match(new RegExp('function\\s+' + toolName + '\\s*\\('));
        }
        if (!fnMatch) {
            // Try arrow function: const toolName = async (args) => {...}
            fnMatch = content.match(new RegExp('(?:var|const|let)\\s+' + toolName + '\\s*='));
        }
        if (!fnMatch) {
            console.warn('Skill tool file: Function "' + toolName + '" not found in content');
            return null;
        }

        // Store raw code for sandboxed execution (don't eval here)
        return { definition: definition, code: content, name: toolName };
    } catch (e) {
        console.error('Failed to parse skill tool:', e);
        return null;
    }
}

async function loadSkillTools(skillId) {
    var assets = await getSkillAssets(skillId);
    var jsAssets = assets.filter(function(a) { return a.type === 'js'; });

    skillTools[skillId] = {};
    var errors = [];

    for (var i = 0; i < jsAssets.length; i++) {
        var parsed = parseSkillToolFile(jsAssets[i].content);
        if (parsed) {
            skillTools[skillId][parsed.name] = parsed;
        } else {
            var errMsg = jsAssets[i].filename + ': Failed to parse tool definition';
            console.warn(errMsg);
            errors.push(errMsg);
        }
    }
    return { loaded: Object.keys(skillTools[skillId]).length, errors: errors };
}

function unloadSkillTools(skillId) {
    delete skillTools[skillId];
}

// ---- devOnly skills (runtime_inspect feature) ----
// A skill with `devOnly: true` in its frontmatter is hidden (from the system
// prompt, the skills list UI and skill-tool rosters) unless extension dev
// mode is active — the same gate as the runtime_inspect tool. This file is
// in WORKER_SHARED_FILES, so the helpers exist in BOTH realms.
function _skillIsDevOnly(skillId) {
    try {
        if (typeof skills === 'object' && skills && skills[skillId] && skills[skillId].devOnly) return true;
        if (typeof EMBEDDED_SKILLS !== 'undefined' && EMBEDDED_SKILLS && EMBEDDED_SKILLS.length) {
            for (var i = 0; i < EMBEDDED_SKILLS.length; i++) {
                var e = EMBEDDED_SKILLS[i];
                if (!e || e.id !== skillId) continue;
                if (e.devOnly) return true;
                // Fallback: parse the embedded frontmatter (base64) — covers a
                // build path that didn't stamp the devOnly field.
                try {
                    if (e.frontmatter && /^devOnly:\s*true\s*$/m.test(decodeURIComponent(escape(atob(e.frontmatter))))) return true;
                } catch (e2) { /* malformed frontmatter — treat as not devOnly */ }
            }
        }
    } catch (e3) { /* fail open: not devOnly */ }
    return false;
}

// Realm-aware dev-mode check. The SW flag is pushed via the 'dev-mode' bus
// message (worker/130-port-bridge.js); the page flag is set by
// _pushDevModeToSW (tools/140-runtime-inspect.js).
function _devModeActiveSync() {
    try {
        if (typeof Platform !== 'undefined' && Platform && Platform.isWorker) return !!self._swDevModeActive;
        return !!(typeof window !== 'undefined' && window._pageDevModeActive);
    } catch (e) { return false; }
}

function isSkillDevHidden(skillId) {
    return _skillIsDevOnly(skillId) && !_devModeActiveSync();
}

function getActiveSkillTools() {
    var tools = [];
    for (var skillId in activeSkills) {
        if (isSkillDevHidden(skillId)) continue;
        if (skillTools[skillId]) {
            for (var toolName in skillTools[skillId]) {
                tools.push(skillTools[skillId][toolName].definition);
            }
        }
    }
    return tools;
}

var LARGE_RESPONSE_LINE_LIMIT = 50; // Max lines to show for large responses

// Execute skill tool in isolated sandbox (same security model as js_eval)
async function executeSkillTool(toolName, args, options, messageIndex) {
    var toolInfo = null;
    for (var skillId in skillTools) {
        if (skillTools[skillId][toolName]) {
            toolInfo = skillTools[skillId][toolName];
            break;
        }
    }

    if (!toolInfo) {
        return { success: false, error: 'Skill tool not found: ' + toolName };
    }

    try {
        var chatId = (options && options.chatId) || activeStreamingChatId || currentChatId;

        // SW context bridges to the offscreen helper, which hosts the
        // real sandbox iframe. The offscreen runs the same MSG_TOOL_CALL /
        // MSG_TOOL_RESULT / MSG_DONE protocol against the sandbox and
        // forwards sandbox tool calls back to the SW via the
        // chrome.runtime.sendMessage type='sw-exec-tool' handler in
        // background.js.
        if (typeof Platform !== 'undefined' && Platform.isWorker) {
            var swResult = await Platform.callOffscreenHelper('helper-skill-sandbox', {
                toolCode: toolInfo.code,
                toolName: toolName,
                args: args,
                chatId: chatId,
                // Plumb the skill-tool toolCallId so display calls from inside
                // the skill render eagerly attached to this tool's result slot.
                parentToolCallId: options && options.toolCallId,
                // Plumb the OUTER tool call's message index so nested
                // servicenow_api / servicenow_diff_edit calls stamp a real
                // messageIndex on their version-history entries instead of -1
                // (offscreen-helper.js runSkillSandbox → sw-exec-tool payload
                // → background.js executeTool). NOT `messageIndex || null` —
                // index 0 is a legitimate value.
                messageIndex: (typeof messageIndex === 'number' && messageIndex >= 0) ? messageIndex : null
            }, 5 * 60 * 1000);
            var swResultStr = JSON.stringify(swResult, null, 2);
            var swLines = swResultStr.split('\n');
            if (swLines.length > LARGE_RESPONSE_LINE_LIMIT && !(options && options.fromSandbox)) {
                setLastLargeResponse(chatId, swResult); // CONC-FIX: per-chat, not shared global; LEAK-FIX: bounded (evicts oldest past cap)
                var swPreview = swLines.slice(0, LARGE_RESPONSE_LINE_LIMIT).join('\n');
                return {
                    success: swResult.success !== undefined ? swResult.success : true,
                    status: swResult.status,
                    _response_truncated: true,
                    _total_lines: swLines.length,
                    _preview_lines: LARGE_RESPONSE_LINE_LIMIT,
                    _notice: 'Response too large (' + swLines.length + ' lines). Showing first ' + LARGE_RESPONSE_LINE_LIMIT + ' lines. Full data stored in `lastLargeResponse` variable - use js_eval to process it (e.g., filter, map, count items, extract specific fields).',
                    preview: swPreview
                };
            }
            return swResult;
        }

        var sandbox = document.createElement('iframe');
        sandbox.style.display = 'none';
        var sandboxMessageHandler = null;

        var MSG_TOOL_CALL = 'sandboxToolCall';
        var MSG_TOOL_RESULT = 'sandboxToolResult';
        var MSG_DONE = 'sandboxDone';

        // Promise to wait for result
        var resultPromise = new Promise(function(resolveMain, rejectMain) {
            function handleSandboxMessage(e) {
                if (e.source !== sandbox.contentWindow) return;

                // Sandbox ready -> send code to execute
                if (e.data && e.data.type === 'sandboxReady') {
                    var code = toolInfo.code + ';\nreturn await ' + toolName + '(' + JSON.stringify(args) + ');';
                    sandbox.contentWindow.postMessage({ type: 'sandboxExec', code: code }, '*');
                } else if (e.data && e.data.type === MSG_TOOL_CALL) {
                    // Pass the OUTER skill-tool toolCallId as parentToolCallId
                    // so display from inside a skill renders eagerly attached
                    // to the skill's tool_result slot. See executeDisplay.
                    // Pass the OUTER tool call's messageIndex (not null) so
                    // nested record mutations get per-message artifact
                    // attribution — same plumbing as the SW path above.
                    var toolPromise = executeTool(e.data.name, e.data.args,
                        (typeof messageIndex === 'number' && messageIndex >= 0) ? messageIndex : null, {
                        chatId: chatId,
                        fromSandbox: true,
                        parentToolCallId: options && options.toolCallId
                    });
                    toolPromise
                        .then(function(result) {
                            if (result && result._screenshotMessage) {
                                var ssMsg = result._screenshotMessage;
                                if (ssMsg.screenshot_id) {
                                    var ssChat = chats[chatId];
                                    if (ssChat) {
                                        if (!ssChat.screenshots) ssChat.screenshots = {};
                                        ssChat.screenshots[ssMsg.screenshot_id] = { base64: ssMsg.base64, name: ssMsg.name, width: ssMsg.width, height: ssMsg.height, timestamp: ssMsg.timestamp, description: ssMsg.description };
                                        // MEMFIX: cap the per-chat screenshots map (~20, LRU by
                                        // timestamp) — an unbounded map grows the chat record by
                                        // ~1-2MB per sandbox screenshot forever. Oldest entries
                                        // (and their base64) are dropped; screenshot_by_id on a
                                        // dropped id returns not-found, same as pre-existing
                                        // behavior for deleted chats.
                                        try {
                                            var _ssKeys = Object.keys(ssChat.screenshots);
                                            var _SS_CAP = 20;
                                            if (_ssKeys.length > _SS_CAP) {
                                                _ssKeys.sort(function(a, b) { return (ssChat.screenshots[a].timestamp || 0) - (ssChat.screenshots[b].timestamp || 0); });
                                                for (var _ei = 0; _ei < _ssKeys.length - _SS_CAP; _ei++) {
                                                    delete ssChat.screenshots[_ssKeys[_ei]];
                                                }
                                            }
                                        } catch (eCap) {}
                                        if (ssMsg.file_id) registerFile(ssMsg.file_id, { type: 'screenshots_map', chatId: chatId });
                                        saveChatsToStorage();
                                    }
                                }
                                result.base64 = ssMsg.base64;
                                result.width = ssMsg.width;
                                result.height = ssMsg.height;
                                result.screenshot_id = ssMsg.screenshot_id || result.screenshot_id;
                                delete result._screenshotMessage;
                            }
                            sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, result: result }, '*');
                        })
                        .catch(function(err) {
                            sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: e.data.id, error: err.message }, '*');
                        });
                } else if (e.data && e.data.type === MSG_DONE) {
                    window.removeEventListener('message', handleSandboxMessage);
                    sandboxMessageHandler = null;
                    if (e.data.error) rejectMain(new Error(e.data.error));
                    else resolveMain(e.data.result);
                }
            }
            sandboxMessageHandler = handleSandboxMessage;
            window.addEventListener('message', handleSandboxMessage);

            sandbox.src = 'sandbox.html';
            document.body.appendChild(sandbox);
        });

        var result = await resultPromise;
        document.body.removeChild(sandbox);

        // Check if response is too large (skip when called from js_eval or another skill tool)
        var resultStr = JSON.stringify(result, null, 2);
        var lines = resultStr.split('\n');

        if (lines.length > LARGE_RESPONSE_LINE_LIMIT && !(options && options.fromSandbox)) {
            // Store full response in a per-chat slot for Agent manipulation (CONC-FIX:
            // not a shared global — avoids cross-chat bleed when two chats run at once;
            // LEAK-FIX: bounded setter evicts the oldest slot past the cap).
            setLastLargeResponse(chatId, result);

            // Create truncated preview (first 50 lines)
            var preview = lines.slice(0, LARGE_RESPONSE_LINE_LIMIT).join('\n');
            var totalLines = lines.length;

            // Return truncated result with metadata
            return {
                success: result.success !== undefined ? result.success : true,
                status: result.status,
                _response_truncated: true,
                _total_lines: totalLines,
                _preview_lines: LARGE_RESPONSE_LINE_LIMIT,
                _notice: 'Response too large (' + totalLines + ' lines). Showing first ' + LARGE_RESPONSE_LINE_LIMIT + ' lines. Full data stored in `lastLargeResponse` variable - use js_eval to process it (e.g., filter, map, count items, extract specific fields).',
                preview: preview
            };
        }

        return result;
    } catch (e) {
        // sandbox / sandboxMessageHandler only exist on the DOM-fallback
        // path; the SW-bridged path returns earlier.
        if (typeof sandboxMessageHandler !== 'undefined' && sandboxMessageHandler) {
            try { window.removeEventListener('message', sandboxMessageHandler); } catch (cleanupErr) {}
        }
        if (typeof sandbox !== 'undefined' && sandbox && sandbox.parentNode) {
            try { sandbox.parentNode.removeChild(sandbox); } catch (cleanupErr) {}
        }
        return { success: false, error: e.message };
    }
}

function isSkillTool(toolName) {
    for (var skillId in skillTools) {
        if (skillTools[skillId][toolName]) return true;
    }
    return false;
}

// Skill Activation/Deactivation with XML loading and version tracking
async function activateSkill(skillId) {
    var skill = skills[skillId];
    if (!skill || activeSkills[skillId]) return { success: false, error: 'Skill not found or already active' };
    
    var assets = await getSkillAssets(skillId);
    var xmlAssets = assets.filter(function(a) { return a.type === 'xml'; });
    var jsAssets = assets.filter(function(a) { return a.type === 'js'; });
    
    // Load JS tools first - fail if any tool fails to parse
    var toolResult = await loadSkillTools(skillId);
    if (toolResult.errors.length > 0) {
        unloadSkillTools(skillId);
        return { success: false, error: 'Failed to load tools: ' + toolResult.errors.join('; ') };
    }
    var toolCount = toolResult.loaded;
    
    if (xmlAssets.length === 0) {
        activeSkills[skillId] = { xmlBackups: {}, activatedAt: Date.now() };
        await saveActiveSkills();
        renderSkillsList();
        var msg = 'Skill activated with ' + toolCount + ' tool(s)';
        return { success: true, message: msg };
    }
    
    var backups = {};
    var errors = [];
    
    for (var i = 0; i < xmlAssets.length; i++) {
        var asset = xmlAssets[i];
        try {
            // Parse XML to get table and sys_id (case-insensitive, flexible format)
            var tableMatch = asset.content.match(/<([a-zA-Z_][a-zA-Z0-9_]*)\s+action=/i);
            var sysIdMatch = asset.content.match(/sys_id>([a-f0-9]{32})</i);
            
            if (tableMatch && sysIdMatch) {
                var table = tableMatch[1].toLowerCase();
                var sysId = sysIdMatch[1].toLowerCase();
                var key = table + '_' + sysId;
                
                // Get current version before uploading
                var currentVersion = await getCurrentRecordVersion(table, sysId);
                if (currentVersion) {
                    backups[key] = currentVersion;
                }
                
                // Upload the XML
                var result = await uploadXml(asset.content, table, sysId);
                if (!result.success) {
                    errors.push(asset.filename + ': ' + (result.error || 'Upload failed'));
                }
            } else {
                errors.push(asset.filename + ': Could not parse table/sys_id from XML');
            }
        } catch (e) {
            errors.push(asset.filename + ': ' + e.message);
        }
    }
    
    // If any XML failed to upload, fail the activation
    if (errors.length > 0) {
        unloadSkillTools(skillId);
        return { success: false, error: 'Failed to load XML: ' + errors.join('; ') };
    }
    
    activeSkills[skillId] = { xmlBackups: backups, activatedAt: Date.now() };
    await saveActiveSkills();
    renderSkillsList();
    
    var msg = 'Skill activated';
    if (toolCount > 0) msg += ' with ' + toolCount + ' tool(s)';
    if (xmlAssets.length > 0) msg += ' and ' + xmlAssets.length + ' XML file(s)';
    return { success: true, message: msg };
}

async function deactivateSkill(skillId) {
    var activeSkill = activeSkills[skillId];
    if (!activeSkill) return { success: false, error: 'Skill not active' };
    
    // Unload JS tools
    unloadSkillTools(skillId);
    
    var errors = [];
    var backups = activeSkill.xmlBackups || {};
    
    for (var key in backups) {
        var versionSysId = backups[key];
        // Key format is table_sysId where sysId is always 32 hex chars
        // Extract sysId (last 32 chars) and table (everything before the last underscore + 32 chars)
        var sysId = key.slice(-32);
        var table = key.slice(0, -33); // Remove underscore + 32 char sysId
        
        try {
            var xml = await getVersionXml(versionSysId);
            if (xml) {
                var result = await uploadXml(xml, table, sysId);
                if (!result.success) {
                    errors.push(key + ': revert failed');
                }
            }
        } catch (e) {
            errors.push(key + ': ' + e.message);
        }
    }
    
    delete activeSkills[skillId];
    await saveActiveSkills();

    // Mark embedded skills as user-modified so import doesn't re-activate
    var skill = skills[skillId];
    if (skill && skill.embeddedHash && !skill.userModified) {
        skill.userModified = true;
        await saveSkill(skill);
    }

    renderSkillsList();
    
    if (errors.length > 0) {
        return { success: true, message: 'Skill deactivated with errors: ' + errors.join(', ') };
    }
    return { success: true, message: 'Skill deactivated and reverted' };
}

async function getCurrentRecordVersion(table, sysId) {
    try {
        var headers = { 'X-UserToken': Platform.getSessionToken(), 'Accept': 'application/json' };
        var url = '/api/now/table/sys_update_version?sysparm_query=name=' + table + '_' + sysId + '^ORDERBYDESCsys_created_on&sysparm_limit=1&sysparm_fields=sys_id';
        var res = await fetch(url, { headers: headers });
        var data = await res.json();
        if (data.result && data.result.length > 0) {
            return data.result[0].sys_id;
        }
    } catch (e) {
        console.error('Failed to get current version:', e);
    }
    return null;
}

async function saveActiveSkills() {
    await setSetting('activeSkills', activeSkills);
}

async function loadActiveSkills() {
    activeSkills = await getSetting('activeSkills', {});
    // Load JS tools for all active skills
    for (var skillId in activeSkills) {
        await loadSkillTools(skillId);
    }
}

// =============================================