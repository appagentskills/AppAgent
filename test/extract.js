// =============================================================
// Shared source-extraction helpers for tests — runs INSIDE the run_tests
// sandbox. NOT a test file (no .test.js suffix). Load it from a test file:
//
//   var EX = await runFile('test/extract.js', { i18n: false });
//
// Why: many tests cut one real function out of a src/ file and evaluate it
// with stubbed free variables (new Function(...)). The old copy-pasted
// helpers found the end of the function by counting raw '{' / '}' (or by
// looking for the first column-zero "\n}"), so a brace or quote inside a
// string, template literal, regex literal or comment could silently move the
// cut. These helpers run every search on a CODE MASK instead: a copy of the
// source, same length and same line breaks, in which the contents of every
// string, template literal (but not its ${} expressions), regex literal and
// comment are blanked out. Brace / paren matching on the mask is exact.
//
// API (all indexes are into the ORIGINAL source; slices are of the original):
//   EX.codeMask(src) -> string            blanked copy (see above)
//   EX.matchBracket(src, openIdx) -> idx   index of the matching ) ] } ; -1 if none
//   EX.findFunction(src, name, opts?) -> {start, fnStart, open, close, end, isAsync} | null
//       first CODE-level `[async] function [*] name (` (never inside a string /
//       comment). start includes `async ` unless opts.includeAsync === false.
//       opts.from: search start index; opts.topLevel: only brace-depth-0 hits.
//   EX.extractFunction(src, name, opts?) -> source text `[async ]function name(...) {...}`
//       throws Error('extract: function <name> not found') when missing.
//   EX.extractFunctions(src, names, opts?) -> the extracts joined with '\n'
//   EX.blockFrom(src, index) -> {start, open, close, end} | null
//       from `index` (e.g. the start of a signature or `var X = function`) to the
//       brace that closes the first code-level `{` found outside parentheses
//       (so `function f(a = {}) {` / `function f({ a }) {` cut correctly).
//   EX.extractFrom(src, anchor, opts?) -> source text from the first CODE-level
//       occurrence of the literal `anchor` through its block's closing brace;
//       throws when the anchor or its block is missing.
// =============================================================

var EXTRACT_REGEX_KEYWORDS = {
    'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1,
    'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1
};
var EXTRACT_PAREN_KEYWORDS = { 'if': 1, 'while': 1, 'for': 1, 'with': 1 };

function _exIsIdentChar(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c === '\\' || c > '\x7f';
}

// Lexes JavaScript just far enough to know which characters are code.
// Regex vs division follows the previous significant token: after a value
// (identifier, number, literal, `)` that closed a call/grouping, `]`) a `/`
// is division; after an operator, `(`, `,`, `{`, `}`, `;`, a keyword such as
// `return` / `typeof`, or the `)` of `if (...)` / `while (...)` it starts a
// regex literal. Template literals nest: `${` opens a code region whose
// matching `}` (tracked per nesting level) resumes the template text.
function codeMask(src) {
    src = String(src);
    var n = src.length, out = src.split('');
    var i = 0;
    var prev = '';          // '' | 'value' | 'keyword' | 'postfix' | punctuator char
    var parens = [];        // for each open '(' : true when it belongs to if/while/for/with
    var lastWord = '';      // last identifier (to classify the next '(')
    var templates = [];     // per open `${`: brace depth inside that expression

    function blank(a, b) {
        for (var k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
    // Scans template text from j (just after ` or the } closing a ${).
    // Returns the index after the closing backtick, or after `${`.
    function template(j) {
        var a = j;
        while (j < n) {
            var c = src[j];
            if (c === '\\') { j += 2; continue; }
            if (c === '`') { blank(a, j + 1); prev = 'value'; return j + 1; }
            if (c === '$' && src[j + 1] === '{') { blank(a, j + 2); templates.push(0); prev = '{'; return j + 2; }
            j++;
        }
        blank(a, n);
        return n;
    }
    function regexAllowed() {
        if (prev === '' || prev === 'keyword') return true;
        if (prev === 'value' || prev === 'postfix') return false;
        return true;   // any punctuator: ( , = : [ ! & | ? { } ; + - * % < > ~ ^ and `if (...)`
    }

    while (i < n) {
        var c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') {
            var e = src.indexOf('\n', i); if (e < 0) e = n;
            blank(i, e); i = e; continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            var ce = src.indexOf('*/', i + 2); ce = ce < 0 ? n : ce + 2;
            blank(i, ce); i = ce; continue;
        }
        if (c === '"' || c === "'") {
            var j = i + 1;
            while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
            blank(i, j + 1); i = j + 1; prev = 'value'; lastWord = ''; continue;
        }
        if (c === '`') { blank(i, i + 1); i = template(i + 1); lastWord = ''; continue; }
        if (c === '/') {
            if (regexAllowed()) {
                var r = i + 1, inClass = false;
                while (r < n) {
                    var rc = src[r];
                    if (rc === '\\') { r += 2; continue; }
                    if (rc === '\n') break;   // not a regex after all (malformed); stop at the line end
                    if (inClass) { if (rc === ']') inClass = false; }
                    else if (rc === '[') inClass = true;
                    else if (rc === '/') { r++; break; }
                    r++;
                }
                while (r < n && /[a-z]/i.test(src[r])) r++;
                blank(i, r); i = r; prev = 'value'; lastWord = ''; continue;
            }
            prev = '/'; i++; lastWord = ''; continue;
        }
        if (c === '}' && templates.length && templates[templates.length - 1] === 0) {
            templates.pop(); blank(i, i + 1); i = template(i + 1); lastWord = ''; continue;
        }
        if (c === '{') { if (templates.length) templates[templates.length - 1]++; prev = '{'; i++; lastWord = ''; continue; }
        if (c === '}') { if (templates.length) templates[templates.length - 1]--; prev = '}'; i++; lastWord = ''; continue; }
        if (c === '(') { parens.push(!!EXTRACT_PAREN_KEYWORDS[lastWord]); prev = '('; i++; lastWord = ''; continue; }
        if (c === ')') { prev = parens.pop() ? ')' : 'value'; i++; lastWord = ''; continue; }
        if (c === ']') { prev = 'value'; i++; lastWord = ''; continue; }
        if ((c === '+' || c === '-') && src[i + 1] === c) {
            // a++ / b  (postfix: division follows) vs  x = ++y  (prefix)
            prev = prev === 'value' ? 'postfix' : c; i += 2; lastWord = ''; continue;
        }
        if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            var d = i + 1;
            while (d < n && (_exIsIdentChar(src[d]) || src[d] === '.')) d++;
            i = d; prev = 'value'; lastWord = ''; continue;
        }
        if (_exIsIdentChar(c)) {
            var w = i + 1;
            while (w < n && _exIsIdentChar(src[w])) w++;
            var word = src.slice(i, w);
            // `x.return / 2`: a property name is a value even when it spells a keyword
            var dotted = prev === '.';
            prev = !dotted && EXTRACT_REGEX_KEYWORDS[word] ? 'keyword' : 'value';
            lastWord = dotted ? '' : word;
            i = w; continue;
        }
        prev = c; i++; lastWord = '';
    }
    return out.join('');
}

