// =============================================
// CONNECTED FOLDERS (local_folder tool)
// =============================================
// Shared by the page bundle (tools tier) AND the service worker
// (WORKER_SHARED_FILES in build/build.js + skills/extension-dev/build.js).
//
// Two kinds of folder:
//   - the built-in VIRTUAL folder (id 'virtual', label "Agent Files"): an
//     OPFS sub-directory 'agent-files' — always readwrite, needs no grant, and
//     is where the agent (and the user, via Settings upload) drop files.
//   - user-connected LOCAL folders: FileSystemDirectoryHandles picked with
//     showDirectoryPicker, persisted in the settings store row
//     'connectedFolders' = [{id, label, access: 'read'|'readwrite', handle,
//     addedAt}] (same persist-first pattern as the deploy folder,
//     core/130-indexeddb.js _readDeployDirRow / setDeployDirHandle).
//
// The row is RE-READ on every call (no cache) so a folder added/removed in
// the panel realm is seen by the SW realm immediately.
//
// Binary data flow: `read` of a binary file registers a 'memory' file-store
// entry (data URL) in the realm that ran it — the SW for every headless
// action — and returns its file_id. servicenow_api (attachment_file_id /
// attachment_source) and web_fetch (body_file_id / body_source / form) run in
// the SW too, and resolve bytes through lfResolveBinaryInput below.
//
// PUBLIC HELPERS (for the Settings UI, phase 2):
//   listLocalFolders()                     -> [publicEntry]  (passive, never prompts)
//   addLocalFolder(handle, {access,label}) -> publicEntry
//   pickLocalFolder(access, label)         -> publicEntry|null (page only, user gesture)
//   removeLocalFolder(id)                  -> true
//   setLocalFolderAccess(id, access)       -> publicEntry
//   updateLocalFolder(id, {label, access}) -> publicEntry
//   localFolderPermissionState(id)         -> 'granted'|'prompt'|'denied'|'none'
//   regrantLocalFolder(id)                 -> state (page only, user gesture)
//   lfListDir(folder, path)                -> [{name, path, kind, size?, lastModified?}]
//   lfReadFileBytes(folder, path)          -> {bytes, name, mime, size, lastModified}
//   lfReadFileAsDataUrl(folder, path)      -> {data_url, name, mime, size}
//   lfWriteFileBytes(folder, path, bytes)  -> {path, size}   (refused on read-only)
//   lfDeleteEntry(folder, path, recursive) -> true
//   lfMkdir(folder, path)                  -> true
//   lfNormalizePath(path)                  -> 'a/b.png' (throws on '..')
//   publicEntry = {id, label, access, kind:'virtual'|'local', name, permission, addedAt}

var LOCAL_FOLDER_VIRTUAL_ID = 'virtual';
var LOCAL_FOLDER_VIRTUAL_LABEL = 'Agent Files';
var LOCAL_FOLDER_OPFS_DIR = 'agent-files';
var LOCAL_FOLDERS_SETTINGS_KEY = 'connectedFolders';
var LF_LIMITS = {
    maxReadBytes: 25 * 1024 * 1024,
    maxTextChars: 200000,
    lsMax: 1000,
    grepMaxFiles: 2000,
    grepMaxFileBytes: 1024 * 1024,
    grepDefaultMatches: 50,
    grepMaxMatches: 500
};
var LF_SKIP_DIRS = { '.git': 1, 'node_modules': 1 };
var LF_TEXT_EXTS = { txt: 1, md: 1, json: 1, js: 1, mjs: 1, cjs: 1, ts: 1, tsx: 1, jsx: 1, css: 1, scss: 1, html: 1, htm: 1, xml: 1, svg: 1, csv: 1, tsv: 1, yml: 1, yaml: 1, ini: 1, toml: 1, log: 1, sh: 1, py: 1, java: 1, rb: 1, go: 1, rs: 1, c: 1, h: 1, cpp: 1, sql: 1, env: 1, gitignore: 1 };
var LF_BINARY_EXTS = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, ico: 1, pdf: 1, zip: 1, gz: 1, tgz: 1, '7z': 1, rar: 1, mp3: 1, mp4: 1, mov: 1, wav: 1, woff: 1, woff2: 1, ttf: 1, otf: 1, exe: 1, dll: 1, so: 1, wasm: 1, jar: 1, class: 1, xlsx: 1, docx: 1, pptx: 1, xls: 1, doc: 1, ppt: 1 };
var LF_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', xml: 'application/xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', js: 'text/javascript', css: 'text/css', mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

// Test seam: override any of { getOpfsRoot, readRow, writeRow,
// showDirectoryPicker, promptUser, registerFile, newFileId, getFileAsync }.
var _lfDeps = {};
function lfSetDeps(deps) { _lfDeps = deps || {}; }

function _lfErr(message, code) { var e = new Error(message); if (code) e.code = code; return e; }

