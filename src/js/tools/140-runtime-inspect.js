// =============================================================
// runtime_inspect — DEV-MODE-ONLY self-introspection tool.
//
// Lets the agent inspect and drive the AppAgent extension's OWN
// runtime (panel page globals, IndexedDB, service-worker state,
// UI navigation) while doing extension development.
//
// Gate: available only when _reloadRebuildsFromWorkspace() is true
// (extension-dev skill active AND deploy folder connected) — the
// exact same condition under which the Reload button rebuilds from
// the workspace (tools/080-widget-tools.js:766).
//
// This file is PAGE-BUNDLE ONLY (tools tier is not in
// WORKER_SHARED_FILES), so the tool always runs in a panel page.
// The SW routes it here because HEADLESS_TOOLS marks it false
// (core/080-tools.js). Dispatch happens via the executeTool
// wrapper at the bottom of this file — tools/020-tool-execution.js
// is intentionally NOT modified.
// =============================================================

// ---- safe serialization (circular refs, depth, size caps) ----
function _riSafeSerialize(value) {
    var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    var MAX_DEPTH = 6, STR_CAP = 4096, KEY_CAP = 100, TOTAL_CAP = 65536;
    function walk(v, d) {
        if (v === null || v === undefined) return v;
        var t = typeof v;
        if (t === 'string') return v.length > STR_CAP ? v.slice(0, STR_CAP) + '…[+' + (v.length - STR_CAP) + ' chars]' : v;
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
        if (t !== 'object') { try { return String(v); } catch (e) { return '[unstringifiable ' + t + ']'; } }
        // Cycle detection tracks only the CURRENT ancestor chain (add before
        // recursing into children, delete after) — a permanent WeakSet would
        // mislabel shared non-cyclic refs as [Circular]. The depth check runs
        // BEFORE the add so depth-capped objects are labeled as such.
        if (seen && seen.has(v)) return '[Circular]';
        if (d >= MAX_DEPTH) return Array.isArray(v) ? '[Array(' + v.length + ') depth-capped]' : '[Object depth-capped]';
        if (seen) seen.add(v);
        try {
            if (Array.isArray(v)) {
                var arr = [], n = Math.min(v.length, KEY_CAP);
                for (var i = 0; i < n; i++) { try { arr.push(walk(v[i], d + 1)); } catch (e1) { arr.push('[unreadable]'); } }
                if (v.length > n) arr.push('…[+' + (v.length - n) + ' items]');
                return arr;
            }
            if (v instanceof Error) return { error: String(v.message || v), stack: walk(String(v.stack || ''), d + 1) };
            var keys;
            try { keys = Object.keys(v); } catch (e2) { try { return String(v); } catch (e3) { return '[opaque object]'; } }
            var out = {};
            for (var k = 0; k < keys.length && k < KEY_CAP; k++) {
                try { out[keys[k]] = walk(v[keys[k]], d + 1); } catch (e4) { out[keys[k]] = '[unreadable: ' + (e4 && e4.message) + ']'; }
            }
            if (keys.length > KEY_CAP) out['…'] = '+' + (keys.length - KEY_CAP) + ' more keys';
            return out;
        } finally {
            if (seen) seen.delete(v);
        }
    }
    var result = walk(value, 0);
    try {
        var json = JSON.stringify(result);
        if (json && json.length > TOTAL_CAP) {
            return { _truncated: true, _totalChars: json.length, preview: json.slice(0, TOTAL_CAP) };
        }
    } catch (e) { try { return String(result); } catch (e5) { return '[unserializable result]'; } }
    return result;
}

