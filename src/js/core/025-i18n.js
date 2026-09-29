// =============================================================
// i18n runtime core. DOM-free: bundled in the panel page AND the service
// worker (WORKER_SHARED_FILES). Gettext-style: the key IS the exact English
// UI text, so with no catalog every call is the English identity.
//
//   t(source, params)             translation, else the English source. {name}
//                                 placeholders are filled from params' OWN
//                                 props; missing/null/undefined stay verbatim.
//   tn(count, one, other, params) plural; the key is `other`. A catalog value is
//                                 a string or {zero,one,two,few,many,other}
//                                 (Intl.PluralRules of i18nLocale()). {count} =
//                                 i18nFormatNumber(count) unless params.count.
//                                 English fallback: Number(count) === 1 ? one : other.
//                                 A count that is not a finite number (null,
//                                 undefined, '', NaN, 'abc', booleans, Infinity)
//                                 always takes the `other` form and {count}
//                                 renders as '' (unless params.count is given).
//   N_(s)                         returns s: extraction marker for label maps whose
//                                 values are also sent to the model or compared;
//                                 translate at display time with t(value).
//   I18N_LANGUAGES                [{code, name, nativeName, dir}]: en + the 24.
//   i18nLang() / i18nLocale() / i18nDir()   code / BCP-47 tag / 'rtl' | 'ltr'
//   i18nFormatDate|Time|DateTime(value, opts), i18nFormatNumber(value, opts)
//                                 Intl with i18nLocale(); null/'' -> '', invalid ->
//                                 String(value), bad opts -> retried without.
//   i18nFormatRelative(date, {now, style, numeric})  style 'short' (default) |
//                                 'long' | 'narrow'; replaces hand-rolled "5m ago".
//   resolveI18nLanguage(pref, browserLangs)  pure -> a supported code, else 'en'.
//   i18nSetCatalog(code, obj)     inject a catalog (tests / injection); null
//                                 deletes; -> true when applied.
//   await i18nInit(opts)          setting 'uiLanguage' (default 'auto') -> resolve
//                                 -> fetch locales/<code>.json (never for en;
//                                 cached, deduped) -> activate. English on failure;
//                                 never throws; -> the active code. opts
//                                 {language, browserLanguages} override the
//                                 setting / navigator.languages. Only the LATEST
//                                 call activates; a superseded one returns the
//                                 code active when it settles. A failed catalog
//                                 load is retried on an explicit {language}
//                                 call, or after I18N_FAILED_TTL_MS otherwise.
//   i18nResponseLanguageInstruction()  '' for English, else the reply-language
//                                 line for the system prompt.
// Host globals (getSetting, navigator, chrome, fetch) are probed ONLY inside
// i18nInit: loading this file and calling t/tn/N_/formatters needs no stubs
// (test/harness.js auto-includes it in loadModules/runFile; opt out i18n:false).
// i18nLocale() is the code, except that a base-only code (en, fr, de...) takes
// the first browser tag of the same language (en-GB keeps UK date formats).
// =============================================================