// ─── service-worker fallback ────────────────────────────────────────
// Local (non-OPFS) handles and createWritable may be unusable in the MV3
// service worker. A file op that fails there with an API-unavailable error is
// re-run in the side panel (worker/120-tool-routing.js executeTool wrapper).
function lfInServiceWorker() {
    if (typeof _lfDeps.inServiceWorker === 'boolean') return _lfDeps.inServiceWorker;
    try { return typeof ServiceWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof ServiceWorkerGlobalScope; } catch (e) { return false; }
}
var LF_PANEL_FALLBACK_ACTIONS = { ls: 1, read: 1, grep: 1, write: 1, mkdir: 1, delete: 1 };
var LF_SW_UNSUPPORTED_CODES = { NO_WRITE_API: 1, NO_OPFS: 1, SW_UNSUPPORTED: 1 };
// True for a browser-API-unavailable failure (not a real answer like NOT_FOUND).
function lfIsApiUnavailableError(err) {
    if (!err) return false;
    if (err.code) return !!LF_SW_UNSUPPORTED_CODES[err.code];
    var n = err.name;
    if (n === 'SecurityError' || n === 'NotAllowedError' || n === 'TypeError') return true;
    return /not a function|is not supported|not implemented/i.test(String(err.message || err));
}
// ctx = { inServiceWorker, action, alreadyRouted }
function lfShouldRouteToPanel(err, ctx) {
    ctx = ctx || {};
    if (!ctx.inServiceWorker || ctx.alreadyRouted || !LF_PANEL_FALLBACK_ACTIONS[ctx.action]) return false;
    return lfIsApiUnavailableError(err);
}
// SW side, after the panel ran a fallback: re-register a binary read's bytes
// under the SAME file_id in the SW file store (file stores are per realm).
function lfAdoptPanelFallbackResult(result) {
    if (!result || typeof result !== 'object') return result;
    var ptr = result._file_pointer;
    delete result._file_pointer;
    if (ptr && result.file_id) {
        var reg = _lfDeps.registerFile || (typeof registerFile === 'function' ? registerFile : null);
        if (reg) { try { reg(result.file_id, ptr); } catch (e) {} }
    }
    result.ran_in = 'panel';
    return result;
}

// ─── paths ──────────────────────────────────────────────────────────
// '' is the folder root. Backslashes become '/', empty and '.' segments are
// dropped, '..' (anywhere) is REJECTED — never resolved — so a path can
// never escape the folder.
function lfNormalizePath(p) {
    if (p == null) return '';
    if (typeof p !== 'string') throw _lfErr('path must be a string', 'BAD_PATH');
    if (p.indexOf('\0') !== -1) throw _lfErr('path contains a NUL character', 'BAD_PATH');
    var segs = p.replace(/\\/g, '/').split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
        var s = segs[i].trim();
        if (!s || s === '.') continue;
        if (s === '..') throw _lfErr('Path escapes the folder ("..") — use paths relative to the folder root', 'PATH_ESCAPE');
        out.push(s);
    }
    return out.join('/');
}
function _lfSegs(p) { var n = lfNormalizePath(p); return n ? n.split('/') : []; }
function _lfExt(name) { var m = /\.([^./]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function lfGuessMime(name) { return LF_MIME[_lfExt(name)] || 'application/octet-stream'; }

// ─── registry (settings store row) ──────────────────────────────────
async function _lfReadRow() {
    if (_lfDeps.readRow) return (await _lfDeps.readRow()) || [];
    var database = await openDatabase();
    var request = database.transaction([settingsStoreName], 'readonly').objectStore(settingsStoreName).get(LOCAL_FOLDERS_SETTINGS_KEY);
    var result = await new Promise(function(resolve, reject) {
        request.onsuccess = function() { resolve(request.result); };
        request.onerror = function() { reject(request.error || new Error('connectedFolders read failed')); };
    });
    var v = result && result.value;
    return Array.isArray(v) ? v : [];
}
// Persist FIRST (withStore rejects on a failed commit) — see setDeployDirHandle.
async function _lfWriteRow(list) {
    if (_lfDeps.writeRow) return _lfDeps.writeRow(list);
    await withStore([settingsStoreName], 'readwrite', function(tx) {
        tx.objectStore(settingsStoreName).put({ key: LOCAL_FOLDERS_SETTINGS_KEY, value: list });
    });
}
function _lfMode(access) { return access === 'readwrite' ? 'readwrite' : 'read'; }
// mode (optional) overrides the folder's access-derived mode: 'read' for
// ls/read/grep/source reads, 'readwrite' for write/mkdir/delete.
async function _lfPermissionOf(handle, access, interactive, mode) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'none';
    mode = { mode: (mode === 'read' || mode === 'readwrite') ? mode : _lfMode(access) };
    var p;
    try { p = await handle.queryPermission(mode); } catch (e) { if (interactive === 'strict' && lfInServiceWorker() && lfIsApiUnavailableError(e)) throw e; p = 'denied'; }
    if (p === 'prompt' && interactive === true && typeof handle.requestPermission === 'function') {
        try { p = await handle.requestPermission(mode); } catch (e) { p = 'denied'; }
    }
    return p;
}
function _lfVirtualEntry() {
    return { id: LOCAL_FOLDER_VIRTUAL_ID, label: LOCAL_FOLDER_VIRTUAL_LABEL, access: 'readwrite', kind: 'virtual', name: LOCAL_FOLDER_OPFS_DIR, permission: 'granted', addedAt: 0 };
}
function _lfPublic(e, permission) {
    return { id: e.id, label: e.label, access: e.access, kind: 'local', name: (e.handle && e.handle.name) || e.label, permission: permission, addedAt: e.addedAt || 0 };
}
async function listLocalFolders() {
    var rows = await _lfReadRow();
    var out = [_lfVirtualEntry()];
    for (var i = 0; i < rows.length; i++) out.push(_lfPublic(rows[i], await _lfPermissionOf(rows[i].handle, rows[i].access, false)));
    return out;
}
function _lfValidAccess(access) {
    if (access !== 'read' && access !== 'readwrite') throw _lfErr('access must be "read" or "readwrite"', 'BAD_ACCESS');
    return access;
}
async function addLocalFolder(handle, opts) {
    opts = opts || {};
    if (!handle || handle.kind !== 'directory') throw _lfErr('addLocalFolder needs a directory handle', 'BAD_HANDLE');
    var access = _lfValidAccess(opts.access || 'read');
    var rows = await _lfReadRow();
    var entry = {
        id: 'lf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        label: String(opts.label || handle.name || 'Folder').trim() || 'Folder',
        access: access,
        handle: handle,
        addedAt: Date.now()
    };
    await _lfWriteRow(rows.concat([entry]));
    return _lfPublic(entry, await _lfPermissionOf(handle, access, false));
}
async function updateLocalFolder(id, patch) {
    if (id === LOCAL_FOLDER_VIRTUAL_ID) throw _lfErr('The built-in Agent Files folder cannot be changed', 'VIRTUAL_READONLY_CONFIG');
    patch = patch || {};
    var rows = await _lfReadRow();
    var idx = rows.findIndex(function(r) { return r.id === id; });
    if (idx < 0) throw _lfErr('Unknown folder "' + id + '"', 'NOT_FOUND');
    var e = Object.assign({}, rows[idx]);
    if (patch.access != null) e.access = _lfValidAccess(patch.access);
    if (patch.label != null && String(patch.label).trim()) e.label = String(patch.label).trim();
    var next = rows.slice(); next[idx] = e;
    await _lfWriteRow(next);
    return _lfPublic(e, await _lfPermissionOf(e.handle, e.access, false));
}
function setLocalFolderAccess(id, access) { return updateLocalFolder(id, { access: access }); }
async function removeLocalFolder(id) {
    if (id === LOCAL_FOLDER_VIRTUAL_ID) throw _lfErr('The built-in Agent Files folder cannot be removed', 'VIRTUAL_READONLY_CONFIG');
    var rows = await _lfReadRow();
    var next = rows.filter(function(r) { return r.id !== id; });
    if (next.length === rows.length) throw _lfErr('Unknown folder "' + id + '"', 'NOT_FOUND');
    await _lfWriteRow(next);
    return true;
}
async function _lfFindRow(ref) {
    var rows = await _lfReadRow();
    var r = rows.find(function(x) { return x.id === ref; });
    if (!r && typeof ref === 'string') {
        var low = ref.toLowerCase();
        r = rows.find(function(x) { return String(x.label).toLowerCase() === low; });
    }
    return r || null;
}
async function localFolderPermissionState(id) {
    if (!id || id === LOCAL_FOLDER_VIRTUAL_ID) return 'granted';
    var r = await _lfFindRow(id);
    return r ? _lfPermissionOf(r.handle, r.access, false) : 'none';
}
// Page only, inside a user-gesture continuation.
async function regrantLocalFolder(id) {
    if (!id || id === LOCAL_FOLDER_VIRTUAL_ID) return 'granted';
    var r = await _lfFindRow(id);
    if (!r) throw _lfErr('Unknown folder "' + id + '"', 'NOT_FOUND');
    return _lfPermissionOf(r.handle, r.access, true);
}
// Page only, inside a user gesture. Cancel → null; other errors propagate.
async function pickLocalFolder(access, label) {
    access = _lfValidAccess(access || 'read');
    var picker = _lfDeps.showDirectoryPicker || (typeof window !== 'undefined' && window.showDirectoryPicker && window.showDirectoryPicker.bind(window));
    if (!picker) throw _lfErr('showDirectoryPicker is not available in this context (open the side panel)', 'NO_PICKER');
    var handle;
    try {
        handle = await picker({ id: 'appagent-connected-folder', mode: _lfMode(access) });
    } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
    }
    return addLocalFolder(handle, { access: access, label: label });
}

