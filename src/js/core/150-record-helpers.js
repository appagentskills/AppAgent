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

function _recHeaders() {
    return {
        'X-UserToken': (typeof Platform !== 'undefined' && Platform.getSessionToken && Platform.getSessionToken()) || '',
        'Accept': 'application/json'
    };
}

function _recPrefix() {
    return (typeof Platform !== 'undefined' && Platform.instanceUrl) || '';
}

async function getRecordScope(table, sysId) {
    if (!sysId || !table) return null;
    if (!_recValidTable.test(table) || !_recValidSysId.test(sysId)) return null;
    try {
        var url = _recPrefix() + '/api/now/table/' + table + '/' + sysId + '?sysparm_fields=sys_scope';
        var res = await fetch(url, { headers: _recHeaders() });
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

async function getRecordVersion(table, sysId) {
    if (!sysId || !_recValidTable.test(table) || !_recValidSysId.test(sysId)) return null;
    try {
        var url = _recPrefix() + '/api/now/table/sys_update_version?sysparm_query=name=' + table + '_' + sysId +
            '^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,sys_created_on,state&sysparm_limit=1';
        var res = await fetch(url, { headers: _recHeaders() });
        var data = await res.json();
        if (data && data.result && data.result[0]) return data.result[0];
    } catch (e) {
        console.error('Failed to get record version:', e);
    }
    return null;
}

async function getRecordDisplayValue(table, sysId) {
    if (!sysId || !_recValidTable.test(table) || !_recValidSysId.test(sysId)) {
        return sysId ? sysId.substring(0, 8) : '';
    }
    try {
        var url = _recPrefix() + '/api/now/table/' + table + '/' + sysId +
            '?sysparm_fields=sys_id,name,number,short_description&sysparm_limit=1';
        var res = await fetch(url, { headers: _recHeaders() });
        var data = await res.json();
        if (data && data.result) {
            return data.result.name || data.result.number || data.result.short_description || sysId.substring(0, 8);
        }
    } catch (e) {
        console.error('Failed to get record display value:', e);
    }
    return sysId ? sysId.substring(0, 8) : 'New Record';
}