// ---- CSP-safe path resolver for get/call ----
// Supports: foo.bar.baz, foo[0], foo['key'], foo["key"], mixed.
function _riParsePath(path) {
    var tokens = [];
    var re = /\.?([A-Za-z_$][\w$]*)|\[(?:(\d+)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\]/g;
    var m, lastIndex = 0;
    while ((m = re.exec(path)) !== null) {
        if (m.index !== lastIndex) throw new Error('Unparseable path segment at offset ' + lastIndex + ' in: ' + path);
        lastIndex = re.lastIndex;
        if (m[1] !== undefined) tokens.push(m[1]);
        else if (m[2] !== undefined) tokens.push(parseInt(m[2], 10));
        else if (m[3] !== undefined) tokens.push(m[3].replace(/\\(.)/g, '$1'));
        else tokens.push(m[4].replace(/\\(.)/g, '$1'));
    }
    if (lastIndex !== path.length) throw new Error('Unparseable path tail at offset ' + lastIndex + ' in: ' + path);
    if (tokens.length === 0) throw new Error('Empty path');
    return tokens;
}

function _riResolvePath(path) {
    var tokens = _riParsePath(path);
    var parent = null;
    var cur = window;
    for (var i = 0; i < tokens.length; i++) {
        if (cur === null || cur === undefined) {
            throw new Error("Cannot read '" + tokens[i] + "' — '" + tokens.slice(0, i).join('.') + "' is " + String(cur));
        }
        parent = cur;
        cur = cur[tokens[i]];
    }
    return { value: cur, parent: parent, lastToken: tokens[tokens.length - 1] };
}

// ---- walk parsed path tokens over a PLAIN object (no window resolution) ----
// Used by db get {path} and db grep {path}. A missing/null intermediate is
// NOT an error — it returns {exists:false} so callers can report cleanly.
function _riWalkTokens(obj, tokens) {
    var cur = obj;
    for (var i = 0; i < tokens.length; i++) {
        if (cur === null || cur === undefined) return { exists: false, value: undefined };
        cur = cur[tokens[i]];
    }
    return { exists: cur !== undefined, value: cur };
}

// ---- sw_state: pull live service-worker debug state over the bus ----
var _riPendingDebugPulls = {};

// Called from app/045-agent-port-bridge-page.js on {type:'debug-state'}.
function _riResolveDebugState(msg) {
    if (!msg || !msg.requestId) return;
    var p = _riPendingDebugPulls[msg.requestId];
    if (!p) return;
    delete _riPendingDebugPulls[msg.requestId];
    try { clearTimeout(p.timer); } catch (e) {}
    p.resolve(msg.state || null);
}

function _riPullSwDebugState() {
    return new Promise(function(resolve, reject) {
        if (typeof _agentBusPort === 'undefined' || !_agentBusPort) {
            reject(new Error('No agent-bus port to the service worker is connected'));
            return;
        }
        var requestId = 'ri_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        var timer = setTimeout(function() {
            delete _riPendingDebugPulls[requestId];
            reject(new Error('sw_state timed out after 5s (SW did not reply on the bus)'));
        }, 5000);
        _riPendingDebugPulls[requestId] = { resolve: resolve, timer: timer };
        try {
            _agentBusPort.postMessage({ type: 'pull-debug-state', requestId: requestId });
        } catch (e) {
            clearTimeout(timer);
            delete _riPendingDebugPulls[requestId];
            reject(e);
        }
    });
}

// ---- dev-mode flag push (page → SW) ----
// Sets window._pageDevModeActive and mirrors it to the SW so BOTH
// getEnabledTools twins (ui/140-dropdowns.js + worker/025-permissions-
// helpers.js) and the devOnly skill gate observe the same value.
// Called with a known boolean from updateReloadBtnVisibility
// (ui/270-iframe-panel.js) and with no args on bus connect
// (_sendPanelHello in app/045-agent-port-bridge-page.js).
async function _pushDevModeToSW(known) {
    var active = false;
    try {
        if (typeof known === 'boolean') active = known;
        else if (typeof _reloadRebuildsFromWorkspace === 'function') active = !!(await _reloadRebuildsFromWorkspace());
    } catch (e) { active = false; }
    try { window._pageDevModeActive = active; } catch (e2) {}
    try {
        if (typeof _agentBusPort !== 'undefined' && _agentBusPort) {
            _agentBusPort.postMessage({ type: 'dev-mode', active: active });
        }
    } catch (e3) { /* stale port — next reconnect re-pushes */ }
}

