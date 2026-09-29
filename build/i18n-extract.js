// build/i18n-extract.js - i18n source-string extractor + catalog checker.
//
// Sandbox-safe: pure top-level functions (no require/fs/DOM/host globals) plus a guarded
// module.exports, so the same file works with run_js_file (module mode), runFile/loadModules
// in tests, and a Node require.
//
// extractI18nStrings({ path: text, ... })
//   -> [{ source, refs: ['path:line', ...], plural?: { one, other } }, ...] sorted by source
//      (code-unit order), plus a NON-enumerable `.nonLiteral: ['path:line', ...]` listing key
//      calls / markup whose key is not a plain literal (templates with ${}, variables,
//      concatenations, dynamic data-i18n content), so batch QA can review them.
//   .js/.mjs/.cjs : t('...'), tn(n, 'one', 'other') (key = other, pair flagged as plural) and
//                   N_('...') with single- or double-quoted literals or substitution-free
//                   templates (`...`), escapes decoded to the runtime value; optional calls
//                   t?.('...') count as calls. Member calls (foo.t(), window.t(), obj?.t())
//                   and declarations are ignored. data-i18n / data-i18n-attr markup inside JS string literals and
//                   templates is scanned too ('+' chains are joined; dynamic parts are reported
//                   in nonLiteral instead of being guessed).
//   .html/.htm    : data-i18n / data-i18n-attr markup, inline JS <script> bodies and on*
//                   handler attributes. Other extensions are ignored.
//   data-i18n key : each OWN non-whitespace text node of the element (child elements keep
//                   their own text), entity-decoded, whitespace runs collapsed to one space,
//                   trimmed = normalizeI18nKey(decodeHtmlEntities(text)). The DOM layer
//                   (ui/245 applyI18n) applies normalizeI18nKey to nodeValue, the same rule.
//   data-i18n-attr="title,placeholder,aria-label": each listed attribute value, same rule.
//
// checkCatalog(sources, catalog) -> { missing, extra, placeholderMismatch }
//   sources: the extractor output or a string array. catalog: { source: string | {category}}.
//   missing: no usable translation ('' or an object without `other` counts as missing).
//   extra: catalog keys that are not sources.
//   placeholderMismatch: [{ source, category (null for a string value), missing, unexpected }]
//     every category of a plural object is checked; {count} may be omitted in plural forms
//     (tn fills it) and is always allowed for tn keys; any other source placeholder is
//     required, and a placeholder the source does not have is unexpected.

var IEX_SENT = '\uFDD0'; // stands for a dynamic (non-literal) part of a JS string expression
var IEX_REGEX_AFTER = { 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1, 'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1, 'extends': 1 };
var IEX_PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
var IEX_VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, keygen: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
var IEX_PLURAL_ORDER = { zero: 1, one: 2, two: 3, few: 4, many: 5, other: 6 };
var IEX_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
    zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f', shy: '\u00ad', hellip: '\u2026', mdash: '\u2014',
    ndash: '\u2013', minus: '\u2212', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d',
    bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a', prime: '\u2032', Prime: '\u2033',
    bull: '\u2022', middot: '\u00b7', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', copy: '\u00a9', reg: '\u00ae',
    trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', frac12: '\u00bd', frac14: '\u00bc',
    frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5', para: '\u00b6', sect: '\u00a7', cent: '\u00a2',
    pound: '\u00a3', euro: '\u20ac', yen: '\u00a5', curren: '\u00a4', iexcl: '\u00a1', iquest: '\u00bf', not: '\u00ac',
    larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194', lArr: '\u21d0', uArr: '\u21d1',
    rArr: '\u21d2', dArr: '\u21d3', hArr: '\u21d4', crarr: '\u21b5', le: '\u2264', ge: '\u2265', ne: '\u2260',
    asymp: '\u2248', infin: '\u221e', check: '\u2713', cross: '\u2717', star: '\u2606', starf: '\u2605', loz: '\u25ca',
    hearts: '\u2665', spades: '\u2660', clubs: '\u2663', diams: '\u2666', circ: '\u02c6', tilde: '\u02dc',
    eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', aacute: '\u00e1', agrave: '\u00e0', acirc: '\u00e2',
    auml: '\u00e4', ouml: '\u00f6', uuml: '\u00fc', ccedil: '\u00e7', ntilde: '\u00f1', szlig: '\u00df'
};

// ---- shared text rules ------------------------------------------------------------------

