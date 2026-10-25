// =============================================================
// Smart file viewers for the Documents page previews.
//
// fvKind(name, mime) picks a viewer (json | js | xml | html | md | '') from
// the file extension first, then the MIME type. fvViewerHtml() builds a
// tabbed viewer (.fv-wrap) with Copy and, for trees, Expand/Collapse all:
//   json  Tree / Pretty / Raw   (parse error -> notice + Raw)
//   xml   Tree / Pretty / Raw   (DOMParser parsererror -> notice + Raw)
//   js    Code (highlightJS + line numbers) / Raw
//   html  Code (highlightXmlLine per line + line numbers) / Raw
//   md    Rendered (formatContent, then sanitized) / Source
// Limits: smart views off above FV_SMART_MAX, Raw cut at FV_RAW_MAX, trees
// stop at FV_TREE_MAX_NODES nodes.
//
// fvInstallDocPreviewHooks() wraps _sdocOverlay and _sdocWsLoadInto
// (tools/110-smart-documents.js, concatenated earlier in the same bundle)
// so the plain <pre class="wsf-code"> text box they render is swapped for
// the smart viewer. Diff views (.sdoc-diff-wrap) are left alone.
// =============================================================

var FV_SMART_MAX = 1024 * 1024;        // smart views off above 1 MB
var FV_RAW_MAX = 2 * 1024 * 1024;      // Raw pane truncated at 2 MB
var FV_TREE_MAX_NODES = 5000;          // tree nodes rendered before stopping
var FV_TREE_MAX_DEPTH = 100;           // nesting guard for trees
var FV_UPSTREAM_CAP = 200000;          // 110-smart-documents.js slices text to 200K chars

var FV_EXT = {
    json: ['json', 'geojson', 'jsonld', 'webmanifest', 'har', 'ipynb'],
    js: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'],
    xml: ['xml', 'xsd', 'xsl', 'xslt', 'wsdl', 'plist', 'rss', 'atom', 'svg', 'xhtml', 'kml', 'gpx'],
    html: ['html', 'htm'],
    md: ['md', 'markdown']
};

// Labels: t() only for keys already in src/locales; new labels go through
// _fvL (not extracted, English until catalogs gain them).
function _fvL(s, p) {
    if (typeof t === 'function') { try { return t(s, p); } catch (_) {} }
    return String(s).replace(/\{(\w+)\}/g, function(m, k) { return p && p[k] != null ? String(p[k]) : m; });
}
function _fvEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _fvSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
}

function fvExt(name) {
    var base = String(name || '').split(/[\\/]/).pop().toLowerCase();
    var i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1) : '';
}

function fvKind(name, mime) {
    var ext = fvExt(name);
    if (ext) {
        for (var k in FV_EXT) if (FV_EXT[k].indexOf(ext) !== -1) return k;
    }
    var m = String(mime || '').toLowerCase().split(';')[0].trim();
    if (!m) return '';
    if (m === 'application/json' || m === 'text/json' || /\+json$/.test(m)) return 'json';
    if (/(java|ecma|type)script$/.test(m) || m === 'text/jsx') return 'js';
    if (m === 'text/html') return 'html';
    if (/\/xml$/.test(m) || /\+xml$/.test(m)) return 'xml';
    if (m === 'text/markdown' || m === 'text/x-markdown') return 'md';
    return '';
}

// ---- highlighting helpers ----------------------------------------------------

function _fvHlJs(code) { return typeof highlightJS === 'function' ? highlightJS(code) : _fvEsc(code); }
function _fvHlXmlLine(line) { return typeof highlightXmlLine === 'function' ? highlightXmlLine(line) : _fvEsc(line); }

// JSON text (already pretty) -> HTML using the .json-* classes (07-markdown.css).
function fvHighlightJson(text) {
    var re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    var out = '', last = 0, m;
    text = String(text == null ? '' : text);
    while ((m = re.exec(text)) !== null) {
        out += _fvEsc(text.slice(last, m.index));
        if (m[1]) out += m[2] ? '<span class="json-key">' + _fvEsc(m[1]) + '</span>' + _fvEsc(m[2]) : '<span class="json-str">' + _fvEsc(m[1]) + '</span>';
        else if (m[3]) out += '<span class="json-bool">' + m[3] + '</span>';
        else if (m[4]) out += '<span class="json-null">null</span>';
        else out += '<span class="json-num">' + _fvEsc(m[5]) + '</span>';
        last = m.index + m[0].length;
    }
    return out + _fvEsc(text.slice(last));
}

