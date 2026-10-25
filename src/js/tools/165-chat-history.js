// =============================================================
// chat_history — SAFE, READ-ONLY access to past chat transcripts.
//
// Unlike runtime_inspect (dev-mode only, can drive the UI and read any
// IndexedDB store), this tool:
//   - is available outside dev mode,
//   - can ONLY open the stores in CH_ALLOWED_STORES ('chats' and the
//     payload blob store 'chat_payloads', so offloaded payload stubs can
//     be resolved) — never settings/widgets/workspaces/credentials,
//   - ONLY opens 'readonly' transactions (CH_TX_MODE) — it never writes,
//   - requires user approval by default: 'chat_history' is in
//     GLOBAL_WRITE_KEYS + GLOBAL_ASK_DEFAULT_KEYS (core/070-permissions.js),
//     so getGlobalDefaultPermission returns 'ask' and the standard gate in
//     _executeToolInner (requestProgrammaticToolApproval) prompts.
//
// Headless: this file is in WORKER_SHARED_FILES (build/build.js +
// skills/extension-dev/build.js) and only needs openDatabase()
// (core/130-indexeddb.js, also shared), so it runs in the SW.
// Helpers are COPIED (not shared) from tools/140-runtime-inspect.js, which
// is page-bundle only.
// =============================================================

var CH_ALLOWED_STORES = ['chats', 'chat_payloads'];
var CH_TX_MODE = 'readonly';
var CH_LIST_DEFAULT = 20, CH_LIST_MAX = 200;
var CH_SEARCH_DEFAULT = 20, CH_SEARCH_MAX = 100;
var CH_GET_DEFAULT_MSGS = 20, CH_GET_MAX_MSGS = 50;
var CH_SCAN_CAP = 1048576;      // ~1MB of string leaves scanned per record
var CH_MAX_PAYLOADS = 25;       // payload rows resolved per get/search
var CH_PAYLOAD_TEXT_CAP = 4096; // chars of a text payload inlined
// Global search budget (across ALL records): total string chars scanned and
// wall-clock ms, checked between strings/records. An object so tests can
// tune it (and the clock) by reference.
var CH_SEARCH_BUDGET = { chars: 8 * 1048576, ms: 2000, now: function() { return Date.now(); } };
// Per-exec regex input cap for search (ReDoS layer 2, see
// _chUnsafePattern): a user pattern is never run against more than
// CH_EXEC_CHUNK chars at once; consecutive chunks overlap by
// CH_EXEC_OVERLAP so matches up to that length are not lost at a boundary
// (a longer match straddling a boundary can be missed — documented trade-off).
// 1024 keeps the worst accepted pattern (one unbounded quantifier x path
// cost 8, e.g. `.*a?a?a?x`) at ~3ms per exec; the time budget is
// re-checked between chunks.
var CH_EXEC_CHUNK = 1024;
var CH_EXEC_OVERLAP = 256;

// ---- redaction ----
// Likely credentials are redacted from EVERY output string and from the
// text that search runs against (so whether a pattern matches never reveals
// a secret). Rules run in order; every rule is linear-time (bounded repeats,
// unambiguous alternatives) so a 1MB string is safe. Quotes may carry ANY
// JSON-escape level (`"`, `\"`, `\\\"` = 1x/2x/3x stringify): CH_BSQ is up to
// 32 backslashes. Keys that mark the value as a secret (header / JSON key /
// k=v / JS assignment):
var CH_SECRET_KEY_SRC = '(?:x-usertoken|(?:proxy-)?authorization|g_ck|pwd|id_token|[a-z0-9_-]{0,40}(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|private[_-]?key)[a-z0-9_-]{0,40})';
var CH_SECRET_KEY_EXACT_RE = new RegExp('^' + CH_SECRET_KEY_SRC + '$', 'i');
// header-style keys whose unquoted value is ALWAYS a credential
var CH_HEADER_KEY_RE = /^(?:x-usertoken|(?:proxy-)?authorization|g_ck)$/i;
var CH_COOKIE_NAME_SRC = '(?:JSESSIONID|glide_[A-Za-z0-9_]{1,60}|BIGipServer[A-Za-z0-9_.-]{0,60}|__Host-[A-Za-z0-9_-]{1,60}|__Secure-[A-Za-z0-9_-]{1,60}|[A-Za-z0-9_.-]{0,40}(?:sess|token|auth|sid|csrf|xsrf|g_ck)[A-Za-z0-9_.-]{0,40})';
var CH_COOKIE_NAME_EXACT_RE = new RegExp('^' + CH_COOKIE_NAME_SRC + '$', 'i');
// session cookies redacted as bare name=value (case-insensitive)
var CH_SESSION_COOKIE_SRC = '(?:[A-Za-z0-9_]{0,20}sessionid|csrftoken|PHPSESSID|connect\\.sid|glide_[A-Za-z0-9_]{1,60}|BIGipServer[A-Za-z0-9_.-]{0,60}|__Host-[A-Za-z0-9_-]{1,60}|__Secure-[A-Za-z0-9_-]{1,60})';
var CH_BSQ = '\\\\{0,32}';
// A quoted value: plain "..." (standard escapes), backslash-escaped quote at
// any level (an inner quote only closes it when followed by , } ] : ) \ or
// the end — so a deeper-escaped quote inside the value keeps it open), or
// '...'. Closing quote optional (= to end of string).
var CH_QVAL_SRC = '"(?:[^"\\\\]|\\\\[\\s\\S])*(?:"|$)' +
    '|\\\\{1,32}"(?:[^"\\\\]|\\\\(?!\\\\{0,32}")|\\\\+"(?!\\s{0,8}(?:[,}\\]:)\\\\]|$)))*(?:\\\\*"|$)' +
    "|'(?:[^'\\\\]|\\\\[\\s\\S])*(?:'|$)";