var I18N_LANGUAGES = [
    { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
    { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
    { code: 'pt-BR', name: 'Brazilian Portuguese', nativeName: 'Português do Brasil', dir: 'ltr' },
    { code: 'zh-CN', name: 'Simplified Chinese', nativeName: '简体中文', dir: 'ltr' },
    { code: 'zh-TW', name: 'Traditional Chinese', nativeName: '繁體中文', dir: 'ltr' },
    { code: 'cs', name: 'Czech', nativeName: 'Čeština', dir: 'ltr' },
    { code: 'da', name: 'Danish', nativeName: 'Dansk', dir: 'ltr' },
    { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', dir: 'ltr' },
    { code: 'fi', name: 'Finnish', nativeName: 'Suomi', dir: 'ltr' },
    { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
    { code: 'fr-CA', name: 'Canadian French', nativeName: 'Français canadien', dir: 'ltr' },
    { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
    { code: 'he', name: 'Hebrew', nativeName: 'עברית', dir: 'rtl' },
    { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', dir: 'ltr' },
    { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
    { code: 'ja', name: 'Japanese', nativeName: '日本語', dir: 'ltr' },
    { code: 'ko', name: 'Korean', nativeName: '한국어', dir: 'ltr' },
    { code: 'nb', name: 'Norwegian Bokmål', nativeName: 'Norsk bokmål', dir: 'ltr' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', dir: 'ltr' },
    { code: 'pt-PT', name: 'European Portuguese', nativeName: 'Português europeu', dir: 'ltr' },
    { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr' },
    { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
    { code: 'sv', name: 'Swedish', nativeName: 'Svenska', dir: 'ltr' },
    { code: 'th', name: 'Thai', nativeName: 'ไทย', dir: 'ltr' },
    { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' }
];

// Lower-case tag -> supported code (after exact matching failed).
var I18N_LANGUAGE_ALIASES = {
    'pt': 'pt-BR', 'zh': 'zh-CN', 'zh-hans': 'zh-CN', 'zh-sg': 'zh-CN', 'zh-my': 'zh-CN',
    'zh-hant': 'zh-TW', 'zh-hk': 'zh-TW', 'zh-mo': 'zh-TW', 'no': 'nb', 'nn': 'nb', 'iw': 'he'
};

var I18N_RELATIVE_UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

var I18N_FAILED_TTL_MS = 60000;

var _i18nState = { lang: 'en', locale: 'en', seq: 0, catalogs: {}, failed: {}, pending: {}, plural: {}, numberFormats: {}, relativeFormats: {} };

// ─── helpers (no host globals) ───────────────────────────────────────────────
function _i18nOwn(obj, key) {
    return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

function _i18nIsStr(v) {
    try { return v === String(v); } catch (e) { return false; }
}

function _i18nIsObj(v) {
    return v !== null && v !== undefined && Object(v) === v;
}

function _i18nIsCatalog(v) {
    return Object.prototype.toString.call(v) === '[object Object]';
}

function _i18nStr(v) {
    if (v === null || v === undefined) return '';
    try { return String(v); } catch (e) { return ''; }
}

function _i18nBlank(v) {
    return v === null || v === undefined || (_i18nIsStr(v) && v.trim() === '');
}

function _i18nNum(v) {
    try { return Number(v); } catch (e) { return NaN; }
}

// tn() count: a finite number, else NaN (null/undefined/''/booleans are not counts).
function _i18nCount(v) {
    if (v === null || v === undefined || v === true || v === false || _i18nBlank(v)) return NaN;
    var n = _i18nNum(v);
    return isFinite(n) ? n : NaN;
}

// A usable catalog string ('' counts as missing), else null.
function _i18nForm(v) {
    return _i18nIsStr(v) && v !== '' ? v : null;
}

function _i18nInfo(code) {
    for (var i = 0; i < I18N_LANGUAGES.length; i++) {
        if (I18N_LANGUAGES[i].code === code) return I18N_LANGUAGES[i];
    }
    return null;
}

function _i18nNormTag(tag) {
    return _i18nStr(tag).trim().replace(/_/g, '-').toLowerCase();
}

function _i18nExact(lower) {
    for (var i = 0; i < I18N_LANGUAGES.length; i++) {
        if (I18N_LANGUAGES[i].code.toLowerCase() === lower) return I18N_LANGUAGES[i].code;
    }
    return null;
}

function _i18nAlias(lower) {
    return _i18nOwn(I18N_LANGUAGE_ALIASES, lower) ? I18N_LANGUAGE_ALIASES[lower] : null;
}

function _i18nMatch(tag) {
    var s = _i18nNormTag(tag);
    if (!s || s === 'auto') return null;
    var hit = _i18nExact(s) || _i18nAlias(s);
    if (hit) return hit;
    var parts = s.split('-');
    if (parts.length > 2) {
        var two = parts[0] + '-' + parts[1];
        hit = _i18nExact(two) || _i18nAlias(two);
        if (hit) return hit;
    }
    return parts.length > 1 ? (_i18nExact(parts[0]) || _i18nAlias(parts[0])) : null;
}

function _i18nList(langs) {
    if (langs === null || langs === undefined) return [];
    if (Array.isArray(langs)) return langs;
    if (_i18nIsStr(langs)) return [langs];
    try { return Array.prototype.slice.call(langs); } catch (e) { return []; }
}

// Pure: exact (case-insensitive, _ -> -), aliases (pt, zh*, no/nn), then the
// base language (fr-BE -> fr, pt-AO -> pt -> pt-BR); 'auto'/unknown pref -> the
// browser list (string or array) -> 'en'.
function resolveI18nLanguage(pref, browserLangs) {
    try {
        var hit = _i18nMatch(pref);
        if (hit) return hit;
        var list = _i18nList(browserLangs);
        for (var i = 0; i < list.length; i++) {
            hit = _i18nMatch(list[i]);
            if (hit) return hit;
        }
    } catch (e) {}
    return 'en';
}

function _i18nPickLocale(code, browserLangs) {
    try {
        if (code.indexOf('-') >= 0) return code;
        var list = _i18nList(browserLangs);
        for (var i = 0; i < list.length; i++) {
            var tag = _i18nStr(list[i]).trim().replace(/_/g, '-');
            if (tag.indexOf('-') < 0 || tag.split('-')[0].toLowerCase() !== code) continue;
            try {
                var canon = Intl.getCanonicalLocales(tag)[0];
                if (canon) return canon;
            } catch (e) {}
        }
    } catch (e) {}
    return code;
}

function i18nLang() {
    return _i18nState.lang || 'en';
}

function i18nLocale() {
    return _i18nState.locale || i18nLang();
}

function i18nDir() {
    var info = _i18nInfo(i18nLang());
    return info && info.dir === 'rtl' ? 'rtl' : 'ltr';
}

function _i18nCatalog() {
    var lang = i18nLang();
    return _i18nOwn(_i18nState.catalogs, lang) ? _i18nState.catalogs[lang] : null;
}

function _i18nFill(text, params) {
    if (!_i18nIsObj(params) || text.indexOf('{') < 0) return text;
    return text.replace(/\{([A-Za-z0-9_]+)\}/g, function(whole, name) {
        if (!_i18nOwn(params, name)) return whole;
        var v = params[name];
        return v === null || v === undefined ? whole : _i18nStr(v);
    });
}

function t(source, params) {
    var key = _i18nStr(source);
    try {
        var cat = _i18nCatalog(), out = null;
        if (_i18nOwn(cat, key)) {
            var v = cat[key];
            out = _i18nForm(v);
            if (out === null && _i18nIsCatalog(v) && _i18nOwn(v, 'other')) out = _i18nForm(v.other);
        }
        return _i18nFill(out === null ? key : out, params);
    } catch (e) {
        return key;
    }
}

function _i18nPluralCategory(n) {
    var loc = i18nLocale(), cache = _i18nState.plural;
    if (!_i18nOwn(cache, loc)) {
        try { cache[loc] = new Intl.PluralRules(loc); } catch (e) { cache[loc] = null; }
    }
    try {
        if (cache[loc]) return cache[loc].select(n);
    } catch (e) {}
    return n === 1 ? 'one' : 'other';
}

function _i18nCountParams(count, params) {
    var out = {};
    if (_i18nIsObj(params)) {
        for (var k in params) {
            if (_i18nOwn(params, k)) out[k] = params[k];
        }
    }
    if (out.count === null || out.count === undefined) out.count = isNaN(count) ? '' : i18nFormatNumber(count);
    return out;
}

function tn(count, one, other, params) {
    var key = _i18nStr(other), n = _i18nCount(count);
    var english = n === 1 ? _i18nStr(one) : key;
    try {
        var cat = _i18nCatalog(), out = null;
        if (_i18nOwn(cat, key)) {
            var v = cat[key];
            out = _i18nForm(v);
            if (out === null && _i18nIsCatalog(v)) {
                var c = isNaN(n) ? 'other' : _i18nPluralCategory(n);
                out = (_i18nOwn(v, c) ? _i18nForm(v[c]) : null) || (_i18nOwn(v, 'other') ? _i18nForm(v.other) : null);
            }
        }
        return _i18nFill(out === null ? english : out, _i18nCountParams(n, params));
    } catch (e) {
        return english;
    }
}

function N_(s) {
    return s;
}

// ─── formatting ──────────────────────────────────────────────────────────────
function _i18nToDate(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;
    if (_i18nIsStr(value) && /^-?\d{9,}$/.test(value.trim())) return new Date(Number(value));
    return new Date(value);
}

function _i18nDateCall(d, kind, loc, opts) {
    if (kind === 'date') return d.toLocaleDateString(loc, opts);
    if (kind === 'time') return d.toLocaleTimeString(loc, opts);
    return d.toLocaleString(loc, opts);
}

function _i18nFormatDateLike(value, opts, kind) {
    try {
        if (_i18nBlank(value)) return '';
        var d = null, ms = NaN;
        try { d = _i18nToDate(value); ms = d.getTime(); } catch (e) { ms = NaN; }
        if (isNaN(ms)) return _i18nStr(value);
        var loc = i18nLocale();
        if (opts) {
            try { return _i18nDateCall(d, kind, loc, opts); } catch (e) {}
        }
        try { return _i18nDateCall(d, kind, loc); } catch (e) {}
        try { return _i18nDateCall(d, kind); } catch (e) {}
    } catch (e) {}
    return _i18nStr(value);
}

function i18nFormatDate(value, opts) {
    return _i18nFormatDateLike(value, opts, 'date');
}

function i18nFormatTime(value, opts) {
    return _i18nFormatDateLike(value, opts, 'time');
}

function i18nFormatDateTime(value, opts) {
    return _i18nFormatDateLike(value, opts, 'datetime');
}

function _i18nNumberFormat(loc, opts) {
    if (opts) return new Intl.NumberFormat(loc, opts);
    var cache = _i18nState.numberFormats;
    if (!_i18nOwn(cache, loc)) cache[loc] = new Intl.NumberFormat(loc);
    return cache[loc];
}

function i18nFormatNumber(value, opts) {
    try {
        if (_i18nBlank(value)) return '';
        var n = _i18nNum(value);
        if (isNaN(n)) return _i18nStr(value);
        var loc = i18nLocale();
        if (opts) {
            try { return _i18nNumberFormat(loc, opts).format(n); } catch (e) {}
        }
        try { return _i18nNumberFormat(loc).format(n); } catch (e) {}
        return String(n);
    } catch (e) {
        return _i18nStr(value);
    }
}

function _i18nRelativeFormat(loc, style, numeric) {
    var key = loc + '|' + style + '|' + numeric, cache = _i18nState.relativeFormats;
    if (!_i18nOwn(cache, key)) {
        try { cache[key] = new Intl.RelativeTimeFormat(loc, { style: style, numeric: numeric }); } catch (e) { cache[key] = null; }
    }
    return cache[key];
}

function _i18nRelativeEnglish(value, unit) {
    if (value === 0) return 'now';
    var abs = Math.abs(value), text = abs + ' ' + unit + (abs === 1 ? '' : 's');
    return value < 0 ? text + ' ago' : 'in ' + text;
}

// Units truncate toward zero like the old hand-rolled text (59m59s -> 59 min.):
// < 60 s -> now, then minutes, hours, days (< 7), weeks, months (30 d), years.
function i18nFormatRelative(date, opts) {
    try {
        if (_i18nBlank(date)) return '';
        var o = _i18nIsObj(opts) ? opts : {}, ms = NaN, now = NaN;
        try { ms = _i18nToDate(date).getTime(); } catch (e) { ms = NaN; }
        if (isNaN(ms)) return _i18nStr(date);
        if (!_i18nBlank(o.now)) {
            try { now = _i18nToDate(o.now).getTime(); } catch (e) { now = NaN; }
        }
        if (isNaN(now)) now = Date.now();
        // -0 (not 0) for the past: numeric:'always' then reads "0 sec. ago", not "in 0 sec.".
        var diff = (ms - now) / 1000, abs = Math.abs(diff), value = diff < 0 ? -0 : 0, unit = 'second';
        for (var i = 0; i < I18N_RELATIVE_UNITS.length; i++) {
            if (abs >= I18N_RELATIVE_UNITS[i][1]) {
                unit = I18N_RELATIVE_UNITS[i][0];
                value = (diff < 0 ? -1 : 1) * Math.floor(abs / I18N_RELATIVE_UNITS[i][1]);
                break;
            }
        }
        var style = o.style === 'long' || o.style === 'narrow' ? o.style : 'short';
        var rtf = _i18nRelativeFormat(i18nLocale(), style, o.numeric === 'always' ? 'always' : 'auto');
        if (rtf) {
            try { return rtf.format(value, unit); } catch (e) {}
        }
        return _i18nRelativeEnglish(value, unit);
    } catch (e) {
        return _i18nStr(date);
    }
}

// ─── catalogs + init ─────────────────────────────────────────────────────────
function i18nSetCatalog(code, obj) {
    try {
        var c = _i18nExact(_i18nNormTag(code));
        if (!c) return false;
        if (obj === null || obj === undefined) delete _i18nState.catalogs[c];
        else if (_i18nIsCatalog(obj)) _i18nState.catalogs[c] = obj;
        else return false;
        delete _i18nState.failed[c];
        return true;
    } catch (e) {
        return false;
    }
}

// A failure is remembered for I18N_FAILED_TTL_MS (a stamp; legacy `true` never expires).
function _i18nFailedFresh(code) {
    if (!_i18nOwn(_i18nState.failed, code)) return false;
    var at = _i18nState.failed[code];
    if (at !== true && Date.now() - at >= I18N_FAILED_TTL_MS) { delete _i18nState.failed[code]; return false; }
    return true;
}

function _i18nNeedsFetch(code) {
    return code !== 'en' && !_i18nOwn(_i18nState.catalogs, code) && !_i18nOwn(_i18nState.pending, code) && !_i18nFailedFresh(code);
}

function _i18nEnsureCatalog(code, loader) {
    if (code === 'en' || _i18nOwn(_i18nState.catalogs, code)) return Promise.resolve(true);
    if (_i18nOwn(_i18nState.pending, code)) return _i18nState.pending[code];
    if (_i18nFailedFresh(code) || !loader) return Promise.resolve(false);
    var pending = Promise.resolve().then(function() {
        return loader(code);
    }).then(function(res) {
        if (!res || res.ok === false) throw new Error('i18n catalog unavailable: ' + code);
        return res.json();
    }).then(function(obj) {
        if (!_i18nIsCatalog(obj)) throw new Error('i18n catalog is not an object: ' + code);
        _i18nState.catalogs[code] = obj;
        return true;
    }).catch(function() {
        _i18nState.failed[code] = Date.now();
        return false;
    }).then(function(ok) {
        delete _i18nState.pending[code];
        return ok;
    });
    _i18nState.pending[code] = pending;
    return pending;
}

async function i18nInit(opts) {
    var seq = _i18nState.seq + 1, code = 'en', langs = null, ok = false;
    _i18nState.seq = seq;
    try {
        var o = _i18nIsObj(opts) ? opts : {}, pref = o.language;
        if ((pref === null || pref === undefined) && typeof getSetting === 'function') {
            try { pref = await getSetting('uiLanguage', 'auto'); } catch (e) { pref = 'auto'; }
        }
        langs = o.browserLanguages;
        if ((langs === null || langs === undefined) && typeof navigator !== 'undefined' && navigator) {
            try { langs = navigator.languages && navigator.languages.length ? navigator.languages : navigator.language; } catch (e) { langs = null; }
        }
        code = resolveI18nLanguage(pref, langs);
        if (o.language !== null && o.language !== undefined) delete _i18nState.failed[code]; // explicit switch retries a failed load
        var loader = null;
        if (_i18nNeedsFetch(code) && typeof fetch === 'function' && typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.getURL) {
            loader = function(c) { return fetch(chrome.runtime.getURL('locales/' + c + '.json')); };
        }
        ok = await _i18nEnsureCatalog(code, loader);
    } catch (e) {
        ok = false;
    }
    if (seq === _i18nState.seq) {
        _i18nState.lang = ok ? code : 'en';
        _i18nState.locale = _i18nPickLocale(_i18nState.lang, langs);
    }
    return i18nLang();
}

function i18nResponseLanguageInstruction() {
    try {
        var info = _i18nInfo(i18nLang());
        if (!info || info.code === 'en') return '';
        return "The user's interface language is " + info.name + ' (' + info.nativeName + '). Reply in ' + info.name +
            ' unless the user writes in another language or asks otherwise. Keep code, identifiers, table/field names, sys_ids and tool arguments unchanged.';
    } catch (e) {
        return '';
    }
}