// ─── folder resolution ──────────────────────────────────────────────
async function _lfOpfsDir() {
    var root;
    if (_lfDeps.getOpfsRoot) root = await _lfDeps.getOpfsRoot();
    else {
        if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') throw _lfErr('Origin private file system is not available', 'NO_OPFS');
        root = await navigator.storage.getDirectory();
    }
    return root.getDirectoryHandle(LOCAL_FOLDER_OPFS_DIR, { create: true });
}
// → { entry: publicEntry, root: FileSystemDirectoryHandle }. Omitted folder = virtual.
// mode: 'read' (default — ls/read/grep/source reads) or 'readwrite'
// (write/mkdir/delete). Only the mode actually needed is checked, so a
// read&write folder whose write grant lapsed can still be read.
async function lfResolveFolder(ref, mode) {
    mode = mode === 'readwrite' ? 'readwrite' : 'read';
    if (ref == null || ref === '' || ref === LOCAL_FOLDER_VIRTUAL_ID || (typeof ref === 'string' && ref.toLowerCase() === LOCAL_FOLDER_VIRTUAL_LABEL.toLowerCase())) {
        return { entry: _lfVirtualEntry(), root: await _lfOpfsDir() };
    }
    var r = await _lfFindRow(String(ref));
    if (!r) throw _lfErr('Unknown folder "' + ref + '". Use local_folder {action:"list"} to see connected folders.', 'NOT_FOUND');
    // Access setting FIRST: a READ-ONLY folder refuses writes before any
    // permission query (else a lapsed grant surfaces PERMISSION_REQUIRED).
    if (mode === 'readwrite') _lfAssertWritable(r);
    if (lfInServiceWorker() && r.handle && typeof r.handle.queryPermission !== 'function') throw _lfErr('Folder handles are not usable in the service worker', 'SW_UNSUPPORTED');
    var perm = await _lfPermissionOf(r.handle, r.access, 'strict', mode);
    if (perm !== 'granted') {
        throw _lfErr('Folder "' + r.label + '" needs its permission re-granted (state: ' + perm + '). Ask the user via local_folder {action:"request", folder:"' + r.id + '"} or from its card on the Documents page.', 'PERMISSION_REQUIRED');
    }
    return { entry: _lfPublic(r, perm), root: r.handle };
}
function _lfAssertWritable(entry) {
    if (entry.access !== 'readwrite') throw _lfErr('Folder "' + entry.label + '" is connected READ-ONLY — writes are refused. The user can change its access from its card on the Documents page.', 'READ_ONLY');
}
// Approval gates (ui/150, worker/120): true ONLY when args is a
// write/mkdir/delete on a REGISTERED real folder whose access is 'read' —
// the tool refuses it with READ_ONLY, so no approval prompt is needed.
// Virtual, unknown, readwrite or unreadable registry → false (keep asking).
// Registry lookup only; never queries handle permission.
async function lfIsReadOnlyWriteTarget(args) {
    if (!args || (args.action !== 'write' && args.action !== 'mkdir' && args.action !== 'delete')) return false;
    var ref = args.folder;
    if (ref == null || ref === '' || ref === LOCAL_FOLDER_VIRTUAL_ID || (typeof ref === 'string' && ref.toLowerCase() === LOCAL_FOLDER_VIRTUAL_LABEL.toLowerCase())) return false;
    try {
        var r = await _lfFindRow(String(ref));
        return !!(r && r.access === 'read');
    } catch (e) { return false; }
}
// Map a File System Access failure for `label` (kind 'dir' | 'file').
// SecurityError / "not a function" are rethrown UNCHANGED (the SW→panel
// fallback, lfIsApiUnavailableError, depends on them). NotAllowedError is
// ALSO rethrown raw inside the service worker (same fallback: the panel can
// re-check/re-grant permission); anywhere else it maps to PERMISSION_REQUIRED.
function lfMapHandleError(e, kind, label) {
    var n = e && e.name;
    if (n === 'SecurityError' || /not a function/i.test((e && e.message) || '')) return e;
    if (n === 'NotAllowedError') {
        if (lfInServiceWorker()) return e;
        return _lfErr('Permission denied for ' + label + ' — re-grant access via local_folder {action:"request"} or from its card on the Documents page.', 'PERMISSION_REQUIRED');
    }
    if (n === 'TypeMismatchError') {
        return kind === 'dir'
            ? _lfErr('Not a directory: ' + label, 'NOT_A_DIRECTORY')
            : _lfErr('Not a file (is a directory): ' + label, 'NOT_A_FILE');
    }
    return _lfErr((kind === 'dir' ? 'Directory not found: ' : 'File not found: ') + label, 'NOT_FOUND');
}
async function _lfDirAt(root, segs, create) {
    var d = root;
    for (var i = 0; i < segs.length; i++) {
        try { d = await d.getDirectoryHandle(segs[i], { create: !!create }); }
        catch (e) { throw lfMapHandleError(e, 'dir', segs.slice(0, i + 1).join('/')); }
    }
    return d;
}
async function _lfFileAt(root, segs, create) {
    if (!segs.length) throw _lfErr('path must name a file', 'BAD_PATH');
    var dir = await _lfDirAt(root, segs.slice(0, -1), create);
    try { return await dir.getFileHandle(segs[segs.length - 1], { create: !!create }); }
    catch (e) { throw lfMapHandleError(e, 'file', segs.join('/')); }
}
async function _lfChildren(dir) {
    var out = [];
    if (typeof dir.values === 'function') { for await (var h of dir.values()) out.push(h); }
    else if (typeof dir.entries === 'function') { for await (var pair of dir.entries()) out.push(pair[1]); }
    out.sort(function(a, b) { return a.kind === b.kind ? (a.name < b.name ? -1 : 1) : (a.kind === 'directory' ? -1 : 1); });
    return out;
}