// Line-number gutter + highlighted source, two side-by-side <pre>s.
function fvCodeBlockHtml(text, highlightedHtml) {
    var n = String(text == null ? '' : text).split('\n').length, nums = [];
    for (var i = 1; i <= n; i++) nums.push(i);
    return '<div class="fv-code"><pre class="fv-gutter" aria-hidden="true">' + nums.join('\n') + '</pre>' +
        '<pre class="fv-code-src">' + highlightedHtml + '</pre></div>';
}

// ---- JSON tree ----------------------------------------------------------------

function _fvJsonLeafVal(v) {
    if (v === null) return '<span class="json-null">null</span>';
    if (typeof v === 'boolean') return '<span class="json-bool">' + v + '</span>';
    if (typeof v === 'number') return '<span class="json-num">' + _fvEsc(String(v)) + '</span>';
    return '<span class="json-str">' + _fvEsc(JSON.stringify(String(v))) + '</span>';
}

// ctx: {count, max, truncated}. key: null (root), number (array index) or string.
function fvJsonNode(key, val, depth, ctx) {
    if (ctx.count >= ctx.max) { ctx.truncated = true; return ''; }
    ctx.count++;
    var keyHtml = key == null ? '' : (typeof key === 'number' ? '<span class="fv-idx">' + key + '</span>' : '<span class="json-key">' + _fvEsc(JSON.stringify(key)) + '</span>') + '<span class="fv-punc">: </span>';
    if (val === null || typeof val !== 'object') return '<div class="fv-leaf">' + keyHtml + _fvJsonLeafVal(val) + '</div>';
    var isArr = Array.isArray(val), keys = isArr ? null : Object.keys(val), len = isArr ? val.length : keys.length;
    var open = isArr ? '[' : '{', close = isArr ? ']' : '}';
    if (!len) return '<div class="fv-leaf">' + keyHtml + '<span class="fv-punc">' + open + close + '</span></div>';
    if (depth >= FV_TREE_MAX_DEPTH) { ctx.truncated = true; return '<div class="fv-leaf">' + keyHtml + '<span class="fv-punc">' + open + '\u2026' + close + '</span></div>'; }
    var kids = '';
    for (var i = 0; i < len; i++) {
        if (ctx.count >= ctx.max) { ctx.truncated = true; break; }
        kids += isArr ? fvJsonNode(i, val[i], depth + 1, ctx) : fvJsonNode(keys[i], val[keys[i]], depth + 1, ctx);
    }
    return '<details class="fv-node"' + (depth < 2 ? ' open' : '') + '><summary>' + keyHtml + '<span class="fv-punc">' + open + '</span>' +
        '<span class="fv-count">' + len + '</span><span class="fv-punc fv-close-inline">' + close + '</span></summary>' +
        '<div class="fv-children">' + kids + '</div><div class="fv-leaf fv-close"><span class="fv-punc">' + close + '</span></div></details>';
}

