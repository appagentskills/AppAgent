// Permission-persistence helpers.
// (The App Scope selector that used to live in this file was removed —
// record scope is now passed per-call via the `scope` parameter on
// servicenow_api / servicenow_run_script, so no global scope state exists.)

function saveToolPermissions() {
    setSetting('toolPermissions', toolPermissions);
    // Mirror to the SW: the agent loop in offscreen has its own
    // `toolPermissions` global hydrated from IDB at boot; without this push,
    // post-boot mutations ("Always allow" from an approval prompt, reset to
    // defaults, settings-panel edits) would only take effect on the next SW
    // restart, so the prompt would keep firing.
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ toolPermissions: toolPermissions });
    }
}

function saveInstancePermissions() {
    setSetting('instancePermissions', instancePermissions);
    if (typeof pushPermissionsToOffscreen === 'function') {
        pushPermissionsToOffscreen({ instancePermissions: instancePermissions });
    }
    // Keep the header tier pill in sync with EVERY mutation path (settings
    // panel, instance-picker toggle, data import) — some callers don't call
    // updateSnStatus themselves, leaving a stale 'Manual'/'Auto' label.
    if (typeof updateSnStatus === 'function') updateSnStatus();
}