// ─── byte helpers ───────────────────────────────────────────────────
function lfBytesToBase64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}
function lfBase64ToBytes(b64) {
    var raw = String(b64 || '');
    var comma = raw.indexOf(',');
    if (/^data:/i.test(raw) && comma !== -1) raw = raw.slice(comma + 1);
    raw = raw.replace(/\s+/g, '');
    var bin = atob(raw);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}
function _lfDataUrlMime(s) { var m = /^data:([^;,]+)[;,]/i.exec(s || ''); return m ? m[1] : null; }
// File-store data (data URL for binary, plain string for text) → bytes.
function lfFileDataToBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    var s = String(data == null ? '' : data);
    if (/^data:[^,]*;base64,/i.test(s)) return lfBase64ToBytes(s);
    if (/^data:[^,]*,/i.test(s)) return new TextEncoder().encode(decodeURIComponent(s.slice(s.indexOf(',') + 1)));
    return new TextEncoder().encode(s);
}
function lfIsBinary(name, bytes) {
    var ext = _lfExt(name);
    if (LF_TEXT_EXTS[ext]) return false;
    if (LF_BINARY_EXTS[ext]) return true;
    if (!bytes) return false;
    var n = Math.min(bytes.length, 8000);
    for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
    // stream:true tolerates a multi-byte sequence cut at the sample boundary,
    // so any decode error is genuinely invalid UTF-8 → binary.
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n), { stream: true }); } catch (e) { return true; }
    return false;
}