// ---- per-action helpers ----
async function _riDb(args) {
    var op = args.op || 'list';
    if (typeof openDatabase !== 'function') return { success: false, error: 'openDatabase() is not available in this context' };
    var db = await openDatabase();
    if (op === 'list') {
        return { success: true, stores: Array.from(db.objectStoreNames) };
    }
    if (!args.store) return { success: false, error: "action 'db' with op '" + op + "' requires 'store'" };
    if (Array.prototype.indexOf.call(db.objectStoreNames, args.store) === -1) {
        return { success: false, error: "Unknown store '" + args.store + "'. Stores: " + Array.from(db.objectStoreNames).join(', ') };
    }
    var tx = db.transaction([args.store], 'readonly');
    var store = tx.objectStore(args.store);
    if (op === 'get') {
        if (args.key === undefined || args.key === null) return { success: false, error: "op 'get' requires 'key'" };
        var rec = await new Promise(function(resolve, reject) {
            var rq = store.get(args.key);
            rq.onsuccess = function() { resolve(rq.result); };
            rq.onerror = function() { reject(rq.error || new Error('IDB get failed')); };
        });
        if (args.path) {
            // Drill into the fetched record with the same dot/bracket syntax
            // as action:'get', but walked over the PLAIN record — not window.
            var getTokens;
            try { getTokens = _riParsePath(args.path); } catch (ePath) {
                return { success: false, error: 'Invalid path: ' + String((ePath && ePath.message) || ePath) };
            }
            var walked = (rec === undefined) ? { exists: false, value: undefined } : _riWalkTokens(rec, getTokens);
            return { success: true, store: args.store, key: args.key, path: args.path, exists: walked.exists, value: _riSafeSerialize(walked.value) };
        }
        var recExists = rec !== undefined;
        return { success: true, found: recExists, exists: recExists, record: _riSafeSerialize(rec) };
    }
    if (op === 'query') {
        var limit = (typeof args.limit === 'number' && args.limit > 0) ? Math.min(args.limit, 100) : 20;
        var recs = await new Promise(function(resolve, reject) {
            var rq = store.getAll(null, limit);
            rq.onsuccess = function() { resolve(rq.result || []); };
            rq.onerror = function() { reject(rq.error || new Error('IDB getAll failed')); };
        });
        return { success: true, count: recs.length, limit: limit, records: recs.map(function(r) { return _riSafeSerialize(r); }) };
    }
    if (op === 'count') {
        var total = await new Promise(function(resolve, reject) {
            var rq = store.count();
            rq.onsuccess = function() { resolve(rq.result); };
            rq.onerror = function() { reject(rq.error || new Error('IDB count failed')); };
        });
        return { success: true, store: args.store, count: total };
    }
    if (op === 'grep') {
        if (!args.pattern || typeof args.pattern !== 'string') return { success: false, error: "op 'grep' requires a 'pattern' string" };
        var regex;
        try {
            regex = new RegExp(args.pattern, (typeof args.flags === 'string') ? args.flags : 'i');
        } catch (eRe) {
            return { success: false, error: 'Invalid regex: ' + String((eRe && eRe.message) || eRe) };
        }
        var subTokens = null;
        if (args.path) {
            try { subTokens = _riParsePath(args.path); } catch (ePa) {
                return { success: false, error: 'Invalid path: ' + String((ePa && ePa.message) || ePa) };
            }
        }
        var maxMatches = (typeof args.limit === 'number' && args.limit > 0) ? Math.min(args.limit, 100) : 20;
        var SCAN_CAP = 1048576; // ~1MB of string leaves scanned per record
        var matches = [];
        var recordsScanned = 0;
        var recordsCapped = 0;
        var truncated = false;
        // Recursively walk one record's (sub)tree, regex-testing STRING leaves.
        // Fully synchronous on purpose — an IDB cursor transaction dies if we
        // await mid-iteration, so all scanning happens inside onsuccess.
        function scanRecord(primaryKey, recVal) {
            recordsScanned++;
            var root = recVal;
            var prefix = '';
            if (subTokens) {
                var drilled = _riWalkTokens(recVal, subTokens);
                if (!drilled.exists) return;
                root = drilled.value;
                prefix = args.path;
            }
            var scanned = 0;
            var capHit = false;
            var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
            function walk(v, p) {
                // truncated = matches were (potentially) dropped because the
                // match limit was hit. Per-record scan-cap hits are reported
                // separately via records_capped, NOT via truncated.
                if (matches.length >= maxMatches) { truncated = true; return; }
                if (scanned >= SCAN_CAP) { capHit = true; return; }
                if (typeof v === 'string') {
                    // Enforce the cap BEFORE regex-scanning: slice an oversized
                    // leaf to the remaining budget instead of scanning it fully.
                    var budget = SCAN_CAP - scanned;
                    var s = v;
                    if (s.length > budget) { s = s.slice(0, budget); capHit = true; }
                    scanned += s.length;
                    regex.lastIndex = 0;
                    var m = regex.exec(s);
                    if (m) {
                        var from = Math.max(0, m.index - 60);
                        var to = Math.min(s.length, m.index + m[0].length + 60);
                        matches.push({
                            key: primaryKey,
                            path: p,
                            excerpt: (from > 0 ? '…' : '') + s.slice(from, to) + (to < s.length || s.length < v.length ? '…' : '')
                        });
                    }
                    return;
                }
                if (v === null || typeof v !== 'object') return;
                if (seen) {
                    if (seen.has(v)) return; // structured-clone data CAN be circular
                    seen.add(v);
                }
                if (Array.isArray(v)) {
                    for (var i = 0; i < v.length; i++) walk(v[i], p + '[' + i + ']');
                    return;
                }
                var keys;
                try { keys = Object.keys(v); } catch (eK) { return; }
                for (var k = 0; k < keys.length; k++) {
                    var kk = keys[k];
                    var seg = /^[A-Za-z_$][\w$]*$/.test(kk)
                        ? (p ? p + '.' + kk : kk)
                        : p + "['" + String(kk).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
                    walk(v[kk], seg);
                }
            }
            walk(root, prefix);
            if (capHit) recordsCapped++;
        }
        var keyFound = null;
        if (args.key !== undefined && args.key !== null) {
            var one = await new Promise(function(resolve, reject) {
                var rq = store.get(args.key);
                rq.onsuccess = function() { resolve(rq.result); };
                rq.onerror = function() { reject(rq.error || new Error('IDB get failed')); };
            });
            keyFound = one !== undefined;
            if (keyFound) scanRecord(args.key, one);
        } else {
            await new Promise(function(resolve, reject) {
                var rq = store.openCursor();
                rq.onsuccess = function() {
                    var cursor = rq.result;
                    if (!cursor) { resolve(); return; }
                    if (matches.length >= maxMatches) { truncated = true; resolve(); return; }
                    scanRecord(cursor.primaryKey, cursor.value);
                    cursor.continue();
                };
                rq.onerror = function() { reject(rq.error || new Error('IDB openCursor failed')); };
            });
        }
        var grepResult = { success: true, store: args.store, pattern: args.pattern, matches: matches, truncated: truncated, records_scanned: recordsScanned, records_capped: recordsCapped };
        if (keyFound !== null) grepResult.key_found = keyFound;
        return grepResult;
    }
    return { success: false, error: "Unknown db op '" + op + "' (use 'list', 'get', 'query', 'count' or 'grep')" };
}

