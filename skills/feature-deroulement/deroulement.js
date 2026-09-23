// =============================================================
// deroulement.js: executable checks for the feature-deroulement skill.
// A plain helper module. It is NOT a skill tool (it deliberately declares no
// tool definition), so the skills engine skips it and the agent loads it itself.
// Dependency-free. Needs only what the js_eval sandbox has: RegExp, Function,
// DOMParser and CSSStyleSheet. Optional: executeTool / loadFile for live lookups.
//
// LOAD IT (see SKILL.md for the full copy-paste snippets):
//   in-repo js_eval : var D = await runFile('skills/feature-deroulement/deroulement.js');
//   run_js_file     : {path:'skills/feature-deroulement/deroulement.js', args:{run:true, files:[...], prose:'...'}}
//                     (module mode returns the JSON report directly)
//   anywhere        : f = await executeTool('get_skill', {skill_id:'feature-deroulement', action:'read_file', filename:'deroulement.js'});
//                     D = await new (Object.getPrototypeOf(async function(){}).constructor)('module','exports','args',
//                           f.content + '\n;return module.exports;')({exports:{}}, {}, {});
//
// API (all return plain JSON-serialisable data):
//   run(opts)                    full pipeline -> report {summary, parse, symbols, crossRefs, changedFunctions,
//                                listeners, probes, mutation, ledger, gate, limitations}
//   parseGateJs / parseGateHtml  (a) syntax + DOM gate
//   proseSymbols / checkSymbols / crossRefs            (b) existence + pair checks
//   parseDiff / findFunctions / changedFunctions       (c) changed-function map + unwired check
//   branches / matrix            (d) branch enumeration + matrix skeleton
//   probe / instrument           (e) __t('B#') probes rebuilt with new Function + caller stubs
//   edgeValues / edgeInputs / domPostconditions        (f) edge inputs + DOM post-conditions
//   mutants / mutationTest       (g) mutation-lite
//   ledger / format              (h) claims ledger + pass/fail gate
//
// There is NO AST parser in the sandbox. Every static check is a regex over a
// lexical mask (drMask). What that cannot see is listed in DR_LIMITATIONS,
// and the list is copied into every report.
// =============================================================

var DR_VERSION = '1.4.0';
var DR_LIMITATIONS = [
    'No AST: static checks are regexes over a lexical mask (comments, string/template text and regex bodies blanked). A regex literal after `)` or `]`, JSX and TypeScript can mis-mask.',
    'parseGateJs compiles with the AsyncFunction constructor: it accepts top-level await/return that a classic script rejects, strips import/export with line regexes, and gives no line number (hint = first unbalanced bracket).',
    'findFunctions sees `function` declarations/expressions, `x = function`, `x: function`, block-bodied arrows assigned to a name (default parameters may nest one level of parentheses), and line-start methods including static, async, get/set, *generator and async *generator. Expression-bodied arrows and computed names are missed.',
    'Wiring counts only references in masked code (comments and string text blanked) of non-excluded .js/.html files, outside the function own body: docs, comments, strings and test/ do not count (test-only references are unverified). Common names (render, init) can over-count, and dynamic dispatch (obj[name](), string handlers, tool registries) under-counts: declare those in opts.entryPoints or opts.waive:{name:reason}, which downgrade ONLY "defined but not referenced" wiring rows to unverified (never a missing symbol, id, handler, parse, file, probe or mutation row).',
    'Every grep hit is judged on the WHOLE-FILE mask (drMasker, cached per file). Reads are capped at opts.maxMaskReads (default 400) and opts.maskBudgetMs (default 30000 ms): a hit in a file that cannot be read, masked or reached within the budget is "unreadable" and never counts as a definition, use or reference, so the row is unverified, never verified or refuted.',
    'Branch counts are lexical: `?:` and `&&`/`||`/`??` count as branches whether or not they drive control flow. Named nested functions are excluded from the parent; anonymous callbacks are included. `default:` is not counted; an early return is any `return` with code after its line, EXCEPT a `return` that is the first statement of a `case`/`default:` arm or of a `try`/`catch`/`finally` block on the same line (that arm is already its own row).',
    'Live lookups use the workspace grep (case-sensitive, max 100 hits, gitignored files such as dist/ excluded). A capped (truncated) result with no definition in it is reported as unverified, never refuted.',
    'Probes instrument if/else-if/case/catch only (a real `catch (e) {` clause; Promise `.catch(fn)` is a call, not a branch row). Ternary, short-circuit and early-return rows are in the matrix but never probed (probe:false). An unhandled promise rejection is recorded as the run threw only when it fires within two event-loop ticks (MessageChannel) after the run settles and the host exposes globalThis.addEventListener(\'unhandledrejection\'); later rejections are missed.',
    'Mutation-lite skips operators inside for/while headers (infinite-loop risk), cannot time out synchronous code, and makes at most `max` (default 10) mutants.',
    'Ids, classes and message types built dynamically (concatenation, template ${}) are invisible to the cross-ref checks.',
    'CSS is parsed with CSSStyleSheet.replaceSync, which drops unparseable rules silently (@import ignored). The "CSS parses" row cross-checks brace balance on the comment- and string-stripped text (unbalanced = refuted) and the number of `{` blocks against the parsed rules (dropped blocks = unverified); a malformed declaration inside a kept rule is not detected. Class names are then pulled from each selectorText with a regex.',
    'parseGateHtml walks every element with DOMParser, including the inert contents of <template> (recursively), and compiles inline handlers and inline <script> bodies. Markup assembled in JS strings is not parsed, and DOMParser silently repairs malformed markup (unclosed tags are not reported).',
    'Qualified names (prose `obj.m()`, inline `onclick="obj.m()"`, listener handlers `obj.m`) are verified only when obj resolves statically to an object literal, a class, or an `obj.m =` / `obj.prototype.m =` assignment in non-test code, and the value is a function, class, arrow or a plain identifier alias (`obj.m = 5` or `{m: make()}` is unverified). Only single-segment qualifiers resolve: `app.obj.m()` is unverified (window/globalThis/self members are looked up as globals; built-in roots such as document/Math are checked against the live object, and a missing member of a present built-in is refuted). Known gap: a parameter or local that shadows the qualifier (`function q(obj){ obj.m = function(){} }`) still verifies `obj.m`, and a shorthand key `{m}` is trusted without checking what m holds. A runFile()/require() result, `this.m` or a parameter is unverified, never verified. A `var x = <non-literal>` (e.g. a factory call) makes `x()` unverified; a literal initializer is not a definition.',
    'Wiring skips object keys, single arrow params and parameter-list names, but other shadowing (a local `var fn` in another scope) still counts as a reference. opts.functions is a union with the diff; pass functionsOnly: true to analyse only the named functions. If opts.exclude removes every file, a config row is unverified (only the parse gate ran).',
    'Handler globals are a fixed list (alert, setTimeout, fetch, ...); sandbox globals (executeTool, runFile, loadFile, ...) never count as defined. Cross-ref uses, senders and handlers inside strings/templates are ignored, but id and class attributes inside JS markup strings still count as definitions/uses (markup built in JS). Identifiers found only in JSON or CSS string text are unverified.',
    'Inline on* handlers run in global scope: definitions inside <template> or only inside <script type="module"> (without window.x = x) do not count. Known gaps: a handler defined locally (inside an IIFE or another function) still counts as a global, and `window.h = bar` counts even when bar is not callable. Undefined handlers are only checked for onclick="..." attributes and addEventListener(name, fn) references, not for setTimeout(handler), arrow wrappers (addEventListener(\'x\', () => handler())) or el.onclick = handler.',
    'Message handlers: `case \'x\':` counts only under a switch on a type/action/cmd/command key, but any `.type === \'x\'` comparison counts, so a DOM check such as btn.type === \'submit\' satisfies a message of type submit. Wiring counts qualified uses (`other.foo()`, `o.foo = 1`) and destructured params (`function g({foo})`) as references to a top-level function foo.',
    'Known false FAILs (refuted where unverified is right): a single-line `var obj = {m(){...}}` makes prose `obj.m()` refuted (non-line-start methods are not found); a default value `function g(a = foo)` is treated as a parameter declaration, so wiring for foo is refuted; `import foo from ...`, `var {foo} = o` and a named function expression called through its variable make `foo()` refuted. Claimed helpers whose names are built-ins (remove(), filter()) come out verified with low confidence.',
    'Probes race an async result against opts.timeoutMs (default 5000 ms, ProbeTimeout is recorded as threw); a synchronous infinite loop still hangs. Mutation checks run the baseline twice (a check that only passes once is refuted) but have no timeout.',
    'Ledger statuses are verified, refuted and unverified (verified-builtin becomes verified with low confidence). Any other status in a report passed to ledger() is counted as refuted; a claims check returning a non-boolean gives unverified.',
    'Prose symbols: only single backticked tokens (identifier, name(), name:line, .class, #id, file:line) are checked. Backticked expressions are skipped and listed in symbols.skipped.'
];
var DR_AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// A definition found only in these paths never verifies a production symbol.
var DR_TEST_RE = /(^|\/)(test|tests|__tests__)\//;
var DR_JS_WORDS = /^(if|else|for|while|do|switch|case|default|break|continue|return|function|var|let|const|class|new|this|null|undefined|true|false|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|void|delete|import|export|from|NaN|Infinity|static|get|set)$/;

// ---------- lexical helpers ----------
function drEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
function drWord(n) { var e = drEsc(n); return /\$/.test(n) ? '(?<![\\w$])' + e + '(?![\\w$])' : '\\b' + e + '\\b'; }

// Same-length copy of src with comments blanked and, unless onlyComments, the text of
// strings, templates (but not their ${} code) and regex literals blanked. Newlines are kept,
// so indexes and line numbers stay valid against the original.
function drMask(src, onlyComments) {
    var s = String(src), n = s.length, out = s.split(''), stack = [], i = 0;
    function blank(a, b) { if (onlyComments) return; blankAlways(a, b); }
    function blankAlways(a, b) { for (var k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; }
    function regexAllowed(k) {
        var p = k - 1; while (p >= 0 && /\s/.test(s[p])) p--;
        if (p > 0 && (s[p] === '+' || s[p] === '-') && s[p - 1] === s[p]) return false; // a++ / 2: division after postfix ++/--
        if (p < 0 || '(,=:[!&|?{};+-*%<>~^'.indexOf(s[p]) >= 0) return true;
        var w = /([A-Za-z_$][\w$]*)$/.exec(s.slice(Math.max(0, p - 11), p + 1));
        return !!w && /^(return|typeof|case|in|of|delete|void|throw|new|do|else|yield|await|instanceof)$/.test(w[1]);
    }
    while (i < n) {
        var c = s[i], d = s[i + 1];
        if (stack[stack.length - 1] === 'tpl') {
            if (c === '\\') { blank(i, i + 2); i += 2; continue; }
            if (c === '`') { stack.pop(); i++; continue; }
            if (c === '$' && d === '{') { stack.push('expr'); i += 2; continue; }
            blank(i, i + 1); i++; continue;
        }
        if (c === '/' && d === '/') { var e = s.indexOf('\n', i); if (e < 0) e = n; blankAlways(i, e); i = e; continue; }
        if (c === '/' && d === '*') { var e2 = s.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2; blankAlways(i, e2); i = e2; continue; }
        if (c === '"' || c === "'") { var j = i + 1; while (j < n && s[j] !== c && s[j] !== '\n') j += (s[j] === '\\') ? 2 : 1; blank(i + 1, j); i = j + 1; continue; }
        if (c === '`') { stack.push('tpl'); i++; continue; }
        if (c === '{' && stack.length) { stack.push('{'); i++; continue; }
        if (c === '}' && stack.length) { stack.pop(); i++; continue; }
        if (c === '/' && regexAllowed(i)) {
            var r = i + 1, inClass = false, closed = false;
            while (r < n && s[r] !== '\n') {
                if (s[r] === '\\') { r += 2; continue; }
                if (inClass) { if (s[r] === ']') inClass = false; } else if (s[r] === '[') inClass = true; else if (s[r] === '/') { closed = true; break; }
                r++;
            }
            if (closed) { blank(i + 1, r); i = r + 1; continue; }
        }
        i++;
    }
    return out.join('');
}
function drLines(s) {
    var st = [0]; for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) st.push(i + 1);
    return function (idx) { var lo = 0, hi = st.length - 1; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (st[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
}
function drMatch(m, open) {
    var o = m[open], c = o === '(' ? ')' : o === '{' ? '}' : ']', depth = 0;
    for (var k = open; k < m.length; k++) { if (m[k] === o) depth++; else if (m[k] === c && --depth === 0) return k; }
    return -1;
}
function drBalance(m) {
    var st = [], pairs = { ')': '(', ']': '[', '}': '{' }, line = drLines(m);
    for (var k = 0; k < m.length; k++) {
        var ch = m[k];
        if ('([{'.indexOf(ch) >= 0) st.push(k);
        else if (pairs[ch]) { if (!st.length || m[st[st.length - 1]] !== pairs[ch]) return 'unexpected "' + ch + '" at line ' + line(k); st.pop(); }
    }
    return st.length ? 'unclosed "' + m[st[st.length - 1]] + '" opened at line ' + line(st[st.length - 1]) : null;
}
function drPreview(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'number' && isNaN(v)) return 'NaN';
    if (typeof v === 'function') return '[function]';
    if (typeof v === 'string') return v.length > 80 ? JSON.stringify(v.slice(0, 60)) + '...(' + v.length + ' chars)' : JSON.stringify(v);
    if (v && typeof v === 'object' && typeof v.nodeType === 'number') return '<' + (v.nodeName || 'node').toLowerCase() + '>';
    try { var j = JSON.stringify(v); return j && j.length > 80 ? j.slice(0, 77) + '...' : String(j); } catch (e) { return String(v); }
}
function drDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return isNaN(a) && isNaN(b);
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(function (k) { return drDeepEqual(a[k], b[k]); });
}
// Parameter list allowing one level of nested parentheses (default values such as a = f()).
var DR_PARAMS = '\\((?:[^()]|\\([^()]*\\))*\\)';
function drDefRe(n) {
    var e = drEsc(n);
    return new RegExp('function\\s*\\*?\\s*' + e + '\\s*\\(|(?:var|let|const|class)\\s+' + e + '(?![\\w$])' +
        '|(?:^|[^\\w$.])' + e + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|' + DR_PARAMS + '\\s*=>|[\\w$]+\\s*=>)' +
        '|^\\s*(?:static\\s+)?(?:async\\s+)?(?:(?:get|set)\\s+)?(?:\\*\\s*)?' + e + '\\s*' + DR_PARAMS + '\\s*\\{|\\.' + e + '\\s*=\\s*(?:async\\s*)?(?:function\\b|class\\b|' + DR_PARAMS + '\\s*=>|[\\w$]+\\s*=>)');
}
// Strict form for alias targets: a function, class, arrow or method, never a bare var/let/const.
function drFnDefRe(n) {
    var e = drEsc(n);
    return new RegExp('function\\s*\\*?\\s*' + e + '\\s*\\(|class\\s+' + e + '(?![\\w$])|(?:^|[^\\w$.])' + e + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|class\\b|' + DR_PARAMS + '\\s*=>|[\\w$]+\\s*=>)' +
        '|^\\s*(?:static\\s+)?(?:async\\s+)?(?:(?:get|set)\\s+)?(?:\\*\\s*)?' + e + '\\s*' + DR_PARAMS + '\\s*\\{');
}
// Call targets: a function, class, arrow or method, or obj.n = function/class/arrow. A bare var/let/const is not callable proof.
function drCallDefRe(n) {
    return new RegExp(drFnDefRe(n).source + '|\\.' + drEsc(n) + '\\s*=\\s*(?:async\\s*)?(?:function\\b|class\\b|' + DR_PARAMS + '\\s*=>|[\\w$]+\\s*=>)');
}
function drIdDefRe(n) {
    var e = drEsc(n);
    return new RegExp('(?<!\\b(?:var|let|const)\\s+)\\bid\\s*=\\s*\\\\?["\'`]' + e + '\\\\?["\'`]|setAttribute\\(\\s*["\']id["\']\\s*,\\s*["\'`]' + e + '["\'`]|\\bid\\s*:\\s*["\'`]' + e + '["\'`]');
}
// Sandbox/test-harness globals (executeTool, runFile, describe...) exist where the helper runs, not in the code under review.
var DR_SANDBOX_GLOBALS = /^(?:executeTool|loadFile|runFile|loadModules|sleep|delay|describe|test|it|assert|skipTest|beforeEach|afterEach|args|module|exports|evalModule|fakeChrome|fakeWindow)$/;
// Standard browser globals an inline handler or listener may call unqualified: a FIXED list, never the live globalThis.
var DR_STD_GLOBALS = /^(?:alert|confirm|prompt|setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame|queueMicrotask|fetch|open|close|print|focus|blur|scroll|scrollTo|scrollBy|postMessage|getComputedStyle|matchMedia|atob|btoa|structuredClone|parseInt|parseFloat|isNaN|isFinite|encodeURI|decodeURI|encodeURIComponent|decodeURIComponent|stop|reportError|getSelection)$/;
// Built-in objects: a qualifier rooted here is judged by walking globalThis (Math.max, JSON.parse, console.log).
var DR_STD_OBJECTS = /^(?:Math|JSON|Object|Array|String|Number|Promise|Reflect|Intl|Date|RegExp|Error|Symbol|Map|Set|URL|console|document|navigator|location|history|localStorage|sessionStorage|crypto|performance)$/;
function drIsBuiltin(n) {
    if (DR_SANDBOX_GLOBALS.test(n)) return false;
    var pools = [globalThis];
    ['Element', 'HTMLElement', 'Node', 'EventTarget', 'Document', 'Array', 'String', 'Object', 'Promise', 'Map', 'Set', 'Number', 'Date', 'RegExp', 'JSON', 'Math'].forEach(function (k) {
        var C = globalThis[k]; if (C) { pools.push(C); if (C.prototype) pools.push(C.prototype); }
    });
    return pools.some(function (p) { try { return n in p; } catch (e) { return false; } });
}
// Inline handler / listener targets: only an OWN function property of the global object (alert, close, setTimeout),
// never a prototype or static member (assign, keys, toString) that an unqualified call cannot reach.
function drOwnGlobal(n) { return DR_STD_GLOBALS.test(n); }
function drDeclaredNames(texts) {
    var set = Object.create(null);
    texts.forEach(function (t) {
        // only callables: function/class declarations, var x = function|class|arrow, window.x = function|arrow|identifier;
        var fnv = '(?:async\\s*)?(?:function\\b|class\\b|' + DR_PARAMS + '\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)', x;
        var m = drMask(t), re = new RegExp('\\bfunction\\s*\\*?\\s*([A-Za-z_$][\\w$]*)|\\bclass\\s+([A-Za-z_$][\\w$]*)|\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + fnv +
            '|(?:window|globalThis|self)\\.([A-Za-z_$][\\w$]*)\\s*=\\s*(?:' + fnv + '|(?!(?:null|undefined|true|false|NaN)\\b)[A-Za-z_$][\\w$]*\\s*(?:;|$))', 'gm');
        while ((x = re.exec(m))) set[x[1] || x[2] || x[3] || x[4]] = true;
    });
    return set;
}