// ─── file ops (usable from any realm) ───────────────────────────────
async function lfListDir(folder, path, opts) {
    opts = opts || {};
    var f = await lfResolveFolder(folder);
    var base = lfNormalizePath(path);
    var max = Math.min(opts.limit || LF_LIMITS.lsMax, LF_LIMITS.lsMax);
    var out = [], truncated = false;
    async function walk(dir, prefix, depth) {
        var kids = await _lfChildren(dir);
        for (var i = 0; i < kids.length; i++) {
            if (out.length >= max) { truncated = true; return; }
            var h = kids[i], p = prefix ? prefix + '/' + h.name : h.name;
            var row = { name: h.name, path: p, kind: h.kind };
            if (h.kind === 'file') {
                try { var file = await h.getFile(); row.size = file.size; row.lastModified = file.lastModified; } catch (e) {}
            }
            out.push(row);
            if (h.kind === 'directory' && opts.recursive && !LF_SKIP_DIRS[h.name] && depth < 20) await walk(h, p, depth + 1);
        }
    }
    await walk(await _lfDirAt(f.root, _lfSegs(base), false), base, 0);
    return { folder: f.entry.id, path: base, entries: out, truncated: truncated };
}
async function lfReadFileBytes(folder, path) {
    var f = await lfResolveFolder(folder);
    var segs = _lfSegs(path);
    var fh = await _lfFileAt(f.root, segs, false);
    var file = await fh.getFile();
    if (file.size > LF_LIMITS.maxReadBytes) throw _lfErr('File is ' + file.size + ' bytes — over the ' + LF_LIMITS.maxReadBytes + '-byte read limit', 'TOO_LARGE');
    var bytes = new Uint8Array(await file.arrayBuffer());
    var name = segs[segs.length - 1];
    return { bytes: bytes, name: name, path: segs.join('/'), mime: lfMimeOf(bytes, file.type || lfGuessMime(name)), size: bytes.length, lastModified: file.lastModified, folder: f.entry.id };
}
// Magic-byte MIME (sniffMime, tools/040-file-store.js) with an extension /
// File.type fallback — a JPEG saved as x.png reports image/jpeg.
function lfMimeOf(bytes, fallback) {
    var sn = _lfDeps.sniffMime || (typeof sniffMime === 'function' ? sniffMime : null);
    var m = (sn && bytes) ? sn(bytes.subarray ? bytes.subarray(0, 32) : bytes) : null;
    return m || fallback || 'application/octet-stream';
}
// Metadata + the first `headBytes` bytes only (no full read) — backs the lazy
// folder pointers local_folder read registers for binary files.
async function lfStatFile(folder, path, headBytes) {
    var f = await lfResolveFolder(folder);
    var segs = _lfSegs(path);
    var fh = await _lfFileAt(f.root, segs, false);
    var file = await fh.getFile();
    var n = headBytes || 8000;
    var head = typeof file.slice === 'function' ? new Uint8Array(await file.slice(0, n).arrayBuffer()) : new Uint8Array(await file.arrayBuffer()).subarray(0, n);
    var name = segs[segs.length - 1];
    return { head: head, name: name, path: segs.join('/'), mime: lfMimeOf(head, file.type || lfGuessMime(name)), size: file.size, lastModified: file.lastModified, folder: f.entry.id };
}
// The File itself (a Blob) WITHOUT reading it: previews hand it to
// URL.createObjectURL, so large media / PDFs never load into memory and the
// maxReadBytes cap does not apply. mime: magic bytes of the first 32 bytes.
async function lfGetFile(folder, path) {
    var f = await lfResolveFolder(folder);
    var segs = _lfSegs(path);
    var fh = await _lfFileAt(f.root, segs, false);
    var file = await fh.getFile();
    var name = segs[segs.length - 1];
    var head = typeof file.slice === 'function' ? new Uint8Array(await file.slice(0, 32).arrayBuffer()) : null;
    return { file: file, name: name, path: segs.join('/'), mime: lfMimeOf(head, file.type || lfGuessMime(name)), size: file.size, folder: f.entry.id };
}
async function lfReadFileAsDataUrl(folder, path) {
    var r = await lfReadFileBytes(folder, path);
    return { data_url: 'data:' + r.mime + ';base64,' + lfBytesToBase64(r.bytes), name: r.name, mime: r.mime, size: r.size };
}
async function lfWriteFileBytes(folder, path, bytes, opts) {
    opts = opts || {};
    var f = await lfResolveFolder(folder, 'readwrite');
    _lfAssertWritable(f.entry);
    var segs = _lfSegs(path);
    var fh = await _lfFileAt(f.root, segs, true);
    if (opts.append) {
        var prev = new Uint8Array(await (await fh.getFile()).arrayBuffer());
        var joined = new Uint8Array(prev.length + bytes.length);
        joined.set(prev, 0); joined.set(bytes, prev.length);
        bytes = joined;
    }
    if (typeof fh.createWritable !== 'function') throw _lfErr('Writing files is not supported in this context', 'NO_WRITE_API');
    var w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return { folder: f.entry.id, path: segs.join('/'), size: bytes.length };
}
async function lfMkdir(folder, path) {
    var f = await lfResolveFolder(folder, 'readwrite');
    _lfAssertWritable(f.entry);
    var segs = _lfSegs(path);
    if (!segs.length) throw _lfErr('path is required', 'BAD_PATH');
    await _lfDirAt(f.root, segs, true);
    return true;
}
async function lfDeleteEntry(folder, path, recursive) {
    var f = await lfResolveFolder(folder, 'readwrite');
    _lfAssertWritable(f.entry);
    var segs = _lfSegs(path);
    if (!segs.length) throw _lfErr('Refusing to delete the folder root', 'BAD_PATH');
    var parent = await _lfDirAt(f.root, segs.slice(0, -1), false);
    try { await parent.removeEntry(segs[segs.length - 1], { recursive: !!recursive }); }
    catch (e) { throw _lfErr('Delete failed for ' + segs.join('/') + ': ' + (e && e.message || e) + (recursive ? '' : ' (non-empty directory? pass recursive:true)'), (e && e.name === 'NotFoundError') ? 'NOT_FOUND' : 'DELETE_FAILED'); }
    return true;
}
async function lfGrep(folder, path, pattern, opts) {
    opts = opts || {};
    if (!pattern) throw _lfErr('pattern is required', 'BAD_ARGS');
    var src = String(pattern), flags = opts.ignore_case === false ? '' : 'i';
    if (src.indexOf('(?i)') === 0) { src = src.slice(4); flags = 'i'; }
    var re;
    try { re = new RegExp(src, flags); } catch (e) { throw _lfErr('Invalid regex: ' + e.message, 'BAD_ARGS'); }
    var f = await lfResolveFolder(folder);
    var base = lfNormalizePath(path);
    var maxMatches = Math.min(opts.limit || LF_LIMITS.grepDefaultMatches, LF_LIMITS.grepMaxMatches);
    var matches = [], scanned = 0, skipped = 0, truncated = false;
    async function scanFile(h, p) {
        if (scanned >= LF_LIMITS.grepMaxFiles) { truncated = true; return; }
        if (LF_BINARY_EXTS[_lfExt(h.name)]) { skipped++; return; }
        var file = await h.getFile();
        if (file.size > LF_LIMITS.grepMaxFileBytes) { skipped++; return; }
        var bytes = new Uint8Array(await file.arrayBuffer());
        if (lfIsBinary(h.name, bytes)) { skipped++; return; }
        scanned++;
        var lines = new TextDecoder().decode(bytes).split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                if (matches.length >= maxMatches) { truncated = true; return; }
                matches.push({ path: p, line: i + 1, text: lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i] });
            }
        }
    }
    async function walk(dir, prefix) {
        var kids = await _lfChildren(dir);
        for (var i = 0; i < kids.length && !truncated; i++) {
            var h = kids[i], p = prefix ? prefix + '/' + h.name : h.name;
            if (h.kind === 'directory') { if (!LF_SKIP_DIRS[h.name]) await walk(h, p); }
            else await scanFile(h, p);
        }
    }
    var segs = _lfSegs(base);
    var target = f.root;
    if (segs.length) {
        try { target = await _lfDirAt(f.root, segs, false); }
        catch (e) { await scanFile(await _lfFileAt(f.root, segs, false), base); target = null; }
    }
    if (target) await walk(target, base);
    return { folder: f.entry.id, matches: matches, total: matches.length, files_scanned: scanned, files_skipped: skipped, truncated: truncated };
}