function normalizeI18nKey(text) {
    return String(text === null || text === void 0 ? '' : text).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text) {
    var s = String(text === null || text === void 0 ? '' : text);
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, function(m, e) {
        if (e.charAt(0) === '#') {
            var hex = e.charAt(1) === 'x' || e.charAt(1) === 'X';
            var cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
            if (!(cp > 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
            return String.fromCodePoint(cp);
        }
        return Object.prototype.hasOwnProperty.call(IEX_ENTITIES, e) ? IEX_ENTITIES[e] : m;
    });
}

function _iexCmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function _iexSortRefs(refs) {
    return refs.sort(function(a, b) {
        var ia = a.lastIndexOf(':'), ib = b.lastIndexOf(':');
        var pa = a.slice(0, ia), pb = b.slice(0, ib);
        if (pa !== pb) return pa < pb ? -1 : 1;
        return Number(a.slice(ia + 1)) - Number(b.slice(ib + 1));
    });
}

function _iexLineStarts(text) {
    var ls = [0];
    for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) ls.push(i + 1);
    }
    return ls;
}

function _iexLineOf(ls, off) {
    var lo = 0, hi = ls.length - 1;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (ls[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
}

// ---- JS lexer ---------------------------------------------------------------------------

function _iexIsWs(c) {
    return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0xFEFF || c === 0x2028 || c === 0x2029 ||
        c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x202F || c === 0x205F || c === 0x3000;
}
function _iexIsLineEnd(c) { return c === 10 || c === 13 || c === 0x2028 || c === 0x2029; }
function _iexIsAlpha(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
function _iexIsIdStart(c) { return _iexIsAlpha(c) || c === 36 || c === 95 || (c > 127 && c !== 0xFDD0 && !_iexIsWs(c)); }
function _iexIsIdPart(c) { return _iexIsIdStart(c) || (c >= 48 && c <= 57); }
function _iexIsDigit(c) { return c >= 48 && c <= 57; }

// Cooked (runtime) value of the string/template body code[a, b). With wantMap, map[k] is the
// source offset of cooked char k (used to report lines for markup found inside strings).
function _iexCook(code, a, b, wantMap) {
    var out = '', map = wantMap ? [] : null, j = a;
    while (j < b) {
        var c = code.charCodeAt(j), at = j, ch;
        if (c !== 92) {
            if (c === 13 && j + 1 < b && code.charCodeAt(j + 1) === 10) { j++; continue; } // CRLF -> LF
            ch = code.charAt(j);
            j++;
        } else {
            var e = code.charAt(j + 1), hex;
            j += 2;
            if (e === 'n') ch = '\n';
            else if (e === 't') ch = '\t';
            else if (e === 'r') ch = '\r';
            else if (e === 'b') ch = '\b';
            else if (e === 'f') ch = '\f';
            else if (e === 'v') ch = '\v';
            else if (e === '0' && !_iexIsDigit(code.charCodeAt(j))) ch = '\0';
            else if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(hex = code.slice(j, j + 2))) { ch = String.fromCharCode(parseInt(hex, 16)); j += 2; }
            else if (e === 'u' && code.charAt(j) === '{') {
                var close = code.indexOf('}', j);
                hex = close > j ? code.slice(j + 1, close) : '';
                var cp = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : -1;
                if (cp >= 0 && cp <= 0x10FFFF) { ch = String.fromCodePoint(cp); j = close + 1; } else ch = 'u';
            }
            else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(hex = code.slice(j, j + 4))) { ch = String.fromCharCode(parseInt(hex, 16)); j += 4; }
            else if (e === '\r') { ch = ''; if (code.charAt(j) === '\n') j++; }
            else if (e === '\n' || e === '\u2028' || e === '\u2029') ch = '';
            else ch = e;
        }
        out += ch;
        if (map) for (var k = 0; k < ch.length; k++) map.push(at);
    }
    return { s: out, map: map };
}

// End index of the regex literal starting at code[i] === '/', or -1 (then it is a division).
function _iexRegexEnd(code, i) {
    var n = code.length, j = i + 1, cls = false;
    while (j < n) {
        var c = code.charCodeAt(j);
        if (_iexIsLineEnd(c)) return -1;
        if (c === 92) {
            if (j + 1 >= n || _iexIsLineEnd(code.charCodeAt(j + 1))) return -1;
            j += 2;
            continue;
        }
        if (cls) { if (c === 93) cls = false; }
        else if (c === 91) cls = true;
        else if (c === 47) {
            j++;
            while (j < n && _iexIsIdPart(code.charCodeAt(j))) j++;
            return j;
        }
        j++;
    }
    return -1;
}

// Tokens: name | num | str (value = cooked, a/b = body bounds) | regex | punct |
// tpl (one per template chunk: tid, head, tail, value = cooked chunk, a/b = chunk bounds).
// Comments are dropped; template substitutions are lexed as ordinary tokens in between.
function _iexLex(code) {
    var toks = [], n = code.length, i = 0, braces = [], tplCount = 0;
    function regexAllowed() {
        var p = toks.length ? toks[toks.length - 1] : null;
        if (!p) return true;
        if (p.type === 'name') return IEX_REGEX_AFTER[p.value] === 1;
        if (p.type === 'punct') return !(p.value === ')' || p.value === ']' || p.value === '++' || p.value === '--');
        if (p.type === 'tpl') return !p.tail;
        return false;
    }
    function readTemplate(from, head, id) {
        var j = from;
        while (j < n) {
            var c = code.charCodeAt(j);
            if (c === 92) { j += 2; continue; }
            if (c === 96 || (c === 36 && code.charCodeAt(j + 1) === 123)) {
                var tail = c === 96;
                toks.push({ type: 'tpl', start: from - 1, a: from, b: j, tid: id, head: head, tail: tail, value: _iexCook(code, from, j, false).s });
                if (tail) return j + 1;
                braces.push(id);
                return j + 2;
            }
            j++;
        }
        toks.push({ type: 'tpl', start: from - 1, a: from, b: n, tid: id, head: head, tail: true, value: _iexCook(code, from, n, false).s });
        return n;
    }
    if (code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33) { while (i < n && !_iexIsLineEnd(code.charCodeAt(i))) i++; } // #!
    while (i < n) {
        var c = code.charCodeAt(i);
        if (_iexIsWs(c)) { i++; continue; }
        if (c === 47) {
            var c2 = code.charCodeAt(i + 1);
            if (c2 === 47) { while (i < n && !_iexIsLineEnd(code.charCodeAt(i))) i++; continue; }
            if (c2 === 42) { var ce = code.indexOf('*/', i + 2); i = ce < 0 ? n : ce + 2; continue; }
            if (regexAllowed()) {
                var re = _iexRegexEnd(code, i);
                if (re > 0) { toks.push({ type: 'regex', start: i, value: code.slice(i, re) }); i = re; continue; }
            }
        }
        if (c === 39 || c === 34) {
            var j = i + 1;
            while (j < n) {
                var d = code.charCodeAt(j);
                if (d === 92) { j += (code.charCodeAt(j + 1) === 13 && code.charCodeAt(j + 2) === 10) ? 3 : 2; continue; }
                if (d === c || d === 10 || d === 13) break;
                j++;
            }
            if (j > n) j = n;
            toks.push({ type: 'str', start: i, a: i + 1, b: j, value: _iexCook(code, i + 1, j, false).s });
            i = (j < n && code.charCodeAt(j) === c) ? j + 1 : j;
            continue;
        }
        if (c === 96) { tplCount++; i = readTemplate(i + 1, true, tplCount); continue; }
        if (_iexIsIdStart(c)) {
            var k = i + 1;
            while (k < n && _iexIsIdPart(code.charCodeAt(k))) k++;
            toks.push({ type: 'name', start: i, value: code.slice(i, k) });
            i = k;
            continue;
        }
        if (_iexIsDigit(c) || (c === 46 && _iexIsDigit(code.charCodeAt(i + 1)))) {
            var m = i + 1, isHex = c === 48 && (code.charCodeAt(i + 1) | 32) === 120;
            while (m < n) {
                var e = code.charCodeAt(m);
                if (_iexIsIdPart(e) || e === 46) { m++; continue; }
                if ((e === 43 || e === 45) && !isHex && (code.charCodeAt(m - 1) | 32) === 101) { m++; continue; }
                break;
            }
            toks.push({ type: 'num', start: i, value: code.slice(i, m) });
            i = m;
            continue;
        }
        if (c === 123) { braces.push(0); toks.push({ type: 'punct', start: i, value: '{' }); i++; continue; }
        if (c === 125) {
            if (braces.length && braces[braces.length - 1] > 0) { i = readTemplate(i + 1, false, braces.pop()); continue; }
            braces.pop();
            toks.push({ type: 'punct', start: i, value: '}' });
            i++;
            continue;
        }
        var pv = code.charAt(i);
        if ('=!<>&|?.+-*/%^'.indexOf(pv) >= 0) {
            for (var q = 0; q < IEX_PUNCTS.length; q++) {
                var op = IEX_PUNCTS[q];
                if (code.slice(i, i + op.length) === op) { pv = op; break; }
            }
            if (pv === '?.' && _iexIsDigit(code.charCodeAt(i + 2))) pv = '?';
        }
        toks.push({ type: 'punct', start: i, value: pv });
        i += pv.length;
    }
    return toks;
}

// ---- JS: t / tn / N_ calls --------------------------------------------------------------

function _iexIsP(tk, v) { return !!tk && tk.type === 'punct' && tk.value === v; }
function _iexIsStr(tk) { return !!tk && tk.type === 'str'; }
// A key literal: a quoted string, or a template with no substitution (`Hello` is head + tail
// in one token and its cooked value is the runtime key, exactly like 'Hello').
function _iexIsLit(tk) { return _iexIsStr(tk) || (!!tk && tk.type === 'tpl' && tk.head === true && tk.tail === true); }

// From toks[j] (just inside a call's '('): index of the first depth-0 ',' or of the closing
// ')' (toClose: skip commas and return the closing ')').
function _iexArgEnd(toks, j, toClose) {
    var depth = 0;
    for (; j < toks.length; j++) {
        var tk = toks[j];
        if (tk.type !== 'punct') continue;
        var v = tk.value;
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') { if (depth === 0) return j; depth--; }
        else if (v === ',' && depth === 0 && !toClose) return j;
    }
    return j;
}

// emit(kind, value, offset, one): kind 'key' | 'plural' | 'nonLiteral'.
function _iexScanCalls(toks, emit) {
    for (var i = 0; i < toks.length; i++) {
        var tk = toks[i], name = tk.value;
        if (tk.type !== 'name' || (name !== 't' && name !== 'tn' && name !== 'N_')) continue;
        var open = i + 1;
        if (_iexIsP(toks[open], '?.') && _iexIsP(toks[open + 1], '(')) open++; // optional call t?.('x') is still a call
        if (!_iexIsP(toks[open], '(')) continue;
        var pv = toks[i - 1], pp = toks[i - 2];
        if (pv && pv.type === 'punct' && (pv.value === '.' || pv.value === '?.' || pv.value === '#')) continue; // member call
        if (pv && pv.type === 'name' && pv.value === 'function') continue; // declaration
        if (_iexIsP(pv, '*') && pp && pp.type === 'name' && pp.value === 'function') continue; // generator declaration
        var close = _iexArgEnd(toks, open + 1, true);
        if (_iexIsP(toks[close + 1], '{') && (!pv || (pv.type === 'punct' && (pv.value === '{' || pv.value === '}' || pv.value === ',' || pv.value === ';')) ||
            (pv.type === 'name' && (pv.value === 'static' || pv.value === 'async' || pv.value === 'get' || pv.value === 'set')))) continue; // method definition
        if (name === 'tn') {
            var k = _iexArgEnd(toks, open + 1, false);
            var one = toks[k + 1], sep = toks[k + 2], other = toks[k + 3], after = toks[k + 4];
            if (_iexIsP(toks[k], ',') && _iexIsLit(one) && _iexIsP(sep, ',') && _iexIsLit(other) && (_iexIsP(after, ',') || _iexIsP(after, ')'))) emit('plural', other.value, other.start, one.value);
            else emit('nonLiteral', '', tk.start);
            continue;
        }
        var s = toks[open + 1], e = toks[open + 2];
        if (_iexIsLit(s) && (_iexIsP(e, ',') || _iexIsP(e, ')'))) emit('key', s.value, s.start);
        else emit('nonLiteral', '', tk.start);
    }
}

// ---- JS: markup inside string expressions -----------------------------------------------

function _iexIsMemberTok(tk) {
    return !!tk && tk.type === 'punct' && (tk.value === '.' || tk.value === '?.' || tk.value === '[' || tk.value === '(');
}

function _iexTplEnd(toks, j) {
    var id = toks[j].tid;
    for (var k = j; k < toks.length; k++) if (toks[k].type === 'tpl' && toks[k].tid === id && toks[k].tail) return k;
    return toks.length - 1;
}

function _iexClose(toks, j) {
    var depth = 0;
    for (var k = j; k < toks.length; k++) {
        var tk = toks[k];
        if (tk.type !== 'punct') continue;
        if (tk.value === '(' || tk.value === '[' || tk.value === '{') depth++;
        else if (tk.value === ')' || tk.value === ']' || tk.value === '}') { depth--; if (depth <= 0) return k; }
    }
    return toks.length - 1;
}

// Skips one non-literal '+' operand (prefix ops, primary, member/call/index chain and the
// tighter-binding * / % ** operators); returns the index after it.
function _iexSkipOperand(toks, j) {
    var n = toks.length;
    for (;;) {
        while (j < n && ((toks[j].type === 'punct' && /^(!|~|-|\+|\+\+|--)$/.test(toks[j].value)) ||
            (toks[j].type === 'name' && /^(typeof|void|await|new|delete)$/.test(toks[j].value)))) j++;
        if (j >= n) return j;
        var tk = toks[j];
        if (tk.type === 'punct' && (tk.value === '(' || tk.value === '[' || tk.value === '{')) j = _iexClose(toks, j) + 1;
        else if (tk.type === 'tpl' && tk.head) j = _iexTplEnd(toks, j) + 1;
        else if (tk.type === 'punct' || tk.type === 'tpl') return j;
        else j++;
        while (j < n) {
            var p = toks[j];
            if (p.type === 'punct' && (p.value === '.' || p.value === '?.')) { j++; if (j < n && toks[j].type === 'name') j++; continue; }
            if (p.type === 'punct' && (p.value === '(' || p.value === '[')) { j = _iexClose(toks, j) + 1; continue; }
            if (p.type === 'tpl' && p.head) { j = _iexTplEnd(toks, j) + 1; continue; }
            if (p.type === 'punct' && (p.value === '++' || p.value === '--')) { j++; continue; }
            break;
        }
        if (j < n && toks[j].type === 'punct' && (toks[j].value === '*' || toks[j].value === '/' || toks[j].value === '%' || toks[j].value === '**')) { j++; continue; }
        return j;
    }
}

// Appends one '+' operand to pieces ({tok} literal chunk | {tok:null, at} dynamic part).
function _iexChainOperand(toks, j, pieces, used, first) {
    var tk = toks[j];
    if (!tk) return j;
    if (tk.type === 'str' && (first || !_iexIsMemberTok(toks[j + 1]))) { pieces.push({ tok: tk }); used[j] = true; return j + 1; }
    if (tk.type === 'tpl' && tk.head) {
        var end = _iexTplEnd(toks, j);
        if (first || !_iexIsMemberTok(toks[end + 1])) {
            for (var k = j; k <= end; k++) {
                var part = toks[k];
                if (part.type !== 'tpl' || part.tid !== tk.tid) continue;
                pieces.push({ tok: part });
                used[k] = true;
                if (!part.tail) pieces.push({ tok: null, at: toks[k + 1] ? toks[k + 1].start : part.b });
            }
            return end + 1;
        }
    }
    pieces.push({ tok: null, at: tk.start });
    return _iexSkipOperand(toks, j);
}

// Joins each string expression ('a' + x + `b${y}`) into one virtual string (dynamic parts =
// IEX_SENT) and hands the ones mentioning data-i18n to onHtml(virtualString, offsetMap).
function _iexScanChains(code, toks, onHtml) {
    var used = [];
    for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        if (used[i] || !(tk.type === 'str' || (tk.type === 'tpl' && tk.head))) continue;
        var pieces = [], j = _iexChainOperand(toks, i, pieces, used, true), marker = false, p;
        while (_iexIsP(toks[j], '+')) j = _iexChainOperand(toks, j + 1, pieces, used, false);
        for (p = 0; p < pieces.length && !marker; p++) marker = !!pieces[p].tok && pieces[p].tok.value.indexOf('data-i18n') >= 0;
        if (!marker) continue;
        var s = '', map = [];
        for (p = 0; p < pieces.length; p++) {
            var pc = pieces[p];
            if (!pc.tok) { s += IEX_SENT; map.push(pc.at); continue; }
            var ck = _iexCook(code, pc.tok.a, pc.tok.b, true);
            s += ck.s;
            for (var q = 0; q < ck.map.length; q++) map.push(ck.map[q]);
        }
        onHtml(s, map);
    }
}