function fvParseJson(text) {
    try { return { ok: true, value: JSON.parse(String(text).replace(/^\uFEFF/, '')) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// ---- XML ------------------------------------------------------------------------

var FV_CDATA_OPEN = '<![' + 'CDATA[';

function fvParseXml(text) {
    if (typeof DOMParser !== 'function') return { ok: false, error: 'DOMParser unavailable' };
    var doc;
    try { doc = new DOMParser().parseFromString(String(text), 'application/xml'); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    var err = doc && doc.getElementsByTagName('parsererror');
    if (!doc || !doc.documentElement || (err && err.length)) {
        var msg = err && err.length ? String(err[0].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) : 'parse error';
        return { ok: false, error: msg };
    }
    return { ok: true, doc: doc };
}

function _fvXmlText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _fvXmlAttrsRaw(el) {
    var s = '';
    for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        s += ' ' + a.name + '="' + String(a.value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"';
    }
    return s;
}
function _fvXmlAttrsHtml(el) {
    var s = '';
    for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        s += ' <span class="xml-attr">' + _fvEsc(a.name) + '</span><span class="xml-bracket">=</span><span class="xml-attr-value">"' + _fvEsc(a.value) + '"</span>';
    }
    return s;
}
function _fvXmlKids(node) {
    var out = [];
    for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 && !/\S/.test(c.nodeValue)) continue;
        out.push(c);
    }
    return out;
}
function _fvXmlOpenHtml(el, selfClose) {
    return '<span class="xml-bracket">&lt;</span><span class="xml-tag">' + _fvEsc(el.nodeName) + '</span>' + _fvXmlAttrsHtml(el) + '<span class="xml-bracket">' + (selfClose ? '/&gt;' : '&gt;') + '</span>';
}
function _fvXmlCloseHtml(el) {
    return '<span class="xml-bracket">&lt;/</span><span class="xml-tag">' + _fvEsc(el.nodeName) + '</span><span class="xml-bracket">&gt;</span>';
}
function _fvXmlMiscHtml(node) {
    if (node.nodeType === 3) return '<span class="xml-text">' + _fvEsc(String(node.nodeValue).trim()) + '</span>';
    if (node.nodeType === 4) return '<span class="xml-decl">' + _fvEsc(FV_CDATA_OPEN + node.nodeValue + ']]>') + '</span>';
    if (node.nodeType === 8) return '<span class="xml-comment">' + _fvEsc('<!--' + node.nodeValue + '-->') + '</span>';
    if (node.nodeType === 7) return '<span class="xml-decl">' + _fvEsc('<?' + node.target + ' ' + node.data + '?>') + '</span>';
    if (node.nodeType === 10) return '<span class="xml-decl">' + _fvEsc('<!DOCTYPE ' + node.name + '>') + '</span>';
    return '';
}

function fvXmlNode(node, depth, ctx) {
    if (ctx.count >= ctx.max) { ctx.truncated = true; return ''; }
    ctx.count++;
    if (node.nodeType !== 1) return '<div class="fv-leaf">' + _fvXmlMiscHtml(node) + '</div>';
    var kids = _fvXmlKids(node);
    if (!kids.length) return '<div class="fv-leaf">' + _fvXmlOpenHtml(node, true) + '</div>';
    if (kids.length === 1 && kids[0].nodeType === 3 && String(kids[0].nodeValue).trim().length <= 200) {
        return '<div class="fv-leaf">' + _fvXmlOpenHtml(node) + _fvXmlMiscHtml(kids[0]) + _fvXmlCloseHtml(node) + '</div>';
    }
    if (depth >= FV_TREE_MAX_DEPTH) { ctx.truncated = true; return '<div class="fv-leaf">' + _fvXmlOpenHtml(node) + '\u2026' + _fvXmlCloseHtml(node) + '</div>'; }
    var inner = '';
    for (var i = 0; i < kids.length; i++) {
        if (ctx.count >= ctx.max) { ctx.truncated = true; break; }
        inner += fvXmlNode(kids[i], depth + 1, ctx);
    }
    return '<details class="fv-node"' + (depth < 2 ? ' open' : '') + '><summary>' + _fvXmlOpenHtml(node) + '<span class="fv-count">' + kids.length + '</span></summary>' +
        '<div class="fv-children">' + inner + '</div><div class="fv-leaf fv-close">' + _fvXmlCloseHtml(node) + '</div></details>';
}

// Pretty-printed XML as raw text lines (2-space indent).
function fvXmlPretty(doc, original) {
    var lines = [];
    var decl = String(original || '').match(/^\s*(<\?xml[^>]*\?>)/);
    if (decl) lines.push(decl[1]);
    function pad(d) { return new Array(d + 1).join('  '); }
    function push(d, s) { String(s).split('\n').forEach(function(l) { if (/\S/.test(l)) lines.push(pad(d) + l.trim()); }); }
    function walk(node, d) {
        if (node.nodeType === 1) {
            var kids = _fvXmlKids(node), open = '<' + node.nodeName + _fvXmlAttrsRaw(node);
            if (!kids.length) { lines.push(pad(d) + open + '/>'); return; }
            if (kids.length === 1 && kids[0].nodeType === 3 && !/\n/.test(String(kids[0].nodeValue).trim())) {
                lines.push(pad(d) + open + '>' + _fvXmlText(String(kids[0].nodeValue).trim()) + '</' + node.nodeName + '>'); return;
            }
            lines.push(pad(d) + open + '>');
            for (var i = 0; i < kids.length; i++) walk(kids[i], d + 1);
            lines.push(pad(d) + '</' + node.nodeName + '>');
        } else if (node.nodeType === 3) push(d, _fvXmlText(node.nodeValue));
        else if (node.nodeType === 4) push(d, FV_CDATA_OPEN + node.nodeValue + ']]>');
        else if (node.nodeType === 8) push(d, '<!--' + node.nodeValue + '-->');
        else if (node.nodeType === 7) push(d, '<?' + node.target + ' ' + node.data + '?>');
        else if (node.nodeType === 10) push(d, '<!DOCTYPE ' + node.name + '>');
    }
    for (var c = doc.firstChild; c; c = c.nextSibling) walk(c, 0);
    return lines;
}

// ---- Markdown ---------------------------------------------------------------------

// Literal <!--document:x--> / <!--display:x--> (and the internal %%CODEBLOCK..%%
// markers) in a FILE must stay text, not embed live docs/templates.
function fvNeutralizeMd(text) {
    return String(text == null ? '' : text)
        .replace(/<!--(\s*[A-Za-z_]+:)/g, '<\u200B!--$1')
        .replace(/%%(CODEBLOCK|DOCUMENT|DISPLAY|INLINE)/g, '%\u200B%$1');
}

var FV_ALLOWED_HANDLER = /^(copyCodeBlock|toggleCodeBlockExpand)\(this(,\s*event)?\)$/;
var FV_URL_ATTRS = { href: 1, src: 1, 'xlink:href': 1, action: 1, formaction: 1, background: 1, poster: 1 };

// Defense in depth after formatContent (which escapes raw HTML): drop active
// elements, any on* / data-_ev-* handler not emitted by formatContent itself,
// srcdoc, and javascript:/vbscript:/data: URLs (data:image/ allowed on src).
function fvSanitizeHtml(html) {
    if (typeof DOMParser !== 'function') return _fvEsc(html);
    var doc = new DOMParser().parseFromString('<!DOCTYPE html><html><body>' + String(html == null ? '' : html) + '</body></html>', 'text/html');
    var bad = doc.body.querySelectorAll('script,iframe,frame,frameset,object,embed,style,link,meta,base,form,noscript,template');
    for (var i = bad.length - 1; i >= 0; i--) if (bad[i].parentNode) bad[i].parentNode.removeChild(bad[i]);
    var all = doc.body.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
        var el = all[j], names = [];
        for (var a = 0; a < el.attributes.length; a++) names.push(el.attributes[a].name);
        names.forEach(function(n) {
            var ln = n.toLowerCase(), v = el.getAttribute(n) || '';
            if (/^on/.test(ln) || /^data-_ev-/.test(ln)) { if (!FV_ALLOWED_HANDLER.test(v.trim())) el.removeAttribute(n); return; }
            if (ln === 'srcdoc') { el.removeAttribute(n); return; }
            if (FV_URL_ATTRS[ln]) {
                var u = v.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
                if (/^(javascript|vbscript|data):/.test(u) && !(ln === 'src' && /^data:image\//.test(u))) el.removeAttribute(n);
            }
        });
    }
    return doc.body.innerHTML;
}

function fvRenderMarkdown(text) {
    if (typeof formatContent !== 'function') return '<pre class="wsf-code">' + _fvEsc(text) + '</pre>';
    return fvSanitizeHtml(formatContent(fvNeutralizeMd(text)));
}

// ---- viewer -------------------------------------------------------------------

// opts: {kind, truncated}. Returns '' when no smart viewer applies.
function fvViewerHtml(name, mime, text, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text);
    var kind = opts.kind || fvKind(name, mime);
    if (!kind) return '';
    var notices = [], views = [], tree = false;
    if (opts.truncated) notices.push(_fvL('Preview shows only the first {n} characters of this file.', { n: text.length }));
    if (text.length > FV_SMART_MAX) {
        notices.push(_fvL('File is larger than {size}: smart views are off.', { size: _fvSize(FV_SMART_MAX) }));
    } else if (kind === 'json') {
        var pj = fvParseJson(text);
        if (pj.ok) {
            var jctx = { count: 0, max: FV_TREE_MAX_NODES, truncated: false };
            var jtree = fvJsonNode(null, pj.value, 0, jctx);
            if (jctx.truncated) notices.push(_fvL('Tree stops at {n} nodes; use Pretty or Raw for the rest.', { n: FV_TREE_MAX_NODES }));
            views.push({ id: 'tree', label: _fvL('Tree'), html: '<div class="fv-tree">' + jtree + '</div>' });
            views.push({ id: 'pretty', label: _fvL('Pretty'), html: fvCodeBlockHtml(JSON.stringify(pj.value, null, 2), fvHighlightJson(JSON.stringify(pj.value, null, 2))) });
            tree = true;
        } else notices.push(_fvL('Could not parse as JSON ({error}); showing raw text.', { error: pj.error }));
    } else if (kind === 'xml') {
        var px = fvParseXml(text);
        if (px.ok) {
            var xctx = { count: 0, max: FV_TREE_MAX_NODES, truncated: false }, xtree = '';
            for (var c = px.doc.firstChild; c; c = c.nextSibling) { if (xctx.count >= xctx.max) { xctx.truncated = true; break; } xtree += fvXmlNode(c, 0, xctx); }
            if (xctx.truncated) notices.push(_fvL('Tree stops at {n} nodes; use Pretty or Raw for the rest.', { n: FV_TREE_MAX_NODES }));
            var plines = fvXmlPretty(px.doc, text);
            views.push({ id: 'tree', label: _fvL('Tree'), html: '<div class="fv-tree">' + xtree + '</div>' });
            views.push({ id: 'pretty', label: _fvL('Pretty'), html: fvCodeBlockHtml(plines.join('\n'), plines.map(_fvHlXmlLine).join('\n')) });
            tree = true;
        } else notices.push(_fvL('Could not parse as XML ({error}); showing raw text.', { error: px.error }));
    } else if (kind === 'js') {
        views.push({ id: 'code', label: _fvL('Code'), html: fvCodeBlockHtml(text, _fvHlJs(text)) });
    } else if (kind === 'html') {
        views.push({ id: 'code', label: _fvL('Code'), html: fvCodeBlockHtml(text, text.split('\n').map(_fvHlXmlLine).join('\n')) });
    } else if (kind === 'md') {
        views.push({ id: 'rendered', label: _fvL('Rendered'), html: '<div class="fv-md message-content">' + fvRenderMarkdown(text) + '</div>' });
    }
    var raw = text.length > FV_RAW_MAX ? text.slice(0, FV_RAW_MAX) : text;
    if (raw.length < text.length) notices.push(_fvL('Raw view truncated at {size}.', { size: _fvSize(FV_RAW_MAX) }));
    views.push({ id: 'raw', label: kind === 'md' ? _fvL('Source') : _fvL('Raw'), html: '<pre class="wsf-code fv-src">' + _fvEsc(raw) + '</pre>' });
    var active = views[0].id;
    var copyId = typeof storeRawCopy === 'function' ? storeRawCopy(text) : '';
    var tabs = views.length > 1 ? '<div class="sdoc-diff-tabs fv-tabs" role="tablist" aria-label="' + _fvEsc(t('View')) + '">' + views.map(function(v) {
        var on = v.id === active;
        return '<button type="button" class="sdoc-diff-tab fv-tab" role="tab" data-fv-view="' + v.id + '" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '"' +
            ' onclick="fvSetView(this, \'' + v.id + '\')" onkeydown="fvKey(event)">' + _fvEsc(v.label) + '</button>';
    }).join('') + '</div>' : '';
    var treeBtns = tree ? '<button type="button" class="fv-btn fv-tree-btn" onclick="fvTreeAll(this, true)">' + _fvEsc(_fvL('Expand all')) + '</button>' +
        '<button type="button" class="fv-btn fv-tree-btn" onclick="fvTreeAll(this, false)">' + _fvEsc(_fvL('Collapse all')) + '</button>' : '';
    var bar = '<div class="fv-bar">' + tabs + '<span class="fv-bar-spacer"></span>' + treeBtns +
        '<button type="button" class="fv-btn fv-copy" onclick="fvCopy(this)">' + _fvEsc(t('Copy')) + '</button></div>';
    var notes = notices.map(function(n) { return '<div class="fv-notice" role="note">' + _fvEsc(n) + '</div>'; }).join('');
    var panes = views.map(function(v) {
        return '<div class="fv-pane" data-fv-pane="' + v.id + '" role="tabpanel"' + (v.id === active ? '' : ' hidden') + '>' + v.html + '</div>';
    }).join('');
    return '<div class="fv-wrap" data-fv-kind="' + kind + '" data-view="' + active + '" data-copy-id="' + _fvEsc(copyId) + '">' + bar + notes + panes + '</div>';
}

// ---- handlers (global: called by the CSP polyfill's inline-handler shim) -------------

function fvSetView(btn, view) {
    var wrap = btn && btn.closest ? btn.closest('.fv-wrap') : null;
    if (!wrap || !wrap.querySelector('.fv-pane[data-fv-pane="' + view + '"]')) return false;
    wrap.setAttribute('data-view', view);
    Array.prototype.forEach.call(wrap.querySelectorAll('.fv-tab'), function(b) {
        var on = b.getAttribute('data-fv-view') === view;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('tabindex', on ? '0' : '-1');
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('.fv-pane'), function(p) { p.hidden = p.getAttribute('data-fv-pane') !== view; });
    return true;
}

function fvKey(event) {
    var btn = event && event.target, k = event && event.key;
    if (!btn || !btn.closest || ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(k) === -1) return false;
    var tabs = Array.prototype.slice.call(btn.closest('.fv-tabs').querySelectorAll('.fv-tab'));
    var i = tabs.indexOf(btn), n = tabs.length;
    var j = k === 'Home' ? 0 : k === 'End' ? n - 1 : k === 'ArrowRight' ? (i + 1) % n : (i - 1 + n) % n;
    event.preventDefault();
    event.stopPropagation();   // keep the overlay's own arrow-key navigation out of it
    fvSetView(tabs[j], tabs[j].getAttribute('data-fv-view'));
    if (tabs[j].focus) tabs[j].focus();
    return true;
}

function fvTreeAll(btn, open) {
    var wrap = btn && btn.closest ? btn.closest('.fv-wrap') : null;
    if (!wrap) return 0;
    var nodes = wrap.querySelectorAll('.fv-pane[data-fv-pane="tree"] details.fv-node');
    for (var i = 0; i < nodes.length; i++) nodes[i].open = !!open;
    return nodes.length;
}

function fvCopy(btn) {
    var wrap = btn && btn.closest ? btn.closest('.fv-wrap') : null;
    if (!wrap) return Promise.resolve(false);
    var id = wrap.getAttribute('data-copy-id'), store = (typeof window !== 'undefined' && window._rawCopyStore) || {};
    var text = id && typeof store[id] === 'string' ? store[id] : ((wrap.querySelector('.fv-src') || {}).textContent || '');
    var clip = typeof navigator !== 'undefined' && navigator.clipboard;
    var snack = function(msg, type) { if (typeof showSnackbar === 'function') showSnackbar(msg, type); };
    if (!clip || typeof clip.writeText !== 'function') { snack(t('Copy failed'), 'error'); return Promise.resolve(false); }
    return clip.writeText(text).then(function() { snack(t('Copied to clipboard'), 'success'); return true; },
        function() { snack(t('Copy failed'), 'error'); return false; });
}

// ---- Documents-page hook ------------------------------------------------------------

// Replace the first plain pre.wsf-code under root (not inside a diff or an
// existing viewer) with the smart viewer. Returns true when upgraded.
function fvUpgradeIn(root, name) {
    if (!root || !root.querySelectorAll) return false;
    var pres = root.querySelectorAll('pre.wsf-code');
    for (var i = 0; i < pres.length; i++) {
        var pre = pres[i];
        if (pre.closest && pre.closest('.sdoc-diff, .sdoc-diff-wrap, .fv-wrap')) continue;
        var text = pre.textContent || '';
        var html = fvViewerHtml(name, '', text, { truncated: text.length >= FV_UPSTREAM_CAP });
        if (!html) return false;
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var el = tmp.firstElementChild || tmp.firstChild;
        if (!el || !pre.parentNode) return false;
        pre.parentNode.replaceChild(el, pre);
        return true;
    }
    return false;
}

function fvInstallDocPreviewHooks() {
    var n = 0;
    if (typeof _sdocOverlay === 'function' && !_sdocOverlay._fv) {
        var origOverlay = _sdocOverlay;
        var wOverlay = function(title, body, opts) {
            var ov = origOverlay.apply(this, arguments);
            try { fvUpgradeIn(ov, title); } catch (e) { if (typeof console !== 'undefined') console.warn('[file-viewers] overlay upgrade failed', e); }
            return ov;
        };
        wOverlay._fv = true; wOverlay._fvOrig = origOverlay;
        _sdocOverlay = wOverlay;
        n++;
    }
    if (typeof _sdocWsLoadInto === 'function' && !_sdocWsLoadInto._fv) {
        var origLoad = _sdocWsLoadInto;
        var wLoad = async function(host) {
            var r = await origLoad.apply(this, arguments);
            if (r === true && host) {
                try { fvUpgradeIn(host, host.getAttribute('data-path')); } catch (e) { if (typeof console !== 'undefined') console.warn('[file-viewers] load upgrade failed', e); }
            }
            return r;
        };
        wLoad._fv = true; wLoad._fvOrig = origLoad;
        _sdocWsLoadInto = wLoad;
        n++;
    }
    return n;
}

fvInstallDocPreviewHooks();