async function _riScreenshot() {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.captureVisibleTab) {
        return { success: false, error: 'chrome.tabs.captureVisibleTab is unavailable in this context' };
    }
    var tab = await new Promise(function(resolve) {
        try { chrome.tabs.getCurrent(function(t) { resolve(t || null); }); } catch (e) { resolve(null); }
    });
    if (!tab) {
        // Side panel pages have no tab of their own — captureVisibleTab would
        // shoot whatever site the active tab shows, not the panel.
        return { success: false, error: 'This panel runs in the side panel (no own tab) — screenshot would capture the active website instead. Open the panel in a full tab (app.html) and retry.' };
    }
    if (tab.active === false) {
        // captureVisibleTab shoots the ACTIVE tab of the window — if this
        // panel tab is backgrounded we would silently capture the wrong tab.
        return { success: false, error: 'The panel tab is not the active tab in its window — focus it first, then retry.' };
    }
    var dataUrl = await new Promise(function(resolve, reject) {
        try {
            chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, function(url) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(url);
            });
        } catch (e) { reject(e); }
    });
    // Downscale to ≤1200px wide for token efficiency.
    var img = new Image();
    await new Promise(function(resolve, reject) {
        img.onload = resolve;
        img.onerror = function() { reject(new Error('Failed to decode captured image')); };
        img.src = dataUrl;
    });
    var scale = Math.min(1, 1200 / (img.width || 1200));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { success: true, width: canvas.width, height: canvas.height, base64: canvas.toDataURL('image/jpeg', 0.85) };
}

