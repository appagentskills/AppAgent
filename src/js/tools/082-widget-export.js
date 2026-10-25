// WIDGET EXPORT - self-contained "Export to HTML" for widgets
// =============================================
// One exporter shared by the UI header buttons (exportWidgetHtmlDownload) and
// the agent tool (html_widget action:'export' in tools/080-widget-tools.js).
//
// Capture strategy:
//  1. Start from the SAVED html of the requested (or latest) version, so the
//     widget's scripts run exactly once when the exported file is opened (a live
//     DOM snapshot with scripts kept would re-run them and duplicate content).
//  2. Pre-resolve asset calls: executeTool("get_file"|"screenshot_by_id", {id})
//     with literal ids (plus any quoted file_/ss_ id literal in the html) are
//     resolved to data URLs and baked into a window.executeTool shim, so widgets
//     that load their images through the bridge (galleries, tabs, lightbox)
//     still work offline. Every other tool rejects "Not available in exported HTML"
//     standalone; when the file is re-rendered inside AppAgent, misses fall through
//     to the live page bridge (see the accessor in widgetExportBuildShim).
//  3. If the widget computes ids dynamically and no candidate id literal exists,
//     fall back to the LIVE DOM (__appagentSerializeForCapture): scripts and
//     inline handlers are removed (static snapshot) -> source:'live-snapshot'.
//  4. Embed every remaining asset as a data URL (img/srcset/source/poster/icon,
//     CSS url() in <style> and style="", <link rel=stylesheet>, <script src>, blob:).
//  5. Inline the design tokens for the CURRENT theme.
//
// Record & replay (local_folder and other read-only bridge calls):
//  - The page-side widget bridge (ui/070-dashboard-ui.js widgetToolCall
//    handler) records every READ-ONLY call a widget makes (local_folder
//    read/ls/list, get_file, screenshot_by_id) with its result, per widget id,
//    in an in-memory LRU (WIDGET_EXPORT_RECORD_CAP_BYTES), keyed by the
//    canonical JSON of {name,args}. Writes and servicenow_api are never recorded.
//  - At export the records are baked into the shim, which replays the exact
//    result for a canonically identical call (key order does not matter); a
//    local_folder read also matches on folder+path alone (encoding/thumbnail
//    ignored; a thumbnail request gets the full data_url as thumbnail.data_url).
//  - Literal executeTool("local_folder",{action,folder,path}) calls are also
//    pre-resolved statically (programmatic caller, encoding:'base64').
//  - A widget that is neither rendered nor recorded is briefly mounted
//    off-screen through the normal pipeline (_mountWidgetIframe) so its reads
//    get recorded; non-read-only calls from that hidden render are refused.

var WIDGET_EXPORT_SIZE_WARN_BYTES = 20 * 1024 * 1024;
var WIDGET_EXPORT_ASSET_TOOLS = { get_file: true, screenshot_by_id: true };
var WIDGET_EXPORT_RECORD_CAP_BYTES = 200 * 1024 * 1024;
var WIDGET_EXPORT_LF_READ_ACTIONS = { read: true, ls: true, list: true };
var WIDGET_EXPORT_IDLE_MS = 1500;
var WIDGET_EXPORT_RENDER_MAX_MS = 20000;

// ---- pure helpers (unit-tested in test/widget-export.test.js) --------------