// Definitions only count in code files, judged on the WHOLE-FILE mask (a multi-line comment or template is blanked).
var DR_CODE_RE = /\.(m?[jt]sx?|cjs|html?)$/;
function drBlank(out, a, b) { for (var k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; }
// HTML code = inline on* handler values + JS <script> bodies, both through drMask; markup and body text are blanked.
// commentsOnly keeps markup and string text and blanks only <!-- --> and script comments (for id definitions).
function drMaskHtml(src, commentsOnly) {
    var s = String(src), out = s.split(''), markup = s.split(''), code = s.replace(/[^\n]/g, ' ').split(''), x;
    var re = /<!--[\s\S]*?(?:-->|$)|(<script\b([^>]*)>)([\s\S]*?)(?=<\/script\s*>|$)/gi;
    while ((x = re.exec(s))) {
        if (x[1] == null) { drBlank(out, x.index, x.index + x[0].length); drBlank(markup, x.index, x.index + x[0].length); continue; }
        var b0 = x.index + x[1].length, body = x[3], ty = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(x[2]), js = !ty || /^(|module|(text|application)\/(java|ecma)script)$/i.test(ty[1]);
        var mk = js ? drMask(body, !!commentsOnly) : body;
        for (var k = 0; k < body.length; k++) { out[b0 + k] = mk[k]; if (js) code[b0 + k] = mk[k]; if (body[k] !== '\n') markup[b0 + k] = ' '; }
    }
    if (commentsOnly) return out.join('');
    var mu = markup.join(''), tag = /<[A-Za-z][\w:-]*(?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/g, t;
    while ((t = tag.exec(mu))) {
        var at = /\s(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, a;
        while ((a = at.exec(t[0]))) {
            var v = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4], off = t.index + a.index + a[0].length - v.length - (a[4] != null ? 0 : 1), mv = drMask(v);
            for (var q = 0; q < v.length; q++) code[off + q] = mv[q];
        }
    }
    // inert <template> contents define nothing until cloned: their scripts/handlers are not code
    var tp = /<template\b[^>]*>[\s\S]*?(?:<\/template\s*>|$)/gi;
    while ((t = tp.exec(mu))) drBlank(code, t.index, t.index + t[0].length);
    return code.join('');
}
// CSS: comments blanked, strings kept (a "/*" inside content: "..." is not a comment opener).
function drMaskCss(src) { return String(src).replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|\/\*[\s\S]*?(?:\*\/|$)/g, function (c) { return c[0] === '/' ? c.replace(/[^\n]/g, ' ') : c; }); }
// kind 'code': comments + string text blanked; 'cmt': comments only. null = not a code file.
function drMaskFile(p, text, kind) {
    if (/\.html?$/.test(p)) return drMaskHtml(text, kind === 'cmt');
    if (/\.css$/.test(p)) return drMaskCss(text);
    if (/\.(m?[jt]sx?|cjs)$/.test(p)) return drMask(text, kind === 'cmt');
    if (/\.json$/.test(p)) return String(text);
    return null;
}
// Whole-file masks, cached per file for the run. A hit whose file cannot be read (or whose line is out of range) is
// 'unreadable': it never counts as a definition, a use or a reference. Reads are capped by count and wall time.
function drMasker(io, files, opts) {
    opts = opts || {};
    var raw = Object.create(null), masks = Object.create(null), css = Object.create(null), why = Object.create(null), reads = 0, t0 = Date.now();
    var maxReads = opts.maxMaskReads || 400, maxMs = opts.maskBudgetMs || 30000;
    async function text(p) {
        if (p in raw) return raw[p];
        var t = files && Object.prototype.hasOwnProperty.call(files, p) && typeof files[p] === 'string' ? files[p] : null;
        if (t == null) {
            if (reads >= maxReads || Date.now() - t0 > maxMs) { why[p] = 'mask budget exhausted (' + reads + ' reads, ' + (Date.now() - t0) + ' ms)'; return null; }
            reads++; t = await io.read(p);
            if (typeof t !== 'string') { t = null; why[p] = (io.errorFor && io.errorFor('read', p)) || 'file could not be read'; }
        }
        raw[p] = t; return t;
    }
    async function lines(p, kind) {
        var key = kind + ':' + p; if (key in masks) return masks[key];
        var t = await text(p); if (t == null) return null;
        var m = drMaskFile(p, t, kind); return (masks[key] = m == null ? null : m.split('\n'));
    }
    async function cssClasses(p) { if (!(p in css)) { var t = await text(p); css[p] = t == null ? null : drCssClasses(t).classes; } return css[p]; }
    return { text: text, lines: lines, cssClasses: cssClasses, why: function (p) { return why[p] || 'file could not be read'; }, stats: function () { return { reads: reads, ms: Date.now() - t0 }; } };
}
// Where re matches on hit h: 'code' | 'string' (only in string/template text) | 'comment' | 'doc' (non-code file) | 'unreadable'.
async function drHitClass(mk, h, re) {
    if (!DR_CODE_RE.test(h.file) && !/\.(css|json)$/.test(h.file)) return 'doc';
    var c = await mk.lines(h.file, 'code'); if (!c || c[h.line - 1] == null) return 'unreadable';
    if (/\.(css|json)$/.test(h.file)) return re.test(c[h.line - 1]) ? 'string' : 'comment'; // data, never code
    if (re.test(c[h.line - 1])) return 'code';
    var k = await mk.lines(h.file, 'cmt'); return k && k[h.line - 1] != null && re.test(k[h.line - 1]) ? 'string' : 'comment';
}
async function drClassify(mk, hits, re, testish) {
    var c = { code: [], string: [], comment: [], doc: [], test: [], unreadable: [] };
    for (var i = 0; i < hits.length; i++) { var h = hits[i]; if (testish && testish(h.file)) c.test.push(h); else c[await drHitClass(mk, h, re)].push(h); }
    return c;
}
// Definition hits of re judged on the whole-file code mask. unreadable = production raw-line candidates that could not be masked.
async function drDefs(mk, re, hits, testish) {
    var out = { defs: [], prod: [], unreadable: [] };
    for (var i = 0; i < hits.length; i++) {
        var h = hits[i]; if (!DR_CODE_RE.test(h.file)) continue;
        var c = await mk.lines(h.file, 'code'), ln = c ? c[h.line - 1] : null;
        if (ln == null) { if (re.test(h.text) && !testish(h.file)) out.unreadable.push(h); continue; }
        if (re.test(ln)) { out.defs.push(h); if (!testish(h.file)) out.prod.push(h); }
    }
    return out;
}
function drAt(hs) { return hs.slice(0, 3).map(function (h) { return h.file + ':' + h.line; }).join(', '); }
// First production hit where re matches on the whole-file code mask (early exit: at most one read per file).
async function drFirstCode(mk, hits, re, testish) { for (var i = 0; i < hits.length; i++) if (!testish(hits[i].file) && await drHitClass(mk, hits[i], re) === 'code') return hits[i]; return null; }
// One macrotask (MessageChannel, not setTimeout: background tabs throttle timers).
function drTick() { return new Promise(function (res) { if (typeof MessageChannel !== 'function') { Promise.resolve().then(res); return; } var ch = new MessageChannel(); ch.port1.onmessage = function () { ch.port1.close(); res(); }; ch.port2.postMessage(0); }); }
function drExcluder(opts) {
    var ex = [], errors = [];
    (opts && opts.exclude != null ? [].concat(opts.exclude) : [/^test\//]).forEach(function (e) {
        if (e instanceof RegExp) { ex.push(e); return; }
        try { ex.push(new RegExp(String(e))); } catch (er) { errors.push({ claim: 'opts.exclude entry ' + JSON.stringify(String(e)) + ' is a valid regex', evidence: er.message }); }
    });
    function inExclude(p) { return ex.some(function (re) { re.lastIndex = 0; return re.test(p); }); }
    return { inExclude: inExclude, testish: function (p) { return inExclude(p) || DR_TEST_RE.test(p); }, errors: errors };
}
// Keys of object literals exported via module.exports / exports / export default / window.X, or assigned to an
// UPPERCASE or *api* variable: {run: drRun} -> run -> drRun, {foo} -> foo -> foo.
function drExportAliases(src) {
    var m = drMask(src), line = drLines(src), out = {}, exported = {}, x;
    var ex = /(?:module\.exports|\bexports|(?:window|globalThis|self)\.[\w$]+)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|$)|export\s+default\s+([A-Za-z_$][\w$]*)/gm;
    while ((x = ex.exec(m))) exported[x[1] || x[2]] = true;
    var re = /(module\.exports|\bexports|(?:window|globalThis|self)\.[\w$]+)\s*=\s*\{|export\s+default\s+\{|\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    while ((x = re.exec(m))) {
        if (x[2] && !(exported[x[2]] || /^[A-Z][A-Z0-9_]*$/.test(x[2]) || /api/i.test(x[2]))) continue;
        var open = x.index + x[0].length - 1, close = drMatch(m, open); if (close < 0) continue;
        var body = m.slice(open + 1, close), depth = 0, start = 0, parts = [];
        for (var k = 0; k <= body.length; k++) {
            var ch = body[k];
            if (k === body.length || (ch === ',' && depth === 0)) { parts.push([start, body.slice(start, k)]); start = k + 1; }
            else if ('([{'.indexOf(ch) >= 0) depth++; else if (')]}'.indexOf(ch) >= 0) depth--;
        }
        parts.forEach(function (p) {
            var q = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$.]*)\s*)?$/.exec(p[1]);
            if (q && !out[q[1]]) out[q[1]] = { target: (q[2] || q[1]).split('.').pop(), line: line(open + 1 + p[0] + Math.max(0, p[1].search(/\S/))) };
        });
    }
    return out;
}
async function drAliasDef(name, hits, io, mk, testish) {
    mk = mk || drMasker(io, null); testish = testish || function (p) { return DR_TEST_RE.test(p); };
    var seen = {}, n = 0, ak = new RegExp('(?:^|[{,\\s])' + drEsc(name) + '\\s*[:,}]|^\\s*' + drEsc(name) + '\\s*$'), cand = hits.filter(function (h) { return DR_CODE_RE.test(h.file) && !testish(h.file); });
    cand.sort(function (x, y) { return (ak.test(y.text) ? 1 : 0) - (ak.test(x.text) ? 1 : 0); }); // alias-looking lines (key: value / shorthand) first
    for (var i = 0; i < cand.length && n < 10; i++) {
        var f = cand[i].file; if (seen[f]) continue; seen[f] = 1; n++;
        var src = await mk.text(f), ml = src == null ? null : await mk.lines(f, 'code'); if (!ml) continue;
        var ea = drExportAliases(src), al = Object.prototype.hasOwnProperty.call(ea, name) ? ea[name] : null, pre = new RegExp('\\.' + drEsc(name) + '\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*(?:;|,|$)'), pm;
        // obj.name = knownFn; is a property alias of a function, never proof on its own (opts.x = 3 is not a definition)
        for (var k0 = 0; !al && k0 < ml.length; k0++) if ((pm = pre.exec(ml[k0])) && !DR_JS_WORDS.test(pm[1])) al = { target: pm[1], line: k0 + 1, prop: true };
        if (!al) continue;
        var tre = drFnDefRe(al.target), d = -1, how = al.prop ? 'property alias ' : 'exported alias ';
        for (var k = 0; k < ml.length && d < 0; k++) if (tre.test(ml[k])) d = k;
        if (d >= 0) return { status: 'verified', evidence: how + name + ' -> ' + al.target + ' at ' + f + ':' + al.line + ' (' + al.target + ' defined at ' + f + ':' + (d + 1) + ')' };
        return { status: 'unverified', evidence: (al.prop ? 'assigned as .' : 'exported as ') + name + ' = ' + al.target + ' at ' + f + ':' + al.line + ' but ' + al.target + ' is not a function defined in ' + f };
    }
    return null;
}
// Is 1-based line inside a <script type="module"> body that does not also publish window.name = ...?
function drInModuleScript(text, line, name) {
    var s = String(text == null ? '' : text), re = /<script\b[^>]*\btype\s*=\s*["']?module\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi, x;
    while ((x = re.exec(s))) {
        var a = s.slice(0, x.index).split('\n').length, b = a + x[0].split('\n').length - 1;
        if (line >= a && line <= b) return !new RegExp('(?:window|globalThis|self)\\.' + drEsc(name) + '\\s*=(?!=)').test(x[1]);
    }
    return false;
}
// var|let|const n = <literal> (number, string, array, object, true/false/null/undefined/NaN): never callable.
function drLiteralInit(text, n) { return new RegExp('\\b(?:var|let|const)\\s+' + drEsc(n) + '\\s*=\\s*(?:-?\\s*\\d|["\'\\x60\\[{]|(?:true|false|null|undefined|NaN)\\b)').test(String(text || '')); }
// Blank the contents of nested brackets so only the top level of an object/class body can be keyed.
function drFlat(body) {
    var out = String(body).split(''), depth = 0;
    for (var k = 0; k < out.length; k++) {
        var ch = out[k];
        if ('([{'.indexOf(ch) >= 0) { if (depth++ > 0) out[k] = ' '; }
        else if (')]}'.indexOf(ch) >= 0) { depth = Math.max(0, depth - 1); if (depth > 0) out[k] = ' '; }
        else if (depth > 0 && ch !== '\n') out[k] = ' ';
    }
    return out.join('');
}
// qual.member resolves? -> {ok, builtin?, why}. Built-in roots walk globalThis; window/globalThis/self defer to the member;
// otherwise the LAST qualifier segment must be an object literal / class with that key, or get own(.prototype).member = ...
async function drQualCheck(qual, member, io, mk, testish) {
    var segs = String(qual).split('.'), e = drEsc(member);
    if (segs.length > 1 && /^(?:window|globalThis|self)$/.test(segs[0])) { segs = segs.slice(1); qual = segs.join('.'); }
    var root = segs[0];
    testish = testish || function (p) { return DR_TEST_RE.test(p); };
    if (root === 'this' || root === 'super') return { ok: false, why: root + '.' + member + ': the receiver is not known statically' };
    if (/^(?:window|globalThis|self)$/.test(qual)) return { ok: true, why: 'global member' };
    if (DR_STD_OBJECTS.test(root)) {
        var o = globalThis, has = false;
        for (var i = 0; i < segs.length && o != null; i++) { try { o = o[segs[i]]; } catch (er) { o = null; } }
        try { has = o != null && member in Object(o); } catch (er) { has = false; }
        if (has) return { ok: true, builtin: true, why: qual + '.' + member + ' is a built-in member' };
        // refute only when the built-in object itself is present in this runtime (no document in a worker: unverified)
        return o != null ? { ok: false, refute: true, why: member + ' is not a member of built-in ' + qual } : { ok: false, why: 'built-in ' + qual + ' is not available in this runtime' };
    }
    if (segs.length > 1) return { ok: false, why: 'multi-segment qualifier ' + qual + ' is not resolved statically' };
    var own = segs[0], hits = await io.grep(drWord(own));
    if (hits == null) return { ok: false, why: 'grep unavailable for qualifier ' + own };
    var seen = {}, texts = [];
    for (var j = 0; j < hits.length && texts.length < 20; j++) {
        var f = hits[j] && hits[j].file; if (!f || seen[f] || !DR_CODE_RE.test(f) || testish(f)) continue; seen[f] = 1;
        var ml = await mk.lines(f, 'code'); if (ml) texts.push(ml.join('\n'));
    }
    // the value must be callable (function/class/arrow) or a plain identifier alias: obj.m = 5 / {m: make()} are not proof
    var val = '(?:(?:async\\s*)?(?:function\\b|class\\b|' + DR_PARAMS + '\\s*=>|[\\w$]+\\s*=>)|(?!(?:null|undefined|true|false|NaN)\\b)[A-Za-z_$][\\w$.]*\\s*(?:[;,)}]|$))';
    var m = texts.join('\n;\n'), w = '(?:^|[^\\w$.])' + drEsc(own);
    if (new RegExp(w + '(?:\\.prototype)?\\.' + e + '\\s*=(?![=>])\\s*' + val, 'm').test(m)) return { ok: true, why: own + '.' + member + ' is assigned a function' };
    // a key sits at a line start or right after { or , (never after ? or ( inside a value expression)
    var key = new RegExp('(?<![:=]\\s*)(?:^|[{,])\\s*(?:static\\s+)?(?:async\\s+)?(?:(?:get|set)\\s+)?\\*?\\s*' + e + '\\s*(?:\\(|[,}]|$|[:=]\\s*' + val + ')', 'm');
    var re = new RegExp(w + '\\s*[:=]\\s*\\{|\\bclass\\s+' + drEsc(own) + '(?![\\w$])[^{]*\\{', 'g'), x;
    while ((x = re.exec(m))) {
        var open = x.index + x[0].length - 1, close = drMatch(m, open); if (close < 0) continue;
        if (key.test(drFlat(m.slice(open + 1, close)))) return { ok: true, why: own + ' has member ' + member };
    }
    return { ok: false, why: qual + ' does not resolve to an object literal, class or assignment with member ' + member + ' (runFile/require result?)' };
}
// Is this masked line a real reference to name? Object keys ({name: 1}), single arrow params (name => ...) and names
// inside a parameter list (function f(name), (a, name) => ..., method(name) {) are declarations, not references.
function drRealRef(txt, name) {
    var re = new RegExp(drWord(name), 'g'), x;
    while ((x = re.exec(txt))) {
        var i = x.index, before = txt.slice(0, i), after = txt.slice(i + x[0].length);
        if (/^\s*:(?!:)/.test(after) && /(?:^|[{,])\s*$/.test(before)) continue;
        if (/^\s*=>/.test(after)) continue;
        var d = 0, j = i - 1;
        for (; j >= 0; j--) { var c = txt[j]; if (c === ')' || c === ']' || c === '}') d++; else if (c === '(' || c === '[' || c === '{') { if (d === 0) break; d--; } }
        if (j >= 0 && txt[j] === '(') {
            var pre = txt.slice(0, j), cl = drMatch(txt, j), post = cl >= 0 ? txt.slice(cl + 1) : '';
            if (/\bfunction\s*\*?\s*[\w$]*\s*$/.test(pre) || (cl >= 0 && /^\s*=>/.test(post))) continue;
            var mh = /^\s*(?:(?:static|async|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*$/.exec(pre);
            if (mh && !/^(?:if|for|while|switch|catch|with|return|typeof|await|new|function)$/.test(mh[1]) && cl >= 0 && /^\s*\{/.test(post)) continue;
        }
        return true;
    }
    return false;
}
// Probe post-conditions only make sense for DOM/HTML producers: DOM APIs or an HTML tag literal in the source.
function drLooksDom(fnSrc) { return /\b(document|createElement|innerHTML|outerHTML|insertAdjacentHTML|DOMParser|appendChild)\b|['"]\s*<\/?[A-Za-z!]/.test(drMask(fnSrc, true)) || /\x60\s*<\/?[A-Za-z!]/.test(String(fnSrc)); }

// ---------- IO: in-memory corpus (tests/offline) or live workspace tools ----------
// opts.io: inject a custom {live, read, grep, diff, ls} (tests / other backends, e.g. a ServiceNow lookup).
function drIO(opts) {
    if (opts.io) return opts.io;
    var ws = opts.workspace, ex = (typeof executeTool === 'function') ? executeTool : null, lf = (typeof loadFile === 'function') ? loadFile : null;
    var local = null, avail = null;
    if (opts.corpus) { local = Object.assign({}, opts.corpus); if (opts.files && !Array.isArray(opts.files)) Object.assign(local, opts.files); }
    return {
        live: !local && !!ex,
        // false when the workspace itself cannot be listed: a missing file then proves nothing
        available: async function () {
            if (local) return true;
            if (!ex) return !!lf;
            if (avail == null) { var r = await ex('workspace', { action: 'ls', path: '', workspace: ws }); avail = !!(r && r.success !== false); }
            return avail;
        },
        read: async function (p) {
            if (local) return Object.prototype.hasOwnProperty.call(local, p) ? String(local[p]) : null;
            if (opts.files && !Array.isArray(opts.files) && opts.files[p] != null) return String(opts.files[p]);
            if (lf) { try { var t = await lf(p, ws); if (typeof t === 'string') return t; } catch (e) { /* fall through */ } }
            if (ex) { var r = await ex('workspace', { action: 'read', path: p, workspace: ws }); if (r && r.success !== false && typeof r.content === 'string') return r.content.replace(/^\d+\t/gm, ''); }
            return null;
        },
        // -> [{file,line,text}] or null when no grep is available (callers then report "unverified", never "0 hits").
        grep: async function (pattern) {
            if (local) {
                var re = new RegExp(pattern), out = [];
                Object.keys(local).forEach(function (p) { String(local[p]).split('\n').forEach(function (t, i) { if (re.test(t)) out.push({ file: p, line: i + 1, text: t }); }); });
                return out;
            }
            if (!ex) return null;
            var r = await ex('workspace', { action: 'grep', pattern: pattern, workspace: ws, limit: 100, ignore_case: false, path: opts.grepPath });
            if (!(r && r.success !== false && Array.isArray(r.matches))) return null;
            var arr = r.matches.slice(); arr.truncated = !!r.truncated; // capped at 100: absence of a definition proves nothing
            return arr;
        },
        diff: async function (p) {
            if (local || !ex) return null;
            var r = await ex('workspace', { action: 'diff', path: p, workspace: ws });
            return (r && r.diffs && r.diffs[0] && typeof r.diffs[0].diff === 'string') ? r.diffs[0].diff : null;
        },
        ls: async function (dir) {
            if (local) return Object.keys(local).filter(function (p) { return p.indexOf(dir + '/') === 0; }).map(function (p) { return p.slice(dir.length + 1); });
            if (!ex) return [];
            var r = await ex('workspace', { action: 'ls', path: dir, workspace: ws });
            return (r && r.entries) || [];
        }
    };
}

// Every IO call goes through this: a throw (or a wrong return type) becomes an ioErrors[] entry and the
// "unavailable" default (read/grep/diff -> null, ls -> []), so dependent rows are unverified, never a crash.
function drSafeIO(io, errs) {
    var failed = {};
    function note(op, arg, e) { var msg = (e && e.message) || String(e); errs.push({ op: op, arg: String(arg == null ? '' : arg).slice(0, 120), error: msg }); failed[op + ':' + arg] = msg; }
    function wrap(op, dflt, ok) {
        return async function (arg) {
            if (!io || typeof io[op] !== 'function') return dflt;
            try { var r = await io[op](arg); if (r == null) return dflt; if (ok(r)) return r; note(op, arg, new Error(op + ' returned ' + (Array.isArray(r) ? 'a malformed array' : typeof r))); return dflt; }
            catch (e) { note(op, arg, e); return dflt; }
        };
    }
    return {
        live: !!(io && io.live), errors: errs,
        read: wrap('read', null, function (r) { return typeof r === 'string'; }),
        // every hit must be {file:string, line:int>=1, text:string}; [null] or a bad shape is an ioError, never 0 hits
        grep: wrap('grep', null, function (r) { return Array.isArray(r) && r.every(function (h) { return !!h && typeof h === 'object' && typeof h.file === 'string' && !!h.file && typeof h.text === 'string' && typeof h.line === 'number' && h.line >= 1 && h.line % 1 === 0; }); }),
        diff: wrap('diff', null, function (r) { return typeof r === 'string'; }),
        ls: wrap('ls', [], function (r) { return Array.isArray(r) && r.every(function (e) { return typeof e === 'string'; }); }),
        available: async function () { if (!io || typeof io.available !== 'function') return true; try { return (await io.available()) !== false; } catch (e) { note('available', '', e); return false; } },
        errorFor: function (op, arg) { return failed[op + ':' + arg] || null; }
    };
}

// ---------- (a) parse gate ----------
function drStripModule(src) {
    var keep = function (m) { return m.replace(/[^\n]/g, ' '); };
    return String(src)
        .replace(/^#!.*/, keep)
        .replace(/\bimport\.meta\b/g, 'Object     ')
        .replace(/^[ \t]*import\s+(?:[\w$]+|\*\s*as\s+[\w$]+|\{[^{}]*\}|[\w$]+\s*,\s*(?:\{[^{}]*\}|\*\s*as\s+[\w$]+))\s*from\s*['"][^'"\n]+['"];?/gm, keep)
        .replace(/^[ \t]*export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s*['"][^'"\n]+['"];?/gm, keep)
        .replace(/^[ \t]*import\s*['"][^'"\n]+['"];?/gm, keep)
        .replace(/^[ \t]*export\s*\{[^}]*\}(?:\s*from\s*['"][^'"\n]+['"])?;?/gm, keep)
        .replace(/^([ \t]*)export\s+default\s+/gm, '$1void ')
        .replace(/^([ \t]*)export\s+(?=(?:async\s+)?function|class\b|const\b|let\b|var\b)/gm, '$1');
}
function drParseGateJs(file, src) {
    try { new DR_AsyncFunction(drStripModule(src)); return { file: file, ok: true }; }
    catch (e) { return { file: file, ok: false, error: e.name + ': ' + e.message, hint: drBalance(drMask(src)) }; }
}
var DR_HANDLER_SKIP = /^(if|for|while|switch|return|typeof|function|new|event|this|window|document|console|alert|confirm|prompt|setTimeout|clearTimeout|Math|JSON|Number|String|Boolean|parseInt|parseFloat|encodeURIComponent|decodeURIComponent)$/;
function drCalls(code) {
    var m = drMask(code), re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g, out = [], x;
    while ((x = re.exec(m))) if (!DR_HANDLER_SKIP.test(x[2]) && out.indexOf(x[2]) < 0) out.push(x[2]);
    // qualified calls root.member(...): window/globalThis/self.x -> x; built-in roots are skipped; anything else is
    // returned qualified ('obj.run') and judged by drQualCheck (unverified unless obj provably has the member)
    var qre = /(^|[^\w$.])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/g;
    while ((x = qre.exec(m))) { var q = drHandlerName(x[2].replace(/\s+/g, '')); if (q && out.indexOf(q) < 0) out.push(q); }
    return out;
}
// 'window.f' -> 'f', 'obj.f' -> 'obj.f', built-in objects ('document.x', 'Math.x') stay qualified and are judged live by
// drQualCheck; handler-scope roots (event.x, this.x) -> null (not judged)
function drHandlerName(h) {
    var s = String(h).split('.'), r = s[0];
    if (s.length < 2) return h;
    if (/^(?:window|globalThis|self)$/.test(r)) return s.slice(1).join('.');
    if (DR_HANDLER_SKIP.test(r) && !DR_STD_OBJECTS.test(r)) return null;
    return s.join('.');
}
// known(name) -> boolean. Without it, handler targets are listed but not judged.
// Every element, including the inert contents of <template> (recursively).
function drAllEls(root) {
    var out = [];
    (function walk(r) { Array.prototype.forEach.call(r.querySelectorAll('*'), function (el) { out.push(el); if (el.tagName === 'TEMPLATE' && el.content) walk(el.content); }); })(root);
    return out;
}
function drParseGateHtml(file, html, known) {
    var doc = new DOMParser().parseFromString(String(html), 'text/html'), all = drAllEls(doc), issues = [], count = Object.create(null), calls = [], unknown = [];
    all.forEach(function (el) { if (el.hasAttribute('id')) count[el.id] = (count[el.id] || 0) + 1; });
    Object.keys(count).forEach(function (id) { if (count[id] > 1) issues.push({ kind: 'duplicate-id', subject: id, detail: 'id "' + id + '" appears ' + count[id] + ' times' }); });
    all.forEach(function (el) {
        Array.prototype.forEach.call(el.attributes, function (a) {
            if (!/^on[a-z]+$/i.test(a.name)) return;
            try { new Function('event', a.value); } catch (e) { issues.push({ kind: 'handler-syntax', subject: a.name, detail: '<' + el.tagName.toLowerCase() + ' ' + a.name + '>: ' + e.message }); return; }
            drCalls(a.value).forEach(function (n) {
                calls.push({ tag: el.tagName.toLowerCase(), attr: a.name, name: n });
                var kn = known ? known(n) : true; // known() may return null: undecidable (grep unavailable/capped) -> unverified, not missing
                if (kn === null) unknown.push({ tag: el.tagName.toLowerCase(), attr: a.name, name: n });
                else if (!kn) issues.push({ kind: 'missing-handler', subject: n, detail: '<' + el.tagName.toLowerCase() + ' ' + a.name + '> calls ' + n + '() which is not defined' });
            });
        });
    });
    all.filter(function (el) { return el.tagName === 'SCRIPT' && !el.hasAttribute('src') && /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i.test((el.getAttribute('type') || '').trim()); }).forEach(function (s) {
        var r = drParseGateJs(file + '<script>', s.textContent); if (!r.ok) issues.push({ kind: 'script-syntax', subject: file, detail: r.error });
    });
    return { file: file, ok: issues.length === 0, ids: Object.keys(count), handlerCalls: calls, issues: issues, unverified: unknown };
}

// ---------- (b) prose symbols + cross-refs ----------
function drProseSymbols(prose) {
    var out = [], skipped = [], seen = {}, re = /`([^`\n]{1,160})`/g, m;
    while ((m = re.exec(String(prose || '')))) {
        var raw0 = m[1].trim(), raw = raw0.replace(/^(?:await|new)\s+(?=[A-Za-z_$])/, '').replace(/\s*;$/, ''), s = null, x;
        if ((x = /^([\w.\/-]+\.(?:js|mjs|css|html|md|json|xml))(?::(\d+)(?:\s*[-\u2013]\s*(\d+))?)?$/.exec(raw))) s = { kind: 'fileRef', name: x[1], line: x[2] ? +x[2] : null, lineEnd: x[3] ? +x[3] : null };
        else if ((x = /^\.(-?[A-Za-z_][\w-]*)$/.exec(raw))) s = { kind: 'cssClass', name: x[1] };
        else if ((x = /^#([A-Za-z_][\w-]*)$/.exec(raw))) s = { kind: 'id', name: x[1] };
        else if ((x = /^((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\s*\([^()]*\)$/.exec(raw))) s = { kind: 'function', name: x[2], qual: x[1].slice(0, -1) };
        else if ((x = /^([A-Za-z_$][\w$]*):(\d+)(?:[-\u2013]\d+)?$/.exec(raw))) s = { kind: 'function', name: x[1], line: +x[2] };
        else if ((x = /^((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)$/.exec(raw))) s = { kind: 'identifier', name: x[2], qual: x[1].slice(0, -1) };
        if (!s || DR_JS_WORDS.test(s.name) || (s.kind === 'identifier' && s.name.length < 3)) { if (skipped.indexOf(raw) < 0) skipped.push(raw); continue; }
        if (!s.qual) delete s.qual;
        var key = s.kind + ':' + (s.qual ? s.qual + '.' : '') + s.name + ':' + (s.line || '');
        if (!seen[key]) { seen[key] = 1; s.raw = raw0; out.push(s); }
    }
    return { symbols: out, skipped: skipped };
}
// ctx {mk, testish}: shared whole-file masker + exclude predicate. Every existence verdict is judged on the masked
// code, never on the raw grep line: a comment/string/doc-only hit never verifies; comment-only is refuted.
async function drCheckSymbols(symbols, io, opts, ctx) {
    opts = opts || {}; ctx = ctx || {}; symbols = Array.isArray(symbols) ? symbols : [];
    var res = [], cap = opts.maxSymbols || 40, testish = ctx.testish || drExcluder(opts).testish;
    var mk = ctx.mk || drMasker(io, opts.files && !Array.isArray(opts.files) ? opts.files : null, opts);
    for (var k = 0; k < symbols.length; k++) {
        var s = symbols[k], r = { kind: s.kind, name: s.name, raw: s.raw, hits: 0, status: 'unverified', evidence: '' };
        res.push(r);
        if (k >= cap) { r.evidence = 'not checked (maxSymbols cap ' + cap + ')'; continue; }
        if (s.kind === 'fileRef') {
            var txt = await io.read(s.name);
            if (txt == null) {
                var why = io.errorFor ? io.errorFor('read', s.name) : null, av = io.available ? await io.available() : true;
                if (why || !av) { r.evidence = why ? 'read failed: ' + why : 'workspace unavailable: file not checked'; continue; }
                r.status = 'refuted'; r.evidence = 'file not found'; continue;
            }
            var nl = txt.split('\n').length, bad = (s.line != null && (s.line < 1 || s.line > nl)) || (s.lineEnd != null && (s.lineEnd < 1 || s.lineEnd > nl || (s.line != null && s.lineEnd < s.line)));
            r.status = bad ? 'refuted' : 'verified'; r.evidence = bad ? 'line out of range: file has ' + nl + ' lines' : 'exists, ' + nl + ' lines'; continue;
        }
        var pat = s.kind === 'cssClass' ? '\\.' + drEsc(s.name) + '(?![\\w-])' : s.kind === 'id' ? drEsc(s.name) : drWord(s.name);
        var hits = await io.grep(pat);
        if (hits == null) { r.evidence = 'grep unavailable'; continue; }
        r.hits = hits.length;
        var first = hits[0] ? hits[0].file + ':' + hits[0].line : '', hre = new RegExp(pat), cls = null;
        if (s.kind === 'function') {
            var dd = await drDefs(mk, drCallDefRe(s.name), hits, testish), al = null, dv = null;
            if (dd.prod.length) {
                r.status = 'verified'; r.evidence = 'defined at ' + drAt(dd.prod);
                if (s.line && !dd.prod.some(function (h) { return Math.abs(h.line - s.line) <= 5; })) { r.status = 'unverified'; r.evidence += ' (cited line ' + s.line + ' is not near a definition; check the citation)'; }
            }
            else if (dd.unreadable.length) r.evidence = 'definition candidate at ' + drAt(dd.unreadable) + ' could not be masked (' + mk.why(dd.unreadable[0].file) + '): not proven';
            else if (dd.defs.length) r.evidence = 'defined only in test/excluded files (' + drAt(dd.defs) + '): a test fixture does not verify a production symbol';
            else if ((dv = (await drDefs(mk, drDefRe(s.name), hits, testish)).prod.filter(function (h) { return !drLiteralInit(h.text, s.name); })).length)
                r.evidence = 'variable whose initializer is not a function/arrow/class at ' + drAt(dv) + ': callable not proven';
            else if ((al = await drAliasDef(s.name, hits, io, mk, testish))) { r.status = al.status; r.evidence = al.evidence; }
            else if (drIsBuiltin(s.name)) {
                // a name on globalThis or a common prototype (find, open, close...) is NOT proof: an invented call looks the same
                var bc = await drFirstCode(mk, hits, hre, testish);
                if (bc) { r.status = 'verified-builtin'; r.confidence = 'low'; r.evidence = 'built-in name, no repo definition; ' + hits.length + (hits.truncated ? '+' : '') + ' repo uses (first code use ' + bc.file + ':' + bc.line + ')'; }
                else r.evidence = 'built-in name but 0 repo uses in code (comments, strings, docs and tests do not count): no repo definition or call backs this claim';
            }
            else if (hits.truncated) r.evidence = 'grep capped at ' + hits.length + ' hits, no definition among them (first ' + first + ')';
            else { r.status = 'refuted'; r.evidence = hits.length ? hits.length + ' hits but no definition in code (comments, strings and docs do not count; first ' + first + ')' : '0 hits'; }
            continue;
        }
        if (s.kind === 'cssClass') {
            var rule = null, unread = [], other = [], cssCmt = 0;
            for (var i = 0; i < hits.length && !rule; i++) {
                var h = hits[i];
                if (!/\.css$/.test(h.file) || testish(h.file)) { other.push(h); continue; }
                var cl = await mk.lines(h.file, 'code'), set = cl ? await mk.cssClasses(h.file) : null;
                if (!cl || cl[h.line - 1] == null || !set) { unread.push(h); continue; }
                if (!hre.test(cl[h.line - 1])) { cssCmt++; continue; }
                if (set[s.name]) rule = h; else other.push(h);
            }
            if (rule) { r.status = 'verified'; r.evidence = 'CSS rule at ' + rule.file + ':' + rule.line; continue; }
            if (unread.length) { r.evidence = 'CSS hit at ' + drAt(unread) + ' could not be read (' + mk.why(unread[0].file) + '): rule not proven'; continue; }
            cls = await drClassify(mk, other, hre, testish); cls.comment = cls.comment.concat(new Array(cssCmt));
        } else if (s.kind === 'id') {
            var ire = drIdDefRe(s.name), idd = [], idu = [], idt = [];
            for (var j = 0; j < hits.length && !idd.length; j++) {
                var hj = hits[j]; if (!DR_CODE_RE.test(hj.file)) continue;
                var km = await mk.lines(hj.file, 'cmt'), kl = km ? km[hj.line - 1] : null;
                if (kl == null) { if (ire.test(hj.text) && !testish(hj.file)) idu.push(hj); continue; }
                if (ire.test(kl)) (testish(hj.file) ? idt : idd).push(hj);
            }
            if (idd.length) { r.status = 'verified'; r.evidence = 'id defined at ' + idd[0].file + ':' + idd[0].line; continue; }
            if (idu.length) { r.evidence = 'id definition candidate at ' + drAt(idu) + ' could not be masked (' + mk.why(idu[0].file) + ')'; continue; }
            if (idt.length) { r.evidence = 'id defined only in test/excluded files (' + idt[0].file + ':' + idt[0].line + ')'; continue; }
            cls = await drClassify(mk, hits, hre, testish);
        } else {
            var fc = await drFirstCode(mk, hits, hre, testish);
            if (fc) { r.status = 'verified'; r.evidence = 'code use at ' + fc.file + ':' + fc.line + ' (' + hits.length + (hits.truncated ? '+' : '') + ' hits)'; continue; }
            cls = await drClassify(mk, hits, hre, testish);
        }
        var noun = s.kind === 'cssClass' ? 'no CSS rule' : s.kind === 'id' ? 'no static id definition' : 'no code use';
        if (!hits.length) { if (s.kind === 'identifier' && drIsBuiltin(s.name)) r.evidence = 'built-in name but 0 repo uses'; else { r.status = 'refuted'; r.evidence = '0 hits'; } }
        else if (cls.comment.length >= hits.length && !hits.truncated) { r.status = 'refuted'; r.evidence = hits.length + ' hits, all in comments (first ' + first + '): ' + noun; }
        else r.evidence = noun + '; ' + hits.length + (hits.truncated ? '+' : '') + ' hits: ' + ['code', 'string', 'doc', 'test', 'unreadable', 'comment'].filter(function (q) { return cls[q].length; }).map(function (q) { return cls[q].length + ' ' + q; }).join(', ') + (s.kind === 'cssClass' ? ' (JS-only hook?)' : s.kind === 'id' ? ' (dynamic?)' : '') + ', first ' + first;
    }
    // qualified names: a verified member is only as good as its qualifier (D.drRun() when D = {run: drRun} is not proof)
    for (var q = 0; q < res.length; q++) {
        var sq = symbols[q]; if (!sq || !sq.qual || !(res[q].status === 'verified' || res[q].status === 'verified-builtin')) continue;
        var qc = await drQualCheck(sq.qual, sq.name, io, mk, testish);
        if (!qc.ok) { res[q].status = 'unverified'; delete res[q].confidence; res[q].evidence += '; qualifier: ' + qc.why; }
        else { if (qc.builtin) res[q].confidence = 'low'; res[q].evidence += '; qualifier: ' + qc.why; }
    }
    return res;
}
// balanced: braces balance once comments and string text are blanked. dropped: source blocks the parser discarded
// ('{' count vs parsed rules whose cssText has a block). Both are judged by the ledger's "CSS parses" row.
function drCssClasses(text) {
    var set = Object.create(null), rules = 0, braced = 0, parser = 'CSSStyleSheet', src = String(text);
    // quoted strings and [attr=...] selectors are not class selectors: [data-x=".ghost"] defines no .ghost rule
    function add(sel) { sel = String(sel).replace(/"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/g, '""').replace(/\[[^\]]*\]/g, ''); var re = /\.(-?[_a-zA-Z][\w-]*)/g, m; while ((m = re.exec(sel))) set[m[1]] = true; }
    var bare = drMaskCss(src).replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g, function (m) { return m.replace(/[^\n]/g, ' '); });
    var depth = 0, balanced = true, opens = 0;
    for (var i = 0; i < bare.length; i++) { if (bare[i] === '{') { depth++; opens++; } else if (bare[i] === '}' && --depth < 0) { balanced = false; depth = 0; } }
    if (depth !== 0) balanced = false;
    try {
        var sh = new CSSStyleSheet(); sh.replaceSync(src);
        (function walk(list) { for (var i = 0; i < list.length; i++) { var ru = list[i]; if (ru.selectorText) { rules++; add(ru.selectorText); } if (/\{/.test(ru.cssText || '')) braced++; if (ru.cssRules) walk(ru.cssRules); } })(sh.cssRules);
    } catch (e) {
        parser = 'regex-fallback (' + e.message + ')'; braced = opens;
        bare.replace(/([^{}]+)\{/g, function (m, sel) { rules++; add(sel); return m; });
    }
    return { classes: set, rules: rules, parser: parser, balanced: balanced, braces: opens, dropped: Math.max(0, opens - braced), empty: !bare.trim() };
}
var DR_TYPE_KEY = '(?:type|action|cmd|command)';
function drHandlerRe(t) { var e = drEsc(t); return new RegExp('case\\s+["\'`]' + e + '["\'`]|\\b' + DR_TYPE_KEY + '\\s*[!=]==?\\s*["\'`]' + e + '["\'`]|["\'`]' + e + '["\'`]\\s*[!=]==?\\s*[\\w$.]*\\b' + DR_TYPE_KEY + '\\b|["\'`]?' + e + '["\'`]?\\s*:\\s*(?:async\\s*)?(?:function\\b|\\()'); }
function drSenderRe(t) { return new RegExp('\\b' + DR_TYPE_KEY + '\\s*:\\s*["\'`]' + drEsc(t) + '["\'`]'); }
async function drCrossRefs(files, io, opts, mk, testish) {
    if (!files || typeof files !== 'object') return { error: 'crossRefs(files): files must be an object {path: text}, got ' + (files === null ? 'null' : typeof files), ids: { used: 0, missing: [] }, classes: { used: 0, cssFiles: 0, cssRules: 0, parser: null, noCss: [] }, messages: { sent: [], handled: [], unhandled: [], noSender: [] } };
    opts = opts || {}; mk = mk || drMasker(io, files, opts); testish = testish || drExcluder(opts).testish;
    var usedIds = [], definedIds = Object.create(null), usedClasses = [], sent = [], handled = [], x;
    function push(list, name, file, line, extra) { list.push(Object.assign({ name: name, file: file, line: line }, extra || {})); }
    Object.keys(files).forEach(function (f) {
        var src = String(files[f]), line = drLines(src);
        if (/\.html?$/.test(f)) { var d = new DOMParser().parseFromString(src, 'text/html'); drAllEls(d).forEach(function (el) { if (el.hasAttribute('id')) definedIds[el.id] = f; }); return; }
        if (!/\.m?js$/.test(f)) return;
        var c = drMask(src, true), cm = drMask(src), re;
        // a use/sender/handler match whose code-mask slice is blank sits inside a string or template: not code
        var inCode = function (mm) { return /[A-Za-z_$]/.test(cm.slice(mm.index, mm.index + mm[0].length)); };
        re = /getElementById\(\s*['"`]([\w:-]+)['"`]\s*\)/g; while ((x = re.exec(c))) if (inCode(x)) push(usedIds, x[1], f, line(x.index));
        re = /(?:querySelector(?:All)?|closest|matches)\(\s*['"`]([^'"`$]+)['"`]/g;
        while ((x = re.exec(c))) { if (!inCode(x)) continue; var sel = x[1], y, r2 = /#([\w-]+)|\.(-?[_a-zA-Z][\w-]*)/g; while ((y = r2.exec(sel))) { if (y[1]) push(usedIds, y[1], f, line(x.index)); else push(usedClasses, y[2], f, line(x.index)); } }
        re = /(?<!\b(?:var|let|const)\s+)\bid\s*=\s*\\?["'`]([\w:-]+)\\?["'`]|setAttribute\(\s*['"]id['"]\s*,\s*['"`]([\w:-]+)['"`]/g; while ((x = re.exec(c))) definedIds[x[1] || x[2]] = f;
        re = /classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g;
        while ((x = re.exec(c))) { if (!inCode(x)) continue; var q = /['"`](-?[_a-zA-Z][\w-]*)['"`]/g, z; while ((z = q.exec(x[1]))) push(usedClasses, z[1], f, line(x.index)); }
        re = /(?:className\s*\+?=\s*|\bclass=\\?)["'`]([^"'`\\$]+)["'`\\]/g;
        while ((x = re.exec(c))) x[1].split(/\s+/).filter(Boolean).forEach(function (k) { if (/^-?[_a-zA-Z][\w-]*$/.test(k)) push(usedClasses, k, f, line(x.index)); });
        re = /\b(?:sendMessage|postMessage|send|emit|dispatch\w*|broadcast\w*)\s*\(\s*(?:JSON\.stringify\(\s*)?\{[^{}]*?\b(?:type|action|cmd|command)\s*:\s*['"`]([\w:.\/-]+)['"`]/g;
        while ((x = re.exec(c))) if (inCode(x)) push(sent, x[1], f, line(x.index));
        re = /\.(?:type|action|cmd|command)\s*[!=]==?\s*['"`]([\w:.\/-]+)['"`]/g; while ((x = re.exec(c))) if (inCode(x)) push(handled, x[1], f, line(x.index));
        re = /\bcase\s+['"`]([\w:.\/-]+)['"`]\s*:/g;
        while ((x = re.exec(c))) { if (!inCode(x)) continue; var sw = c.lastIndexOf('switch', x.index), head = sw >= 0 ? c.slice(sw, c.indexOf(')', sw) + 1) : ''; if (/\b(?:type|action|cmd|command)\b/.test(head)) push(handled, x[1], f, line(x.index)); }
    });
    // ids: used but not defined locally -> look for a static definition anywhere
    // ids / handler / sender lines are judged on the whole-file comment mask ('cmt'): a commented-out id="x" or
    // case 'x' is not a definition; a hit whose file cannot be masked makes the row unverifiable, never verified.
    async function onCmt(hits, re, needCode) { // needCode: the match must also be code (not inside a string/template)
        var unread = null;
        for (var j = 0; j < hits.length; j++) {
            var h = hits[j]; if (!DR_CODE_RE.test(h.file) || testish(h.file) || !re.test(h.text)) continue;
            var km = await mk.lines(h.file, 'cmt'), kl = km ? km[h.line - 1] : null;
            if (kl == null) { unread = unread || h.file + ':' + h.line + ' (' + mk.why(h.file) + ')'; continue; }
            var mm = re.exec(kl); if (!mm) continue;
            if (!needCode) return { yes: true };
            var cl = await mk.lines(h.file, 'code'), cs = cl ? cl[h.line - 1] : null;
            if (cs == null) { unread = unread || h.file + ':' + h.line + ' (' + mk.why(h.file) + ')'; continue; }
            // case 'x': only counts under a switch on a type/action/cmd/command key (not switch (typeof v))
            if (/^case\b/.test(mm[0])) { var up = cl.slice(0, h.line).join('\n'), sw = up.lastIndexOf('switch'), hd = sw >= 0 ? up.slice(sw).split(')')[0] : ''; if (!/\b(?:type|action|cmd|command)\b/.test(hd)) continue; }
            if (/[A-Za-z_$]/.test(cs.slice(mm.index, mm.index + mm[0].length))) return { yes: true };
        }
        return { yes: false, unreadable: unread };
    }
    var missingIds = [], idCache = Object.create(null);
    for (var i = 0; i < usedIds.length; i++) {
        var u = usedIds[i]; if (definedIds[u.name]) continue;
        if (!(u.name in idCache)) { var hits = await io.grep(drEsc(u.name)); idCache[u.name] = hits == null ? null : Object.assign(await onCmt(hits, drIdDefRe(u.name)), { truncated: !!hits.truncated }); }
        var ce = idCache[u.name]; // truncated is cached WITH the entry: a later cache hit must not read another grep's flag
        if (ce == null) missingIds.push(Object.assign({ unverifiable: true }, u));
        else if (!ce.yes) missingIds.push(ce.unreadable ? Object.assign({ unverifiable: true, unreadable: ce.unreadable }, u) : ce.truncated ? Object.assign({ unverifiable: true, capped: true }, u) : u);
    }
    // classes: every JS-used class needs a CSS rule (CSSStyleSheet-parsed)
    var cssTexts = Object.create(null);
    Object.keys(files).forEach(function (f) { if (/\.css$/.test(f)) cssTexts[f] = files[f]; });
    var cssPaths = (opts.cssFiles || []).slice(); // copy: never mutate the caller's array
    if (!opts.cssFiles && opts.cssDir !== false) { var dir = opts.cssDir || 'src/css'; (await io.ls(dir)).forEach(function (n) { if (/\.css$/.test(n)) cssPaths.push(dir + '/' + n); }); }
    for (var p = 0; p < cssPaths.length; p++) if (!(cssPaths[p] in cssTexts)) { var t = await io.read(cssPaths[p]); if (t != null) cssTexts[cssPaths[p]] = t; }
    var cssSet = Object.create(null), rules = 0, parser = '';
    Object.keys(cssTexts).forEach(function (f) { var r = drCssClasses(cssTexts[f]); rules += r.rules; parser = r.parser; Object.assign(cssSet, r.classes); });
    var noCss = usedClasses.filter(function (u, k) { return !cssSet[u.name] && usedClasses.findIndex(function (v) { return v.name === u.name; }) === k; });
    // message types: sent needs a handler somewhere; handled should have a sender somewhere
    var unhandled = [], noSender = [];
    for (var s = 0; s < sent.length; s++) {
        if (handled.some(function (h) { return h.name === sent[s].name; })) continue;
        var hh = await io.grep('["\'\x60]' + drEsc(sent[s].name) + '["\'\x60]'), hr = hh == null ? null : await onCmt(hh, drHandlerRe(sent[s].name), true);
        if (!hr || !hr.yes) unhandled.push(Object.assign({ unverifiable: !hr || !!hr.unreadable || !!hh.truncated, capped: !!(hh && hh.truncated), unreadable: hr && hr.unreadable }, sent[s]));
    }
    for (var h = 0; h < handled.length; h++) {
        if (sent.some(function (v) { return v.name === handled[h].name; })) continue;
        var sh = await io.grep('["\'\x60]' + drEsc(handled[h].name) + '["\'\x60]'), sr = sh == null ? null : await onCmt(sh, drSenderRe(handled[h].name), true);
        if (!sr || !sr.yes) noSender.push(Object.assign({ unverifiable: !sr || !!sr.unreadable || !!sh.truncated, capped: !!(sh && sh.truncated) }, handled[h]));
    }
    return {
        ids: { used: usedIds.length, missing: missingIds },
        classes: { used: usedClasses.length, cssFiles: Object.keys(cssTexts).length, cssRules: rules, parser: parser, noCss: noCss },
        messages: { sent: sent, handled: handled, unhandled: unhandled, noSender: noSender }
    };
}

// ---------- (c) diff -> changed functions -> wiring ----------
function drParseDiff(text) {
    var out = {}, cur = '_', nl = 0, prev = '', m, all = String(text || '').split('\n');
    for (var i = 0; i < all.length; i++) {
        var L = all[i];
        if (/^diff --git /.test(L)) { nl = 0; prev = L; continue; } // a new file section ends the previous hunk
        // file header, not a deletion: outside a hunk, right after diff --git/index, or a '--- ' directly followed by '+++ '
        if (/^--- /.test(L) && (!nl || /^(diff --git |index )/.test(prev) || /^\+\+\+ /.test(all[i + 1] || ''))) { nl = 0; prev = L; continue; }
        if ((m = /^\+\+\+ (?:b\/)?(.+)$/.exec(L)) && /^--- /.test(prev)) { cur = m[1].trim(); nl = 0; prev = L; continue; }
        prev = L;
        if ((m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L))) { nl = +m[1]; out[cur] = out[cur] || []; continue; }
        if (!nl) continue;
        if (L[0] === '+') { if (out[cur].indexOf(nl) < 0) out[cur].push(nl); nl++; } // a -/+ pair marks one line, not two
        else if (L[0] === '-') { if (out[cur].indexOf(nl) < 0) out[cur].push(nl); }
        else if (L[0] !== '\\') nl++;
    }
    return out;
}
function drFindFunctions(src, masked) {
    var m = masked || drMask(src), line = drLines(src), out = [], seen = {}, x;
    function add(name, kind, start, bodyOpen) {
        if (bodyOpen < 0 || m[bodyOpen] !== '{' || seen[bodyOpen]) return;
        var close = drMatch(m, bodyOpen); if (close < 0) return;
        seen[bodyOpen] = true;
        out.push({ name: name || null, kind: kind, start: start, bodyOpen: bodyOpen, bodyClose: close, line: line(start), endLine: line(close) });
    }
    function after(k) { while (k < m.length && /\s/.test(m[k])) k++; return k; }
    var re = /\b(async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
    while ((x = re.exec(m))) {
        var po = x.index + x[0].length - 1, pc = drMatch(m, po), nm = x[2];
        if (!nm) { var lb = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(m.slice(Math.max(0, x.index - 80), x.index)); nm = lb ? lb[1] : null; }
        if (pc > 0) add(nm, 'function', x.index, after(pc + 1));
    }
    re = /([A-Za-z_$][\w$]*)\s*[:=]\s*(async\s*)?(\(|[A-Za-z_$][\w$]*\s*=>)/g; // arrows; params scanned with drMatch (nested parens OK)
    while ((x = re.exec(m))) {
        var ao = x.index + x[0].length - 1, ae;
        if (m[ao] === '(') { var apc = drMatch(m, ao); if (apc < 0) continue; ae = after(apc + 1); if (m.slice(ae, ae + 2) !== '=>') continue; ae = after(ae + 2); }
        else ae = after(ao + 1);
        if (m[ae] === '{') add(x[1], 'arrow', x.index + x[0].indexOf(x[2] || x[3], x[1].length), ae);
    }
    re = /^[ \t]*(?:static\s+)?(?:async\s+)?(?:(?:get|set)\s+(?=[A-Za-z_$]))?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/gm; // methods
    while ((x = re.exec(m))) {
        if (DR_JS_WORDS.test(x[1]) || x[1] === 'with') continue;
        var mo = x.index + x[0].length - 1, mc = drMatch(m, mo); if (mc < 0) continue;
        var mb = after(mc + 1); if (m[mb] === '{') add(x[1], 'method', x.index + x[0].search(/\S/), mb);
    }
    return out.sort(function (a, b) { return a.start - b.start; });
}
// Innermost NAMED function that contains each changed line (anonymous callbacks roll up to their parent).
function drChangedFunctions(src, changedLines) {
    var fns = drFindFunctions(src).filter(function (f) { return f.name; }), hit = [];
    (changedLines || []).forEach(function (ln) {
        var best = null;
        fns.forEach(function (f) { if (f.line <= ln && f.endLine >= ln && (!best || f.bodyClose - f.start < best.bodyClose - best.start)) best = f; });
        if (best && hit.indexOf(best) < 0) hit.push(best);
    });
    return hit;
}
function drFnSource(src, f) {
    var s = src.slice(f.start, f.bodyClose + 1);
    return f.kind === 'method' ? s.replace(/^(?:static\s+)?(async\s+)?(?:(?:get|set)\s+(?=[A-Za-z_$]))?(\*\s*)?/, function (a, as, st) { return (as || '') + 'function' + (st ? '* ' : ' '); }) : s;
}
function drListeners(file, src, fns) {
    var c = drMask(src, true), line = drLines(src), re = /\.addEventListener\(\s*['"`](\w+)['"`]\s*,\s*([^,)]*)([^;\n]*)/g, out = [], x;
    while ((x = re.exec(c))) {
        var ln = line(x.index), lineStart = c.lastIndexOf('\n', x.index) + 1, before = c.slice(lineStart, x.index);
        var tgt = /(document\.getElementById\([^)]*\)|[\w$.\]\[]+(?:\([^()]*\))?)\s*$/.exec(before), h = x[2].trim();
        var inFn = null; fns.forEach(function (f) { if (f.name && f.bodyOpen < x.index && f.bodyClose > x.index && (!inFn || f.start > inFn.start)) inFn = f; });
        var once = /\bonce\b/.test(x[3]), body = inFn ? c.slice(inFn.bodyOpen, inFn.bodyClose) : '';
        out.push({ file: file, line: ln, event: x[1], target: tgt ? tgt[1] : '?', handler: /^[A-Za-z_$][\w$.]*$/.test(h) ? h : '(inline)', inFunction: inFn ? inFn.name : null,
            renderPathRisk: !!(inFn && /render|refresh|update|draw|build|show|mount|open/i.test(inFn.name) && !once && body.indexOf('removeEventListener') < 0) });
    }
    return out;
}

// ---------- (d) branch enumeration ----------
function drBranches(src, fn, all) {
    var m = drMask(src), f = fn || drFindFunctions(src, m)[0], line = drLines(src), rows = [], x;
    if (!f) return rows;
    var region = m.split('');
    (all || drFindFunctions(src, m)).forEach(function (g) { if (g !== f && g.name && g.start > f.start && g.bodyClose < f.bodyClose) for (var k = g.start; k <= g.bodyClose; k++) if (region[k] !== '\n') region[k] = ' '; });
    var r = region.join(''), re = /\belse\s+if\s*\(|\bif\s*\(|\bcase\b|(?<!\.)\bcatch\s*(?:\([^)]*\))?\s*\{|&&|\|\||\?\?|\?(?![.?])|\breturn\b/g;
    function lineText(k) { var a = src.lastIndexOf('\n', k) + 1, b = src.indexOf('\n', k); return src.slice(a, b < 0 ? src.length : b).trim().slice(0, 100); }
    re.lastIndex = f.bodyOpen + 1;
    while ((x = re.exec(r)) && x.index < f.bodyClose) {
        var t = x[0], row = { id: 'B' + (rows.length + 1), line: line(x.index), kind: '', condition: '', arms: ['T', 'F'], probe: false, at: x.index, T: '', F: '', expected: '', evidence: '' };
        if (/if\s*\($/.test(t)) {
            var o = x.index + t.length - 1, cl = drMatch(m, o);
            row.kind = /^else/.test(t) ? 'else-if' : 'if'; row.open = o; row.close = cl; row.probe = cl > 0;
            row.condition = cl > 0 ? src.slice(o + 1, cl).replace(/\s+/g, ' ').trim().slice(0, 100) : lineText(x.index);
        } else if (t === 'case') {
            var colon = r.indexOf(':', x.index); row.kind = 'case'; row.arms = ['hit']; row.colon = colon; row.probe = colon > 0;
            row.condition = src.slice(x.index, colon).replace(/\s+/g, ' ').trim();
        } else if (/^catch/.test(t)) { // a real catch clause; Promise .catch( is excluded by the (?<!\.) lookbehind
            var br = x.index + t.length - 1; row.kind = 'catch'; row.arms = ['hit']; row.brace = br; row.probe = br > 0; row.condition = 'catch';
        } else if (t === 'return') {
            var eol = r.indexOf('\n', x.index); if (eol < 0 || !/[^\s};]/.test(r.slice(eol, f.bodyClose))) continue;
            // first statement of a case/default arm or try/catch/finally block on the same line: that arm is already a row
            var pre = r.slice(r.lastIndexOf('\n', x.index) + 1, x.index);
            if (/(?:\bcase\b[^:]*|\bdefault\s*):\s*\{?\s*$|\b(?:try|finally)\s*\{\s*$|(?<!\.)\bcatch\b[^{]*\{\s*$/.test(pre)) continue;
            row.kind = 'early-return'; row.arms = ['taken']; row.condition = lineText(x.index);
        } else { row.kind = t === '?' ? 'ternary' : 'logical ' + t; row.condition = lineText(x.index); }
        rows.push(row);
    }
    return rows;
}
function drMatrix(rows, title) {
    var h = (title ? '#### Branch matrix: ' + title + '\n' : '') + '| B# | line | kind | condition | T input | F input | expected | evidence |\n|---|---|---|---|---|---|---|---|\n';
    return h + rows.map(function (r) { return '| ' + r.id + ' | ' + r.line + ' | ' + r.kind + ' | `' + r.condition.replace(/\|/g, '\\|').replace(/`/g, "'") + '` | ' + r.T + ' | ' + (r.arms.length > 1 ? r.F : 'n/a') + ' | ' + r.expected + ' | ' + r.evidence + ' |'; }).join('\n');
}

// ---------- (e) probe / trace harness ----------
function drAsVar(fnSrc) {
    var s = String(fnSrc).trim().replace(/;\s*$/, '');
    if (!/^(async\s+)?function\b/.test(s) && !/^(async\s*)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s)) s = s.replace(/^(async\s+)?/, function (a) { return a + 'function '; });
    // expression-bodied arrow (x => x + 1): give it a block body so the instrumenter finds a function body
    var ea = /^((?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*([\s\S]+)$/.exec(s);
    if (ea && ea[2].charAt(0) !== '{') s = ea[1] + ' { return (' + ea[2] + '\n); }';
    return 'var __f = ' + s + ';';
}
function drInstrument(fnSrc) {
    var src = drAsVar(fnSrc), m = drMask(src), all = drFindFunctions(src, m), top = all.filter(function (f) { return f.name === '__f'; })[0] || all[0];
    if (!top) throw new Error('instrument: no function body found');
    var rows = drBranches(src, top, all), edits = [];
    rows.forEach(function (r) {
        if (!r.probe) return;
        if (r.kind === 'if' || r.kind === 'else-if') { edits.push({ pos: r.open + 1, text: '__t("' + r.id + '",(' }); edits.push({ pos: r.close, text: '))' }); }
        else if (r.kind === 'case') edits.push({ pos: r.colon + 1, text: ' __t("' + r.id + '",true);' });
        else if (r.kind === 'catch') edits.push({ pos: r.brace + 1, text: '__t("' + r.id + '",true);' });
    });
    edits.sort(function (a, b) { return b.pos - a.pos; }).forEach(function (e) { src = src.slice(0, e.pos) + e.text + src.slice(e.pos); });
    return { src: src, rows: rows.map(function (r) { return { id: r.id, line: r.line, kind: r.kind, condition: r.condition, arms: r.arms, probe: r.probe }; }) };
}
function drBuild(varSrc, stubs, extra) {
    var names = Object.keys(stubs || {}), vals = names.map(function (n) { return stubs[n]; });
    if (extra) { names.push('__t'); vals.push(extra); }
    return new Function(names.join(','), varSrc + '\nreturn __f;').apply(null, vals);
}
// opts: {stubs:{name:value}, inputs:[[args]|{label,args}], thisArg, post(result,args)->{ok,issues}, domCheck:true}
async function drProbe(fnSrc, opts) {
    opts = opts || {};
    var inst, kinds = {}, log = [], fn;
    try { inst = drInstrument(fnSrc); }
    catch (e) { return { ok: false, error: 'instrument failed: ' + (e && e.message || e), runs: [], branches: [], coverage: { arms: 0, hit: [], missed: [] }, missingStubs: [] }; }
    inst.rows.forEach(function (r) { kinds[r.id] = r.kind; });
    var t = function (id, v) { log.push(id + ':' + ((kinds[id] === 'if' || kinds[id] === 'else-if') ? (v ? 'T' : 'F') : 'hit')); return v; };
    try { fn = drBuild(inst.src, opts.stubs, t); } catch (e) { return { ok: false, error: 'build failed: ' + (e && e.message || e), runs: [], branches: inst.rows, coverage: { arms: 0, hit: [], missed: [] }, missingStubs: [] }; }
    var runs = [], inputs = opts.inputs || [[]], rej = [], G = typeof globalThis !== 'undefined' ? globalThis : null;
    // an unawaited rejected promise (e.g. a stub returning Promise.reject) is a crash the caller never sees: catch it per run
    function onRej(ev) { try { ev.preventDefault(); } catch (e) { /* ignore */ } var rs = ev && ev.reason; rej.push((rs && rs.name ? rs.name + ': ' : '') + (rs && rs.message || String(rs))); }
    var canRej = !!(G && typeof G.addEventListener === 'function');
    if (canRej) G.addEventListener('unhandledrejection', onRej);
    try {
        for (var k = 0; k < inputs.length; k++) {
            var inp = inputs[k], a = Array.isArray(inp) ? inp : (inp && inp.args) || [];
            var run = { label: (!Array.isArray(inp) && inp && inp.label) || 'run' + (k + 1), input: a.map(drPreview).join(', '), trace: [], result: undefined, threw: null };
            log = []; rej = [];
            try {
                var res = fn.apply(opts.thisArg || null, a);
                if (res && typeof res.then === 'function') { // a promise that never settles must not hang run(): race it against opts.timeoutMs
                    var tmo = null, lim = opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
                    try { res = await Promise.race([res, new Promise(function (_, rj) { tmo = setTimeout(function () { var te = new Error('did not settle within ' + lim + ' ms'); te.name = 'ProbeTimeout'; rj(te); }, lim); })]); }
                    finally { if (tmo) clearTimeout(tmo); }
                }
                run.result = drPreview(res);
                if (opts.post) run.post = await opts.post(res, a);
                else if (opts.domCheck !== false && ((res && typeof res.nodeType === 'number') || (typeof res === 'string' && /<[a-z][\s\S]*>/i.test(res)))) run.post = drDomPostconditions(res);
            } catch (e) { run.threw = (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)); }
            if (canRej) { await drTick(); await drTick(); if (rej.length && !run.threw) run.threw = 'UnhandledRejection: ' + rej[0]; }
            run.trace = log.slice(); runs.push(run);
        }
    } finally { if (canRej) G.removeEventListener('unhandledrejection', onRej); }
    var arms = [], seen = {};
    inst.rows.forEach(function (r) { if (r.probe) r.arms.forEach(function (x) { arms.push(r.id + ':' + x); }); });
    runs.forEach(function (r) { r.trace.forEach(function (h) { seen[h] = true; }); });
    var missing = runs.map(function (r) { var q = /ReferenceError: ([\w$]+) is not defined/.exec(r.threw || ''); return q && q[1]; }).filter(Boolean);
    var table = '| run | input | trace | result |\n|---|---|---|---|\n' + runs.map(function (r) {
        return '| ' + r.label + ' | ' + r.input.replace(/\|/g, '\\|').slice(0, 60) + ' | ' + (r.trace.join(' ') || '(no branch)') + ' | ' + (r.threw ? 'THREW ' + r.threw : r.result).replace(/\|/g, '\\|').slice(0, 60) + (r.post && !r.post.ok ? ' POST FAIL' : '') + ' |';
    }).join('\n');
    return { ok: true, branches: inst.rows, runs: runs, coverage: { arms: arms.length, hit: arms.filter(function (x) { return seen[x]; }), missed: arms.filter(function (x) { return !seen[x]; }) }, missingStubs: missing.filter(function (n, i) { return missing.indexOf(n) === i; }), table: table };
}

// ---------- (f) edge inputs + DOM post-conditions ----------
function drEdgeValues() {
    return [['empty', ''], ['whitespace', '   '], ['null', null], ['undefined', undefined], ['NaN', NaN], ['zero', 0], ['negative', -1],
        ['huge', new Array(100001).join('x')], ['emoji', '\ud83d\ude80\ud83d\udc4d\ud83c\udffd'], ['rtl', '\u202eabc \u05e9\u05dc\u05d5\u05dd'],
        ['zero-width', 'a\u200b\u200cb\ufeff'], ['xss', '<img src=x onerror="window.__drXss=1"><script>window.__drXss=1</script>'], ['empty-array', []], ['empty-object', {}]
    ].map(function (p) { return { name: p[0], value: p[1] }; });
}
// One input per (argument position x edge value); other positions keep baseArgs. opts.only: [names]
function drEdgeInputs(baseArgs, opts) {
    var base = baseArgs && baseArgs.length ? baseArgs : [undefined], out = [];
    base.forEach(function (b, pos) {
        drEdgeValues().forEach(function (v) {
            if (opts && opts.only && opts.only.indexOf(v.name) < 0) return;
            var a = base.slice(); a[pos] = v.value; out.push({ label: 'arg' + pos + '=' + v.name, args: a });
        });
    });
    return out;
}
function drDomPostconditions(target) {
    var root = typeof target === 'string' ? new DOMParser().parseFromString(target, 'text/html').body : target, issues = [], ids = {};
    var bad = /\bundefined\b|\bNaN\b|\[object Object\]/, text = root.textContent || '', m = bad.exec(text);
    if (m) issues.push({ kind: 'bad-text', detail: '"' + m[0] + '" in text: ' + JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + 30)) });
    var els = [root].concat(Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('*') : []));
    els.forEach(function (el) {
        if (!el.attributes) return;
        if (el.id) ids[el.id] = (ids[el.id] || 0) + 1;
        Array.prototype.forEach.call(el.attributes, function (a) {
            if (bad.test(a.value)) issues.push({ kind: 'bad-attr', detail: el.tagName.toLowerCase() + '[' + a.name + '="' + a.value.slice(0, 40) + '"]' });
            if (/^on/i.test(a.name) && /__drXss/.test(a.value)) issues.push({ kind: 'xss', detail: 'edge payload rendered as live ' + a.name + ' on <' + el.tagName.toLowerCase() + '>' });
        });
        if (el.tagName === 'SCRIPT' && /__drXss/.test(el.textContent)) issues.push({ kind: 'xss', detail: 'edge payload rendered as a live <script>' });
        if (/^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role') === 'button') {
            var named = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('aria-labelledby') || el.querySelector('img[alt]:not([alt=""]),[aria-label]');
            if (!named && (el.tagName !== 'A' || el.hasAttribute('href'))) issues.push({ kind: 'no-accessible-name', detail: '<' + el.tagName.toLowerCase() + (el.className ? ' class="' + el.className + '"' : '') + '> has no text/aria-label/title' });
        }
    });
    Object.keys(ids).forEach(function (id) { if (ids[id] > 1) issues.push({ kind: 'duplicate-id', detail: 'id "' + id + '" x' + ids[id] }); });
    if (typeof window !== 'undefined' && window.__drXss) { issues.push({ kind: 'xss', detail: 'edge payload EXECUTED (window.__drXss set)' }); window.__drXss = undefined; }
    return { ok: issues.length === 0, issues: issues };
}

// ---------- (g) mutation-lite ----------
var DR_SWAP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '>=': '>', '<=': '<', '>': '>=', '<': '<=', '&&': '||', '||': '&&' };
function drMutants(fnSrc, max) {
    max = max || 10;
    var src = drAsVar(fnSrc), m = drMask(src), line = drLines(src), loops = [], cands = [], x, re;
    re = /\b(for|while)\s*\(/g; while ((x = re.exec(m))) { var o = x.index + x[0].length - 1; loops.push([o, drMatch(m, o)]); }
    function inLoop(i) { return loops.some(function (l) { return i > l[0] && i < l[1]; }); }
    re = /\bif\s*\(/g;
    while ((x = re.exec(m))) { var po = x.index + x[0].length - 1, pc = drMatch(m, po); if (pc > 0) cands.push({ op: 'negate if', pos: po + 1, end: pc, repl: '!(' + src.slice(po + 1, pc) + ')' }); }
    re = /===|!==|(?<![=!<>])==(?!=)|!=(?!=)|>=|<=|&&|\|\||(?<![=>!<-])>(?![=>])|(?<![<])<(?![=<])/g;
    while ((x = re.exec(m))) if (!inLoop(x.index)) cands.push({ op: x[0] + ' -> ' + DR_SWAP[x[0]], pos: x.index, end: x.index + x[0].length, repl: DR_SWAP[x[0]] });
    cands.sort(function (a, b) { return a.pos - b.pos; });
    var pick = cands.length <= max ? cands : Array.apply(null, Array(max)).map(function (_, k) { return cands[Math.floor(k * cands.length / max)]; });
    return pick.map(function (c, k) { return { id: 'M' + (k + 1), op: c.op, line: line(c.pos), src: src.slice(0, c.pos) + c.repl + src.slice(c.end) }; });
}
function drCasesCheck(cases) {
    return async function (fn) {
        for (var i = 0; i < cases.length; i++) { var r = fn.apply(null, cases[i].args || []); if (r && typeof r.then === 'function') r = await r; if (!drDeepEqual(r, cases[i].expect)) return false; }
        return true;
    };
}
// check(fn) -> truthy/throws. A mutant is KILLED when the check fails on it; SURVIVED = the check cannot tell it from the original.
async function drMutationTest(fnSrc, check, opts) {
    opts = opts || {};
    if (typeof check !== 'function') check = drCasesCheck(opts.cases || []);
    var lastErr = null;
    async function passes(fn) { lastErr = null; try { return (await check(fn)) !== false; } catch (e) { lastErr = e; return false; } }
    function refName(e) { var q = e && /^([\w$]+) is not defined/.exec(e.message || ''); return q && (e.name === 'ReferenceError' || /ReferenceError/.test(String(e))) ? q[1] : null; }
    var fail = { baselineOk: false, total: 0, killed: 0, survived: [], invalid: 0 }, base;
    try { base = drBuild(drAsVar(fnSrc), opts.stubs); } catch (e) { return Object.assign(fail, { error: 'original does not build: ' + e.message }); }
    // the baseline runs twice: a check that only passes on its first call would otherwise "kill" every mutant
    if (!(await passes(base)) || !(await passes(base))) {
        // A ReferenceError is a missing stub, not a wrong check: collect every missing name (no-op stubs) and report unverified.
        var missing = [], stubs = Object.assign({}, opts.stubs || {}), n = refName(lastErr);
        while (n && missing.indexOf(n) < 0 && missing.length < 10) {
            missing.push(n); stubs[n] = function () {};
            try { await passes(drBuild(drAsVar(fnSrc), stubs)); } catch (e) { break; }
            n = refName(lastErr);
        }
        if (missing.length) return Object.assign(fail, { missingStubs: missing, error: 'baseline threw ReferenceError (missing stub' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '): pass mutation stubs:{' + missing.map(function (m) { return m + ': ...'; }).join(', ') + '} and re-run' });
        return Object.assign(fail, { error: 'check fails on the ORIGINAL function: fix the check or the code first' + (lastErr ? ' (threw ' + (lastErr.name || 'Error') + ': ' + lastErr.message + ')' : '') });
    }
    var ms = drMutants(fnSrc, opts.max), out = { baselineOk: true, total: ms.length, killed: 0, survived: [], invalid: 0 };
    for (var i = 0; i < ms.length; i++) {
        var fn; try { fn = drBuild(ms[i].src, opts.stubs); } catch (e) { out.invalid++; continue; }
        if (await passes(fn)) out.survived.push({ id: ms[i].id, op: ms[i].op, line: ms[i].line }); else out.killed++;
    }
    out.score = out.total - out.invalid ? Math.round(100 * out.killed / (out.total - out.invalid)) : null;
    return out;
}

// ---------- (h) claims ledger + gate ----------
// waive / entryPoints downgrade ONLY "defined but not referenced" wiring rows (tag 'unwired'), waive only with a non-empty
// reason string. "Does not exist" rows (symbols, ids, inline/listener handlers, message handlers), parse, file, config, io,
// probe and mutation rows are never downgraded. An unknown status counts as refuted.
var DR_STATUSES = { verified: 1, refuted: 1, unverified: 1 };
function drLedger(rep, opts) {
    rep = rep && typeof rep === 'object' ? rep : {}; opts = opts || {};
    var rows = [], waive = opts.waive && typeof opts.waive === 'object' ? opts.waive : {}, entry = [].concat(opts.entryPoints || []), own = Object.prototype.hasOwnProperty;
    function add(claim, kind, subject, status, evidence, tag) {
        var confidence = null;
        if (status === 'verified-builtin') { status = 'verified'; confidence = 'low'; evidence = 'verified-builtin (low confidence): ' + evidence; }
        if (typeof status !== 'string' || !own.call(DR_STATUSES, status)) { evidence = 'unknown status ' + JSON.stringify(String(status)) + ' counted as refuted: ' + evidence; status = 'refuted'; }
        var waived = status === 'refuted' && subject != null && own.call(waive, subject);
        if (waived && tag === 'unwired') {
            var why = waive[subject];
            if (typeof why === 'string' && why.trim()) { status = 'unverified'; evidence += ' | waived: ' + why.trim(); }
            else evidence += ' | waive ignored: waive.' + subject + ' needs a non-empty reason string';
        } else if (waived) evidence += ' | waive ignored: only "defined but not referenced" wiring rows can be waived, never a ' + kind + ' row';
        else if (status === 'refuted' && tag === 'unwired' && entry.indexOf(subject) >= 0) { status = 'unverified'; evidence += ' | waived: declared entry point'; }
        var row = { claim: claim, kind: kind, subject: subject, evidence: evidence, status: status }; if (confidence) row.confidence = confidence;
        rows.push(row);
    }
    (rep.missingFiles || []).forEach(function (p) { var why = (rep.readErrors || {})[p]; add(p + ' is readable and analysed', 'file', p, 'refuted', why ? 'read failed: ' + why : 'file not found' + (rep.workspaceAvailable === false ? ' (workspace unavailable)' : '')); });
    (rep.configErrors || []).forEach(function (c) { add(c.claim, 'config', null, 'refuted', c.evidence); });
    (rep.otherFiles || []).forEach(function (p) { add(p + ' is checked', 'file', p, 'unverified', 'no static checks for this file type (only JS, HTML and CSS are analysed)'); });
    (rep.parse || []).forEach(function (p) {
        if (p.css) {
            var cst = p.balanced === false ? 'refuted' : (!p.ok || p.dropped || (!p.rules && p.empty === false)) ? 'unverified' : 'verified';
            add(p.file + ' CSS parses', 'parse', p.file, cst, p.parser + ', ' + p.rules + ' rules' + (p.balanced === false ? ', UNBALANCED braces (comments and strings stripped)' : '') + (p.dropped ? ', ' + p.dropped + ' of ' + p.braces + ' blocks dropped by the parser' : '') + (!p.rules && p.empty === false ? ', 0 rules from non-empty CSS' : ''));
            return;
        }
        if (p.issues) {
            if (!p.issues.length) add(p.file + ' HTML is well-formed', 'parse', p.file, 'verified', 'DOMParser: ' + p.ids.length + ' unique ids, ' + p.handlerCalls.length + ' inline handler calls');
            p.issues.forEach(function (i) { add(p.file + ': ' + i.detail, 'parse', i.subject, 'refuted', i.kind); });
            (p.unverified || []).forEach(function (u) { add(p.file + ': <' + u.tag + ' ' + u.attr + '> handler ' + u.name + '() is defined', 'parse', u.name, 'unverified', u.why || 'grep unavailable or capped: definition not proven'); });
        }
        else add(p.file + ' parses', 'parse', p.file, p.ok ? 'verified' : 'refuted', p.ok ? 'AsyncFunction compile OK' : p.error + (p.hint ? ' (' + p.hint + ')' : ''));
    });
    (rep.symbols || []).forEach(function (s) { add('`' + s.raw + '` exists (' + s.kind + ')', 'symbol', s.name, s.status, s.evidence); });
    var x = rep.crossRefs;
    if (x && x.error) add('cross-refs ran on the analysed files', 'config', null, 'refuted', x.error);
    if (rep.excludedAll) add('opts.exclude leaves at least one file for cross-ref and wiring analysis', 'config', null, 'unverified', 'every file matched opts.exclude (' + rep.excluded.length + ' excluded): only the parse gate ran, cross-refs and wiring checked nothing');
    if (x) {
        x.ids.missing.forEach(function (u) { add('#' + u.name + ' (' + u.file + ':' + u.line + ') has a static id definition', 'cross-ref', u.name, u.unverifiable ? 'unverified' : 'refuted', u.unverifiable ? (u.capped ? 'grep capped at 100 hits with no definition among them: absence unproven' : 'grep unavailable') : 'looked up via getElementById/querySelector, no id="' + u.name + '" found'); });
        x.classes.noCss.forEach(function (u) { add('.' + u.name + ' (' + u.file + ':' + u.line + ') has a CSS rule', 'cross-ref', u.name, 'unverified', 'no selector in ' + x.classes.cssFiles + ' CSS files (' + x.classes.cssRules + ' rules). JS-only hook, or a missing style?'); });
        x.messages.unhandled.forEach(function (u) { add('message type "' + u.name + '" (sent ' + u.file + ':' + u.line + ') has a handler', 'cross-ref', u.name, u.unverifiable ? 'unverified' : 'refuted', u.unverifiable ? (u.capped ? 'grep capped at 100 hits, no handler among them: absence unproven' : 'grep unavailable') : 'no case/=== handler found'); });
        x.messages.noSender.forEach(function (u) { add('handled type "' + u.name + '" (' + u.file + ':' + u.line + ') has a sender', 'cross-ref', u.name, 'unverified', u.capped ? 'grep capped at 100 hits, no sender among them: absence unproven' : 'no `type: "' + u.name + '"` sender found (dead handler, or sent dynamically?)'); });
    }
    var bulk = [], branchRow = {}; // whole-file analysis (no diff): one summary row instead of one reverse-mode row per function
    (rep.changedFunctions || []).forEach(function (f) {
        var wc = f.name + ' (' + f.file + ':' + f.line + ') is referenced beyond its definition';
        if (f.refs === null) add(f.name + ' is wired', 'wiring', f.name, 'unverified', 'grep unavailable', 'unwired');
        else if (f.refs > 0) add(wc, 'wiring', f.name, 'verified', f.refs + ' code refs, e.g. ' + f.refSample, 'unwired');
        else if (f.refsUnreadable) add(wc, 'wiring', f.name, 'unverified', f.refsUnreadable + ' hit(s) in files that could not be masked (e.g. ' + f.unreadableSample + ': ' + f.unreadableWhy + '): reference neither proven nor disproven', 'unwired');
        else if (f.refsTestOnly) add(wc, 'wiring', f.name, 'unverified', 'referenced only in tests (' + f.refsTestOnly + ', e.g. ' + f.testSample + '): no production caller proven', 'unwired');
        else if (f.refsCapped) add(wc, 'wiring', f.name, 'unverified', 'grep capped at 100 hits, no code reference among them: absence unproven', 'unwired');
        else add(wc, 'wiring', f.name, 'refuted', '0 code references outside its own body (comments, strings, docs and tests do not count): unwired?', 'unwired');
        if (f.reverseModeRequired) {
            var pr = (rep.probes || []).filter(function (p) { return p.fn === f.name; })[0];
            if (!pr && /^whole-file/.test(f.changedVia || '')) { bulk.push(f.name + ' (' + f.branchPoints + ')'); return; }
            branchRow[f.name] = true;
            add(f.name + ': every probed branch arm exercised (' + f.branchPoints + ' branch points, reverse mode required)', 'branch', f.name,
                pr && pr.ok && pr.coverage.arms > 0 && !pr.coverage.missed.length ? 'verified' : 'unverified', pr ? (pr.ok ? 'probe hit ' + pr.coverage.hit.length + '/' + pr.coverage.arms + ' arms; missed ' + pr.coverage.missed.join(' ') + (pr.coverage.arms ? '' : ' (0 probeable arms: ternary/short-circuit rows are never probed)') : pr.error) : 'no probe run: fill the matrix by hand (R1-R6) or run probe()');
        }
    });
    if (bulk.length) add(bulk.length + ' function' + (bulk.length > 1 ? 's have' : ' has') + ' more than 5 branch points (whole-file analysis, no diff): reverse mode not scoped', 'branch', null, 'unverified',
        bulk.join(', ') + '. Pass opts.functions:[names you changed] (or opts.diff) to get one row and one matrix per function.');
    (rep.functionsNotFound || []).forEach(function (n) { add('opts.functions entry ' + n + ' is a function in the targets', 'wiring', n, 'unverified', 'no named function ' + n + ' in the analysed files'); });
    (rep.listeners || []).forEach(function (l) {
        if (l.handlerDefined === false) add('listener handler ' + l.handler + ' (' + l.file + ':' + l.line + ') is defined', 'wiring', l.handler, 'refuted', 'no definition found');
        else if (l.handlerDefined === null) add('listener handler ' + l.handler + ' (' + l.file + ':' + l.line + ') is defined', 'wiring', l.handler, 'unverified', l.handlerWhy || 'grep unavailable or capped: definition not proven');
        if (l.renderPathRisk) add(l.event + ' listener at ' + l.file + ':' + l.line + ' is not re-attached on every ' + l.inFunction + '()', 'wiring', l.inFunction, 'unverified', 'addEventListener inside a render-like function with no {once} and no removeEventListener');
    });
    (rep.probes || []).forEach(function (p) {
        if (!p.ok) { add(p.fn + ' probe builds', 'probe', p.fn, 'refuted', p.error); return; }
        if (p.missingStubs.length) add(p.fn + ' probe has all stubs', 'probe', p.fn, 'unverified', 'missing stubs: ' + p.missingStubs.join(', '));
        // missed arms always reach the ledger, even when fn is not in the analysed (changed) set
        if (!branchRow[p.fn] && p.coverage && p.coverage.missed.length) add(p.fn + ': every probed branch arm exercised', 'probe', p.fn, 'unverified', 'probe hit ' + p.coverage.hit.length + '/' + p.coverage.arms + ' arms; missed ' + p.coverage.missed.join(' '));
        p.runs.forEach(function (r) {
            if (r.post && !r.post.ok) add(p.fn + '(' + r.label + ') output passes DOM post-conditions', 'probe', p.fn, 'refuted', r.post.issues.map(function (i) { return i.kind + ': ' + i.detail; }).join('; '));
            if (r.threw && !/ReferenceError: [\w$]+ is not defined/.test(r.threw)) add(p.fn + '(' + r.label + ') does not throw', 'probe', p.fn, 'unverified', r.threw + ': intended validation, or a crash?');
        });
    });
    (rep.mutation || []).forEach(function (mu) {
        if (!mu.baselineOk) add(mu.fn + ' mutation check passes on the original', 'mutation', mu.fn, mu.missingStubs && mu.missingStubs.length ? 'unverified' : 'refuted', mu.error);
        else if (mu.survived.length) add(mu.fn + ' checks kill every mutant', 'mutation', mu.fn, 'unverified', mu.survived.length + ' survived: ' + mu.survived.map(function (s) { return s.op + '@' + s.line; }).join(', ') + ' (weak check or equivalent mutant)');
        else if (!(mu.total - (mu.invalid || 0))) add(mu.fn + ' checks kill every mutant', 'mutation', mu.fn, 'unverified', '0 valid mutants generated (' + mu.total + ' total, ' + (mu.invalid || 0) + ' invalid): the check was never exercised');
        else add(mu.fn + ' checks kill every mutant', 'mutation', mu.fn, 'verified', mu.killed + '/' + mu.total + ' killed');
    });
    (rep.claims || []).forEach(function (c) { add(c.claim, 'claim', c.subject || null, c.status, c.evidence); });
    (rep.ioErrors || []).forEach(function (e) { add('io.' + e.op + '(' + e.arg + ') succeeded', 'io', null, 'unverified', 'threw: ' + e.error + ' (dependent rows are unverified)'); });
    if (!rows.length) add('the run produced at least one claim', 'config', null, 'refuted', (rep.filesGiven ? 'files were given but ' : '') + 'the ledger has 0 rows: nothing was verified');
    var counts = { verified: 0, refuted: 0, unverified: 0, lowConfidence: 0 };
    rows.forEach(function (r) { counts[r.status]++; if (r.confidence === 'low') counts.lowConfidence++; });
    return { rows: rows, counts: counts, gate: { pass: counts.refuted === 0, refuted: rows.filter(function (r) { return r.status === 'refuted'; }).map(function (r) { return r.claim + ': ' + r.evidence; }), unverified: rows.filter(function (r) { return r.status === 'unverified'; }).map(function (r) { return r.claim + ': ' + r.evidence; }) } };
}
function drFormat(rep) {
    rep = rep && typeof rep === 'object' ? rep : {};
    var L = rep.ledger || drLedger(rep), icon = { verified: 'OK', refuted: 'REFUTED', unverified: 'UNVERIFIED' };
    var md = '### Claims ledger: ' + (L.gate.pass ? 'PASS' : 'FAIL') + ' (' + L.counts.verified + ' verified, ' + L.counts.refuted + ' refuted, ' + L.counts.unverified + ' unverified)\n| # | claim | kind | status | evidence |\n|---|---|---|---|---|\n';
    md += L.rows.map(function (r, i) { return '| ' + (i + 1) + ' | ' + r.claim.replace(/\|/g, '\\|') + ' | ' + r.kind + ' | ' + icon[r.status] + (r.confidence === 'low' ? ' (low confidence)' : '') + ' | ' + String(r.evidence).replace(/\|/g, '\\|') + ' |'; }).join('\n');
    var cf = rep.changedFunctions || [], wf = cf.filter(function (f) { return f.reverseModeRequired && /^whole-file/.test(f.changedVia || ''); });
    cf.forEach(function (f) { if (f.reverseModeRequired && f.branches && (wf.length <= 3 || wf.indexOf(f) < 0)) md += '\n\n' + drMatrix(f.branches, f.name + ' (' + f.file + ':' + f.line + ')'); });
    if (wf.length > 3) md += '\n\n_' + wf.length + ' whole-file branch matrices omitted: pass opts.functions:[names] (or opts.diff) to get them._';
    return md;
}

// ---------- orchestration ----------
// opts: {files:[paths]|{path:src}, prose, diff: string|{path:diff}, workspace, corpus:{path:src} (offline), io (custom lookups), entryPoints:[names],
//        waive:{name:reason}, cssFiles:[paths], cssDir, probes:[{file,fn,inputs,edge,baseArgs,stubs,post}],
//        mutation:[{file,fn,cases:[{args,expect}]|check,stubs,max}], claims:[{claim,check:bool|fn,evidence}], maxSymbols,
//        exclude:[RegExp|regex-source string] (default [/^test\//]: parse gate only, no cross-ref/wiring/branch analysis; [] analyses everything),
//        functions:[names] (analyse exactly these functions instead of the diff / whole file),
//        maxMaskReads (default 400), maskBudgetMs (default 30000): whole-file mask read budget; past it, hits are unreadable (unverified)}
async function drRun(opts) {
    var errs = [];
    opts = opts || {}; if (typeof opts.files === 'string') opts = Object.assign({}, opts, { files: [opts.files] }); // files:'a.js' means one path, not its characters
    try { return await drRunInner(opts, errs); }
    catch (e) { // never crash the caller: an internal error is a refuted row, so the gate fails loudly
        var msg = (e && e.name ? e.name + ': ' : '') + (e && e.message || String(e)), row = { claim: 'deroulement.js run completes', kind: 'internal', subject: null, status: 'refuted', evidence: 'internal error: ' + msg };
        var gate = { pass: false, refuted: [row.claim + ': ' + row.evidence], unverified: [] };
        return { version: DR_VERSION, error: msg, ioErrors: errs, ledger: { rows: [row], counts: { verified: 0, refuted: 1, unverified: 0, lowConfidence: 0 }, gate: gate }, gate: gate,
            summary: { pass: false, verified: 0, refuted: 1, unverified: 0, internalError: msg }, limitations: DR_LIMITATIONS.slice() };
    }
}
async function drRunInner(opts, errs) {
    var io = drSafeIO(drIO(opts), errs), files = {}, raw = opts.files, isList = Array.isArray(raw), paths = isList ? raw.slice() : Object.keys(raw || {}), readErrors = {};
    for (var i = 0; i < paths.length; i++) {
        var t = isList ? await io.read(paths[i]) : raw[paths[i]];
        if (typeof t === 'string') files[paths[i]] = t;
        else if (!isList && t != null) files[paths[i]] = String(t);
        else if (isList && io.errorFor('read', paths[i])) readErrors[paths[i]] = io.errorFor('read', paths[i]);
    }
    var rep = { version: DR_VERSION, files: Object.keys(files), missingFiles: paths.filter(function (p) { return !(p in files); }), readErrors: readErrors, filesGiven: paths.length > 0,
        parse: [], symbols: [], changedFunctions: [], listeners: [], probes: [], mutation: [], claims: [], ioErrors: errs, configErrors: [], otherFiles: [] };
    if (rep.missingFiles.length) rep.workspaceAvailable = await io.available();
    var ex = drExcluder(opts), inExclude = ex.inExclude, testish = ex.testish, mk = drMasker(io, files, opts);
    ex.errors.forEach(function (c) { rep.configErrors.push(c); });
    var targets = {}; // excluded files (test fixtures) still get the parse gate, nothing else: their string contents are fixtures, not wiring
    Object.keys(files).forEach(function (p) { if (!inExclude(p)) targets[p] = files[p]; });
    rep.excluded = Object.keys(files).filter(function (p) { return !(p in targets); });
    if (rep.excluded.length && !Object.keys(targets).length) rep.excludedAll = true;
    var fnList = opts.functions != null ? [].concat(opts.functions) : null, fnFound = {};
    var jsTexts = Object.keys(targets).filter(function (f) { return /\.m?js$/.test(f); }).map(function (f) { return targets[f]; });
    var declared = drDeclaredNames(jsTexts), resolved = Object.create(null), resolvedWhy = Object.create(null), modOnly = Object.create(null);
    // -> true | false | null. null = undecidable (grep unavailable or capped, unmaskable candidate, or defined only in
    // test/excluded files): unverified, never "defined". Definitions are judged on the whole-file code mask.
    async function defined(name) {
        if (declared[name] || drOwnGlobal(name)) return true;
        if (!(name in resolved) && name.indexOf('.') > 0) { // qualified: obj.member must provably exist, else unverified
            var qi = name.lastIndexOf('.'), qc = await drQualCheck(name.slice(0, qi), name.slice(qi + 1), io, mk, testish);
            resolved[name] = qc.ok ? true : qc.refute ? false : null; if (!qc.ok) resolvedWhy[name] = qc.why;
        }
        if (!(name in resolved)) {
            var h = await io.grep(drWord(name));
            if (h == null) { resolved[name] = null; resolvedWhy[name] = 'grep unavailable'; }
            else {
                var dd = await drDefs(mk, drCallDefRe(name), h, testish);
                if (dd.prod.length) {
                    resolved[name] = true;
                    // inline on* handlers run in global scope: a definition only inside <script type="module"> is not reachable
                    var gl = 0;
                    for (var pi = 0; pi < dd.prod.length && !gl; pi++) { var ph0 = dd.prod[pi]; if (!/\.html?$/.test(ph0.file) || !drInModuleScript(await mk.text(ph0.file), ph0.line, name)) gl++; }
                    if (!gl) modOnly[name] = dd.prod[0].file + ':' + dd.prod[0].line;
                }
                else if (dd.unreadable.length) { resolved[name] = null; resolvedWhy[name] = 'definition candidate at ' + drAt(dd.unreadable) + ' could not be masked (' + mk.why(dd.unreadable[0].file) + ')'; }
                else if (dd.defs.length) { resolved[name] = null; resolvedWhy[name] = 'defined only in test/excluded files (' + dd.defs[0].file + ':' + dd.defs[0].line + ')'; }
                else if (h.truncated) { resolved[name] = null; resolvedWhy[name] = 'grep capped at ' + h.length + ' hits, no definition among them'; }
                else resolved[name] = false;
            }
        }
        return resolved[name];
    }
    for (var f in files) {
        if (/\.m?js$/.test(f)) rep.parse.push(drParseGateJs(f, files[f]));
        else if (/\.html?$/.test(f)) {
            var calls = drParseGateHtml(f, files[f]).handlerCalls;
            for (var c = 0; c < calls.length; c++) await defined(calls[c].name);
            var ph = drParseGateHtml(f, files[f], function (n) { return declared[n] || drOwnGlobal(n) ? true : modOnly[n] ? false : resolved[n]; });
            ph.unverified.forEach(function (u) { u.why = resolvedWhy[u.name]; });
            rep.parse.push(ph);
        } else if (/\.css$/.test(f)) { var cr = drCssClasses(files[f]); rep.parse.push({ file: f, css: true, ok: cr.parser === 'CSSStyleSheet' && cr.balanced, rules: cr.rules, parser: cr.parser, balanced: cr.balanced, dropped: cr.dropped, braces: cr.braces, empty: cr.empty }); }
        else rep.otherFiles.push(f);
    }
    var ps = drProseSymbols(opts.prose);
    rep.symbols = await drCheckSymbols(ps.symbols, io, opts, { mk: mk, testish: testish }); rep.symbolsSkipped = ps.skipped;
    rep.crossRefs = await drCrossRefs(targets, io, opts, mk, testish);
    var diffMap = typeof opts.diff === 'string' ? drParseDiff(opts.diff) : {};
    if (opts.diff && typeof opts.diff === 'object') Object.keys(opts.diff).forEach(function (p) { var d = drParseDiff(opts.diff[p]); diffMap[p] = d[p] || d._ || []; });
    // wiring: a reference counts only on the whole-file code mask (comments, string/template text and HTML markup blanked)
    // of a .js/.html file, outside the function's own body. A production hit whose file cannot be masked is 'unreadable'.
    async function codeRefs(fn, file, hits) {
        var wre = new RegExp(drWord(fn.name)), dre = drDefRe(fn.name), out = { code: [], test: [], unreadable: [] };
        for (var i = 0; i < hits.length; i++) {
            var h = hits[i]; if (!/\.(m?js|cjs|html?)$/.test(h.file)) continue;
            if (h.file === file && h.line >= fn.line && h.line <= fn.endLine) continue; // own definition/body: self-recursion is not wiring
            var ml = await mk.lines(h.file, 'code'), txt = ml ? ml[h.line - 1] : null;
            if (txt == null) { if (!testish(h.file)) out.unreadable.push(h); continue; }
            if (!drRealRef(txt, fn.name) || dre.test(txt)) continue;
            (testish(h.file) ? out.test : out.code).push(h);
        }
        return out;
    }
    for (f in targets) {
        if (!/\.m?js$/.test(f)) continue;
        // opts.functions is a UNION with the diff (named functions are always analysed); functionsOnly: true = only them
        var src = targets[f], all = drFindFunctions(src), how = 'diff', lines = null;
        var fnSel = fnList ? all.filter(function (g) { return g.name && fnList.indexOf(g.name) >= 0; }).filter(function (g, i, a) { return a.findIndex(function (h) { return h.name === g.name; }) === i; }) : [];
        fnSel.forEach(function (g) { fnFound[g.name + '@' + f] = 1; fnFound[g.name] = 1; });
        if (fnList && opts.functionsOnly) { how = 'opts.functions'; lines = []; }
        else {
            lines = diffMap[f] || diffMap['b/' + f] || (paths.length === 1 ? diffMap._ : null);
            if (!lines && !opts.diff) { var d2 = await io.diff(f); if (d2 != null) { var pd = drParseDiff(d2); lines = pd[f] || pd._ || []; } }
            if (!lines && fnList) { how = 'opts.functions'; lines = []; }
            if (!lines) { how = 'whole-file (no diff available)'; lines = src.split('\n').map(function (_, k) { return k + 1; }); }
        }
        var changed = drChangedFunctions(src, lines).map(function (g) { return { fn: g, via: how }; });
        fnSel.forEach(function (g) { var ex0 = changed.filter(function (c) { return c.fn.bodyOpen === g.bodyOpen; })[0]; if (ex0) ex0.via = 'opts.functions'; else changed.push({ fn: g, via: 'opts.functions' }); });
        for (var k = 0; k < changed.length; k++) {
            var fn = changed[k].fn, br = drBranches(src, fn, all), hits = await io.grep(drWord(fn.name)), wr = hits == null ? null : await codeRefs(fn, f, hits);
            rep.changedFunctions.push({ file: f, name: fn.name, line: fn.line, endLine: fn.endLine, changedVia: changed[k].via, refs: wr && wr.code.length, refSample: wr && wr.code[0] ? wr.code[0].file + ':' + wr.code[0].line : '',
                refsTestOnly: wr ? wr.test.length : 0, testSample: wr && wr.test[0] ? wr.test[0].file + ':' + wr.test[0].line : '', refsCapped: !!(hits && hits.truncated),
                refsUnreadable: wr ? wr.unreadable.length : 0, unreadableSample: wr && wr.unreadable[0] ? wr.unreadable[0].file + ':' + wr.unreadable[0].line : '', unreadableWhy: wr && wr.unreadable[0] ? mk.why(wr.unreadable[0].file) : '',
                branchPoints: br.length, reverseModeRequired: br.length > 5, branches: br.map(function (r) { return { id: r.id, line: r.line, kind: r.kind, condition: r.condition, arms: r.arms, probe: r.probe, T: '', F: '', expected: '', evidence: '' }; }) });
        }
        var ls = drListeners(f, src, all);
        for (var q = 0; q < ls.length; q++) {
            if (ls[q].handler !== '(inline)') { var hn = /^this\./.test(ls[q].handler) ? ls[q].handler.split('.').pop() : drHandlerName(ls[q].handler); ls[q].handlerDefined = hn == null ? true : await defined(hn); if (ls[q].handlerDefined === null) ls[q].handlerWhy = resolvedWhy[hn]; }
            rep.listeners.push(ls[q]);
        }
    }
    if (fnList) rep.functionsNotFound = fnList.filter(function (n) { return !fnFound[n]; });
    function fnSrcOf(file, name) { var s = files[file] || '', g = drFindFunctions(s).filter(function (x) { return x.name === name; })[0]; return g ? drFnSource(s, g) : null; }
    for (var p = 0; p < (opts.probes || []).length; p++) {
        var P = opts.probes[p], fs = P.src || fnSrcOf(P.file, P.fn);
        if (!fs) { rep.probes.push({ fn: P.fn, ok: false, error: 'function ' + P.fn + ' not found in ' + P.file }); continue; }
        var inputs = (P.inputs || []).concat(P.edge ? drEdgeInputs(P.baseArgs || (P.inputs && P.inputs[0]) || [undefined], P.only ? { only: P.only } : null) : []);
        var dom = P.domCheck != null ? !!P.domCheck : drLooksDom(fs); // DOM post-conditions only for DOM/HTML producers unless asked
        var pr = await drProbe(fs, { stubs: P.stubs, inputs: inputs.length ? inputs : [[]], post: P.post, thisArg: P.thisArg, domCheck: dom });
        pr.fn = P.fn; pr.domCheck = dom; rep.probes.push(pr);
    }
    for (var u = 0; u < (opts.mutation || []).length; u++) {
        var M = opts.mutation[u], ms = M.src || fnSrcOf(M.file, M.fn);
        var mr = ms ? await drMutationTest(ms, M.check, { cases: M.cases, stubs: M.stubs, max: M.max }) : { baselineOk: false, error: 'function ' + M.fn + ' not found', survived: [] };
        mr.fn = M.fn; rep.mutation.push(mr);
    }
    for (var v = 0; v < (opts.claims || []).length; v++) {
        var C = opts.claims[v], ok;
        try { ok = typeof C.check === 'function' ? await C.check() : C.check; } catch (e) { ok = false; C.evidence = (C.evidence || '') + ' threw ' + e.message; }
        rep.claims.push({ claim: C.claim, subject: C.subject, status: ok === true ? 'verified' : ok === false ? 'refuted' : 'unverified', evidence: C.evidence || (ok === true ? 'assertion held' : ok === false ? 'assertion failed' : 'no check given') });
    }
    rep.ledger = drLedger(rep, opts);
    rep.gate = rep.ledger.gate;
    rep.summary = { pass: rep.gate.pass, verified: rep.ledger.counts.verified, refuted: rep.ledger.counts.refuted, unverified: rep.ledger.counts.unverified,
        parseErrors: rep.parse.filter(function (x) { return !x.ok; }).length, symbolsChecked: rep.symbols.length, changedFunctions: rep.changedFunctions.length,
        reverseModeRequired: rep.changedFunctions.filter(function (x) { return x.reverseModeRequired; }).map(function (x) { return x.name; }), liveLookups: io.live, ioErrors: errs.length };
    rep.limitations = DR_LIMITATIONS.slice();
    return rep;
}

var DEROULEMENT = {
    version: DR_VERSION, limitations: DR_LIMITATIONS, run: drRun, mask: drMask,
    parseGateJs: drParseGateJs, parseGateHtml: drParseGateHtml,
    proseSymbols: drProseSymbols, checkSymbols: function (syms, opts) { return drCheckSymbols(syms, drSafeIO(drIO(opts || {}), []), opts); },
    crossRefs: function (files, opts) { return drCrossRefs(files, drSafeIO(drIO(Object.assign({ files: files }, opts || {})), []), opts); }, cssClasses: drCssClasses, exportAliases: drExportAliases, looksDom: drLooksDom,
    parseDiff: drParseDiff, findFunctions: drFindFunctions, changedFunctions: drChangedFunctions, fnSource: drFnSource, listeners: drListeners,
    branches: drBranches, matrix: drMatrix, instrument: drInstrument, probe: drProbe,
    edgeValues: drEdgeValues, edgeInputs: drEdgeInputs, domPostconditions: drDomPostconditions,
    mutants: drMutants, mutationTest: drMutationTest, ledger: drLedger, format: drFormat
};
if (typeof module !== 'undefined' && module) module.exports = DEROULEMENT;
// run_js_file module mode: {args:{run:true, ...}} returns the JSON report instead of the API.
if (typeof args !== 'undefined' && args && args.run === true) return await drRun(args);
