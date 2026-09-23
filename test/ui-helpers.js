// =============================================================
// Shared UI-test helpers — runs INSIDE the run_tests sandbox (real DOM,
// no Node). NOT a test file (no .test.js suffix), so the runner never
// executes it directly. Load it from a test file exactly like
// harness.test.js loads the harness:
//
//   var WS = args.workspace;   // run_tests passes the resolved workspace; ALWAYS explicit
//   var U  = await runFile('test/ui-helpers.js', { workspace: WS }, WS);
//
// API (all DOM helpers use the REAL sandbox document):
//   U.WORKSPACE                         workspace every loader call uses
//   U.DOM_PASSTHROUGH                   DOM ctor/fn names forwarded by loadUi
//   await U.loadUi(paths, opts?) -> m   loadModules(paths) with workspace +
//       DOM globals preset. opts: {globals, passthrough:[...], allowUnstubbed:[...],
//       lenient, window}. Default globals: document, DOMParser, navigator
//       (clipboard recorder), window (= fakeWindow({document, _rawCopyStore:{}})
//       — NOT the real window). Throws if m.__unstubbed has a name outside
//       opts.allowUnstubbed. m.__scope = raw scope (stubs + implicit globals).
//   U.assertUnstubbed(m, allow)         re-check m.__unstubbed after calls
//       (typeof-probes inside function bodies are recorded lazily).
//   await U.mountDom({html, css:[paths], body:bool}) -> {root,$,$$,cleanup}
//       fresh <div data-ui-test-root> in document.body + one <style> with the
//       concatenated real CSS files. body:true mounts src/html/body.html.
//       Call cleanup() (or U.cleanupAll()) in afterEach.
//   U.cleanupAll()                      removes every mount still attached
//   U.fireInline(el, type, m, init?) -> {event, result, stopped, prevented}
//       runs el's on<type> ATTRIBUTE against the module scope (the CSP build
//       converts inline handlers; the sandbox window does not know module
//       functions). `this` = el, `event` = a real Event with target=el
//       (a real KeyboardEvent for key* types: init.key/shiftKey/... are set).
//   U.click(el) / U.key(el, key, {shiftKey,...}) / U.input(el, value)
//       real DOM events (addEventListener listeners fire; inline attrs do NOT).
//   U.parse(html) -> Document           DOMParser, inert (no handlers run)
//   U.frag(html)  -> <body> of parse(html)
//   U.css(el, prop) -> string           getComputedStyle (mounted nodes only)
//   U.a11y(el) -> {tag, role, type, tabindex, aria:{...}, name, hasName, focusable}
//   U.stubs() -> {executeTool, showSnackbar, saveChatsToStorage, storage, chrome}
//       recorders: fn.calls = [[args...]], executeTool.respond(name, fn|value).
//   U.flush()                           await pending microtasks + a macrotask
//
// Sandbox limits (see report): iframe is 0x0 (no layout/scroll metrics),
// focus() does not move activeElement, localStorage throws, <details>
// 'toggle' fires async (set .open then fireInline(el,'toggle',m)).
// =============================================================

var UI_DEFAULT_WORKSPACE = (typeof args !== 'undefined' && args && args.workspace) || undefined;
var UI_DOM_PASSTHROUGH = ['Element', 'HTMLElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent',
    'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLDetailsElement', 'DocumentFragment'];
var _uiMounts = [];

function _uiRecorder(impl) {
    var f = function() { var a = Array.prototype.slice.call(arguments); f.calls.push(a); return impl ? impl.apply(this, a) : undefined; };
    f.calls = [];
    return f;
}

function _uiClipboard() {
    var clip = { mode: 'ok', writes: [] };
    clip.writeText = function(t) { clip.writes.push(t); return clip.mode === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied')); };
    return clip;
}

async function loadUi(paths, opts) {
    opts = opts || {};
    var win = opts.window || (typeof fakeWindow === 'function' ? fakeWindow({ document: document, _rawCopyStore: {}, currentSearchHighlight: null, isRunning: false })
        : { document: document, _rawCopyStore: {}, currentSearchHighlight: null, isRunning: false });
    var globals = Object.assign({ document: document, DOMParser: DOMParser, window: win, navigator: { userAgent: 'ui-test', clipboard: _uiClipboard() } }, opts.globals || {});
    var m = await loadModules(paths, { workspace: opts.workspace || UI_DEFAULT_WORKSPACE, globals: globals, lenient: opts.lenient === true,
        passthrough: UI_DOM_PASSTHROUGH.concat(opts.passthrough || []) });
    assertUnstubbed(m, opts.allowUnstubbed || []);
    return m;
}

function assertUnstubbed(m, allow) {
    var extra = (m.__unstubbed || []).filter(function(n) { return (allow || []).indexOf(n) < 0; });
    if (extra.length) throw new Error('loadUi: unexpected unstubbed globals: ' + extra.join(', ') + ' (stub them or add to allowUnstubbed)');
    return true;
}

async function mountDom(spec) {
    spec = spec || {};
    var ws = spec.workspace || UI_DEFAULT_WORKSPACE;
    var style = null;
    if (spec.css && spec.css.length) {
        var text = '';
        for (var i = 0; i < spec.css.length; i++) text += '\n/* ' + spec.css[i] + ' */\n' + await loadFile(spec.css[i], ws);
        style = document.createElement('style');
        style.setAttribute('data-ui-test-style', '1');
        style.textContent = text;
        document.head.appendChild(style);
    }
    var root = document.createElement('div');
    root.setAttribute('data-ui-test-root', '1');
    var html = spec.html || '';
    if (spec.body) html = (await loadFile('src/html/body.html', ws)) + html;
    root.innerHTML = html;
    document.body.appendChild(root);
    var mount = {
        root: root, style: style,
        $: function(sel) { return root.querySelector(sel); },
        $$: function(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); },
        cleanup: function() { if (root.parentNode) root.parentNode.removeChild(root); if (style && style.parentNode) style.parentNode.removeChild(style); }
    };
    _uiMounts.push(mount);
    return mount;
}