// ---- HTML scanner (HTML files and virtual JS strings) -----------------------------------

function _iexIsJsType(type) {
    if (type === void 0) return true;
    var t0 = String(type).trim().toLowerCase();
    return !t0 || t0 === 'module' || /^(text|application)\/(x-)?(java|ecma)script$/.test(t0);
}

// opts: { js: virtual JS string (dynamic parts are IEX_SENT; content cut off at the end of the
// string is reported, not guessed), pos(k) -> source offset, onScript(a, b), onHandler(code, k) }
function _iexScanHtml(s, opts, emit) {
    var n = s.length, i = 0, stack = [], textAt = -1;
    function flushText(end, eof) {
        if (textAt < 0) return;
        var from = textAt, el = stack.length ? stack[stack.length - 1] : null;
        textAt = -1;
        if (!el || !el.i18n) return;
        var raw = s.slice(from, end), text = decodeHtmlEntities(raw), at = from + Math.max(raw.search(/\S/), 0);
        if (text.indexOf(IEX_SENT) >= 0) { emit('nonLiteral', '', opts.pos(at)); return; }
        if (eof && opts.js) return; // reported through the still-open element below
        var key = normalizeI18nKey(text);
        if (key) emit('key', key, opts.pos(at));
    }
    function endTag(at) {
        var j = at + 2;
        while (j < n && !_iexIsWs(s.charCodeAt(j)) && s.charCodeAt(j) !== 47 && s.charCodeAt(j) !== 62) j++;
        var name = s.slice(at + 2, j).toLowerCase();
        for (var k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { stack.length = k; break; }
        var gt = s.indexOf('>', j);
        return gt < 0 ? n : gt + 1;
    }
    function startTag(at) {
        var j = at + 1;
        while (j < n && !_iexIsWs(s.charCodeAt(j)) && s.charCodeAt(j) !== 47 && s.charCodeAt(j) !== 62) j++;
        var name = s.slice(at + 1, j).toLowerCase(), attrs = Object.create(null), vat = Object.create(null), closed = false, self = false;
        while (j < n) {
            var c = s.charCodeAt(j);
            if (_iexIsWs(c)) { j++; continue; }
            if (c === 62) { closed = true; j++; break; }
            if (c === 47) { if (s.charCodeAt(j + 1) === 62) { closed = self = true; j += 2; break; } j++; continue; }
            var an = j;
            while (j < n && !_iexIsWs(s.charCodeAt(j)) && s.charCodeAt(j) !== 47 && s.charCodeAt(j) !== 62 && s.charCodeAt(j) !== 61) j++;
            if (j === an) j++;
            var aname = s.slice(an, j).toLowerCase(), value = '', vpos = an, k = j;
            while (k < n && _iexIsWs(s.charCodeAt(k))) k++;
            if (s.charCodeAt(k) === 61) {
                k++;
                while (k < n && _iexIsWs(s.charCodeAt(k))) k++;
                var qc = s.charCodeAt(k);
                if (qc === 34 || qc === 39) {
                    var qe = s.indexOf(s.charAt(k), k + 1);
                    if (qe < 0) qe = n;
                    value = s.slice(k + 1, qe);
                    vpos = k + 1;
                    j = qe < n ? qe + 1 : n;
                } else {
                    var ue = k;
                    while (ue < n && !_iexIsWs(s.charCodeAt(ue)) && s.charCodeAt(ue) !== 62) ue++;
                    value = s.slice(k, ue);
                    vpos = k;
                    j = ue;
                }
            }
            if (!(aname in attrs)) { attrs[aname] = value; vat[aname] = vpos; }
        }
        var el = { name: name, i18n: 'data-i18n' in attrs, at: at }, hasAttrList = 'data-i18n-attr' in attrs;
        if (!closed) { // markup cut off at the end of the text
            if (opts.js && (el.i18n || hasAttrList)) emit('nonLiteral', '', opts.pos(at));
            return n;
        }
        if (hasAttrList) {
            var list = decodeHtmlEntities(attrs['data-i18n-attr']);
            if (list.indexOf(IEX_SENT) >= 0) emit('nonLiteral', '', opts.pos(vat['data-i18n-attr']));
            else {
                var names = list.split(',');
                for (var ni = 0; ni < names.length; ni++) {
                    var nm = names[ni].trim().toLowerCase();
                    if (!nm || !(nm in attrs)) continue;
                    var v = decodeHtmlEntities(attrs[nm]);
                    if (v.indexOf(IEX_SENT) >= 0) { emit('nonLiteral', '', opts.pos(vat[nm])); continue; }
                    var key = normalizeI18nKey(v);
                    if (key) emit('key', key, opts.pos(vat[nm]));
                }
            }
        }
        if (opts.onHandler) {
            for (var hn in attrs) if (hn.length > 2 && hn.charAt(0) === 'o' && hn.charAt(1) === 'n' && attrs[hn]) opts.onHandler(decodeHtmlEntities(attrs[hn]), vat[hn]);
        }
        if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
            var re = new RegExp('<\\/' + name + '(?![A-Za-z0-9-])', 'ig');
            re.lastIndex = j;
            var m = re.exec(s), bodyEnd = m ? m.index : n;
            if (name === 'script') {
                if (!opts.js && opts.onScript && !('src' in attrs) && _iexIsJsType(attrs.type)) opts.onScript(j, bodyEnd);
            } else if (name === 'textarea' || name === 'title') { // RCDATA: one text node
                stack.push(el);
                textAt = j < bodyEnd ? j : -1;
                flushText(bodyEnd, !m);
                stack.pop();
                if (!m && opts.js && el.i18n) emit('nonLiteral', '', opts.pos(at));
            }
            if (!m) return n;
            var gt = s.indexOf('>', m.index);
            return gt < 0 ? n : gt + 1;
        }
        if (!self && IEX_VOID_TAGS[name] !== 1) stack.push(el);
        return j;
    }
    while (i < n) {
        if (s.charCodeAt(i) === 60) {
            var c1 = s.charCodeAt(i + 1);
            if (c1 === 33 && s.slice(i, i + 4) === '<!--') { flushText(i); var ce = s.indexOf('-->', i + 4); i = ce < 0 ? n : ce + 3; continue; }
            if (c1 === 47 && _iexIsAlpha(s.charCodeAt(i + 2))) { flushText(i); i = endTag(i); continue; }
            if (_iexIsAlpha(c1)) { flushText(i); i = startTag(i); continue; }
            if (c1 === 33 || c1 === 63) { flushText(i); var cg = s.indexOf('>', i + 2); i = cg < 0 ? n : cg + 1; continue; }
        }
        if (textAt < 0) textAt = i;
        i++;
    }
    flushText(n, true);
    if (opts.js) for (var k = 0; k < stack.length; k++) if (stack[k].i18n) emit('nonLiteral', '', opts.pos(stack[k].at));
}

