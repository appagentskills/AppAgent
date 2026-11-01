// ============================================
// ITEM 10: COMPOSER PICKER ('/' active skills, '@' references)
// ============================================
// Typing '/' or '@' (or full-width '／' / '＠') at the start of a word in
// either composer (chat + Home, COMPOSERS in ui/246) opens a listbox above
// the box:
//   '/'  active skills only (global `activeSkills`, core/030; names and
//        descriptions from `skills`)                     -> '/<skill-id> '
//   '@'  ONE ranked search over every reference source; the user types free
//        words, never a source prefix:
//        - attachments of the current chat (messages with a file_id whose
//          description starts 'User attached', app/030; matched on the
//          name)                                         -> '@<file_id> '
//        - Smart Documents (`smartDocuments`, tools/110; shared docs plus
//          the current chat's private ones; title + id) -> '@<doc_id> '
//        - Agent Files (virtual folder, lfListDir; file name, folder and
//          full path; async cache, 10 s TTL)             -> '@virtual:<path> '
//          ('@virtual:"a b.txt" ' when the path has whitespace)
//        - chats by title (no sub-agent chats, not the current chat)
//                                                        -> '@chat:<id> '
//        The inserted prefixes ('virtual:', 'chat:') are never matched.
//
// Search (composerPickerScore, pure): NFKD + combining marks stripped +
// lower-case on both sides; every query word must match some field (AND); a
// word matches as exact / prefix > word or path-segment start > substring >
// fuzzy subsequence (anchored at a word start). A name/title match beats a
// path/id match; ties go to the most recent item. '@' merges all sources
// into one list of COMPOSER_PICKER_MAX rows with a per-type cap (filled up
// afterwards) so hundreds of files cannot crowd out docs and chats. An empty
// query lists recent items from every source. Matched characters are
// wrapped in <mark> after escaping. The search pool is built once per open
// (rebuilt only when the Agent Files listing lands); per keystroke only the
// previous matches are rescored while the query grows.
//
// Every row has a type icon on the left (UI_ICONS; files via
// sdocFileIcon / sdocFileTypeInfo). ArrowUp/ArrowDown move, Enter/Tab
// insert, Esc closes (and keeps it closed for that word). On a multi-word
// '@' query Enter inserts only after an explicit ArrowUp/Down, else it
// submits; Tab always inserts. Accept keeps the token dismissed so the
// inserted ref never reopens the picker. The textarea
// keeps focus: the active option is exposed with aria-activedescendant
// (option ids are type-prefixed and stable per item).
//
// The key handler is registered with registerComposerKeyHandler(fn,
// {first:true}) so, while the popup is open, it consumes ArrowUp/Down/Esc
// before history recall (ui/246) and Enter/Tab before submit. 320
// kbdCanPause yields Esc to the picker via composerPickerIsOpen().

var COMPOSER_PICKER_MAX = 30;
var COMPOSER_PICKER_TYPE_MAX = 12;
var COMPOSER_PICKER_FILES_LIMIT = 500;
var COMPOSER_PICKER_FILES_TTL_MS = 10000;
var COMPOSER_PICKER_FILES_TIMEOUT_MS = 5000;
var COMPOSER_PICKER_POOL_TTL_MS = 3000;
// '@' queries may hold a few words (spaces allowed) on one line.
var COMPOSER_PICKER_QUERY_MAX = 60;
var COMPOSER_PICKER_WORDS_MAX = 4;
var COMPOSER_PICKER_TRIGGERS = { '/': 'skills', '\uFF0F': 'skills', '@': 'refs', '\uFF20': 'refs' };
var COMPOSER_PICKER_TYPE_ORDER = { skill: 0, attachment: 1, doc: 2, file: 3, chat: 4 };
var COMPOSER_PICKER_TIER = { exact: 40, prefix: 30, boundary: 20, substring: 10, fuzzy: 0 };
var COMPOSER_PICKER_NAME_BONUS = 5;

// Open picker: {kind, inputId, trigger, source, start, end, query, items,
// index, pool, matched, qn, filesVersion}.
var _composerPicker = null;
// Esc / Accept / a restored draft / Enter on prose close the picker for one
// word: {kind, start, trigger}.
var _composerPickerDismissed = null;
// Closed because the token matched nothing: {kind, start, trigger, query,
// filesVersion} (a new Agent Files listing invalidates it).
// While the user keeps extending that query nothing is re-matched; it
// reopens only when the token is shortened or edited.
var _composerPickerNoMatch = null;
// Ref tokens inserted by Accept ('doc_1', 'file_x'), without the trigger.
var _composerPickerInserted = {};
// Agent Files cache. gen: bumped per request (a reply for an older request
// is dropped); version: bumped when a listing lands (pool rebuild); at: time
// of the last good listing (TTL).
var _composerPickerFiles = { entries: null, loading: false, gen: 0, version: 0, at: 0 };
// Short-lived pool cache so close/reopen while typing does not re-index.
var _composerPickerPoolCache = null;

function _composerPickerIsTrigger(ch, source) {
    if (!Object.prototype.hasOwnProperty.call(COMPOSER_PICKER_TRIGGERS, ch)) return false;
    return !source || COMPOSER_PICKER_TRIGGERS[ch] === source;
}