function cleanupAll() { while (_uiMounts.length) _uiMounts.pop().cleanup(); }

function fireInline(el, type, m, init) {
    if (!el) throw new Error('fireInline: element is null');
    var code = el.getAttribute('on' + type);
    if (code == null) throw new Error('fireInline: <' + el.tagName.toLowerCase() + '> has no on' + type + ' attribute');
    // key* types get a REAL KeyboardEvent so event.key/code/shiftKey/ctrlKey/...
    // come from init (a plain Event silently drops them). Other types unchanged.
    var evInit = Object.assign({ bubbles: true, cancelable: true }, init || {});
    delete evInit.target;
    var ev = (/^key/.test(type) && typeof KeyboardEvent === 'function') ? new KeyboardEvent(type, evInit) : new Event(type, evInit);
    Object.defineProperty(ev, 'target', { value: (init && init.target) || el });
    Object.defineProperty(ev, 'currentTarget', { value: el });
    var info = { event: ev, result: undefined, stopped: false, prevented: false };
    var sp = ev.stopPropagation.bind(ev), pd = ev.preventDefault.bind(ev);
    ev.stopPropagation = function() { info.stopped = true; sp(); };
    ev.preventDefault = function() { info.prevented = true; pd(); };
    var scope = new Proxy({}, {
        has: function(t, k) { return typeof k === 'string' && k !== 'event' && ((k in m) || (m.__scope && (k in m.__scope))); },
        get: function(t, k) { if (typeof k !== 'string') return undefined; return (k in m) ? m[k] : m.__scope[k]; },
        set: function(t, k, v) { m.__scope[k] = v; return true; }
    });
    var fn = new Function('__s', 'event', 'with (__s) { return (function(){ ' + code + ' }).call(this); }');
    info.result = fn.call(el, scope, ev);
    return info;
}

function click(el) { el.click(); return el; }
function key(el, k, opts) {
    var ev = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}));
    el.dispatchEvent(ev); return ev;
}
function input(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el;
}
function parse(html) { return new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html'); }
function frag(html) { return parse(html).body; }
function css(el, prop) { return getComputedStyle(el).getPropertyValue(prop) || getComputedStyle(el)[prop]; }

function a11y(el) {
    var aria = {};
    Array.prototype.forEach.call(el.attributes, function(a) { if (a.name.indexOf('aria-') === 0) aria[a.name.slice(5)] = a.value; });
    var tag = el.tagName.toLowerCase();
    var name = aria.label || (el.getAttribute('aria-labelledby') && el.ownerDocument.getElementById(el.getAttribute('aria-labelledby'))
        ? el.ownerDocument.getElementById(el.getAttribute('aria-labelledby')).textContent : '') || (el.textContent || '').trim() || el.getAttribute('title') || el.getAttribute('alt') || '';
    var focusable = el.hasAttribute('tabindex') ? el.getAttribute('tabindex') !== '-1'
        : /^(a|button|input|select|textarea|summary)$/.test(tag) && !(tag === 'a' && !el.hasAttribute('href')) && !el.disabled;
    return { tag: tag, role: el.getAttribute('role'), type: el.getAttribute('type'), tabindex: el.getAttribute('tabindex'), aria: aria,
        name: String(name).trim(), hasName: !!String(name).trim(), focusable: focusable };
}

function stubs() {
    var responders = {};
    var executeTool = _uiRecorder(function(name, a) {
        var r = responders[name];
        return Promise.resolve(typeof r === 'function' ? r(a) : (r !== undefined ? r : { success: true }));
    });
    executeTool.respond = function(name, r) { responders[name] = r; return executeTool; };
    var data = {};
    var storage = {
        _data: data,
        get: _uiRecorder(function(k) { return Promise.resolve(k == null ? Object.assign({}, data) : data[k]); }),
        set: _uiRecorder(function(k, v) { data[k] = v; return Promise.resolve(); }),
        remove: _uiRecorder(function(k) { delete data[k]; return Promise.resolve(); })
    };
    return {
        executeTool: executeTool,
        showSnackbar: _uiRecorder(),
        saveChatsToStorage: _uiRecorder(function() { return Promise.resolve(); }),
        storage: storage,
        chrome: typeof fakeChrome === 'function' ? fakeChrome() : null
    };
}

async function flush() { await Promise.resolve(); await new Promise(function(r) { setTimeout(r, 0); }); }

module.exports = {
    WORKSPACE: UI_DEFAULT_WORKSPACE, DOM_PASSTHROUGH: UI_DOM_PASSTHROUGH,
    loadUi: loadUi, assertUnstubbed: assertUnstubbed, mountDom: mountDom, cleanupAll: cleanupAll,
    fireInline: fireInline, click: click, key: key, input: input, parse: parse, frag: frag, css: css,
    a11y: a11y, stubs: stubs, flush: flush, recorder: _uiRecorder, clipboard: _uiClipboard
};