function _riUiState() {
    function g(name) { try { return window[name]; } catch (e) { return undefined; } }
    var chatsMap = g('chats') || {};
    var running = g('runningChatIds') || {};
    var chatSummaries = Object.values(chatsMap)
        .sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .slice(0, 50)
        .map(function(c) {
            return { id: c.id, title: c.title, msgCount: (c.messages || []).length, running: !!running[c.id], isSubAgent: !!c.isSubAgent };
        });
    var approvals = Object.keys(g('pendingToolApprovals') || {}).map(function(k) {
        var v = (g('pendingToolApprovals') || {})[k] || {};
        return { key: k, tool: v.toolName || v.name || null };
    });
    var widgets = {};
    var cw = g('chatWidgets') || {};
    Object.keys(cw).forEach(function(cid) {
        widgets[cid] = (cw[cid] || []).map(function(w) { return w.id; });
    });
    return {
        success: true,
        state: _riSafeSerialize({
            currentChatId: g('currentChatId'),
            currentView: g('currentView'),
            activeStreamingChatId: g('activeStreamingChatId'),
            runningChatIds: Object.keys(running).filter(function(c) { return running[c]; }),
            pausedChats: Object.keys(g('pausedChats') || {}).filter(function(c) { return (g('pausedChats') || {})[c]; }),
            chatCount: Object.keys(chatsMap).length,
            chats: chatSummaries,
            pendingToolApprovals: approvals,
            widgets: widgets,
            lastApiError: g('lastApiError'),
            llmConnectionStatus: g('llmConnectionStatus'),
            sidebarCollapsed: g('sidebarCollapsed'),
            settingsPanelOpen: g('settingsPanelOpen'),
            appTheme: g('appTheme'),
            currentIframeUrl: g('currentIframeUrl'),
            hooksEnabled: g('hooksEnabled'),
            activeSkills: Object.keys(g('activeSkills') || {}),
            devMode: !!window._pageDevModeActive
        })
    };
}

function _riSetView(view) {
    var map = {
        home: function() { openHomeView(); },
        chat: function() {
            if (typeof currentChatId !== 'undefined' && currentChatId && typeof chats !== 'undefined' && chats[currentChatId]) {
                openChatFromJobsDropdown(currentChatId);
            } else {
                closeHomeView();
            }
        },
        dashboard: function() { openDashboardView(); },
        skills: function() { openSkillsView(); },
        documents: function() { openDocumentsView(); },
        history: function() { openHistoryView(); },
        docs: function() { openDocsView(); },
        settings: function() { openSettingsPageView(); }
    };
    if (!map[view]) {
        return { success: false, error: "Unknown view '" + view + "'. Valid: " + Object.keys(map).join(', ') };
    }
    map[view]();
    return { success: true, view: (typeof currentView !== 'undefined') ? currentView : view };
}

// ---- set: CSP-safe write of a page-context state variable ----
// Resolves the PARENT of the path and assigns the final segment.
// _riResolvePath already throws a clear error when an intermediate
// segment is null/undefined, so a missing parent never crashes here.
async function _riSet(args) {
    if (!args.path) return { success: false, error: "action 'set' requires 'path'" };
    // Prototype-pollution guard (writes only — reads via 'get'/'call' stay
    // allowed): refuse to assign through __proto__/constructor/prototype.
    var setTokens = _riParsePath(args.path);
    for (var st = 0; st < setTokens.length; st++) {
        var seg = String(setTokens[st]);
        if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
            return { success: false, error: "action 'set' rejects path segment '" + seg + "' (prototype-pollution guard — reads are still allowed)" };
        }
    }
    var resolved = _riResolvePath(args.path);
    if (resolved.parent === null || resolved.parent === undefined) {
        return { success: false, error: "Cannot set '" + args.path + "' — resolved parent object is " + String(resolved.parent) };
    }
    var oldValue = resolved.value;
    resolved.parent[resolved.lastToken] = args.value;
    var calledAfter = false;
    if (args.call_after) {
        try {
            var fn = _riResolvePath(args.call_after);
            if (typeof fn.value !== 'function') {
                throw new Error("'" + args.call_after + "' is " + (typeof fn.value) + ", not a function");
            }
            await fn.value.apply(fn.parent, []);
            calledAfter = true;
        } catch (e) {
            // The write itself succeeded — report that, but surface the call_after failure.
            return { success: true, path: args.path, old_value: _riSafeSerialize(oldValue), called_after: false, call_after_error: String((e && e.message) || e) };
        }
    }
    return { success: true, path: args.path, old_value: _riSafeSerialize(oldValue), called_after: calledAfter };
}