// ─── file-store bridge ──────────────────────────────────────────────
// Registers through the unified registerFile (tools/040-file-store.js) and
// waits for the IndexedDB write, so the other realm (SW <-> panel) can
// resolve the file_id as soon as this tool returns.
async function _lfRegister(pointer) {
    var nid = _lfDeps.newFileId || (typeof newFileId === 'function' ? newFileId : null);
    var reg = _lfDeps.registerFile || (typeof registerFile === 'function' ? registerFile : null);
    if (!nid || !reg) throw _lfErr('File store unavailable', 'NO_FILE_STORE');
    var id = nid();
    reg(id, pointer);
    var ready = _lfDeps.registerFileReady || (typeof registerFileReady === 'function' ? registerFileReady : null);
    if (ready) await ready(id);
    return id;
}
async function _lfGetStoreFile(fileId) {
    var get = _lfDeps.getFileAsync || (typeof getFileAsync === 'function' ? getFileAsync : null);
    if (!get) throw _lfErr('File store unavailable', 'NO_FILE_STORE');
    var f = await get(fileId);
    if (!f || f.data == null) throw _lfErr('File not found: ' + fileId + ' (file_ids live in the realm that created them — use one from local_folder read, web_fetch save_file, take_screenshot, …)', 'NOT_FOUND');
    return f;
}
function _lfParseSource(src) {
    if (typeof src === 'string') { try { src = JSON.parse(src); } catch (e) { throw _lfErr('source must be an object {folder, path}', 'BAD_ARGS'); } }
    if (!src || typeof src !== 'object' || !src.path) throw _lfErr('source must be an object {folder, path}', 'BAD_ARGS');
    return src;
}
// A source:{folder,path} read made on behalf of ANOTHER tool (servicenow_api
// attachment_source, web_fetch body_source/form, local_folder write source)
// must honour the local_folder:read permission exactly like a direct
// local_folder {action:'read'} call: Off → refused, Ask → approval prompt.
// Uses requestProgrammaticToolApproval (page: ui/150, SW: worker/120 — both
// define it); falls back to the stored permission when neither is loaded.
async function lfAuthorizeSourceRead(folder, path, options) {
    options = options || {};
    var args = { action: 'read', folder: folder, path: path };
    var where = '"' + (path || '') + '" in folder "' + (folder == null || folder === '' ? LOCAL_FOLDER_VIRTUAL_ID : folder) + '"';
    var approve = _lfDeps.approve || (typeof requestProgrammaticToolApproval === 'function' ? requestProgrammaticToolApproval : null);
    if (approve) {
        var res = await approve('local_folder', args, options);
        if (!res || !res.allowed) {
            throw _lfErr('Reading ' + where + ' was not permitted (local_folder:read): ' + ((res && res.error) || 'denied by the user') + '.', 'PERMISSION_DENIED');
        }
        return true;
    }
    var getPerm = _lfDeps.getToolPermission || (typeof getToolPermission === 'function' ? getToolPermission : null);
    var p = getPerm ? getPerm('local_folder', 'read', options.chatId) : 'allow';
    if (p === 'disabled') throw _lfErr('Reading ' + where + ' is refused: local_folder:read is Off in Settings > Tool permissions.', 'PERMISSION_DENIED');
    if (p === 'ask') throw _lfErr('Reading ' + where + ' needs approval (local_folder:read is Ask) but no approval prompt is available here.', 'PERMISSION_DENIED');
    return true;
}
// Resolve binary input from ONE of { file_id, source:{folder,path}, base64 (raw or data URL), content (text) }
// → { bytes: Uint8Array, name, mime }. Used by local_folder write, servicenow_api, web_fetch.
// options = the calling tool's execution options (chatId …) — source reads
// are permission-gated via lfAuthorizeSourceRead.
async function lfResolveBinaryInput(input, options) {
    input = input || {};
    if (input.file_id) {
        // Unified path: resolveFile -> {blob, name, mime} (blob, folder pointer
        // or location pointer), no base64 round-trip.
        var rf = _lfDeps.resolveFile || (!_lfDeps.getFileAsync && typeof resolveFile === 'function' ? resolveFile : null);
        if (rf) {
            var x = await rf(input.file_id);
            if (!x) throw _lfErr('File not found: ' + input.file_id + ' (use a file_id from local_folder read, web_fetch save_file, take_screenshot, get_file, …)', 'NOT_FOUND');
            var xb = x.bytes || new Uint8Array(await x.blob.arrayBuffer());
            return { bytes: xb, name: x.name || null, mime: lfMimeOf(xb, x.mime) };
        }
        var f = await _lfGetStoreFile(input.file_id);
        var fm = (typeof f.data === 'string' && _lfDataUrlMime(f.data)) || f.mime || lfGuessMime(f.name);
        return { bytes: lfFileDataToBytes(f.data), name: f.name || null, mime: fm };
    }
    if (input.source) {
        var s = _lfParseSource(input.source);
        await lfAuthorizeSourceRead(s.folder, s.path, options);
        var r = await lfReadFileBytes(s.folder, s.path);
        return { bytes: r.bytes, name: r.name, mime: r.mime };
    }
    if (input.base64 != null && input.base64 !== '') {
        return { bytes: lfBase64ToBytes(input.base64), name: null, mime: _lfDataUrlMime(String(input.base64)) || null };
    }
    if (input.content != null) return { bytes: new TextEncoder().encode(String(input.content)), name: null, mime: 'text/plain' };
    throw _lfErr('No data: pass one of content, base64, file_id or source {folder, path}', 'BAD_ARGS');
}