function _exMask(src, opts) { return (opts && typeof opts.mask === 'string') ? opts.mask : codeMask(src); }

function _exMatchOnMask(mask, openIdx) {
    var open = mask[openIdx], close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : null;
    if (!close) return -1;
    var depth = 0;
    for (var i = openIdx; i < mask.length; i++) {
        var c = mask[i];
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function matchBracket(src, openIdx, opts) { return _exMatchOnMask(_exMask(src, opts), openIdx); }

function _exDepthAt(mask, idx) {
    var depth = 0;
    for (var i = 0; i < idx; i++) { var c = mask[i]; if (c === '{') depth++; else if (c === '}') depth--; }
    return depth;
}

function _exEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Block that follows `index`: skips balanced (...) so braces in parameter
// defaults / destructuring never count, then matches the first `{`.
function _exBlockOnMask(mask, index) {
    for (var i = index; i < mask.length; i++) {
        var c = mask[i];
        if (c === '(') { var p = _exMatchOnMask(mask, i); if (p < 0) return null; i = p; continue; }
        if (c === '{') { var b = _exMatchOnMask(mask, i); return b < 0 ? null : { start: index, open: i, close: b, end: b + 1 }; }
    }
    return null;
}

function blockFrom(src, index, opts) { return _exBlockOnMask(_exMask(src, opts), index); }

function findFunction(src, name, opts) {
    opts = opts || {};
    src = String(src);
    var mask = _exMask(src, opts);
    var re = new RegExp('(^|[^\\w$.])((async\\s+)?)function\\s*(\\*\\s*)?' + _exEscape(name) + '\\s*\\(', 'g');
    re.lastIndex = opts.from || 0;
    var m;
    while ((m = re.exec(mask))) {
        var at = m.index + m[1].length;
        if (opts.topLevel && _exDepthAt(mask, at) !== 0) { re.lastIndex = m.index + 1; continue; }
        var fnStart = at + m[2].length;
        var block = _exBlockOnMask(mask, fnStart);
        if (!block) return null;
        return {
            start: opts.includeAsync === false ? fnStart : at,
            fnStart: fnStart, open: block.open, close: block.close, end: block.end,
            isAsync: !!m[2]
        };
    }
    return null;
}

function extractFunction(src, name, opts) {
    var f = findFunction(src, name, opts);
    if (!f) throw new Error('extract: function ' + name + ' not found');
    return String(src).slice(f.start, f.end);
}

function extractFunctions(src, names, opts) {
    opts = Object.assign({}, opts || {});
    if (typeof opts.mask !== 'string') opts.mask = codeMask(src);
    return names.map(function(name) { return extractFunction(src, name, opts); }).join('\n');
}

function extractFrom(src, anchor, opts) {
    opts = opts || {};
    src = String(src);
    var mask = _exMask(src, opts);
    var from = opts.from || 0, at = -1;
    // the anchor's own string/comment characters are blanked in the mask, so
    // locate it in the source and accept only hits whose first char is code.
    while ((at = src.indexOf(anchor, from)) >= 0 && mask[at] !== src[at]) from = at + 1;
    if (at < 0) throw new Error('extract: anchor not found: ' + anchor);
    var block = _exBlockOnMask(mask, at);
    if (!block) throw new Error('extract: no block after anchor: ' + anchor);
    return src.slice(at, block.end);
}

if (typeof module !== 'undefined' && module) {
    module.exports = {
        codeMask: codeMask, matchBracket: matchBracket, blockFrom: blockFrom,
        findFunction: findFunction, extractFunction: extractFunction,
        extractFunctions: extractFunctions, extractFrom: extractFrom
    };
}