// Pure: the '/' or '@' token that ends at the caret, or null. The trigger
// must start a word (start of the text or after whitespace), so '@' inside
// an e-mail or URL never opens the picker. '/' takes one word; '@' may take
// up to COMPOSER_PICKER_WORDS_MAX words on the same line. No selection.
function composerPickerQuery(value, selStart, selEnd) {
    if (typeof value !== 'string') return null;
    var caret = typeof selStart === 'number' ? selStart : value.length;
    if (typeof selEnd === 'number' && selEnd !== caret) return null;
    if (caret < 1 || caret > value.length) return null;
    var s = caret;
    while (s > 0 && !/\s/.test(value.charAt(s - 1))) s--;
    var ch = value.charAt(s), query;
    if (_composerPickerIsTrigger(ch, 'skills')) {
        query = value.slice(s + 1, caret);
        // '//' is not a picker; neither is a second trigger in the token.
        for (var k = 0; k < query.length; k++) if (_composerPickerIsTrigger(query.charAt(k), 'skills')) return null;
        return { trigger: ch, source: 'skills', query: query, start: s, end: caret };
    }
    var lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    var from = Math.max(lineStart, caret - COMPOSER_PICKER_QUERY_MAX - 1);
    for (var i = caret - 1; i >= from; i--) {
        var c = value.charAt(i);
        if (!_composerPickerIsTrigger(c, 'refs')) continue;
        // Nearest '@' decides: mid-word ('a@b', 'x/@y', '@@') is no picker.
        if (i > 0 && !/\s/.test(value.charAt(i - 1))) return null;
        query = value.slice(i + 1, caret);
        if (/^\s/.test(query)) return null;
        // Already a complete reference: '@virtual:..' / '@chat:..', or an
        // inserted ref followed by whitespace ('@doc_1 hi').
        var first = /^(\S+)(\s)?/.exec(query);
        if (first && (/^(virtual|chat):/i.test(first[1]) ||
            (first[2] && Object.prototype.hasOwnProperty.call(_composerPickerInserted, first[1])))) return null;
        if (query.trim().split(/\s+/).length > COMPOSER_PICKER_WORDS_MAX) return null;
        return { trigger: c, source: 'refs', query: query, start: i, end: caret };
    }
    return null;
}

// ---------- search (pure) ----------

var _COMPOSER_PICKER_MARKS_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
var _COMPOSER_PICKER_WORD_RE = /[\p{L}\p{N}]/u;

// Pure: NFKD, combining marks stripped, lower-cased. map[i]/ends[i] give the
// source range of normalized char i; starts[i] is true at a word or
// path-segment start.
function composerPickerNormalize(s) {
    s = String(s == null ? '' : s);
    var out = '', map = [], ends = [], i = 0;
    while (i < s.length) {
        var cp = s.codePointAt(i), len = cp > 0xffff ? 2 : 1, ch = s.substr(i, len), n = ch;
        try { n = ch.normalize('NFKD'); } catch (e) {}
        n = n.replace(_COMPOSER_PICKER_MARKS_RE, '').toLowerCase();
        for (var j = 0; j < n.length; j++) { map.push(i); ends.push(i + len); }
        out += n;
        i += len;
    }
    var starts = [];
    for (var k = 0; k < out.length; k++) starts.push(k === 0 || !_COMPOSER_PICKER_WORD_RE.test(out.charAt(k - 1)));
    return { text: s, n: out, map: map, ends: ends, starts: starts };
}

function composerPickerTokens(query) {
    var n = composerPickerNormalize(query).n.trim();
    return n ? n.split(/\s+/) : [];
}

function _composerPickerRange(a, len) { var r = []; for (var i = 0; i < len; i++) r.push(a + i); return r; }

// Best match of one normalized token in one prepared field, or null.
function _composerPickerMatchToken(f, tok) {
    var n = f.n, L = tok.length;
    if (!L || !n) return null;
    var idx = n.indexOf(tok);
    if (idx === 0) return { tier: n.length === L ? 'exact' : 'prefix', at: _composerPickerRange(0, L) };
    if (idx > 0) {
        for (var j = idx; j !== -1; j = n.indexOf(tok, j + 1)) {
            if (f.starts[j]) return { tier: 'boundary', at: _composerPickerRange(j, L) };
        }
        return { tier: 'substring', at: _composerPickerRange(idx, L) };
    }
    if (L < 2) return null;
    // Fuzzy: subsequence whose first char starts a word/segment. If the
    // greedy walk from the first such start fails, later starts fail too.
    var c0 = tok.charAt(0);
    for (var s = 0; s < n.length; s++) {
        if (!f.starts[s] || n.charAt(s) !== c0) continue;
        var pos = [s], k = 1;
        for (var p = s + 1; p < n.length && k < L; p++) if (n.charAt(p) === tok.charAt(k)) { pos.push(p); k++; }
        return k === L ? { tier: 'fuzzy', at: pos } : null;
    }
    return null;
}