// web_fetch: a clear error string when the body options conflict, else null.
// form/body_file_id/body_source/body_base64 need POST/PUT/PATCH and are
// mutually exclusive with the string `body`.
function lfFetchBodyConflict(args) {
    args = args || {};
    var alt = [];
    if (args.form) alt.push('form');
    if (args.body_file_id) alt.push('body_file_id');
    if (args.body_source) alt.push('body_source');
    if (args.body_base64 != null && args.body_base64 !== '') alt.push('body_base64');
    if (!alt.length) return null;
    var method = String(args.method || 'GET').toUpperCase();
    if (args.body != null && args.body !== '') return 'Conflicting request bodies: pass either body OR ' + alt.join('/') + ', not both.';
    if (alt.length > 1) return 'Conflicting request bodies: pass only one of ' + alt.join(', ') + '.';
    if (['POST', 'PUT', 'PATCH'].indexOf(method) === -1) return alt[0] + ' needs method POST, PUT or PATCH (got ' + method + ').';
    return null;
}
// web_fetch body builder. Returns null when no binary/form body option is set
// (legacy string `body` path stays untouched). { body, contentType|null, multipart }.
// form: { field: "text" | {file_id|folder+path|source|base64, filename?, content_type?} }
async function lfBuildFetchBody(args, options) {
    args = args || {};
    if (args.form && typeof args.form === 'object') {
        var fd = new FormData();
        var keys = Object.keys(args.form);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i], v = args.form[k];
            if (v == null) continue;
            if (typeof v !== 'object') { fd.append(k, String(v)); continue; }
            var src = v.source || (v.path ? { folder: v.folder, path: v.path } : null);
            var bin = await lfResolveBinaryInput({ file_id: v.file_id, source: src, base64: v.base64, content: v.content }, options);
            var mime = v.content_type || bin.mime || lfGuessMime(v.filename || bin.name);
            fd.append(k, new Blob([bin.bytes], { type: mime }), v.filename || bin.name || k);
        }
        return { body: fd, contentType: null, multipart: true };
    }
    if (args.body_file_id || args.body_source || (args.body_base64 != null && args.body_base64 !== '')) {
        var b = await lfResolveBinaryInput({ file_id: args.body_file_id, source: args.body_source, base64: args.body_base64 }, options);
        return { body: b.bytes, contentType: args.content_type || args.body_content_type || b.mime || 'application/octet-stream', multipart: false, size: b.bytes.length };
    }
    return null;
}

// ─── tool entry ─────────────────────────────────────────────────────
async function _lfRequest(args, options) {
    var prompt = _lfDeps.promptUser || (typeof executePromptUser === 'function' ? executePromptUser : null);
    if (!prompt) return { success: false, error: 'request must run in the side panel (no prompt_user here)' };
    var reason = args.reason ? String(args.reason) : '';
    // m8: the virtual folder's label ("Agent Files") is accepted like its id,
    // matching lfResolveFolder.
    var _lfIsVirtual = args.folder === LOCAL_FOLDER_VIRTUAL_ID || (typeof args.folder === 'string' && args.folder.toLowerCase() === String(LOCAL_FOLDER_VIRTUAL_LABEL).toLowerCase());
    if (args.folder && !_lfIsVirtual) {
        var row = await _lfFindRow(String(args.folder));
        if (!row) return { success: false, error: 'Unknown folder "' + args.folder + '"' };
        var cur = await _lfPermissionOf(row.handle, row.access, false);
        if (cur === 'granted') return { success: true, folder: _lfPublic(row, cur), already_granted: true };
        // requestPermission starts INSIDE the Submit click (gesture hook).
        var regrantOpts = Object.assign({}, options || {}, { onSubmitSync: function() {
            return typeof row.handle.requestPermission === 'function' ? row.handle.requestPermission({ mode: _lfMode(row.access) }) : Promise.resolve('none');
        } });
        var rr = await prompt({ title: 'Re-grant access to folder "' + row.label + '"', description: (reason ? reason + '\n\n' : '') + 'Submit, then allow access in the browser prompt.', fields: [{ name: 'confirm', type: 'boolean', label: 'Re-grant ' + (row.access === 'readwrite' ? 'read/write' : 'read-only') + ' access', value: true }] }, regrantOpts);
        var rp = { _message_persist: rr && rr._message_persist };
        if (!rr || !rr.success) return Object.assign(rp, { success: false, cancelled: true, error: 'User cancelled' });
        var st;
        if (rr.gesture) { try { st = await rr.gesture; } catch (e) { st = 'denied'; } }
        else st = await _lfPermissionOf(row.handle, row.access, true);
        if (st !== 'granted') return Object.assign(rp, { success: false, permission: st, folder: _lfPublic(row, st), error: 'Access was not granted (' + st + ') — the user can re-grant it from its card on the Documents page.' });
        return Object.assign(rp, { success: st === 'granted', permission: st, folder: _lfPublic(row, st) });
    }
    var access = args.access === 'readwrite' ? 'readwrite' : 'read';
    function _chosenAccess(vals) { vals = vals || {}; return vals.access === 'readwrite' ? 'readwrite' : (vals.access === 'read' ? 'read' : access); }
    // The picker opens SYNCHRONOUSLY inside the Submit click (prompt_user
    // onSubmitSync hook) so the user activation is not lost across awaits.
    var pickOpts = Object.assign({}, options || {}, { onSubmitSync: function(vals) {
        // No label field: the folder is named after its directory handle (addLocalFolder).
        return pickLocalFolder(_chosenAccess(vals), args.label || '');
    } });
    var res = await prompt({
        title: 'Connect a folder',
        description: (reason ? reason + '\n\n' : '') + 'Submit, then choose the folder in the browser picker.',
        fields: [
            { name: 'access', type: 'select', label: 'Access', options: [{ value: 'read', label: 'Read only' }, { value: 'readwrite', label: 'Read & write' }], value: access }
        ]
    }, pickOpts);
    var persist = { _message_persist: res && res._message_persist };
    if (!res || !res.success) return Object.assign(persist, { success: false, cancelled: true, error: 'User cancelled' });
    var vals = res.values || {};
    var chosen = _chosenAccess(vals);
    try {
        // No gesture result = submitted from another panel: best-effort late picker.
        var entry = res.gesture ? await res.gesture : await pickLocalFolder(chosen, args.label || '');
        if (!entry) return Object.assign(persist, { success: false, cancelled: true, error: 'User cancelled the folder picker' });
        return Object.assign(persist, { success: true, folder: entry });
    } catch (e) {
        return Object.assign(persist, { success: false, error: 'Folder picker failed: ' + (e && e.message || e) + ' — the user can connect it from the Documents page (Connect folder card) instead.' });
    }
}

