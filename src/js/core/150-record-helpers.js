// =============================================================
// ServiceNow record helpers — DOM-free, shared across page + SW.
//
// Three helpers that the diff-edit and servicenow_api tool paths
// call to capture a before/after snapshot of mutated records:
//
//   • getRecordScope(table, sysId)        — sys_scope for cross-scope PUTs
//   • getRecordVersion(table, sysId)      — latest sys_update_version sys_id
//   • getRecordDisplayValue(table, sysId) — best-effort display label
//
// All three are pure async fetchers. They were originally page-only
// (defined in ui/090-version-history.js using window.sessionToken)
// and shimmed in the SW (worker/020-page-stubs.js). Consolidated here
// so both contexts call the same impl: token via Platform.getSessionToken(),
// optional instance prefix via Platform.instanceUrl when the SW is talking
// to a non-default instance (page context resolves relative URLs through
// the fetch interceptor — Platform.instanceUrl is also set on the page,
// so the prefix is harmless there).
// =============================================================

var _recValidTable = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
var _recValidSysId = /^[0-9a-fA-F]{32}$/;

// Optional `target` ({instanceUrl, token}) points the helpers at a NON-active
// instance so cross-instance mutations can be version-tracked too (they were
// previously skipped entirely and never reached the sidebar Artifacts list).
function _recHeaders(target) {
    return {
        'X-UserToken': (target && target.token) || (typeof Platform !== 'undefined' && Platform.getSessionToken && Platform.getSessionToken()) || '',
        'Accept': 'application/json'
    };
}

function _recFetchOpts(target) {
    var o = { headers: _recHeaders(target) };
    if (target && target.instanceUrl) o.credentials = 'include';
    return o;
}

function _recPrefix(target) {
    if (target && target.instanceUrl) return String(target.instanceUrl).replace(/\/+$/, '');
    return (typeof Platform !== 'undefined' && Platform.instanceUrl) || '';
}

// ---- Instance identity of version-history entries (page + SW) ----
// Entries may carry `instanceUrl` (set for writes on a non-active instance).
// ONE key function decides record identity everywhere (sidebar grouping,
// revert/redo/diff lookups): normalized origin, and a missing value or the
// active instance both map to '' so an untagged entry and an entry stamped
// with the active URL (e.g. while the active URL was still unknown) merge.
function normalizeInstanceUrl(u) {
    if (!u) return '';
    var s = String(u).trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s).origin.toLowerCase(); }
    catch (e) { return s.toLowerCase().replace(/\/+$/, ''); }
}

function _recActiveInstanceUrl() {
    var a = '';
    try {
        if (typeof Platform !== 'undefined' && Platform) {
            a = Platform.instanceUrl || (typeof Platform.resolveInstanceUrl === 'function' ? Platform.resolveInstanceUrl(null) : '') || '';
        }
    } catch (e) { a = ''; }
    return normalizeInstanceUrl(a);
}

// '' = the active instance (or unknown/missing); otherwise the normalized origin.
function recordInstanceKey(instanceUrl) {
    var n = normalizeInstanceUrl(instanceUrl);
    if (!n) return '';
    return n === _recActiveInstanceUrl() ? '' : n;
}

// Value to STORE on a new entry: always the normalized origin (the entry's own
// instance, else the CURRENT active one), so an entry written while A was
// active still targets A after the user switches to B. recordInstanceKey()
// keeps mapping a stored active origin to '' for grouping/merging with legacy
// untagged entries. undefined only when no origin is known at all.
function recordStoredInstanceUrl(instanceUrl) {
    return normalizeInstanceUrl(instanceUrl) || _recActiveInstanceUrl() || undefined;
}

function recordEntryKey(entry) {
    if (!entry) return '';
    return recordInstanceKey(entry.instanceUrl) + '|' + entry.table + '_' + entry.sysId;
}

function isSameRecordEntry(v, table, sysId, instanceUrl) {
    return !!v && v.table === table && v.sysId === sysId &&
        recordInstanceKey(v.instanceUrl) === recordInstanceKey(instanceUrl);
}

// Resolve where a sidebar action for an entry must go. The STORED origin is
// compared to the CURRENT active instance at action time (recordInstanceKey):
// legacy untagged entries and the active origin → active; any other origin
// (incl. an entry stored while it was active) → that instance. Active instance →
// {active:true} (relative URLs, session token). Other instance → its origin +
// a token from Platform.getTokenForInstance (same as the tools). Returns null
// when no token can be obtained — callers MUST refuse rather than fall back
// to the active instance (the same sys_id may exist there).
async function resolveRecordTarget(instanceUrl) {
    var key = recordInstanceKey(instanceUrl);
    if (!key) {
        return { active: true, instanceUrl: '', token: (typeof Platform !== 'undefined' && Platform.getSessionToken && Platform.getSessionToken()) || '' };
    }
    var token = '';
    try {
        if (typeof Platform !== 'undefined' && typeof Platform.getTokenForInstance === 'function') {
            token = (await Platform.getTokenForInstance(key)) || '';
        }
    } catch (e) { token = ''; }
    if (!token) return null;
    return { active: false, instanceUrl: key, token: token };
}