// tokens: normalized words; fields: [{f: composerPickerNormalize(..), name}].
// Every token must match (AND); each counts its best field.
function _composerPickerScoreFields(tokens, fields) {
    var hits = fields.map(function() { return []; });
    var total = 0;
    for (var t = 0; t < tokens.length; t++) {
        var best = null, bestF = -1, bestS = -1;
        for (var i = 0; i < fields.length; i++) {
            var m = _composerPickerMatchToken(fields[i].f, tokens[t]);
            if (!m) continue;
            var sc = COMPOSER_PICKER_TIER[m.tier] + (fields[i].name ? COMPOSER_PICKER_NAME_BONUS : 0);
            if (sc > bestS) { best = m; bestF = i; bestS = sc; }
        }
        if (!best) return null;
        total += bestS;
        hits[bestF] = hits[bestF].concat(best.at);
    }
    return { score: total, hits: hits };
}

// Normalized positions -> sorted unique source indices.
function _composerPickerSourceHits(f, positions) {
    var seen = {}, out = [];
    (positions || []).forEach(function(p) {
        if (p < 0 || p >= f.map.length) return;
        for (var i = f.map[p]; i < f.ends[p]; i++) if (!seen[i]) { seen[i] = 1; out.push(i); }
    });
    return out.sort(function(a, b) { return a - b; });
}

// Pure scorer. fields: strings (names) or {text, name:false} (paths/ids).
// Returns null when some word does not match, else {score, hits} where
// hits[i] are the matched source indices of fields[i].
function composerPickerScore(query, fields) {
    var prepared = (fields || []).map(function(x) {
        var o = (x && typeof x === 'object') ? x : { text: x };
        return { f: composerPickerNormalize(o.text), name: o.name !== false };
    });
    var r = _composerPickerScoreFields(composerPickerTokens(query), prepared);
    if (!r) return null;
    return { score: r.score, hits: r.hits.map(function(h, i) { return _composerPickerSourceHits(prepared[i].f, h); }) };
}

function _composerPickerEsc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(s));
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Pure: escaped text with the given source indices wrapped in <mark>.
function composerPickerHighlight(text, indices) {
    text = String(text == null ? '' : text);
    var on = {};
    (indices || []).forEach(function(i) { on[i] = 1; });
    var out = '', run = '', inMark = false;
    function flush() { if (run) out += inMark ? '<mark>' + _composerPickerEsc(run) + '</mark>' : _composerPickerEsc(run); run = ''; }
    for (var i = 0; i < text.length; i++) {
        var m = !!on[i];
        if (m !== inMark) { flush(); inMark = m; }
        run += text.charAt(i);
    }
    flush();
    return out;
}

// ---------- sources -> pool entries ----------

function _composerPickerIcon(name) {
    return (typeof UI_ICONS !== 'undefined' && UI_ICONS && UI_ICONS[name]) || '';
}

// Icon for a file name: sdocFileIcon (tools/110) when loaded, else a small
// extension map onto UI_ICONS.
function _composerPickerFileIcon(name) {
    if (typeof sdocFileIcon === 'function') {
        try { var svg = sdocFileIcon({ name: name, kind: 'file' }); if (svg) return svg; } catch (e) {}
    }
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    var ext = m ? m[1].toLowerCase() : '';
    if (/^(png|jpe?g|gif|webp|bmp|ico|avif)$/.test(ext)) return _composerPickerIcon('image');
    if (ext === 'pdf') return _composerPickerIcon('pdf');
    if (/^(js|ts|py|java|c|cpp|cs|go|rb|php|sh|json|html|css|xml|sql|md)$/.test(ext)) return _composerPickerIcon('code') || _composerPickerIcon('file');
    return _composerPickerIcon('file');
}

function _composerPickerAgo(ts) {
    if (!ts) return '';
    try {
        if (typeof sdocTimeAgo === 'function') return String(sdocTimeAgo(ts));
        if (typeof i18nFormatRelative === 'function') return String(i18nFormatRelative(Math.min(ts, Date.now()), { now: Date.now(), style: 'narrow' }));
    } catch (e) {}
    return '';
}

// item: {type, id, label, labelPrefix?, detail, icon, insert}.
// fields: [{text, name, show: 'label'|'detail'|''}]; only `name` fields get
// the name bonus. key = type + ':' + id (stable across keystrokes).
function _composerPickerEntry(item, fields, recency) {
    item.key = item.type + ':' + item.id;
    return {
        item: item, recency: recency || 0, order: COMPOSER_PICKER_TYPE_ORDER[item.type] || 9,
        fields: fields.filter(function(x) { return x && x.text; }).map(function(x) {
            return { f: composerPickerNormalize(x.text), name: !!x.name, show: x.show || '' };
        })
    };
}

function _composerPickerSkillEntries() {
    var act = (typeof activeSkills !== 'undefined' && activeSkills) ? activeSkills : {};
    var all = (typeof skills !== 'undefined' && skills) ? skills : {};
    return Object.keys(act).filter(function(id) {
        if (!act[id]) return false;
        if (typeof isSkillDevHidden === 'function' && isSkillDevHidden(id)) return false;
        return true;
    }).map(function(id) {
        var s = all[id] || (typeof act[id] === 'object' ? act[id] : null) || {};
        return _composerPickerEntry({ type: 'skill', id: id, label: id, labelPrefix: '/', detail: s.description || s.name || '',
            icon: _composerPickerIcon('skill'), insert: '/' + id + ' ' },
            [{ text: id, name: true, show: 'label' }, { text: s.name || '', name: false }], 0);
    });
}

function _composerPickerChatId(kind) {
    return (kind === 'chat' && typeof currentChatId !== 'undefined' && currentChatId) ? currentChatId : null;
}