// key, optional same quote (any escape level) around it, ':' or '=', then a
// quoted value or an unquoted token (optionally prefixed by an auth scheme:
// `Basic xyz`). Unquoted values are only masked when _chUnquotedSecret says
// so (no `Password: please reset`, no `x = document.getElementById(..)`).
var CH_KEY_VALUE_RE = new RegExp('((?:' + CH_BSQ + '["\'])?)\\b(' + CH_SECRET_KEY_SRC + ')\\1(\\s*[:=]\\s*)(' + CH_QVAL_SRC + '|(?:(?:bearer|basic|token|digest)\\s+)?[^\\s,;}&"\'\\\\<>]+)', 'gi');
// Generic words that are only treated as secret keys when quoted (JSON) and
// followed by a quoted value — never in prose (`the key point`, `code: see`).
var CH_JSON_GENERIC_KEY_RE = new RegExp('(' + CH_BSQ + '["\'])(token|key|code|sig|signature|secret|apikey|otp|passcode|credentials?)\\1(\\s*:\\s*)(' + CH_QVAL_SRC + ')', 'gi');
function _chMaskValue(val) {
    var mq = /^\\*["']/.exec(val);
    return mq ? mq[0] + '[redacted]' + mq[0] : '[redacted]';
}
// Looks like a credential rather than a prose word: has a digit, a
// non-letter, an inner capital (camel/random case), or is very long.
function _chTokenLike(v) {
    return (v.length >= 4 && (/\d/.test(v) || /[^A-Za-z]/.test(v) || /[a-z][A-Z]/.test(v))) || v.length >= 24;
}
function _chUnquotedSecret(key, sep, val) {
    if (/^(?:bearer|basic|token|digest)\s/i.test(val)) return true;
    if (CH_HEADER_KEY_RE.test(key)) return true;
    if (val.charAt(0) === '=') return false; // comparison `==` / `===`
    if (sep.indexOf('=') !== -1) {
        // code, not a credential: a call (`getPw(`) or, in a spaced JS
        // assignment, member access / literal keyword (`= document.x`, `= null`)
        if (/^[A-Za-z_$][\w$]*\(/.test(val)) return false;
        if (/\s/.test(sep) && /^(?:[A-Za-z_$][\w$]*[.\[]|(?:null|undefined|true|false|this|new|function|await|typeof|void)$)/.test(val)) return false;
        return true;
    }
    return _chTokenLike(val); // `key: value` — only token-looking values
}
var CH_REDACT_RULES = [
    // PEM private-key blocks (body bounded; a truncated block is masked to the cap)
    [/(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----)(?:(?!-----END )[\s\S]){0,32768}(-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)?/g, function(m, b, e) { return b + '[redacted]' + (e || ''); }],
    [CH_KEY_VALUE_RE, function(m, q, key, sep, val) {
        if (!/^\\*["']/.test(val) && !_chUnquotedSecret(key, sep, val)) return m;
        return q + key + q + sep + _chMaskValue(val);
    }],
    [CH_JSON_GENERIC_KEY_RE, function(m, q, key, sep, val) { return q + key + q + sep + _chMaskValue(val); }],
    // URL query parameters carrying credentials (`?token=`, `&sig=`, `?code=`)
    [/((?:[?&]|&amp;)(?:token|key|code|sig|signature|secret|apikey|api_key|access_token|refresh_token|id_token|client_secret|password|auth|sessionid)=)([^&#\s"'<>\\]+)/gi, '$1[redacted]'],
    // Cookie / Set-Cookie header: the whole header value
    [/(\b(?:set-)?cookie(?:\\{0,32}["'])?\s*[:=]\s*(?:\\{0,32}["'])?)([^\r\n"'\\]+)/gi, '$1[redacted]'],
    // cookie objects (chrome.cookies / devtools JSON): name before value
    [new RegExp('(' + CH_BSQ + '"name' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '"' + CH_COOKIE_NAME_SRC + CH_BSQ + '"[^{}]{0,400}?' + CH_BSQ + '"value' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '")((?:[^"\\\\]|\\\\(?!\\\\{0,32}"))*)', 'gi'), '$1[redacted]'],
    [new RegExp('(' + CH_BSQ + '"domain' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '"[^"\\\\]{0,200}' + CH_BSQ + '"[^{}]{0,400}?' + CH_BSQ + '"value' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '")((?:[^"\\\\]|\\\\(?!\\\\{0,32}"))*)', 'gi'), '$1[redacted]'],
    // ... and value before name
    [new RegExp('(' + CH_BSQ + '"value' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '")((?:[^"\\\\]|\\\\(?!\\\\{0,32}"))*)(' + CH_BSQ + '"[^{}]{0,400}?' + CH_BSQ + '"name' + CH_BSQ + '"\\s*:\\s*' + CH_BSQ + '"' + CH_COOKIE_NAME_SRC + CH_BSQ + '")', 'gi'), '$1[redacted]$3'],
    // well-known session cookies as name=value (any case: jsessionid=, sessionid=, csrftoken=)
    [new RegExp('\\b(' + CH_SESSION_COOKIE_SRC + ')=([^;\\s,"\'\\\\&]+)', 'gi'), '$1=[redacted]'],
    // bare auth schemes, any case. Bearer needs a token-looking value (not
    // `bearer of bad news`); Basic only when the token looks encoded.
    [/\b(bearer)\s+([A-Za-z0-9._~+\/=-]+)/gi, function(m, b, t) { return (_chTokenLike(t) || (b === 'Bearer' && t.length >= 8)) ? b + ' [redacted]' : m; }],
    [/\bBasic\s+(?=[A-Za-z0-9+\/]{0,200}(?:[0-9+\/=]|[a-z][A-Za-z0-9+\/]{0,200}[A-Z]))[A-Za-z0-9+\/]{8,}={0,2}/g, 'Basic [redacted]'],
    // JWTs
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
    // GitHub tokens (classic + fine-grained)
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
    // Stripe secret / restricted keys, Slack tokens, Google API keys
    [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted]'],
    [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
    [/\bAIza[0-9A-Za-z_-]{35}/g, '[redacted]'],
    // OpenAI/Anthropic-style keys: not inside a word, >=12 chars, has a digit
    [/(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{12,}/g, '[redacted]'],
    // AWS access key ids and 40-char secret keys (mixed case + digit, so
    // lowercase-hex git SHAs are not hit). With a '/' inside, only after a
    // `secret` context word (a 40-char path is not a key).
    [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, '[redacted]'],
    [/\b([A-Za-z_-]{0,20}(?:secret|Secret|SECRET)[A-Za-z_-]{0,20})([\s:="']{1,6})(?=[A-Za-z0-9\/+]{0,39}[a-z])(?=[A-Za-z0-9\/+]{0,39}[A-Z])(?=[A-Za-z0-9\/+]{0,39}[0-9])[A-Za-z0-9\/+]{40}(?![A-Za-z0-9\/+=])/g, '$1$2[redacted]'],
    [/(?<![A-Za-z0-9\/+=])(?=[A-Za-z0-9+]{0,39}[a-z])(?=[A-Za-z0-9+]{0,39}[A-Z])(?=[A-Za-z0-9+]{0,39}[0-9])[A-Za-z0-9+]{40}(?![A-Za-z0-9\/+=])/g, '[redacted]']
];
// Embedded binary (data URLs / long base64 runs inside JSON-stringified
// payload text) is replaced, never inlined or searched.
var CH_EMBEDDED_B64_RE = /data:[A-Za-z0-9.+-]{1,40}\/[A-Za-z0-9.+-]{1,80}(?:;[A-Za-z0-9.=_-]{1,60}){0,4};base64,[A-Za-z0-9+\/=]*|(?<![A-Za-z0-9+\/])[A-Za-z0-9+\/]{1024,}={0,2}/g;
function _chStripBinary(s) {
    return s.replace(CH_EMBEDDED_B64_RE, function(m) { return '[binary ' + m.length + ' chars omitted]'; });
}
function _chApplyRules(r) {
    for (var i = 0; i < CH_REDACT_RULES.length; i++) {
        CH_REDACT_RULES[i][0].lastIndex = 0;
        r = r.replace(CH_REDACT_RULES[i][0], CH_REDACT_RULES[i][1]);
    }
    return r;
}
// \uXXXX escapes (any backslash level) of printable ASCII other than quotes
// and backslash, decoded so `\u0070assword` / `ghp_\u0041..` are seen.
function _chDecodeUnicode(s) {
    return s.replace(/\\{1,32}u([0-9a-fA-F]{4})/g, function(m, hex) {
        var c = parseInt(hex, 16);
        return (c > 0x20 && c < 0x7f && c !== 0x22 && c !== 0x27 && c !== 0x5c) ? String.fromCharCode(c) : m;
    });
}
// Strip embedded binary, then redact credentials. Always applied to the
// WHOLE string before any slicing (excerpt windows, caps). When the text has
// \uXXXX escapes, the DECODED form is redacted too; if that reveals a secret
// the decoded+redacted form is returned (otherwise the original text is kept).
function _chRedact(s) {
    if (typeof s !== 'string') return s;
    var r = _chApplyRules(_chStripBinary(s));
    if (/\\u[0-9a-fA-F]{4}/.test(r)) {
        var d = _chDecodeUnicode(r);
        if (d !== r) { var rd = _chApplyRules(d); if (rd !== d) return rd; }
    }
    return r;
}

// ---- safe serialization (circular refs, depth, size caps) ----
function _chSafeSerialize(value) {
    var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    var MAX_DEPTH = 8, STR_CAP = 4096, KEY_CAP = 100, TOTAL_CAP = 65536;
    function walk(v, d) {
        if (v === null || v === undefined) return v;
        var t = typeof v;
        if (t === 'string') {
            if (_chLooksBinary(v)) return '[binary ' + v.length + ' chars omitted]';
            var r = _chRedact(v);
            return r.length > STR_CAP ? r.slice(0, STR_CAP) + '…[+' + (r.length - STR_CAP) + ' chars]' : r;
        }
        if (t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[Function]';
        if (t !== 'object') { try { return String(v); } catch (e) { return '[unstringifiable ' + t + ']'; } }
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
            var keys;
            try { keys = Object.keys(v); } catch (e2) { return '[opaque object]'; }
            var out = {};
            for (var k = 0; k < keys.length && k < KEY_CAP; k++) {
                try { out[keys[k]] = walk(v[keys[k]], d + 1); } catch (e4) { out[keys[k]] = '[unreadable]'; }
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
            return { success: true, _truncated: true, _totalChars: json.length, hint: 'Output capped at 64KB — narrow with path or a smaller from/to range.', preview: json.slice(0, TOTAL_CAP) };
        }
    } catch (e) { return '[unserializable result]'; }
    return result;
}

// ---- dot/bracket path parser over PLAIN objects (never window) ----
function _chParsePath(path) {
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

function _chWalkTokens(obj, tokens) {
    var cur = obj;
    for (var i = 0; i < tokens.length; i++) {
        if (cur === null || cur === undefined) return { exists: false, value: undefined };
        cur = cur[tokens[i]];
    }
    return { exists: cur !== undefined, value: cur };
}

// ---- IndexedDB access: allowlisted stores, readonly only ----
async function _chOpenStore(storeName) {
    if (CH_ALLOWED_STORES.indexOf(storeName) === -1) {
        throw new Error("chat_history may only read the stores " + CH_ALLOWED_STORES.join(', ') + " (requested '" + storeName + "')");
    }
    if (typeof openDatabase !== 'function') throw new Error('openDatabase() is not available in this context');
    var dbh = await openDatabase();
    if (Array.prototype.indexOf.call(dbh.objectStoreNames, storeName) === -1) {
        throw new Error("IndexedDB store '" + storeName + "' does not exist");
    }
    var tx = dbh.transaction([storeName], CH_TX_MODE);
    return tx.objectStore(storeName);
}

function _chReq(rq, what) {
    return new Promise(function(resolve, reject) {
        rq.onsuccess = function() { resolve(rq.result); };
        rq.onerror = function() { reject(rq.error || new Error('IDB ' + what + ' failed')); };
    });
}

async function _chGetChat(chatId) {
    var store = await _chOpenStore('chats');
    return await _chReq(store.get(chatId), 'get');
}

// Iterate every chats record via a cursor. onRecord runs SYNCHRONOUSLY
// inside onsuccess (an IDB transaction dies on await mid-iteration);
// return false from onRecord to stop early.
async function _chEachChat(onRecord) {
    var store = await _chOpenStore('chats');
    await new Promise(function(resolve, reject) {
        var rq = store.openCursor();
        rq.onsuccess = function() {
            var cursor = rq.result;
            if (!cursor) { resolve(); return; }
            var cont;
            try { cont = onRecord(cursor.primaryKey, cursor.value); } catch (e) { reject(e); return; }
            if (cont === false) { resolve(); return; }
            cursor.continue();
        };
        rq.onerror = function() { reject(rq.error || new Error('IDB openCursor failed')); };
    });
}

// Fetch payload rows {id, base64, at} by id from chat_payloads (readonly).
async function _chGetPayloads(ids) {
    var out = {};
    if (!ids.length) return out;
    var store = await _chOpenStore('chat_payloads');
    await Promise.all(ids.map(function(id) {
        return _chReq(store.get(id), 'get').then(function(row) { out[id] = row; }, function() { out[id] = undefined; });
    }));
    return out;
}

function _chChatTs(rec) { return (rec && (rec.updatedAt || rec.createdAt)) || 0; }
function _chTsNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
    return 0;
}
function _chIso(v) { var n = _chTsNum(v); return n ? new Date(n).toISOString() : null; }

function _chParseTime(v, name) {
    if (v === undefined || v === null || v === '') return { ok: true, value: null };
    if (typeof v === 'number' && isFinite(v)) return { ok: true, value: v };
    if (typeof v === 'string') {
        var t = Date.parse(v);
        if (!isNaN(t)) return { ok: true, value: t };
    }
    return { ok: false, error: "Invalid '" + name + "': expected an ISO date string or epoch milliseconds" };
}

function _chLimit(v, def, max) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return def;
    return Math.min(Math.floor(v), max);
}

function _chMeta(key, rec) {
    var msgs = rec && Array.isArray(rec.messages) ? rec.messages.length : (rec && typeof rec._msgCount === 'number' ? rec._msgCount : 0);
    return {
        id: (rec && rec.id) || key,
        title: (rec && rec.title) || '',
        createdAt: _chIso(rec && rec.createdAt),
        updatedAt: _chIso(rec && (rec.updatedAt || rec.createdAt)),
        message_count: msgs,
        is_sub_agent: !!(rec && rec.isSubAgent),
        parent_chat_id: (rec && rec.parentChatId) || null
    };
}

// Payload text heuristics: base64/data-URL blobs are never inlined.
function _chLooksBinary(s) {
    if (typeof s !== 'string') return true;
    // a data URL, also when JSON-stringified (leading quote)
    if (/^\s*"?data:[^,]*;base64,/.test(s)) return true;
    if (s.length <= 256) return false;
    var head = s.slice(0, 2048);
    if (!/^[A-Za-z0-9+/=\s]+$/.test(head)) return false;
    // Raw base64 is one long run or wrapped lines (no spaces); prose made
    // only of letters has a space every few chars, so it is NOT binary.
    var spaces = head.length - head.replace(/ /g, '').length;
    if (spaces > head.length / 100) return false;
    return /[A-Za-z0-9+/=]{64,}/.test(head);
}

// Collect offloaded-payload stubs inside a (sub)tree: message/screenshot
// entries flagged _b64Evicted (id = file_id || screenshot_id || key) and
// cachedToolResults entries flagged _fcEvicted (id = their key).
function _chCollectStubs(v, key, depth, acc) {
    if (!v || typeof v !== 'object' || depth > 4 || acc.length >= CH_MAX_PAYLOADS) return;
    if (!Array.isArray(v)) {
        if (v._b64Evicted) { var id = v.file_id || v.screenshot_id || (typeof key === 'string' ? key : null); if (id) acc.push({ node: v, id: id, kind: 'binary' }); }
        else if (v._fcEvicted && typeof key === 'string') acc.push({ node: v, id: key, kind: 'text' });
    }
    var keys = Array.isArray(v) ? null : Object.keys(v);
    var n = Array.isArray(v) ? v.length : keys.length;
    for (var i = 0; i < n && acc.length < CH_MAX_PAYLOADS; i++) {
        var k = keys ? keys[i] : i;
        var c = v[k];
        if (c && typeof c === 'object') _chCollectStubs(c, k, depth + 1, acc);
    }
}

// Annotate stubs IN PLACE (records are fresh structured clones) with
// `_payload: {id, present, chars, text?}`; binary payloads are never inlined.
async function _chResolveStubs(root) {
    var stubs = [];
    _chCollectStubs(root, null, 0, stubs);
    if (!stubs.length) return 0;
    var rows = await _chGetPayloads(stubs.map(function(s) { return s.id; }).filter(function(id, i, a) { return a.indexOf(id) === i; }));
    stubs.forEach(function(s) {
        var row = rows[s.id];
        var data = row ? (row.base64 !== undefined ? row.base64 : row.data) : undefined;
        var info = { id: s.id, present: !!row, chars: typeof data === 'string' ? data.length : 0 };
        if (typeof data === 'string' && !_chLooksBinary(data)) {
            // clean (strip embedded data URLs + redact) BEFORE capping so a
            // token cut at the cap boundary cannot escape redaction
            var clean = _chRedact(data);
            info.text = clean.length > CH_PAYLOAD_TEXT_CAP ? clean.slice(0, CH_PAYLOAD_TEXT_CAP) + '…[+' + (clean.length - CH_PAYLOAD_TEXT_CAP) + ' chars]' : clean;
        } else if (row) {
            info.note = 'binary payload (image/file) — not inlined';
        }
        s.node._payload = info;
    });
    return stubs.length;
}

// ---- search helpers ----
// ReDoS guard. A RegExp#exec cannot be interrupted, and chat_history runs in
// the MV3 SERVICE WORKER (WORKER_SHARED_FILES): a SW cannot create a
// dedicated Worker, and search runs synchronously inside IDB cursor
// callbacks, so a killable-on-timeout matcher is not available. Heuristic
// blacklists were bypassable ((a|\x61)+b, (a{1,10}){1,10}b, .*.*.*x,
// backrefs), so user patterns are restricted to a strict SAFE SUBSET whose
// backtracking is bounded by construction (_chUnsafePattern returns why a
// pattern is outside it):
//  - no quantifier (*, +, ?, {n,m}) applied to a group,
//  - no backreferences (\1, \k<n>), no lookarounds / inline modifiers,
//  - at most ONE unbounded quantifier (*, +, {n,}); bounds <= 100,
//  - path cost (product of alternation branches and bounded-quantifier
//    spans) <= 1024, or <= 8 when the pattern has an unbounded quantifier,
//  - pattern <= 256 chars, flags only from 'imsud'.
// Worst case is then O(chunk^2 x 8) per exec, and layer 2 runs every exec
// on <= CH_EXEC_CHUNK chars (~3ms), checking the time budget between chunks.
var CH_PATTERN_MAX_LEN = 256, CH_PATTERN_MAX_BOUND = 100;
var CH_PATTERN_COST = { bounded: 1024, withUnbounded: 8 };
function _chEscapeLen(src, i) { // length of the escape starting at src[i] === '\\'
    var n = src.charAt(i + 1), m;
    if (n === 'x') return 4;
    if (n === 'u') { m = /^\{[0-9a-fA-F]{1,6}\}/.exec(src.slice(i + 2, i + 12)); return m ? 2 + m[0].length : 6; }
    if (n === 'c') return 3;
    if (n === 'p' || n === 'P') { m = /^\{[^}]{0,60}\}/.exec(src.slice(i + 2, i + 66)); return m ? 2 + m[0].length : 2; }
    return 2;
}
function _chUnsafePattern(src, flags) {
    if (typeof src !== 'string') return 'pattern must be a string';
    if (src.length > CH_PATTERN_MAX_LEN) return 'pattern is longer than ' + CH_PATTERN_MAX_LEN + ' chars';
    if (flags && !/^[imsud]*$/.test(flags)) return "unsupported flags '" + flags + "' (allowed: i, m, s, u, d)";
    var unbounded = 0, cost = 1, prev = null, alts = [1];
    for (var i = 0; i < src.length; i++) {
        var c = src.charAt(i);
        if (c === '\\') {
            var n = src.charAt(i + 1);
            if (/[1-9]/.test(n)) return 'backreference \\' + n + ' at offset ' + i + ' is not supported';
            if (n === 'k' && src.charAt(i + 2) === '<') return 'named backreference \\k<..> at offset ' + i + ' is not supported';
            i += _chEscapeLen(src, i) - 1; prev = 'atom'; continue;
        }
        if (c === '[') {
            var j = i + 1;
            if (src.charAt(j) === '^') j++;
            for (; j < src.length && src.charAt(j) !== ']'; j++) { if (src.charAt(j) === '\\') j++; }
            i = j; prev = 'atom'; continue;
        }
        if (c === '(') {
            if (src.charAt(i + 1) === '?') {
                var c2 = src.charAt(i + 2), c3 = src.charAt(i + 3);
                if (c2 === ':') i += 2;
                else if (c2 === '<' && c3 !== '=' && c3 !== '!') { var gt = src.indexOf('>', i); i = gt < 0 ? src.length : gt; }
                else return 'lookaround / inline modifier group at offset ' + i + ' is not supported';
            }
            alts.push(1); prev = null; continue;
        }
        if (c === ')') { if (alts.length > 1) cost *= alts.pop(); prev = 'group'; continue; }
        if (c === '|') { alts[alts.length - 1]++; prev = null; continue; }
        var lo = -1, hi = -1, qlen = 1;
        if (c === '*') { lo = 0; hi = Infinity; }
        else if (c === '+') { lo = 1; hi = Infinity; }
        else if (c === '?') { lo = 0; hi = 1; }
        else if (c === '{') {
            var mm = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
            if (mm) { lo = +mm[1]; hi = mm[2] ? (mm[3] === '' ? Infinity : +mm[3]) : lo; qlen = mm[0].length; }
        }
        if (lo < 0) { prev = (c === '^' || c === '$') ? 'assert' : 'atom'; continue; }
        if (prev === 'group') return 'quantifier at offset ' + i + ' is applied to a group';
        if (lo > CH_PATTERN_MAX_BOUND || (hi !== Infinity && hi > CH_PATTERN_MAX_BOUND)) return 'repetition bound at offset ' + i + ' is above ' + CH_PATTERN_MAX_BOUND;
        if (hi === Infinity) { if (++unbounded > 1) return 'more than one unbounded quantifier (*, +, {n,}); second at offset ' + i; }
        else cost *= (hi - lo + 1);
        i += qlen - 1;
        if (src.charAt(i + 1) === '?') i++; // lazy
        prev = 'quant';
    }
    cost *= alts[0];
    var limit = unbounded ? CH_PATTERN_COST.withUnbounded : CH_PATTERN_COST.bounded;
    if (cost > limit) return 'too many alternative paths (cost ' + cost + ' > ' + limit + (unbounded ? ' with an unbounded quantifier' : '') + ')';
    return null;
}

// Searchable text of a JSON string (payload rows are JSON-stringified, often
// twice): parse it (and nested JSON strings, bounded depth) and emit one
// `key: value` line per leaf, so quotes/newlines appear unescaped. Leaves are
// re-redacted, and values under secret keys / of cookie objects are masked
// structurally. Returns null when the text is not JSON.
function _chJsonText(s) {
    function parse(str) {
        var t = str.replace(/^\s+/, ''), c = t.charAt(0);
        if (c !== '{' && c !== '[' && c !== '"') return undefined;
        try { return JSON.parse(t); } catch (e) { return undefined; }
    }
    var top = parse(s);
    if (top === undefined) return null;
    var parts = [], len = 0;
    function push(str) { if (len < CH_SCAN_CAP) { parts.push(str); len += str.length + 1; } }
    function walk(x, key, d, masked) {
        if (len >= CH_SCAN_CAP || d > 12) return;
        var label = key === null ? '' : key + ': ';
        if (x === null || x === undefined) { push(label + String(x)); return; }
        if (typeof x !== 'object') {
            if (masked) { push(label + '[redacted]'); return; }
            if (typeof x !== 'string') { push(label + String(x)); return; }
            if (_chLooksBinary(x)) { push(label + '[binary ' + x.length + ' chars omitted]'); return; }
            var inner = d < 6 ? parse(x) : undefined;
            if (inner !== undefined && (typeof inner === 'string' || (inner && typeof inner === 'object'))) { walk(inner, key, d + 1, false); return; }
            push(label + _chRedact(x));
            return;
        }
        if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i], key, d + 1, masked); return; }
        var cookie = typeof x.name === 'string' && 'value' in x && (CH_COOKIE_NAME_EXACT_RE.test(x.name) || 'domain' in x);
        var keys = Object.keys(x);
        for (var k = 0; k < keys.length; k++) {
            var kk = keys[k];
            walk(x[kk], kk, d + 1, masked || CH_SECRET_KEY_EXACT_RE.test(kk) || (cookie && kk === 'value'));
        }
    }
    walk(top, null, 0, false);
    return parts.join('\n');
}

// ---- actions ----
async function _chList(args) {
    var since = _chParseTime(args.since, 'since'); if (!since.ok) return { success: false, error: since.error };
    var until = _chParseTime(args.until, 'until'); if (!until.ok) return { success: false, error: until.error };
    var limit = _chLimit(args.limit, CH_LIST_DEFAULT, CH_LIST_MAX);
    var rows = [];
    await _chEachChat(function(key, rec) {
        var ts = _chTsNum(_chChatTs(rec));
        if (since.value !== null && ts < since.value) return;
        if (until.value !== null && ts > until.value) return;
        rows.push({ ts: ts, meta: _chMeta(key, rec) });
    });
    rows.sort(function(a, b) { return b.ts - a.ts; });
    return _chSafeSerialize({
        success: true,
        total: rows.length,
        returned: Math.min(limit, rows.length),
        chats: rows.slice(0, limit).map(function(r) { return r.meta; })
    });
}

async function _chSearch(args) {
    if (!args.pattern || typeof args.pattern !== 'string') return { success: false, error: "action 'search' requires a 'pattern' string" };
    var flags = (typeof args.flags === 'string') ? args.flags.replace(/[gy]/g, '') : 'i';
    var regex;
    try { regex = new RegExp(args.pattern, flags); } catch (eRe) {
        return { success: false, error: 'Invalid regex: ' + String((eRe && eRe.message) || eRe) };
    }
    var unsafe = _chUnsafePattern(args.pattern, flags);
    if (unsafe) return { success: false, error: 'Unsafe regex (outside the safe subset): ' + unsafe + '. Use a simpler pattern: a literal or escaped substring (`token expired`, `\\(x\\)`), character classes with at most one * or + (`[\\w.-]+@example\\.com`, `error.*timeout`), alternation without repeating the group (`(?:GET|POST) /api`), bounds <= 100 (`\\d{1,3}`); no backreferences or lookarounds.' };
    var subTokens = null;
    if (args.path) {
        try { subTokens = _chParsePath(args.path); } catch (ePa) {
            return { success: false, error: 'Invalid path: ' + String((ePa && ePa.message) || ePa) };
        }
    }
    var since = _chParseTime(args.since, 'since'); if (!since.ok) return { success: false, error: since.error };
    var maxMatches = _chLimit(args.limit, CH_SEARCH_DEFAULT, CH_SEARCH_MAX);
    var matches = [], truncated = false, truncatedReason = null, scannedChats = 0, cappedChats = 0;
    var totalScanned = 0, startedAt = CH_SEARCH_BUDGET.now();
    function stop(reason) { truncated = true; if (!truncatedReason) truncatedReason = reason; }
    // Global budget check: true when exhausted (sets truncated + reason).
    function overBudget() {
        if (truncatedReason === 'char_budget' || truncatedReason === 'time_budget') return true;
        if (totalScanned >= CH_SEARCH_BUDGET.chars) { stop('char_budget'); return true; }
        if (CH_SEARCH_BUDGET.now() - startedAt >= CH_SEARCH_BUDGET.ms) { stop('time_budget'); return true; }
        return false;
    }

    // s is ALREADY redacted (see findIn), so the ±60-char window can never
    // expose part of a secret whose prefix fell outside it.
    function excerpt(s, m) {
        var from = Math.max(0, m.index - 60);
        var to = Math.min(s.length, m.index + m.len + 60);
        return (from > 0 ? '…' : '') + s.slice(from, to) + (to < s.length ? '…' : '');
    }
    // exec in CH_EXEC_CHUNK windows (overlapping), checking the time budget
    // between windows. Returns {index, len} or null.
    function execText(text) {
        var step = CH_EXEC_CHUNK - CH_EXEC_OVERLAP;
        for (var off = 0; ; off += step) {
            if (off > 0 && overBudget()) return null;
            var chunk = (off === 0 && text.length <= CH_EXEC_CHUNK) ? text : text.slice(off, off + CH_EXEC_CHUNK);
            regex.lastIndex = 0;
            var m = regex.exec(chunk);
            if (m) return { index: off + m.index, len: m[0].length };
            if (off + CH_EXEC_CHUNK >= text.length) return null;
        }
    }
    // Match against the REDACTED text (so a match never depends on a secret),
    // then against the JSON-decoded form when the string is JSON.
    // `sliced`: raw was cut at a budget boundary — drop the trailing partial
    // token so a cut secret cannot slip past redaction.
    function findIn(raw, sliced) {
        var text = _chRedact(raw);
        if (sliced) text = text.replace(/\S+$/, '');
        var m = execText(text);
        if (m) return { text: text, m: m };
        var flat = _chJsonText(text);
        if (flat && flat !== text) {
            var m2 = execText(flat);
            if (m2) return { text: flat, m: m2, decoded: true };
        }
        return null;
    }
    function addMatch(cid, title, p, hit) {
        var row = { chat_id: cid, title: title, path: p, excerpt: excerpt(hit.text, hit.m) };
        if (hit.decoded) row.json_decoded = true;
        matches.push(row);
    }
    function scanRecord(key, rec) {
        scannedChats++;
        var root = rec, prefix = '';
        if (subTokens) {
            var d = _chWalkTokens(rec, subTokens);
            if (!d.exists) return;
            root = d.value; prefix = args.path;
        }
        var scanned = 0, capHit = false;
        var seen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
        var cid = (rec && rec.id) || key, title = (rec && rec.title) || '';
        function walk(v, p) {
            if (matches.length >= maxMatches) { stop('match_limit'); return; }
            if (scanned >= CH_SCAN_CAP) { capHit = true; return; }
            if (typeof v === 'string') {
                if (_chLooksBinary(v)) return; // base64/data-URL blobs are never scanned
                if (overBudget()) return;
                var budget = Math.min(CH_SCAN_CAP - scanned, CH_SEARCH_BUDGET.chars - totalScanned), s = v, cut = false;
                if (s.length > budget) { s = s.slice(0, budget); capHit = true; cut = true; }
                scanned += s.length; totalScanned += s.length;
                var hit = findIn(s, cut);
                if (hit) addMatch(cid, title, p, hit);
                return;
            }
            if (v === null || typeof v !== 'object') return;
            if (seen) { if (seen.has(v)) return; seen.add(v); }
            if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], p + '[' + i + ']'); return; }
            var keys;
            try { keys = Object.keys(v); } catch (eK) { return; }
            for (var k = 0; k < keys.length; k++) {
                var kk = keys[k];
                var seg = /^[A-Za-z_$][\w$]*$/.test(kk) ? (p ? p + '.' + kk : kk) : p + "['" + String(kk).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
                walk(v[kk], seg);
            }
        }
        walk(root, prefix);
        if (capHit) cappedChats++;
    }

    if (args.chat_id) {
        var rec = await _chGetChat(args.chat_id);
        if (rec === undefined) return { success: false, error: "No chat with id '" + args.chat_id + "'" };
        scanRecord(args.chat_id, rec);
        // Cheap payload pass (single chat only): scan offloaded TEXT payloads
        // (cached tool results); binary payloads are skipped.
        if (!subTokens && matches.length < maxMatches) {
            var stubs = [];
            _chCollectStubs(rec.cachedToolResults || {}, null, 0, stubs);
            var textStubs = stubs.filter(function(s) { return s.kind === 'text'; });
            if (textStubs.length) {
                var rows = await _chGetPayloads(textStubs.map(function(s) { return s.id; }));
                textStubs.forEach(function(s) {
                    if (matches.length >= maxMatches) { stop('match_limit'); return; }
                    if (overBudget()) return;
                    var row = rows[s.id], data = row ? (row.base64 !== undefined ? row.base64 : row.data) : undefined;
                    if (typeof data !== 'string' || _chLooksBinary(data)) return;
                    var cap = Math.min(CH_SCAN_CAP, CH_SEARCH_BUDGET.chars - totalScanned);
                    var str = data.length > cap ? data.slice(0, cap) : data;
                    totalScanned += str.length;
                    var hit = findIn(str, str.length < data.length);
                    if (hit) addMatch(rec.id || args.chat_id, rec.title || '', "cachedToolResults['" + s.id + "'].fullContent", hit);
                });
            }
        }
    } else {
        await _chEachChat(function(key, rec) {
            if (matches.length >= maxMatches) { stop('match_limit'); return false; }
            if (overBudget()) return false;
            if (since.value !== null && _chTsNum(_chChatTs(rec)) < since.value) return;
            scanRecord(key, rec);
        });
    }
    var out = { success: true, pattern: args.pattern, flags: flags, matches: matches, truncated: truncated, chats_scanned: scannedChats, chats_scan_capped: cappedChats, chars_scanned: totalScanned };
    if (truncated) out.truncated_reason = truncatedReason || 'match_limit';
    return _chSafeSerialize(out);
}

async function _chGet(args) {
    if (!args.chat_id || typeof args.chat_id !== 'string') return { success: false, error: "action 'get' requires 'chat_id'" };
    var rec = await _chGetChat(args.chat_id);
    if (rec === undefined) return { success: false, error: "No chat with id '" + args.chat_id + "'" };
    var meta = _chMeta(args.chat_id, rec);
    if (args.path) {
        var tokens;
        try { tokens = _chParsePath(args.path); } catch (eP) {
            return { success: false, error: 'Invalid path: ' + String((eP && eP.message) || eP) };
        }
        var walked = _chWalkTokens(rec, tokens);
        if (walked.exists && walked.value && typeof walked.value === 'object') await _chResolveStubs(walked.value);
        return _chSafeSerialize({ success: true, chat: meta, path: args.path, exists: walked.exists, value: walked.value });
    }
    var msgs = Array.isArray(rec.messages) ? rec.messages : [];
    var from = (typeof args.from === 'number' && isFinite(args.from)) ? Math.floor(args.from) : 0;
    if (from < 0) from = Math.max(0, msgs.length + from); // negative = from the end
    from = Math.min(from, msgs.length);
    var to = (typeof args.to === 'number' && isFinite(args.to)) ? Math.floor(args.to) : from + CH_GET_DEFAULT_MSGS;
    if (to < from) return { success: false, error: "'to' must be >= 'from'" };
    var capped = false;
    if (to - from > CH_GET_MAX_MSGS) { to = from + CH_GET_MAX_MSGS; capped = true; }
    to = Math.min(to, msgs.length);
    var slice = msgs.slice(from, to);
    var resolved = await _chResolveStubs(slice);
    return _chSafeSerialize({
        success: true,
        chat: meta,
        from: from,
        to: to,
        range_capped: capped,
        has_more: to < msgs.length,
        payloads_resolved: resolved,
        messages: slice
    });
}

async function executeChatHistory(args) {
    args = args || {};
    var action = args.action || 'list';
    try {
        if (action === 'list') return await _chList(args);
        if (action === 'search') return await _chSearch(args);
        if (action === 'get') return await _chGet(args);
        return { success: false, error: "Unknown action '" + action + "' (use 'list', 'search' or 'get')" };
    } catch (e) {
        return { success: false, error: 'chat_history ' + action + ' failed: ' + String((e && e.message) || e) };
    }
}