// ---- per-file drivers -------------------------------------------------------------------

function _iexEmit(ctx, kind, value, off, one) {
    var ref = ctx.path + ':' + _iexLineOf(ctx.lines, off);
    if (kind === 'nonLiteral' || String(value).indexOf(IEX_SENT) >= 0 || (one !== void 0 && String(one).indexOf(IEX_SENT) >= 0)) { ctx.nonLiteral[ref] = true; return; }
    if (value === '') return;
    var e = ctx.entries[value];
    if (!e) e = ctx.entries[value] = { source: value, refs: Object.create(null), plural: null };
    e.refs[ref] = true;
    if (kind === 'plural' && !e.plural) e.plural = { one: one, other: value };
}

function _iexScanHandlerCode(code, off, ctx) {
    _iexScanCalls(_iexLex(code), function(kind, value, _o, one) { _iexEmit(ctx, kind, value, off, one); });
}

function _iexScanJs(code, base, ctx) {
    var toks = _iexLex(code);
    _iexScanCalls(toks, function(kind, value, off, one) { _iexEmit(ctx, kind, value, base + off, one); });
    _iexScanChains(code, toks, function(s, map) {
        var last = map.length - 1;
        function at(k) { return base + map[k < 0 ? 0 : (k > last ? last : k)]; }
        _iexScanHtml(s, {
            js: true,
            pos: at,
            onHandler: function(hcode, k) { _iexScanHandlerCode(hcode, at(k), ctx); }
        }, function(kind, value, off, one) { _iexEmit(ctx, kind, value, off, one); });
    });
}