// Attachments of the current chat only (none on Home).
function _composerPickerAttachmentEntries(kind) {
    var chatId = _composerPickerChatId(kind);
    var chat = chatId && typeof chats !== 'undefined' && chats ? chats[chatId] : null;
    var msgs = chat && Array.isArray(chat.messages) ? chat.messages : [];
    var base = (chat && (chat.updatedAt || chat.createdAt)) || 0;
    var out = [], seen = {};
    for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (!m || !m.file_id || seen[m.file_id]) continue;
        if (!/^User attached/.test(String(m.description || ''))) continue;
        seen[m.file_id] = true;
        var name = m.name || m.file_id;
        var icon = m.role === 'screenshot' ? _composerPickerIcon('image') :
            m.role === 'pdf' ? _composerPickerIcon('pdf') : _composerPickerFileIcon(name);
        out.push(_composerPickerEntry({ type: 'attachment', id: m.file_id, label: name, detail: '',
            icon: icon, insert: '@' + m.file_id + ' ' },
            [{ text: name, name: true, show: 'label' }], (m.timestamp || base) + i / 1e6));
    }
    return out;
}

// Chat-scoped docs are private to their chat (as on the Documents page).
function _composerPickerDocEntries(kind) {
    var all = (typeof smartDocuments !== 'undefined' && smartDocuments) ? Object.values(smartDocuments) : [];
    var chatId = _composerPickerChatId(kind);
    return all.filter(function(d) {
        if (!d || !d.id) return false;
        return d.scope !== 'chat' || (!!chatId && d.ownerChatId === chatId);
    }).map(function(d) {
        var ts = d.updatedAt || d.createdAt || 0;
        return _composerPickerEntry({ type: 'doc', id: d.id, label: d.title || d.id, detail: _composerPickerAgo(ts),
            icon: _composerPickerIcon('compose'), insert: '@' + d.id + ' ' },
            [{ text: d.title || d.id, name: true, show: 'label' }, { text: d.id, name: false }], ts);
    });
}