// Find executeTool(...) calls in widget source. Returns
// { ids:[{tool,id}], dynamic:<count of asset calls without a literal id>,
//   otherTools:[names], candidateIds:[quoted file_/ss_ literals],
//   localFolder:[literal args of read-only local_folder calls whose action and
//   path (and folder, when given) are literals], localDynamic:<count of
//   read-only local_folder calls with computed args> }.
// local_folder is listed in otherTools only for a literal NON-read action.
function widgetExportExtractAssetCalls(source) {
    var out = { ids: [], dynamic: 0, otherTools: [], candidateIds: [], localFolder: [], localDynamic: 0, localDynamicFolders: [], pathCandidates: [] };
    if (!source || typeof source !== 'string') return out;
    var seen = {};
    var callRe = /executeTool\s*\(\s*(['"`])([A-Za-z0-9_]+)\1\s*(?:,\s*([^)]*))?\)/g;
    var m;
    while ((m = callRe.exec(source))) {
        var tool = m[2];
        var argText = m[3] || '';
        if (WIDGET_EXPORT_ASSET_TOOLS[tool]) {
            var idm = /(?:^|[{,\s])['"]?id['"]?\s*:\s*(['"`])([^'"`$]+)\1/.exec(argText);
            if (idm) {
                if (!seen[idm[2]]) { seen[idm[2]] = true; out.ids.push({ tool: tool, id: idm[2] }); }
            } else {
                out.dynamic++;
            }
        } else if (tool === 'local_folder') {
            var lf = widgetExportParseLiteralArgs(argText);
            var act = lf.literal.action;
            if (typeof act === 'string' && !WIDGET_EXPORT_LF_READ_ACTIONS[act]) {
                if (out.otherTools.indexOf(tool) === -1) out.otherTools.push(tool);
            } else if (act === 'list' || (typeof act === 'string' && typeof lf.literal.path === 'string' && !lf.dynamic.folder && !lf.dynamic.path)) {
                var lkey = widgetExportCallKey(tool, lf.literal);
                if (!out.localFolder.some(function(a) { return widgetExportCallKey(tool, a) === lkey; })) out.localFolder.push(lf.literal);
            } else {
                out.localDynamic++;
                // Literal folder of a computed-path read ('' = default folder):
                // paired with pathCandidates for an optional static pre-resolve.
                if (act === 'read' && !lf.dynamic.folder && (lf.literal.folder === undefined || typeof lf.literal.folder === 'string')) {
                    var fk = lf.literal.folder || '';
                    if (out.localDynamicFolders.indexOf(fk) === -1) out.localDynamicFolders.push(fk);
                }
            }
        } else if (out.otherTools.indexOf(tool) === -1) {
            out.otherTools.push(tool);
        }
    }
    var litRe = /(['"`])((?:file|ss)_[A-Za-z0-9_\-]+)\1/g;
    while ((m = litRe.exec(source))) {
        if (out.candidateIds.indexOf(m[2]) === -1) out.candidateIds.push(m[2]);
    }
    // Quoted relative image-path literals (e.g. a gallery's data array): reads
    // with computed paths often index these, incl. lazily-rendered tabs that
    // were never opened (so never recorded).
    var pathRe = /(['"`])([^'"`\s<>${}\\:]{1,200}\.(?:png|jpe?g|gif|webp|svg|avif|bmp))\1/gi;
    while ((m = pathRe.exec(source)) && out.pathCandidates.length < 500) {
        if (m[2].indexOf('//') === -1 && out.pathCandidates.indexOf(m[2]) === -1) out.pathCandidates.push(m[2]);
    }
    return out;
}

// Parse the top-level `key: literal` pairs of an object-literal argument text.
// Returns { literal:{key:value}, dynamic:{key:true} } — a key whose value is not
// a plain string/number/boolean literal (concatenation, variable, template with
// ${}) is reported in dynamic. Nested objects are skipped (neither).
function widgetExportParseLiteralArgs(argText) {
    var out = { literal: {}, dynamic: {} };
    var s = String(argText || '').trim();
    if (s.charAt(0) !== '{') return out;
    // Blank nested objects/arrays so only top-level pairs are parsed.
    var inner = s.slice(1), prev;
    do { prev = inner; inner = inner.replace(/\{[^{}]*\}/g, '{}').replace(/\[[^\[\]]*\]/g, '[]'); } while (inner !== prev);
    s = '{' + inner;
    var re = /(?:^|[{,])\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*/g;
    var m;
    while ((m = re.exec(s))) {
        var key = m[1], rest = s.slice(re.lastIndex);
        var lit = /^(?:(['"])((?:\\.|(?!\1)[^\\])*)\1|`([^`$]*)`|(-?\d+(?:\.\d+)?)|(true|false))\s*(?=[,}]|$)/.exec(rest);
        if (lit) {
            out.literal[key] = lit[1] ? lit[2].replace(/\\(.)/g, '$1') : lit[3] != null ? lit[3] : lit[4] != null ? Number(lit[4]) : lit[5] === 'true';
            re.lastIndex += lit[0].length;
        } else if (rest.charAt(0) !== '{' && rest.charAt(0) !== '[') {
            out.dynamic[key] = true;
        }
    }
    return out;
}

// Stable JSON: object keys sorted, undefined members dropped. The export shim
// carries an equivalent ES5 copy (WIDGET_EXPORT_SHIM_KEY_SRC; equivalence is
// unit-tested) — Function#toString is not used because instrumenting
// loaders/builds may rewrite function bodies.
function widgetExportCanonicalJson(v) {
    if (v === undefined || typeof v === 'function') return undefined;
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
        var a = [];
        for (var i = 0; i < v.length; i++) { var e = widgetExportCanonicalJson(v[i]); a.push(e === undefined ? 'null' : e); }
        return '[' + a.join(',') + ']';
    }
    var keys = Object.keys(v).sort(), parts = [];
    for (var j = 0; j < keys.length; j++) {
        var c = widgetExportCanonicalJson(v[keys[j]]);
        if (c !== undefined) parts.push(JSON.stringify(keys[j]) + ':' + c);
    }
    return '{' + parts.join(',') + '}';
}

function widgetExportCallKey(name, args) {
    return widgetExportCanonicalJson({ name: String(name), args: args || {} });
}

// Shim copies of widgetExportCanonicalJson (K) and widgetExportLocalReadKey (L).
var WIDGET_EXPORT_SHIM_KEY_SRC =
    'var K=function(v){if(v===undefined||typeof v==="function")return undefined;' +
        'if(v===null||typeof v!=="object")return JSON.stringify(v);' +
        'if(Array.isArray(v)){var a=[];for(var i=0;i!==v.length;i++){var e=K(v[i]);a.push(e===undefined?"null":e);}return "["+a.join(",")+"]";}' +
        'var ks=Object.keys(v).sort(),p=[];for(var j=0;j!==ks.length;j++){var c=K(v[ks[j]]);if(c!==undefined)p.push(JSON.stringify(ks[j])+":"+c);}' +
        'return "{"+p.join(",")+"}";};' +
    'var L=function(a){a=a||{};var p=String(a.path==null?"":a.path).replace(/\\\\/g,"/").replace(/^(\\.\\/)+/,"").replace(/\\/+/g,"/").replace(/^\\/|\\/$/g,"");' +
        'return String(a.folder||"virtual")+"|"+p;};';

// folder|path identity of a local_folder read (encoding/thumbnail ignored).
function widgetExportLocalReadKey(args) {
    args = args || {};
    var p = String(args.path == null ? '' : args.path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return String(args.folder || 'virtual') + '|' + p;
}

// Read-only bridge calls that may be recorded/replayed. Never servicenow_api,
// never a local_folder write/delete/mkdir/grep/request.
function widgetExportIsRecordable(name, args) {
    if (name === 'get_file' || name === 'screenshot_by_id') return true;
    if (name === 'local_folder') return !!(args && WIDGET_EXPORT_LF_READ_ACTIONS[args.action] === true);
    return false;
}

// Rough byte size of a result (string lengths dominate: data URLs).
function widgetExportApproxSize(v, depth) {
    depth = depth || 0;
    if (v == null) return 4;
    if (typeof v === 'string') return v.length + 2;
    if (typeof v !== 'object') return 8;
    if (depth > 8) return 16;
    var n = 2;
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) n += widgetExportApproxSize(v[i], depth + 1) + 1; return n; }
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) n += k.length + 3 + widgetExportApproxSize(v[k], depth + 1);
    return n;
}

// In-memory per-widget recorder with a global LRU byte cap (oldest-used
// entries dropped first) plus per-widget activity (in-flight count, last call).
function widgetExportCreateRecorder(capBytes) {
    var cap = capBytes > 0 ? capBytes : WIDGET_EXPORT_RECORD_CAP_BYTES;
    var lru = new Map(), total = 0, activity = {};
    function drop(lk) { var e = lru.get(lk); if (e) { total -= e.bytes; lru.delete(lk); } }
    function record(widgetId, name, args, result) {
        if (!widgetId || !widgetExportIsRecordable(name, args)) return false;
        if (!result || typeof result !== 'object' || result.success === false || result.error) return false;
        var key = widgetExportCallKey(name, args);
        var bytes = widgetExportApproxSize(result) + key.length;
        if (bytes > cap) return false;
        var lk = widgetId + '\n' + key;
        drop(lk);
        lru.set(lk, { widgetId: widgetId, key: key, name: name, args: JSON.parse(widgetExportCanonicalJson(args || {})), result: result, bytes: bytes });
        total += bytes;
        while (total > cap && lru.size) drop(lru.keys().next().value);
        return true;
    }
    // key -> entry for one widget; touch=true marks them recently used.
    function entries(widgetId, touch) {
        var out = {}, hit = [];
        lru.forEach(function(e, lk) { if (e.widgetId === widgetId) { out[e.key] = e; hit.push(lk); } });
        if (touch) hit.forEach(function(lk) { var e = lru.get(lk); lru.delete(lk); lru.set(lk, e); });
        return out;
    }
    function clear(widgetId) {
        Array.from(lru.keys()).forEach(function(lk) { if (lru.get(lk).widgetId === widgetId) drop(lk); });
        delete activity[widgetId];
    }
    function note(widgetId, starting) {
        if (!widgetId) return;
        var a = activity[widgetId] || (activity[widgetId] = { inflight: 0, last: 0 });
        a.inflight = Math.max(0, a.inflight + (starting ? 1 : -1));
        a.last = Date.now();
    }
    return {
        record: record, entries: entries, clear: clear, note: note,
        activity: function(id) { return activity[id] || { inflight: 0, last: 0 }; },
        totalBytes: function() { return total; }, size: function() { return lru.size; }
    };
}

var _wexRecorder = widgetExportCreateRecorder(WIDGET_EXPORT_RECORD_CAP_BYTES);

// Bridge entry points (ui/070-dashboard-ui.js widgetToolCall handler,
// core/135-widget-store.js remove).
function widgetExportRecordCall(widgetId, name, args, result) { try { return _wexRecorder.record(widgetId, name, args, result); } catch (e) { return false; } }
function widgetExportNoteCall(widgetId, starting) { _wexRecorder.note(widgetId, starting); }
function widgetExportClearRecords(widgetId) { _wexRecorder.clear(widgetId); }
function widgetExportRecordedCalls(widgetId) { return _wexRecorder.entries(widgetId, true); }

// True when the iframe belongs to the hidden export pre-render container.
function widgetExportIsOffscreenIframe(iframe) {
    try {
        var root = iframe && iframe.getRootNode ? iframe.getRootNode() : null;
        var el = (root && root.host) ? root.host : iframe;
        return !!(el && el.closest && el.closest('[data-wex-offscreen]'));
    } catch (e) { return false; }
}

// Widget id to record a call under: the DOM-derived id, else the fullscreen
// overlay / split pane owner (those containers carry no data-widget-id).
function widgetExportRecordingId(iframe, derivedId) {
    if (derivedId) return derivedId;
    try {
        if (iframe && iframe.closest) {
            if (iframe.closest('#widget-fullscreen-overlay') && typeof expandedWidgetId !== 'undefined' && expandedWidgetId) return expandedWidgetId;
            var pane = iframe.closest('#split-widget-pane');
            if (pane && pane.dataset && pane.dataset.widgetId) return pane.dataset.widgetId;
        }
    } catch (e) {}
    return null;
}

// List the url(...) references in a CSS string (unquoted, de-duplicated, data: skipped).
function widgetExportCssUrls(css) {
    var urls = [];
    if (!css || typeof css !== 'string') return urls;
    var re = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
    var m;
    while ((m = re.exec(css))) {
        var u = m[2].trim();
        if (!u || /^data:/i.test(u) || u.charAt(0) === '#') continue;
        if (urls.indexOf(u) === -1) urls.push(u);
    }
    return urls;
}

// Rewrite url(...) references using map {originalUrl: replacement}; unmapped stay.
function widgetExportRewriteCssUrls(css, map) {
    if (!css || typeof css !== 'string') return css;
    map = map || {};
    return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, function(all, q, u) {
        var key = u.trim();
        return Object.prototype.hasOwnProperty.call(map, key) ? 'url("' + map[key] + '")' : all;
    });
}

// Pack replay results for the shim: big strings equal to an asset become
// {__wexA:id}, other big strings are pooled once in D as {__wexD:n}.
// Returns { C:{key:packedResult}, D:[strings], R:{folder|path: key} }.
function widgetExportPackCalls(calls, assets) {
    assets = assets || {};
    var byVal = {}, pool = [], poolIdx = {}, C = {}, R = {};
    Object.keys(assets).forEach(function(id) { if (typeof assets[id] === 'string' && !byVal[assets[id]]) byVal[assets[id]] = id; });
    function pack(v, depth) {
        if (typeof v === 'string') {
            if (v.length < 1024) return v;
            if (Object.prototype.hasOwnProperty.call(byVal, v)) return { __wexA: byVal[v] };
            if (!Object.prototype.hasOwnProperty.call(poolIdx, v)) { poolIdx[v] = pool.length; pool.push(v); }
            return { __wexD: poolIdx[v] };
        }
        if (!v || typeof v !== 'object' || depth > 8) return v;
        if (Array.isArray(v)) return v.map(function(x) { return pack(x, depth + 1); });
        var o = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = pack(v[k], depth + 1);
        return o;
    }
    Object.keys(calls || {}).forEach(function(key) {
        var e = calls[key];
        C[key] = pack(e.result, 0);
        if (e.name === 'local_folder' && e.args && e.args.action === 'read') {
            var rk = widgetExportLocalReadKey(e.args), prev = R[rk];
            // Prefer the entry that carries the full data_url.
            if (!prev || (!(calls[prev].result && calls[prev].result.data_url) && e.result && e.result.data_url)) R[rk] = key;
        }
    });
    return { C: C, D: pool, R: R };
}

// The window.executeTool shim embedded as the first <head> script. assets maps
// id -> data URL; calls (optional) maps canonical key -> {name,args,result}
// (record & replay + static local_folder). '<' is escaped so a data URL can
// never close the script tag.
function widgetExportBuildShim(assets, calls) {
    var esc = function(v) { return JSON.stringify(v).replace(/</g, '\\u003c'); };
    var p = widgetExportPackCalls(calls, assets);
    return '(function(){' +
        'var A=' + esc(assets || {}) + ';' +
        'var C=' + esc(p.C) + ';var D=' + esc(p.D) + ';var R=' + esc(p.R) + ';' +
        WIDGET_EXPORT_SHIM_KEY_SRC +
        'window.__appagentExportKey=function(n,a){return K({name:String(n),args:a||{}});};window.__appagentExportReadKey=L;' +
        'var H=function(o,k){return Object.prototype.hasOwnProperty.call(o,k);};' +
        'var U=function(v){if(!v||typeof v!=="object")return v;' +
            'if(H(v,"__wexA"))return A[v.__wexA];if(H(v,"__wexD"))return D[v.__wexD];' +
            'if(Array.isArray(v))return v.map(U);var o={};for(var k in v)if(H(v,k))o[k]=U(v[k]);return o;};' +
        'window.__appagentExportAssets=A;window.__appagentExportCalls=C;' +
        // Live passthrough: if the exported file is rendered again inside AppAgent, the
        // page bridge (070 injectWidgetBridge, inserted before </head> AFTER this shim)
        // assigns window.executeTool. The accessor keeps the shim in front (embedded
        // assets/replays still answer) and forwards misses to that live bridge.
        // Standalone there is no bridge, so misses reject exactly as before.
        'var P=null;var S=function(name,args){' +
            'args=args||{};var k=K({name:name,args:args});' +
            'if(H(C,k))return Promise.resolve(U(C[k]));' +
            'if(name==="local_folder"&&args.action==="read"){var rk=L(args);' +
                'if(H(R,rk)&&H(C,R[rk])){var r=U(C[R[rk]]);' +
                    'if(!r.data_url&&r.file_id&&A[r.file_id])r.data_url=A[r.file_id];' +
                    'if(args.thumbnail&&r.data_url&&!(r.thumbnail&&r.thumbnail.data_url))r.thumbnail={data_url:r.data_url};' +
                    'return Promise.resolve(r);}}' +
            'var u=A[args.id];' +
            'if(u&&name==="get_file"){var r={success:true,id:args.id,data:u,data_url:u};' +
                'if(args.thumbnail)r.thumbnail={data_url:u};return Promise.resolve(r);}' +
            'if(u&&name==="screenshot_by_id")return Promise.resolve({success:true,id:args.id,screenshot_id:args.id,base64:u,data_url:u});' +
            'if(typeof P==="function")return P(name,args);' +
            'return Promise.reject(new Error("Not available in exported HTML: "+name));' +
        '};' +
        'try{Object.defineProperty(window,"executeTool",{configurable:true,enumerable:true,' +
            'get:function(){return S;},set:function(v){if(v!==S)P=v;}});}catch(e){window.executeTool=S;}' +
    '})();';
}

// Size warning (null under the threshold).
function widgetExportSizeWarning(bytes, limit) {
    limit = limit || WIDGET_EXPORT_SIZE_WARN_BYTES;
    if (!(bytes > limit)) return null;
    return 'Exported file is ' + (bytes / 1048576).toFixed(1) + ' MB (over ' + Math.round(limit / 1048576) + ' MB); it may be slow to open or share.';
}

function widgetExportSlug(title) {
    var s = String(title || 'widget').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return s || 'widget';
}

// Theme token <style> for the current app theme.
function widgetExportTokenCss(dark) {
    return ':where(:root){' + WIDGET_TOKENS_STATIC + (dark ? WIDGET_TOKENS_DARK : WIDGET_TOKENS_LIGHT) + '}';
}

function widgetExportIsBridgeScript(text) {
    return /_toolCallbacks|__appagentSerializeForCapture/.test(String(text || ''));
}

// ---- async I/O helpers -----------------------------------------------------

function _wexBlobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
        var fr = new FileReader();
        fr.onload = function() { resolve(fr.result); };
        fr.onerror = function() { reject(fr.error || new Error('read failed')); };
        fr.readAsDataURL(blob);
    });
}

async function _wexResolveAssetId(id, tool) {
    var order = (tool === 'screenshot_by_id' || /^ss_/.test(id)) ? ['ss', 'file'] : ['file', 'ss'];
    for (var i = 0; i < order.length; i++) {
        try {
            var r = order[i] === 'ss'
                ? (typeof executeScreenshotById === 'function' ? await executeScreenshotById({ id: id }) : null)
                : (typeof executeGetFile === 'function' ? await executeGetFile({ id: id }) : null);
            var u = r && (r.base64 || r.data || r.data_url);
            if (typeof u === 'string' && /^data:/i.test(u)) return u;
        } catch (e) { /* try next */ }
    }
    return null;
}

function _wexFindLiveIframe(widgetId) {
    var f = null;
    try { if (typeof getWidgetIframe === 'function') f = getWidgetIframe(widgetId); } catch (e) {}
    if (!f && typeof expandedWidgetId !== 'undefined' && expandedWidgetId === widgetId) f = document.querySelector('#widget-fullscreen-overlay iframe.widget-iframe');
    if (!f) {
        var pane = document.querySelector('#split-widget-pane');
        if (pane && (!pane.dataset || !pane.dataset.widgetId || pane.dataset.widgetId === widgetId)) f = pane.querySelector('iframe');
    }
    return f && f.contentWindow ? f : null;
}

function _wexSerializeLive(iframe) {
    return new Promise(function(resolve) {
        var reqId = 'wex_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        var done = false;
        var timer = setTimeout(function() { finish(null); }, 1500);
        function finish(v) {
            if (done) return; done = true; clearTimeout(timer);
            try { window.removeEventListener('message', onMsg); } catch (e) {}
            resolve(v);
        }
        function onMsg(ev) {
            var d = ev && ev.data;
            if (!d || d.type !== '__appagentSerializedDom' || String(d.reqId) !== reqId) return;
            if (ev.source !== iframe.contentWindow) return;
            finish(d.html || null);
        }
        window.addEventListener('message', onMsg);
        try { iframe.contentWindow.postMessage({ type: '__appagentSerializeForCapture', reqId: reqId }, '*'); } catch (e) { finish(null); }
    });
}

// ---- main exporter ---------------------------------------------------------

async function exportWidgetHtml(widgetId, opts) {
    opts = opts || {};
    var warnings = [];
    if (!widgetId) throw new Error('widget_id is required');
    var view = null;
    try { await WidgetStore.init(); await WidgetStore.read(widgetId); view = WidgetStore.view(widgetId, opts.version); } catch (e) { view = null; }
    if (!view && opts.version) throw new Error('Widget/version not found: ' + widgetId + ' v' + opts.version);
    if (!view) {
        var fb = (typeof getWidgetById === 'function' && getWidgetById(widgetId)) || (typeof dashboardWidgets !== 'undefined' && dashboardWidgets[widgetId]) || null;
        if (fb && fb.html) view = { title: fb.title, html: fb.html };
    }
    if (!view || typeof view.html !== 'string') throw new Error('Widget not found: ' + widgetId);
    var title = view.title || 'Widget';
    var isLatest = !opts.version || !view.latestVersion || Number(opts.version) === Number(view.latestVersion);

    var calls = widgetExportExtractAssetCalls(view.html);
    var liveHtml = null;
    if (isLatest && opts.live !== false) {
        var iframe = _wexFindLiveIframe(widgetId);
        if (iframe) liveHtml = await _wexSerializeLive(iframe);
    }

    // Pre-resolve asset ids (literal call ids + id-looking literals).
    var assets = {};
    var wanted = calls.ids.slice();
    calls.candidateIds.forEach(function(id) { if (!wanted.some(function(w) { return w.id === id; })) wanted.push({ tool: null, id: id }); });
    for (var i = 0; i < wanted.length; i++) {
        var u = await _wexResolveAssetId(wanted[i].id, wanted[i].tool);
        if (u) assets[wanted[i].id] = u;
        else if (wanted[i].tool) warnings.push('Could not resolve ' + wanted[i].tool + ' id ' + wanted[i].id + '; it will fail in the exported file.');
    }

    // Record & replay: recorded read-only bridge calls of this widget. A widget
    // that is neither recorded nor rendered is pre-rendered off-screen.
    var recorded = (typeof widgetExportRecordedCalls === 'function') ? widgetExportRecordedCalls(widgetId) : {};
    var needsCalls = calls.dynamic > 0 || calls.localDynamic > 0;
    if (needsCalls && !Object.keys(recorded).length && !_wexFindLiveIframe(widgetId) && isLatest) {
        var rendered = opts.offscreen !== false && await _wexRenderOffscreen(widgetId, view);
        if (rendered) recorded = widgetExportRecordedCalls(widgetId);
        if (!Object.keys(recorded).length) warnings.push('Widget was not open and loads files at runtime; open the widget once, then export again so its file reads are embedded.');
    }
    var replay = await _wexPrepareReplay(recorded, assets);
    await _wexStaticLocalFolder(calls.localFolder, replay, assets);
    // Computed-path reads: pre-resolve quoted image-path literals in the
    // widget's literal folder(s) so never-opened tabs still replay (folder|path
    // match). Optional: a candidate that is not a real file is skipped silently.
    if (calls.localDynamic > 0 && calls.localDynamicFolders.length && calls.pathCandidates.length) {
        var cand = [];
        calls.localDynamicFolders.forEach(function(f) {
            calls.pathCandidates.forEach(function(p) { cand.push(f ? { action: 'read', folder: f, path: p } : { action: 'read', path: p }); });
        });
        await _wexStaticLocalFolder(cand, replay, assets, true);
    }
    var replayCount = Object.keys(replay.calls).length;
    if (replay.unresolved) warnings.push(replay.unresolved + ' read call(s) could not be resolved/matched; they will fail in the exported file.');
    if (calls.localDynamic > 0 && !replayCount) warnings.push(calls.localDynamic + ' local_folder read call(s) use computed paths and no recorded calls were available; they will fail in the exported file.');

    // Only RESOLVED candidates count: a stray 'file_name'-style literal must not
    // suppress the live-snapshot fallback. Recorded calls also cover dynamic ids.
    var resolvedCandidates = calls.candidateIds.filter(function(id) { return !!assets[id]; }).length;
    var unresolvedDynamic = calls.dynamic > 0 && resolvedCandidates === 0 && !replayCount;
    var source = 'saved';
    var doc;
    if (unresolvedDynamic && liveHtml) {
        source = 'live-snapshot';
        warnings.push('Widget loads assets with dynamically computed ids; exported a static snapshot of the live view (scripts removed, interactivity lost).');
        doc = new DOMParser().parseFromString(liveHtml, 'text/html');
        Array.prototype.forEach.call(doc.querySelectorAll('script'), function(s) { s.remove(); });
        Array.prototype.forEach.call(doc.querySelectorAll('*'), function(el) {
            Array.prototype.slice.call(el.attributes).forEach(function(a) { if (/^on/i.test(a.name)) el.removeAttribute(a.name); });
        });
    } else {
        if (unresolvedDynamic) warnings.push('Widget loads assets with dynamically computed ids and no live render was available; those assets will not load in the exported file. Open the widget and export again.');
        doc = new DOMParser().parseFromString(view.html, 'text/html');
        // Supplement: harvest id -> data URL pairs from the live DOM (elements
        // carrying both a data: src and a file_/ss_ id attribute).
        if (liveHtml) {
            try {
                var ldoc = new DOMParser().parseFromString(liveHtml, 'text/html');
                Array.prototype.forEach.call(ldoc.querySelectorAll('[src^="data:"]'), function(el) {
                    Array.prototype.forEach.call(el.attributes, function(a) {
                        if (/^(file|ss)_[A-Za-z0-9_\-]+$/.test(a.value) && !assets[a.value]) assets[a.value] = el.getAttribute('src');
                    });
                });
            } catch (e) {}
        }
    }
    if (calls.otherTools.length && source === 'saved') warnings.push('Widget calls ' + calls.otherTools.join(', ') + '; these reject in the exported file (no live data).');

    // Strip injected bridge/tokens (present in live snapshots).
    Array.prototype.forEach.call(doc.querySelectorAll('style[data-appagent-tokens]'), function(s) { s.remove(); });
    Array.prototype.forEach.call(doc.querySelectorAll('script'), function(s) { if (!s.src && widgetExportIsBridgeScript(s.textContent)) s.remove(); });

    var stats = { images_embedded: Object.keys(assets).length + (source === 'saved' ? replay.embedded : 0) };
    await _wexEmbedAssets(doc, warnings, stats);

    var head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    doc.documentElement.setAttribute('data-appagent-theme', dark ? 'dark' : 'light');
    if (source === 'saved') {
        var shim = doc.createElement('script');
        shim.setAttribute('data-appagent-export-shim', '1');
        shim.textContent = widgetExportBuildShim(assets, replay.calls);
        head.insertBefore(shim, head.firstChild);
    }
    var tok = doc.createElement('style');
    tok.setAttribute('data-appagent-tokens', '1');
    tok.textContent = widgetExportTokenCss(dark);
    head.insertBefore(tok, head.firstChild);
    if (!doc.querySelector('meta[charset]')) { var mc = doc.createElement('meta'); mc.setAttribute('charset', 'utf-8'); head.insertBefore(mc, head.firstChild); }
    if (!doc.querySelector('title')) { var te = doc.createElement('title'); te.textContent = title; head.appendChild(te); }

    var html = '<!doctype html>\n' + doc.documentElement.outerHTML;
    var bytes = new Blob([html]).size;
    var sw = widgetExportSizeWarning(bytes);
    if (sw) warnings.push(sw);
    return { html: html, warnings: warnings, stats: { source: source, images_embedded: stats.images_embedded, size_bytes: bytes, title: title, version: view.version || view.latestVersion || null } };
}

function _wexHasDataUrl(r) {
    return !!r && ['data_url', 'data', 'base64'].some(function(k) { return typeof r[k] === 'string' && /^data:/i.test(r[k]); });
}

// Complete a local_folder read result whose data_url was omitted (over the
// caller cap) from its file_id. Returns the (copied) result, or null.
async function _wexCompleteRead(result) {
    var r = Object.assign({}, result);
    // A plain (non-base64) binary read carries only a file_id: embed its bytes too.
    if (r.file_id && (r.data_url_omitted || (r.binary && !_wexHasDataUrl(r)))) {
        var u = await _wexResolveAssetId(r.file_id, 'get_file');
        if (!u) return null;
        r.data_url = u;
        delete r.data_url_omitted; delete r.data_url_limit_chars; delete r.note;
    }
    return r;
}

// Recorded entries -> { calls:{key:{name,args,result}}, embedded, unresolved }.
// get_file / screenshot_by_id data also lands in assets (id lookups, thumbnails).
async function _wexPrepareReplay(recorded, assets) {
    var out = { calls: {}, embedded: 0, unresolved: 0 };
    var keys = Object.keys(recorded || {});
    for (var i = 0; i < keys.length; i++) {
        var e = recorded[keys[i]];
        if (!e || !widgetExportIsRecordable(e.name, e.args)) continue;
        var r = e.result;
        if (e.name === 'local_folder' && e.args.action === 'read') {
            r = await _wexCompleteRead(r);
            if (!r) { out.unresolved++; continue; }
            // The widget may chain get_file({id: f.file_id}): serve it by id.
            if (r.file_id && typeof r.data_url === 'string' && !assets[r.file_id]) assets[r.file_id] = r.data_url;
        }
        if (e.name !== 'local_folder' && e.args && e.args.id && !assets[e.args.id]) {
            var u = r && (r.base64 || r.data || r.data_url);
            if (typeof u === 'string' && /^data:/i.test(u)) assets[e.args.id] = u;
        }
        out.calls[keys[i]] = { name: e.name, args: e.args, result: r };
        if (_wexHasDataUrl(r)) out.embedded++;
    }
    return out;
}

// Static pre-resolve of literal local_folder calls through the local_folder
// executor as a programmatic caller (full data_url, encoding:'base64').
async function _wexStaticLocalFolder(list, replay, assets, optional) {
    if (!list || !list.length) return;
    var readKeys = {};
    Object.keys(replay.calls).forEach(function(k) { var c = replay.calls[k]; if (c.name === 'local_folder' && c.args.action === 'read') readKeys[widgetExportLocalReadKey(c.args)] = true; });
    for (var i = 0; i < list.length; i++) {
        var args = list[i], key = widgetExportCallKey('local_folder', args);
        if (replay.calls[key] || (args.action === 'read' && readKeys[widgetExportLocalReadKey(args)])) continue;
        var r = null;
        try {
            if (typeof executeLocalFolder === 'function') {
                r = await executeLocalFolder(Object.assign({}, args, args.action === 'read' ? { encoding: 'base64' } : {}), { fromWidget: true });
            }
        } catch (e) { r = null; }
        if (r && r.success !== false && !r.error && args.action === 'read') r = await _wexCompleteRead(r);
        if (!r || r.success === false || r.error) { if (!optional) replay.unresolved++; continue; }
        replay.calls[key] = { name: 'local_folder', args: args, result: r };
        if (assets && r.file_id && typeof r.data_url === 'string' && !assets[r.file_id]) assets[r.file_id] = r.data_url;
        if (args.action === 'read') readKeys[widgetExportLocalReadKey(args)] = true;
        if (_wexHasDataUrl(r)) replay.embedded++;
    }
}

// Briefly mount the widget off-screen through the normal pipeline so its
// bridge calls get recorded; waits for idle (no call for WIDGET_EXPORT_IDLE_MS,
// none in flight) up to WIDGET_EXPORT_RENDER_MAX_MS. The data-wex-offscreen
// marker makes the bridge refuse non-read-only calls from this render.
async function _wexRenderOffscreen(widgetId, view) {
    if (typeof _mountWidgetIframe !== 'function' || typeof _unmountWidgetIframe !== 'function' || !document.body) return false;
    var c = document.createElement('div');
    c.setAttribute('data-widget-id', widgetId);
    c.setAttribute('data-wex-offscreen', '1');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:700px;opacity:0;pointer-events:none;';
    document.body.appendChild(c);
    var start = Date.now();
    try {
        _mountWidgetIframe(c, { id: widgetId, title: view.title, html: view.html });
        while (Date.now() - start < WIDGET_EXPORT_RENDER_MAX_MS) {
            await new Promise(function(res) { setTimeout(res, 250); });
            var a = _wexRecorder.activity(widgetId);
            // Before the first call, allow the sandbox extra time to boot.
            var quietFrom = a.last >= start ? a.last : start + 2500;
            if (!a.inflight && Date.now() - quietFrom >= WIDGET_EXPORT_IDLE_MS) break;
        }
    } catch (e) {
        return false;
    } finally {
        try { _unmountWidgetIframe(c); } catch (e2) {}
        if (c.parentNode) c.parentNode.removeChild(c);
    }
    return true;
}

async function _wexEmbedAssets(doc, warnings, stats) {
    var cache = {};
    async function fetchAs(url, kind) {
        var key = kind + '|' + url;
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        var val = null;
        if (/^(file|ss)_[A-Za-z0-9_\-]+$/.test(url) && kind === 'data') val = await _wexResolveAssetId(url, null);
        else if (/^(https?:|blob:|chrome-extension:)/i.test(url) || (/^\/\//.test(url))) {
            try {
                var res = await fetch(/^\/\//.test(url) ? 'https:' + url : url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                val = kind === 'text' ? await res.text() : await _wexBlobToDataUrl(await res.blob());
            } catch (e) { warnings.push('Could not embed ' + url.slice(0, 120) + ' (' + e.message + '); kept the original URL.'); }
        }
        cache[key] = val;
        return val;
    }
    async function toData(url, isImage) {
        if (!url || /^(data:|#|about:|javascript:)/i.test(url)) return null;
        var d = await fetchAs(url, 'data');
        if (d && isImage) stats.images_embedded++;
        return d;
    }
    async function rewriteCss(css, base) {
        var urls = widgetExportCssUrls(css), map = {};
        for (var i = 0; i < urls.length; i++) {
            var abs = urls[i];
            if (base) { try { abs = new URL(urls[i], base).href; } catch (e) {} }
            var d = await toData(abs, true);
            if (d) map[urls[i]] = d;
        }
        return widgetExportRewriteCssUrls(css, map);
    }
    async function attr(sel, name, isImage) {
        var els = doc.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
            var d = await toData(els[i].getAttribute(name), isImage);
            if (d) els[i].setAttribute(name, d);
        }
    }
    async function srcset(sel) {
        var els = doc.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
            var parts = els[i].getAttribute('srcset').split(/,\s+/), outp = [];
            for (var j = 0; j < parts.length; j++) {
                var p = parts[j].trim().split(/\s+/);
                var d = await toData(p[0], true);
                if (d) p[0] = d;
                outp.push(p.join(' '));
            }
            els[i].setAttribute('srcset', outp.join(', '));
        }
    }
    await attr('img[src]', 'src', true);
    await srcset('img[srcset], source[srcset]');
    await attr('source[src]', 'src', true);
    await attr('video[poster]', 'poster', true);
    await attr('video[src], audio[src]', 'src', false);
    await attr('link[rel~="icon"][href]', 'href', true);
    // Stylesheets -> inline <style>.
    var links = doc.querySelectorAll('link[rel~="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        var css = await fetchAs(href, 'text');
        if (css == null) continue;
        var st = doc.createElement('style');
        st.textContent = await rewriteCss(css, href);
        links[i].parentNode.replaceChild(st, links[i]);
    }
    var styles = doc.querySelectorAll('style');
    for (var s = 0; s < styles.length; s++) styles[s].textContent = await rewriteCss(styles[s].textContent, null);
    var inl = doc.querySelectorAll('[style]');
    for (var k = 0; k < inl.length; k++) {
        var v = inl[k].getAttribute('style');
        if (/url\(/i.test(v)) inl[k].setAttribute('style', await rewriteCss(v, null));
    }
    // External scripts -> inline.
    var scripts = doc.querySelectorAll('script[src]');
    for (var q = 0; q < scripts.length; q++) {
        var src = scripts[q].getAttribute('src');
        var js = await fetchAs(src, 'text');
        if (js == null) continue;
        scripts[q].removeAttribute('src');
        scripts[q].textContent = js.replace(/<\/script/gi, '<\\/script');
    }
}

// ---- UI entry point --------------------------------------------------------

async function exportWidgetHtmlDownload(widgetId) {
    var btns = [];
    try { btns = document.querySelectorAll('.widget-export-btn[onclick*="\'' + String(widgetId).replace(/["\\]/g, '\\$&') + '\'"]'); } catch (e) { btns = []; }
    Array.prototype.forEach.call(btns, function(b) { b.setAttribute('aria-busy', 'true'); });
    try {
        var res = await exportWidgetHtml(widgetId, {});
        if (res.stats.size_bytes > WIDGET_EXPORT_SIZE_WARN_BYTES) {
            var ok = await showConfirmModal(t('Export HTML'), widgetExportSizeWarning(res.stats.size_bytes), 'warning');
            if (!ok) return;
        }
        var name = widgetExportSlug(res.stats.title) + '.html';
        downloadFile(name, res.html, 'text/html');
        var w = res.warnings.filter(function(x) { return !/MB \(over/.test(x); });
        var msg = t('Exported {name}', { name: name });
        showSnackbar(w.length ? msg + ' \u2014 ' + w[0] + (w.length > 1 ? ' (+' + (w.length - 1) + ')' : '') : msg, w.length ? 'warning' : 'success');
    } catch (e) {
        showSnackbar(t('Export failed: {error}', { error: e.message }), 'error');
    } finally {
        Array.prototype.forEach.call(btns, function(b) { b.removeAttribute('aria-busy'); });
    }
}