// ---- dispatch: emit an internal event (bus / sw / dom targets) ----
// target:'bus' (default) — AgentEvents.emit(event, payload) in page context,
//   invoking the REAL page-side handlers (renders, chat updates). Emit is
//   synchronous and swallows handler throws (app/035-agent-events.js).
// target:'sw'  — posts {type: event, ...payload} to the service worker over
//   the agent bus port, hitting the SW port-bridge inbound switch
//   (worker/130-port-bridge.js: pull-chat, toggle-pause, interrupt, …).
// target:'dom' — fires a DOM event on an element of the PANEL PAGE's own
//   document, NOT the ServiceNow iframe (use iframe_tool for that).
var _riMouseEvents = { click: 1, dblclick: 1, mousedown: 1, mouseup: 1, mousemove: 1, mouseenter: 1, mouseleave: 1, mouseover: 1, mouseout: 1, contextmenu: 1 };

function _riDispatchDom(args) {
    if (!args.selector) return { success: false, error: "dispatch target 'dom' requires 'selector'" };
    if (!args.event) return { success: false, error: "dispatch target 'dom' requires 'event'" };
    var el;
    try { el = document.querySelector(args.selector); } catch (e) {
        return { success: false, error: 'Invalid selector: ' + String((e && e.message) || e) };
    }
    if (!el) return { success: true, target: 'dom', matched: false, dispatched: false };
    if (args.event === 'click' && !args.options) {
        el.click();
        return { success: true, target: 'dom', matched: true, tagName: el.tagName, dispatched: true };
    }
    var init = { bubbles: true, cancelable: true };
    if (args.options) {
        for (var k in args.options) {
            if (Object.prototype.hasOwnProperty.call(args.options, k)) init[k] = args.options[k];
        }
    }
    var evt;
    if (_riMouseEvents[args.event]) evt = new MouseEvent(args.event, init);
    else if (args.event.indexOf('key') === 0) evt = new KeyboardEvent(args.event, init);
    else if (args.event === 'input' && typeof InputEvent !== 'undefined') evt = new InputEvent(args.event, init);
    else evt = new Event(args.event, init);
    el.dispatchEvent(evt);
    return { success: true, target: 'dom', matched: true, tagName: el.tagName, dispatched: true };
}

function _riDispatch(args) {
    var target = args.target || 'bus';
    if (target === 'dom') return _riDispatchDom(args);
    if (!args.event) return { success: false, error: "action 'dispatch' requires 'event'" };
    if (target === 'bus') {
        if (typeof AgentEvents === 'undefined' || !AgentEvents || typeof AgentEvents.emit !== 'function') {
            return { success: false, error: 'AgentEvents bus is unavailable in this context' };
        }
        // Diagnostic hint only — emit with zero listeners is a silent no-op by design.
        var hadListeners;
        try { hadListeners = (typeof AgentEvents._types === 'function') ? AgentEvents._types().indexOf(args.event) !== -1 : undefined; } catch (e2) { hadListeners = undefined; }
        AgentEvents.emit(args.event, args.payload || {});
        return { success: true, target: 'bus', event: args.event, emitted: true, had_listeners: hadListeners };
    }
    if (target === 'sw') {
        if (typeof _agentBusPort === 'undefined' || !_agentBusPort) {
            return { success: false, error: 'No agent-bus port to the service worker is connected' };
        }
        var msg = { type: args.event };
        if (args.payload && typeof args.payload === 'object') {
            for (var pk in args.payload) {
                if (Object.prototype.hasOwnProperty.call(args.payload, pk) && pk !== 'type') msg[pk] = args.payload[pk];
            }
        }
        _agentBusPort.postMessage(msg);
        return { success: true, target: 'sw', event: args.event, posted: true };
    }
    return { success: false, error: "Unknown dispatch target '" + target + "' (use 'bus', 'sw' or 'dom')" };
}