// '@virtual:<path>' — quoted when the path contains whitespace (or a quote).
function composerPickerFileRef(path) {
    var p = String(path || '');
    if (/[\s"]/.test(p)) return '@virtual:"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return '@virtual:' + p;
}

function _composerPickerFileEntries() {
    return (_composerPickerFiles.entries || []).map(function(f) {
        var name = f.name || String(f.path).split('/').pop();
        var cut = String(f.path).lastIndexOf('/');
        var folder = cut > 0 ? String(f.path).slice(0, cut) : '';
        return _composerPickerEntry({ type: 'file', id: f.path, label: name, detail: folder,
            icon: _composerPickerFileIcon(name), insert: composerPickerFileRef(f.path) + ' ' },
            [{ text: name, name: true, show: 'label' }, { text: folder, name: false, show: 'detail' },
                { text: f.path, name: false }], f.lastModified || 0);
    });
}

// Excludes the current chat only in the chat composer (Home may sit beside
// a background currentChatId that is still a valid reference).
function _composerPickerChatEntries(kind) {
    var all = (typeof chats !== 'undefined' && chats) ? chats : {};
    var cur = _composerPickerChatId(kind);
    return Object.keys(all).map(function(id) { return all[id]; }).filter(function(c) {
        return !!c && !!c.id && c.id !== cur && !c.isSubAgent && !c.parentChatId;
    }).map(function(c) {
        var title = c.title || c.id, ts = c.updatedAt || c.createdAt || 0;
        return _composerPickerEntry({ type: 'chat', id: c.id, label: title, detail: _composerPickerAgo(ts),
            icon: _composerPickerIcon('chat'), insert: '@chat:' + c.id + ' ' },
            [{ text: title, name: true, show: 'label' }], ts);
    });
}

function _composerPickerBuildPool(source, kind) {
    if (source === 'skills') return _composerPickerSkillEntries();
    if (source !== 'refs') return [];
    return [].concat(_composerPickerAttachmentEntries(kind), _composerPickerDocEntries(kind),
        _composerPickerFileEntries(), _composerPickerChatEntries(kind));
}

function _composerPickerPool(source, kind) {
    var key = source + '|' + kind + '|' + (_composerPickerChatId(kind) || '') + '|' +
        (source === 'refs' ? _composerPickerFiles.version : 0);
    var c = _composerPickerPoolCache, now = Date.now();
    if (c && c.key === key && now - c.at < COMPOSER_PICKER_POOL_TTL_MS) return c.pool;
    var pool = _composerPickerBuildPool(source, kind);
    _composerPickerPoolCache = { key: key, at: now, pool: pool };
    return pool;
}

// ---------- ranking ----------

function _composerPickerMatch(entries, query) {
    var tokens = composerPickerTokens(query), out = [];
    for (var i = 0; i < entries.length; i++) {
        var r = _composerPickerScoreFields(tokens, entries[i].fields);
        if (r) out.push({ e: entries[i], score: r.score, hits: r.hits });
    }
    return out;
}

// Score, then recency (refs), then type, label, key: a total order, so the
// ranking is stable whatever the pool order.
function _composerPickerCompare(a, b) {
    var ka = a.e.item.key, kb = b.e.item.key;
    return (b.score - a.score) || (b.e.recency - a.e.recency) || (a.e.order - b.e.order) ||
        String(a.e.item.label).localeCompare(String(b.e.item.label)) || (ka < kb ? -1 : ka > kb ? 1 : 0);
}

// Top COMPOSER_PICKER_MAX; '@' caps each type at COMPOSER_PICKER_TYPE_MAX
// first, then fills the remaining rows in rank order.
function _composerPickerSelect(matched, source) {
    var sorted = matched.slice().sort(_composerPickerCompare);
    if (source !== 'refs') return sorted.slice(0, COMPOSER_PICKER_MAX);
    var per = {}, out = [], rest = [];
    sorted.forEach(function(m) {
        var t = m.e.item.type;
        if (out.length < COMPOSER_PICKER_MAX && (per[t] || 0) < COMPOSER_PICKER_TYPE_MAX) { per[t] = (per[t] || 0) + 1; out.push(m); }
        else rest.push(m);
    });
    for (var i = 0; i < rest.length && out.length < COMPOSER_PICKER_MAX; i++) out.push(rest[i]);
    return out.sort(_composerPickerCompare);
}

// Row data with highlighted label/detail HTML (escaped, then <mark>).
function _composerPickerMaterialize(selected) {
    return selected.map(function(m) {
        var it = m.e.item, label = [], detail = [], labelText = it.label, detailText = it.detail;
        m.e.fields.forEach(function(fd, i) {
            if (fd.show === 'label') { labelText = fd.f.text; label = _composerPickerSourceHits(fd.f, m.hits[i]); }
            else if (fd.show === 'detail') { detailText = fd.f.text; detail = _composerPickerSourceHits(fd.f, m.hits[i]); }
        });
        return {
            type: it.type, id: it.id, key: it.key, label: it.label, labelPrefix: it.labelPrefix || '', detail: it.detail || '',
            icon: it.icon, insert: it.insert, score: m.score,
            labelHtml: _composerPickerEsc(it.labelPrefix || '') + composerPickerHighlight(labelText, label),
            detailHtml: it.detail ? (detailText === it.detail ? composerPickerHighlight(detailText, detail) : _composerPickerEsc(it.detail)) : ''
        };
    });
}

// Ranked rows for a source ('skills' | 'refs'); builds a fresh pool.
function composerPickerItems(source, query, kind) {
    if (source !== 'skills' && source !== 'refs') return [];
    var pool = _composerPickerBuildPool(source, kind);
    return _composerPickerMaterialize(_composerPickerSelect(_composerPickerMatch(pool, query), source));
}

// ---------- Agent Files cache ----------

// Refresh the Agent Files listing (TTL, timeout, generation); re-sync the
// open '@' picker when a new listing lands. Returns the promise or null.
function composerPickerRefreshFiles(force) {
    var F = _composerPickerFiles;
    if (typeof lfListDir !== 'function') return null;
    // force supersedes an in-flight listing (its result is dropped by gen).
    if (F.loading && !force) return null;
    if (!force && F.entries && Date.now() - F.at < COMPOSER_PICKER_FILES_TTL_MS) return null;
    var gen = ++F.gen;
    F.loading = true;
    var folder = typeof LOCAL_FOLDER_VIRTUAL_ID !== 'undefined' ? LOCAL_FOLDER_VIRTUAL_ID : 'virtual';
    var timer = null, p;
    try { p = Promise.resolve(lfListDir(folder, '', { recursive: true, limit: COMPOSER_PICKER_FILES_LIMIT })); }
    catch (e) { p = Promise.reject(e); }
    var timeout = new Promise(function(resolve, reject) {
        if (typeof setTimeout === 'function') timer = setTimeout(function() { reject(new Error('timeout')); }, COMPOSER_PICKER_FILES_TIMEOUT_MS);
    });
    return Promise.race([p, timeout]).then(function(res) {
        if (gen !== F.gen) return false;
        var entries = res && Array.isArray(res.entries) ? res.entries : [];
        F.entries = entries.filter(function(e) { return e && e.kind === 'file' && e.path; })
            .map(function(e) { return { name: e.name, path: e.path, lastModified: e.lastModified || 0 }; });
        F.at = Date.now();
        F.version++;
        return true;
    }, function() {
        if (gen !== F.gen) return false;
        if (!F.entries) F.entries = [];
        F.at = 0; // retry on the next open
        return false;
    }).then(function(changed) {
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
        if (gen !== F.gen) return;
        F.loading = false;
        var pk = _composerPicker;
        if (changed && pk && pk.source === 'refs') {
            var input = _composerPickerInput(pk);
            if (input) composerPickerSync(input, true);
        }
    });
}

// ---------- popup ----------

function composerPickerIsOpen() {
    return !!_composerPicker;
}

function _composerPickerListId(inputId) { return inputId + '-picker'; }
// '<input>-picker-opt-<type>-<id>' with the id reduced to [A-Za-z0-9_]
// (other chars as '-xxxx' hex): unique and stable per item.
function _composerPickerOptionId(inputId, item) {
    var id = String(item && item.id != null ? item.id : '').replace(/[^A-Za-z0-9_]/g, function(c) {
        return '-' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
    return inputId + '-picker-opt-' + (item && item.type || 'item') + '-' + id;
}

function _composerPickerInput(p) {
    return (p && typeof document !== 'undefined' && document) ? document.getElementById(p.inputId) : null;
}

function _composerPickerPopup(inputId, create) {
    if (typeof document === 'undefined' || !document) return null;
    var id = _composerPickerListId(inputId);
    var el = document.getElementById(id);
    if (el || !create || typeof document.createElement !== 'function') return el;
    var input = document.getElementById(inputId);
    var host = input && input.parentElement;
    if (!host) return null;
    el = document.createElement('div');
    el.id = id;
    el.className = 'composer-picker';
    el.setAttribute('role', 'listbox');
    el.hidden = true;
    // mousedown (not click) so the textarea keeps focus.
    el.addEventListener('mousedown', function(e) {
        var opt = e.target && e.target.closest ? e.target.closest('[data-picker-index]') : null;
        e.preventDefault();
        if (!opt || !_composerPicker) return;
        _composerPicker.index = parseInt(opt.getAttribute('data-picker-index'), 10) || 0;
        composerPickerAccept();
    });
    host.appendChild(el);
    return el;
}

// In a chat the popup opens upward from the composer; cap its height to the
// room between the composer top and whatever would cover/clip it above (the
// .main-header bar, or the nearest overflow-clipping ancestor), so rows are
// never hidden under the header. On the New chat (home) page it opens
// downward (.composer-picker-below); cap it to the room between the composer
// bottom and the viewport / clipping-ancestor bottom. Scrolls internally (CSS).
var COMPOSER_PICKER_MAX_H = 260, COMPOSER_PICKER_MIN_H = 64, COMPOSER_PICKER_GAP = 16;
function _composerPickerBelow(el) {
    return !!el && /(^|\s)composer-picker-below(\s|$)/.test(el.className || '');
}
function _composerPickerFit(el) {
    var host = el && el.parentElement;
    if (!host || typeof host.getBoundingClientRect !== 'function') return;
    var top = 0;
    try {
        if (_composerPickerBelow(el)) {
            var bottom = (typeof window !== 'undefined' && window && window.innerHeight) || Infinity;
            var gcsB = typeof getComputedStyle === 'function' ? getComputedStyle : null;
            for (var b = host.parentElement; b && gcsB && !/^(BODY|HTML)$/.test(b.tagName || ''); b = b.parentElement) {
                var csB = gcsB(b);
                if (csB && /(hidden|auto|scroll|clip)/.test((csB.overflowY || '') + ' ' + (csB.overflow || ''))) {
                    bottom = Math.min(bottom, b.getBoundingClientRect().bottom);
                    break;
                }
            }
            var roomB = Math.floor(bottom - host.getBoundingClientRect().bottom - COMPOSER_PICKER_GAP);
            el.style.maxHeight = Math.max(COMPOSER_PICKER_MIN_H, Math.min(COMPOSER_PICKER_MAX_H, roomB)) + 'px';
            return;
        }
        var main = host.closest ? host.closest('.main') : null;
        var hdr = main && main.querySelector ? main.querySelector('.main-header') : null;
        if (hdr && hdr.offsetParent !== null) top = Math.max(top, hdr.getBoundingClientRect().bottom);
        var gcs = typeof getComputedStyle === 'function' ? getComputedStyle : null;
        for (var a = host.parentElement; a && gcs && !/^(BODY|HTML)$/.test(a.tagName || ''); a = a.parentElement) {
            var cs = gcs(a);
            if (cs && /(hidden|auto|scroll|clip)/.test((cs.overflowY || '') + ' ' + (cs.overflow || ''))) {
                top = Math.max(top, a.getBoundingClientRect().top);
                break;
            }
        }
        var room = Math.floor(host.getBoundingClientRect().top - top - COMPOSER_PICKER_GAP);
        el.style.maxHeight = Math.max(COMPOSER_PICKER_MIN_H, Math.min(COMPOSER_PICKER_MAX_H, room)) + 'px';
    } catch (e) {}
}
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function() {
        var p = _composerPicker;
        var el = p ? _composerPickerPopup(p.inputId, false) : null;
        if (el && !el.hidden) _composerPickerFit(el);
    });
}

function _composerPickerOptionHtml(p, it, i) {
    var sel = i === p.index;
    return '<div class="composer-picker-option' + (sel ? ' active' : '') + '" role="option" id="' +
        _composerPickerEsc(_composerPickerOptionId(p.inputId, it)) + '" data-picker-index="' + i + '" data-picker-type="' + it.type +
        '" aria-selected="' + (sel ? 'true' : 'false') + '">' +
        '<span class="composer-picker-icon composer-picker-icon-' + it.type + '" aria-hidden="true">' + (it.icon || '') + '</span>' +
        '<span class="composer-picker-label">' + it.labelHtml + '</span>' +
        (it.detail ? '<span class="composer-picker-detail">' + it.detailHtml + '</span>' : '') +
        '</div>';
}

function _composerPickerRender() {
    var p = _composerPicker;
    if (!p) return;
    var input = _composerPickerInput(p);
    var el = _composerPickerPopup(p.inputId, true);
    var listId = _composerPickerListId(p.inputId);
    var skillsSrc = p.source === 'skills';
    if (p.index >= p.items.length) p.index = 0;
    var active = p.items[p.index] || null;
    if (el) {
        var hasT = typeof t === 'function';
        // Literal t('...') calls so the i18n extractor sees the keys.
        el.setAttribute('aria-label', skillsSrc ? (hasT ? t('Skills') : 'Skills') : (hasT ? t('References') : 'References'));
        var html;
        if (!p.items.length) {
            html = '<div class="composer-picker-empty" role="presentation">' +
                _composerPickerEsc(skillsSrc ? (hasT ? t('No matching skills') : 'No matching skills') :
                    (hasT ? t('No matching references') : 'No matching references')) + '</div>';
        } else {
            html = p.items.map(function(it, i) { return _composerPickerOptionHtml(p, it, i); }).join('');
        }
        el.innerHTML = html;
        // New chat page: open below the composer; inside a chat: above.
        el.className = 'composer-picker' + (p.kind === 'home' ? ' composer-picker-below' : '');
        el.hidden = false;
        _composerPickerFit(el);
        var act = active && typeof document.getElementById === 'function' ? document.getElementById(_composerPickerOptionId(p.inputId, active)) : null;
        if (act && typeof act.scrollIntoView === 'function') { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    }
    if (input && typeof input.setAttribute === 'function') {
        input.setAttribute('aria-controls', listId);
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'true');
        // Always the id of a row rendered just above (or nothing).
        if (active && el) input.setAttribute('aria-activedescendant', _composerPickerOptionId(p.inputId, active));
        else if (typeof input.removeAttribute === 'function') input.removeAttribute('aria-activedescendant');
    }
}

function composerPickerClose() {
    var p = _composerPicker;
    _composerPicker = null;
    if (!p) return;
    var el = _composerPickerPopup(p.inputId, false);
    if (el) { el.hidden = true; el.innerHTML = ''; }
    var input = _composerPickerInput(p);
    if (input && typeof input.removeAttribute === 'function') {
        input.removeAttribute('aria-activedescendant');
        input.setAttribute('aria-expanded', 'false');
    }
}

// Recompute the picker for a composer after its value or caret changed.
// Unchanged token -> no work (caret events repeat); force re-ranks (files
// landed, Accept re-validation).
function composerPickerSync(input, force) {
    var kind = typeof composerKindForInput === 'function' ? composerKindForInput(input) : null;
    if (!kind) return;
    var q = composerPickerQuery(input.value, input.selectionStart, input.selectionEnd);
    var d = _composerPickerDismissed;
    if (d && (!q || d.kind !== kind || d.start !== q.start || d.trigger !== q.trigger)) d = _composerPickerDismissed = null;
    var nm = _composerPickerNoMatch;
    if (nm && (!q || nm.kind !== kind || nm.start !== q.start || nm.trigger !== q.trigger ||
        q.query.indexOf(nm.query) !== 0 || nm.filesVersion !== _composerPickerFiles.version)) nm = _composerPickerNoMatch = null;
    // Dismissed, or still extending a query that matched nothing: no work.
    if (!q || d || nm) {
        if (_composerPicker && _composerPicker.kind === kind) composerPickerClose();
        return;
    }
    var cur = _composerPicker;
    var prev = cur && cur.kind === kind && cur.inputId === input.id && cur.start === q.start && cur.trigger === q.trigger ? cur : null;
    var filesV = _composerPickerFiles.version;
    if (prev && !force && prev.query === q.query && prev.end === q.end && prev.filesVersion === filesV) return;
    if (cur && !prev) composerPickerClose();
    // A new '@' picker refreshes the Agent Files listing (TTL) in the background.
    if (!prev && q.source === 'refs') composerPickerRefreshFiles();
    var pool = prev && prev.filesVersion === filesV ? prev.pool : _composerPickerPool(q.source, kind);
    var qn = composerPickerTokens(q.query).join(' ');
    // A grown query only narrows the previous matches (AND, monotone tiers).
    var cand = prev && prev.pool === pool && prev.matched && qn.indexOf(prev.qn) === 0 ? prev.matched : pool;
    var matched = _composerPickerMatch(cand, q.query);
    var items = _composerPickerMaterialize(_composerPickerSelect(matched, q.source));
    // Plain prose after an '@', not a lookup: remember it for this token.
    if (q.source === 'refs' && _composerPickerIsProse(q.query, matched, items.length)) {
        _composerPickerNoMatch = { kind: kind, start: q.start, trigger: q.trigger, query: q.query, filesVersion: filesV };
        if (_composerPicker) composerPickerClose();
        return;
    }
    var keepKey = prev && prev.query === q.query && prev.items[prev.index] ? prev.items[prev.index].key : null;
    var index = 0;
    if (keepKey) { for (var i = 0; i < items.length; i++) if (items[i].key === keepKey) { index = i; break; } }
    _composerPicker = { kind: kind, inputId: input.id, trigger: q.trigger, source: q.source, query: q.query,
        start: q.start, end: q.end, items: items, index: index, pool: pool,
        moved: !!(prev && prev.query === q.query && prev.moved),
        matched: matched.map(function(m) { return m.e; }), qn: qn, filesVersion: filesV };
    _composerPickerRender();
}

function composerPickerMove(delta) {
    var p = _composerPicker;
    if (!p || !p.items.length) return;
    var n = p.items.length;
    p.index = ((p.index + delta) % n + n) % n;
    // An explicit choice: Enter may accept even on a multi-word query.
    p.moved = true;
    _composerPickerRender();
}

// '@' query that is prose, not a lookup: it holds whitespace and matches
// nothing (AND is monotone, so extending it can never match). A query that
// still matches stays open: Enter submits it anyway unless ArrowUp/Down
// picked a row.
function _composerPickerIsProse(query, matched, count) {
    return /\s/.test(query) && !count;
}

// Sent / cleared composer (ui/246 composerResetInput): forget per-token state.
function composerPickerResetState() {
    _composerPickerDismissed = null;
    _composerPickerNoMatch = null;
}

// Keep the picker closed for the token at the caret (history replace, ui/246).
function composerPickerDismissAt(input) {
    var kind = input && typeof composerKindForInput === 'function' ? composerKindForInput(input) : null;
    var q = kind ? composerPickerQuery(input.value, input.selectionStart, input.selectionEnd) : null;
    if (q) _composerPickerDismissed = { kind: kind, start: q.start, trigger: q.trigger };
    if (_composerPicker) composerPickerClose();
}

// Insert the active item in place of the '/query' or '@query' token. The
// token is re-read first: if the value/caret moved without an event, the
// picker re-syncs (or closes) and false means nothing was inserted.
function composerPickerAccept() {
    var p = _composerPicker;
    if (!p) return false;
    var input = _composerPickerInput(p);
    if (!input) { composerPickerClose(); return false; }
    var q = composerPickerQuery(input.value, input.selectionStart, input.selectionEnd);
    // Stale token: re-sync so the user sees the real rows; insert nothing.
    if (!q || q.start !== p.start || q.trigger !== p.trigger || q.end !== p.end || q.query !== p.query) {
        composerPickerSync(input, true);
        return false;
    }
    if (!p.items.length) return false;
    var item = p.items[p.index] || p.items[0];
    // The 'input' fired by the insert must not reopen on the inserted ref.
    _composerPickerDismissed = { kind: p.kind, start: p.start, trigger: p.trigger };
    if (p.source === 'refs') {
        var tok = String(item.insert || '').replace(/^[@\uFF20]/, '').trim();
        if (tok) _composerPickerInserted[tok] = 1;
    }
    composerPickerClose();
    if (typeof composerInsertText === 'function') composerInsertText(input, item.insert, p.start, p.end);
    else {
        input.value = input.value.slice(0, p.start) + item.insert + input.value.slice(p.end);
        try { input.setSelectionRange(p.start + item.insert.length, p.start + item.insert.length); } catch (e) {}
    }
    try { if (typeof input.focus === 'function') input.focus(); } catch (e) {}
    return true;
}

function _composerPickerKeyHandler(e, kind) {
    var p = _composerPicker;
    if (!p || !e || p.kind !== kind) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    switch (e.key) {
        case 'ArrowDown':
            // An empty popup does not swallow arrows (history, caret).
            if (e.shiftKey || !p.items.length) return false;
            e.preventDefault(); composerPickerMove(1); return true;
        case 'ArrowUp':
            if (e.shiftKey || !p.items.length) return false;
            e.preventDefault(); composerPickerMove(-1); return true;
        case 'Escape':
            e.preventDefault();
            _composerPickerDismissed = { kind: kind, start: p.start, trigger: p.trigger };
            composerPickerClose();
            return true;
        case 'Enter':
        case 'Tab':
            if (e.shiftKey || !p.items.length) return false;
            // Multi-word query: Enter is prose (submit) unless the user picked
            // a row with ArrowUp/Down. Tab always accepts.
            if (e.key === 'Enter' && /\s/.test(p.query) && !p.moved) {
                _composerPickerDismissed = { kind: kind, start: p.start, trigger: p.trigger };
                composerPickerClose();
                return false;
            }
            if (!composerPickerAccept()) {
                // Stale token re-synced and still open: show it, do not submit.
                if (_composerPicker) { e.preventDefault(); return true; }
                return false;
            }
            e.preventDefault();
            return true;
    }
    return false;
}

registerComposerKeyHandler(_composerPickerKeyHandler, { first: true });

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    // Typing / paste / insert: re-rank. Caret moves (click, Left/Right,
    // Home/End, programmatic setSelectionRange via selectionchange)
    // re-evaluate the token too; unchanged tokens cost nothing. Blur closes.
    document.addEventListener('input', function(e) {
        if (e && e.target && typeof composerKindForInput === 'function' && composerKindForInput(e.target)) composerPickerSync(e.target);
    }, true);
    document.addEventListener('keyup', function(e) {
        if (!e || !e.target || typeof composerKindForInput !== 'function' || !composerKindForInput(e.target)) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') composerPickerSync(e.target);
    }, true);
    document.addEventListener('click', function(e) {
        if (e && e.target && typeof composerKindForInput === 'function' && composerKindForInput(e.target)) composerPickerSync(e.target);
    }, true);
    document.addEventListener('selectionchange', function() {
        var a = document.activeElement;
        if (a && typeof composerKindForInput === 'function' && composerKindForInput(a)) composerPickerSync(a);
    });
    document.addEventListener('focusout', function(e) {
        if (_composerPicker && e && e.target && e.target.id === _composerPicker.inputId) composerPickerClose();
    }, true);
}