function _iexScanHtmlFile(text, ctx) {
    _iexScanHtml(text, {
        js: false,
        pos: function(k) { return k; },
        onScript: function(a, b) { _iexScanJs(text.slice(a, b), a, ctx); },
        onHandler: function(code, k) { _iexScanHandlerCode(code, k, ctx); }
    }, function(kind, value, off, one) { _iexEmit(ctx, kind, value, off, one); });
}

// ---- public API -------------------------------------------------------------------------

function extractI18nStrings(files) {
    var map = files && typeof files === 'object' ? files : {};
    var entries = Object.create(null), nonLiteral = Object.create(null), paths = Object.keys(map).sort(_iexCmp);
    for (var p = 0; p < paths.length; p++) {
        var path = paths[p], text = map[path];
        if (typeof text !== 'string') continue;
        var ext = (/\.([A-Za-z0-9]+)$/.exec(path) || ['', ''])[1].toLowerCase();
        var ctx = { path: path, lines: _iexLineStarts(text), entries: entries, nonLiteral: nonLiteral };
        if (ext === 'js' || ext === 'mjs' || ext === 'cjs') _iexScanJs(text, 0, ctx);
        else if (ext === 'html' || ext === 'htm') _iexScanHtmlFile(text, ctx);
    }
    var out = Object.keys(entries).sort(_iexCmp).map(function(key) {
        var e = entries[key], item = { source: e.source, refs: _iexSortRefs(Object.keys(e.refs)) };
        if (e.plural) item.plural = { one: e.plural.one, other: e.plural.other };
        return item;
    });
    Object.defineProperty(out, 'nonLiteral', { value: _iexSortRefs(Object.keys(nonLiteral)), enumerable: false, writable: true, configurable: true });
    return out;
}