// ---- main executor ----
async function executeRuntimeInspect(args) {
    args = args || {};
    // Dev-mode gate — the EXACT Reload-rebuilds condition. Fail closed.
    var devMode = false;
    try {
        if (typeof _reloadRebuildsFromWorkspace === 'function') devMode = !!(await _reloadRebuildsFromWorkspace());
    } catch (e) { devMode = false; }
    if (!devMode) {
        return { success: false, error: 'runtime_inspect is available only in extension dev mode (extension-dev skill active AND deploy folder connected in Settings > GitHub).' };
    }
    try {
        switch (args.action) {
            case 'ui_state':
                return _riUiState();
            case 'get': {
                if (!args.path) return { success: false, error: "action 'get' requires 'path'" };
                var got = _riResolvePath(args.path);
                return { success: true, exists: got.value !== undefined, value: _riSafeSerialize(got.value) };
            }
            case 'call': {
                if (!args.path) return { success: false, error: "action 'call' requires 'path'" };
                var resolved = _riResolvePath(args.path);
                if (typeof resolved.value !== 'function') {
                    return { success: false, error: "'" + args.path + "' is " + (typeof resolved.value) + ", not a function" };
                }
                var callArgs = Array.isArray(args.args) ? args.args : [];
                var rv = await resolved.value.apply(resolved.parent, callArgs);
                return { success: true, result: _riSafeSerialize(rv) };
            }
            case 'set':
                return await _riSet(args);
            case 'dispatch':
                return _riDispatch(args);
            case 'db':
                return await _riDb(args);
            case 'sw_state': {
                var state = await _riPullSwDebugState();
                return { success: true, state: _riSafeSerialize(state) };
            }
            case 'screenshot':
                return await _riScreenshot();
            case 'new_chat': {
                if (args.focus === false) {
                    var id = generateId();
                    chats[id] = { id: id, title: 'New Chat', messages: [], createdAt: Date.now(), isTemporary: true };
                    if (typeof renderChatList === 'function') renderChatList();
                    return { success: true, chatId: id, focused: false };
                }
                newChat();
                return { success: true, chatId: (typeof currentChatId !== 'undefined') ? currentChatId : null, focused: true };
            }
            case 'focus_chat': {
                if (!args.chatId) return { success: false, error: "action 'focus_chat' requires 'chatId'" };
                if (typeof chats === 'undefined' || !chats[args.chatId]) {
                    return { success: false, error: "Unknown chatId '" + args.chatId + "'" };
                }
                openChatFromJobsDropdown(args.chatId);
                return { success: true, chatId: args.chatId };
            }
            case 'set_view':
                if (!args.view) return { success: false, error: "action 'set_view' requires 'view'" };
                return _riSetView(args.view);
            default:
                return { success: false, error: "Unknown action '" + args.action + "'. Valid: ui_state, get, call, set, dispatch, db, sw_state, screenshot, new_chat, focus_chat, set_view" };
        }
    } catch (e2) {
        return { success: false, error: String((e2 && e2.message) || e2) };
    }
}

// ---- dispatch hook ----
// tools/020-tool-execution.js is owned by another in-flight change, so we
// register by wrapping the global executeTool instead of adding a dispatch
// arm there. Safe because: (a) this file loads AFTER tools/020 (same tier,
// higher prefix) and BEFORE the app tier, (b) `executeTool` is a function
// declaration → a reassignable binding, and (c) every caller (page exec-tool
// handler in app/045, direct panel dispatch) resolves the global at call
// time. Page-only: the worker tier never loads this file, and the SW routes
// runtime_inspect to a panel because HEADLESS_TOOLS marks it false.
if (typeof Platform === 'undefined' || !Platform || !Platform.isWorker) {
    var _riInnerExecuteTool = executeTool;
    executeTool = async function(name) {
        if (name === 'runtime_inspect') {
            var riArgs = arguments[1] || {};
            var riOptions = arguments[3];
            // Permission gate — this wrapper short-circuits BEFORE the shared
            // dispatcher (_executeToolInner in tools/020-tool-execution.js), so
            // the ask/disabled Settings behind the 'runtime_inspect' permission
            // key (core/070-permissions.js GLOBAL_WRITE_KEYS) must be enforced
            // here, with the exact call + denial shape the dispatcher uses.
            if (typeof requestProgrammaticToolApproval !== 'undefined') {
                var riApproval = await requestProgrammaticToolApproval('runtime_inspect', riArgs, riOptions);
                if (!riApproval.allowed) {
                    return { success: false, error: riApproval.error, _denied: true };
                }
            } else {
                // Fail CLOSED: if the approval helper is unavailable we cannot
                // enforce the 'runtime_inspect' permission, so deny rather than
                // silently bypassing the ask/disabled Settings gate.
                return { success: false, error: 'runtime_inspect: permission approval unavailable' };
            }
            return executeRuntimeInspect(riArgs);
        }
        return _riInnerExecuteTool.apply(this, arguments);
    };
}