// fetch() a ServiceNow path ('/api/now/...') on a resolved target. Active →
// relative URL (the page fetch interceptor adds token + credentials);
// otherwise absolute URL with the target's token and credentials.
function recordFetch(target, path, opts) {
    opts = Object.assign({}, opts || {});
    if (!target || target.active || !target.instanceUrl) {
        var h0 = Object.assign({}, opts.headers || {});
        if (!h0['X-UserToken']) h0['X-UserToken'] = (target && target.token) || (typeof window !== 'undefined' && window.sessionToken) || '';
        opts.headers = h0;
        return fetch(path, opts);
    }
    var h = Object.assign({}, opts.headers || {});
    h['X-UserToken'] = target.token;
    opts.headers = h;
    opts.credentials = 'include';
    return fetch(target.instanceUrl + path, opts);
}

async function getRecordScope(table, sysId, target) {
    if (!sysId || !table) return null;
    if (!_recValidTable.test(table) || !_recValidSysId.test(sysId)) return null;
    try {
        var url = _recPrefix(target) + '/api/now/table/' + table + '/' + sysId + '?sysparm_fields=sys_scope';
        var res = await fetch(url, target && target.instanceUrl
            ? { headers: _recHeaders(target), credentials: 'include' }
            : { headers: _recHeaders() });
        if (!res.ok) return null;
        var data = await res.json();
        if (data && data.result && data.result.sys_scope) {
            return data.result.sys_scope.value || data.result.sys_scope;
        }
    } catch (e) {
        console.error('Failed to get record scope:', e);
    }
    return null;
}

async function getRecordVersion(table, sysId, target) {
    if (!sysId || !_recValidTable.test(table) || !_recValidSysId.test(sysId)) return null;
    try {
        var url = _recPrefix(target) + '/api/now/table/sys_update_version?sysparm_query=name=' + table + '_' + sysId +
            '^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,sys_created_on,state&sysparm_limit=1';
        var res = await fetch(url, _recFetchOpts(target));
        var data = await res.json();
        if (data && data.result && data.result[0]) return data.result[0];
    } catch (e) {
        console.error('Failed to get record version:', e);
    }
    return null;
}

// ---- maint detection (single source of truth: page + SW; used by
// background.js snGetInstancesDetailed, platform-bridge _ensureActiveRoles,
// tools/020 _rsCheckAdmin + list_instances). The `maint` login is not a
// sys_user and has no roles, yet has MORE access than admin.
// snMaintEligible: probe ONLY when the roles probe SUCCEEDED with 0 roles and
// no user name is known (or it is literally 'maint') — users with roles, a
// known name, or a failed roles probe never trigger a request.
// snDetectMaint: ONE request to an admin-only-OOB table (sys_properties read
// ACL requires admin; user_admin/ESS get 403 or ACL-filtered 0 rows): maint iff
// HTTP 200 with >= 1 row. 401/403/empty/error body/network => false.
// Cached per instance URL + session token (a token/user switch re-probes);
// network errors are not cached.
var SN_MAINT_PROBE_PATH = '/api/now/table/sys_properties?sysparm_limit=1&sysparm_fields=sys_id';
var _snMaintCache = {};
function snMaintEligible(roles, rolesProbeOk, userName) {
    return !!rolesProbeOk && Array.isArray(roles) && roles.length === 0 && (!userName || userName === 'maint');
}
function _snMaintKey(instanceUrl, token) {
    return String(instanceUrl || '').replace(/\/+$/, '') + '|' + String(token || '');
}
function snMaintCached(instanceUrl, token) {
    var k = _snMaintKey(instanceUrl, token);
    return Object.prototype.hasOwnProperty.call(_snMaintCache, k) ? _snMaintCache[k] : undefined;
}
async function snDetectMaint(instanceUrl, token, fetchFn) {
    var k = _snMaintKey(instanceUrl, token);
    if (Object.prototype.hasOwnProperty.call(_snMaintCache, k)) return _snMaintCache[k];
    var f = fetchFn || function(u, o) { return fetch(u, o); };
    var res;
    try {
        res = await f(String(instanceUrl || '').replace(/\/+$/, '') + SN_MAINT_PROBE_PATH, {
            method: 'GET', credentials: 'include',
            headers: { 'Accept': 'application/json', 'X-UserToken': token || '' }
        });
    } catch (e) { return false; } // transient: not cached
    var ok = false;
    try {
        if (res && res.ok) {
            var data = await res.json();
            ok = !!(data && Array.isArray(data.result) && data.result.length >= 1);
        }
    } catch (e2) { ok = false; }
    _snMaintCache[k] = ok;
    return ok;
}

async function getRecordDisplayValue(table, sysId, target) {
    if (!sysId || !_recValidTable.test(table) || !_recValidSysId.test(sysId)) {
        return sysId ? sysId.substring(0, 8) : '';
    }
    try {
        var url = _recPrefix(target) + '/api/now/table/' + table + '/' + sysId +
            '?sysparm_fields=sys_id,name,number,short_description&sysparm_limit=1';
        var res = await fetch(url, _recFetchOpts(target));
        var data = await res.json();
        if (data && data.result) {
            return data.result.name || data.result.number || data.result.short_description || sysId.substring(0, 8);
        }
    } catch (e) {
        console.error('Failed to get record display value:', e);
    }
    return sysId ? sysId.substring(0, 8) : 'New Record';
}