var LF_DATA_URL_MAX_CHARS = 1024 * 1024;
async function executeLocalFolder(args, options) {
    args = args || {};
    var action = args.action;
    try {
        if (action === 'list') return { success: true, folders: await listLocalFolders() };
        if (action === 'request') return await _lfRequest(args, options);
        if (action === 'ls') return Object.assign({ success: true }, await lfListDir(args.folder, args.path, { recursive: !!args.recursive, limit: args.limit }));
        if (action === 'grep') return Object.assign({ success: true }, await lfGrep(args.folder, args.path, args.pattern, { ignore_case: args.ignore_case, limit: args.limit }));
        if (action === 'mkdir') { await lfMkdir(args.folder, args.path); return { success: true, path: lfNormalizePath(args.path) }; }
        if (action === 'delete') { await lfDeleteEntry(args.folder, args.path, !!args.recursive); return { success: true, deleted: lfNormalizePath(args.path) }; }
        if (action === 'read') {
            var wantB64 = args.encoding === 'base64';
            var st = await lfStatFile(args.folder, args.path);
            var binary = lfIsBinary(st.name, st.head);
            var out = { success: true, folder: st.folder, path: st.path, name: st.name, mime: st.mime, mime_type: st.mime, size: st.size, binary: binary };
            // Text (and base64/panel-fallback) reads need the bytes; a plain
            // binary read only registers a lazy folder pointer.
            var r = (!binary || wantB64 || args._lf_panel_fallback) ? await lfReadFileBytes(args.folder, args.path) : null;
            if (binary || wantB64 || args.save_file) {
                // Panel fallback ran because the SW cannot open this handle,
                // so a SW-side lazy pointer would not resolve: store a Blob copy.
                out.file_id = args._lf_panel_fallback
                    ? await _lfRegister({ type: 'memory', data: r.bytes, name: st.name, mime: st.mime })
                    : await _lfRegister({ kind: 'folder', type: 'folder', folder: st.folder, path: st.path, name: st.name, size: st.size, mime: st.mime, lastModified: st.lastModified });
                var dataUrl = (wantB64 && r) ? 'data:' + st.mime + ';base64,' + lfBytesToBase64(r.bytes) : '';
                if (wantB64) {
                    // Cap the inline data_url (~1 MB) — larger payloads flood the
                    // context; the file_id carries the full bytes.
                    if (dataUrl.length <= LF_DATA_URL_MAX_CHARS) out.data_url = dataUrl;
                    else { out.data_url_omitted = true; out.note = 'data_url omitted: the encoded file is ' + dataUrl.length + ' chars (over ~1 MB). Use file_id instead (servicenow_api attachment_file_id, web_fetch body_file_id / form, get_file).'; }
                }
                else if (binary) out.hint = 'Binary file saved to the file store: pass file_id to servicenow_api (attachment_file_id), web_fetch (body_file_id / form), or get_file {attach:true} to view it.';
            }
            if (!binary && !wantB64) {
                var text = new TextDecoder().decode(r.bytes);
                if (text.length > LF_LIMITS.maxTextChars) { out.content = text.slice(0, LF_LIMITS.maxTextChars); out.truncated = true; }
                else out.content = text;
            }
            return out;
        }
        if (action === 'write') {
            // READ_ONLY before resolving the input (no source-read approval).
            if (await lfIsReadOnlyWriteTarget(args)) _lfAssertWritable(await _lfFindRow(String(args.folder)));
            var src = args.source || null;
            var bin = await lfResolveBinaryInput({ file_id: args.file_id, source: src, base64: args.base64, content: args.content }, options);
            var w = await lfWriteFileBytes(args.folder, args.path, bin.bytes, { append: !!args.append });
            return Object.assign({ success: true }, w);
        }
        return { success: false, error: 'Unknown action "' + action + '". Use list, ls, read, grep, write, mkdir, delete or request.' };
    } catch (e) {
        var msg = (e && e.message) || String(e);
        if (lfShouldRouteToPanel(e, { inServiceWorker: lfInServiceWorker(), action: action, alreadyRouted: !!args._lf_panel_fallback })) {
            return { success: false, _route_to_panel: true, code: (e && e.code) || (e && e.name) || 'SW_UNSUPPORTED', error: 'local_folder ' + action + ' is not supported in the service worker (' + msg + ').' };
        }
        return { success: false, error: msg, code: (e && e.code) || undefined };
    }
}