function _iexPlaceholders(text) {
    var found = Object.create(null), re = /\{([A-Za-z0-9_]+)\}/g, m, s = String(text);
    while ((m = re.exec(s)) !== null) found[m[1]] = true;
    return found;
}

function _iexPluralCmp(a, b) {
    var oa = IEX_PLURAL_ORDER[a] || 99, ob = IEX_PLURAL_ORDER[b] || 99;
    return oa !== ob ? oa - ob : _iexCmp(a, b);
}

function checkCatalog(sources, catalog) {
    var list = Array.isArray(sources) ? sources : (sources && Array.isArray(sources.sources) ? sources.sources : []);
    var has = Object.prototype.hasOwnProperty, src = Object.create(null), keys = [], i, p;
    for (i = 0; i < list.length; i++) {
        var it = list[i], key = typeof it === 'string' ? it : (it && typeof it.source === 'string' ? it.source : '');
        if (!key) continue;
        var pl = it && typeof it === 'object' && it.plural && typeof it.plural === 'object' ? it.plural : null;
        if (!(key in src)) { src[key] = pl; keys.push(key); }
        else if (pl && !src[key]) src[key] = pl;
    }
    keys.sort(_iexCmp);
    var cat = catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? catalog : {};
    var missing = [], extra = [], mismatch = [];
    for (i = 0; i < keys.length; i++) {
        var k = keys[i], v = has.call(cat, k) ? cat[k] : null, plural = src[k];
        var isObj = !!v && typeof v === 'object' && !Array.isArray(v);
        var usable = typeof v === 'string' ? v !== '' : (isObj && has.call(v, 'other') && typeof v.other === 'string' && v.other !== '');
        if (!usable) { missing.push(k); continue; }
        var required = _iexPlaceholders(plural && typeof plural.other === 'string' ? plural.other : k), allowed = Object.create(null);
        for (p in required) allowed[p] = true;
        if (plural) {
            var onePh = _iexPlaceholders(typeof plural.one === 'string' ? plural.one : '');
            for (p in onePh) allowed[p] = true;
            allowed.count = true;
        }
        var countOptional = !!plural || isObj, forms = isObj ? Object.keys(v).sort(_iexPluralCmp) : [null];
        for (var f = 0; f < forms.length; f++) {
            var str = forms[f] === null ? v : v[forms[f]];
            if (typeof str !== 'string') continue;
            var have = _iexPlaceholders(str), miss = [], unexpected = [];
            for (p in required) if (!have[p] && !(countOptional && p === 'count')) miss.push(p);
            for (p in have) if (!allowed[p]) unexpected.push(p);
            if (miss.length || unexpected.length) mismatch.push({ source: k, category: forms[f], missing: miss.sort(_iexCmp), unexpected: unexpected.sort(_iexCmp) });
        }
    }
    var catKeys = Object.keys(cat).sort(_iexCmp);
    for (i = 0; i < catKeys.length; i++) if (!(catKeys[i] in src)) extra.push(catKeys[i]);
    return { missing: missing, extra: extra, placeholderMismatch: mismatch };
}

if (typeof module !== 'undefined' && module && typeof module.exports === 'object') {
    module.exports = {
        extractI18nStrings: extractI18nStrings,
        checkCatalog: checkCatalog,
        normalizeI18nKey: normalizeI18nKey,
        decodeHtmlEntities: decodeHtmlEntities
    };
}
