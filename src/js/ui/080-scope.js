// Permission-persistence helpers.
// (The App Scope selector that used to live in this file was removed —
// record scope is now passed per-call via the `scope` parameter on
// servicenow_api / servicenow_run_script, so no global scope state exists.)

// F6 (flux single-writer): these are DISPATCHERS, not writers. The page
// mutates its replica for instant UI feedback, then posts the map to the SW
// ('permissions-update'), which applies it, persists to IDB `settings` (the
// page never writes permission maps to IDB anymore), and rebroadcasts
// 'permissions-changed' so every panel converges. If the bus port is down
// the patch is queued and flushed on reconnect (see
// pushPermissionsToOffscreen in app/045-agent-port-bridge-page.js).
function saveToolPermissions() {
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ toolPermissions: toolPermissions });
    }
}

function saveInstancePermissions() {
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ instancePermissions: instancePermissions });
    }
    // Keep the header tier pill in sync with EVERY mutation path (settings
    // panel, instance-picker toggle, data import) — some callers don't call
    // updateSnStatus themselves, leaving a stale 'Manual'/'Auto' label.
    if (typeof updateSnStatus === 'function') updateSnStatus();
}
