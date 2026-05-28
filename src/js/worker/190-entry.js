// =============================================================
// AppAgent SW runtime — entry point.
//
// This file is the LAST entry in sw-bundle.js. By the time it
// executes, everything else has been declared: globals, Platform
// stub, page stubs, the entire shared agent bundle (loop, streaming,
// tools, IDB, etc.), bus/broadcast bridge, checkpoint, tool routing,
// and the port handler. Now we do the actual boot:
//
//   1. Open IDB + load chats / api providers / session token.
//   2. Scan the agent_runs store for any chats whose status is
//      'running' (i.e. dropped mid-run by a previous SW kill) and
//      resume them.
//
// All async work below is fire-and-forget — bundle load is sync, the
// SW is now reachable via chrome.runtime.onConnect for 'agent-bus'
// (registered in 130-port-bridge.js, already executed before this
// file).
// =============================================================

// Exposed on `self` so resumeRunningCheckpoints (called from both this
// file AND background.js's onStartup / heartbeat-alarm path) can await
// it before touching `chats`. Without this, the background.js path
// races loadChatsFromStorage and runs runAgent with an empty `chats`
// global — `chats[streamingChatId]` is undefined and the loop crashes.
var _swBootReadyResolve = null;
self._swBootReady = new Promise(function(resolve) { _swBootReadyResolve = resolve; });

(function bootSwRuntime() {
    // Per-loader .catch so a transient IDB hiccup in any single loader
    // doesn't block the resume scan. We want resume to be best-effort:
    // a missing provider list, missing skills, etc. degrades gracefully,
    // but a stuck SW with running checkpoints sitting in IDB is far worse
    // than running with partial state for a few seconds.
    function safe(p, label) {
        return Promise.resolve(p).catch(function(e) {
            console.error('[sw-runtime] loader failed: ' + label, e);
            return null;
        });
    }
    var loadActive = (typeof loadActiveSkills === 'function') ? loadActiveSkills() : Promise.resolve();
    var loadCustom = (typeof loadCustomSystemPrompt === 'function') ? loadCustomSystemPrompt() : Promise.resolve();
    var loadHooks = (typeof loadHooksSettings === 'function') ? loadHooksSettings() : Promise.resolve();
    var loadPerms = (typeof loadToolPermissionsInWorker === 'function') ? loadToolPermissionsInWorker() : Promise.resolve();
    // Smart documents tool runs in SW (HEADLESS_TOOLS.document = true), but its
    // in-memory smartDocuments cache is only hydrated by loadAllDocuments. The
    // page calls this from 120-init.js; the SW must do the same or the tool's
    // list/read/update/edit/delete actions all see an empty store and fail.
    var loadDocs = (typeof loadAllDocuments === 'function') ? loadAllDocuments() : Promise.resolve();
    Promise.all([
        safe(loadChatsFromStorage(), 'chats'),
        safe(loadApiProviders(), 'apiProviders'),
        safe(loadActive, 'activeSkills'),
        safe(loadCustom, 'customSystemPrompt'),
        safe(loadHooks, 'hooksEnabled'),
        safe(loadPerms, 'toolPermissions'),
        safe(loadDocs, 'smartDocuments'),
        safe(Platform.ready, 'platform')
    ]).then(function() {
        // Signal that `chats` and providers are populated. Any concurrent
        // resume from background.js was waiting on this.
        if (_swBootReadyResolve) { _swBootReadyResolve(); _swBootReadyResolve = null; }
        return listRunningAgentCheckpoints();
    }).then(function(checkpoints) {
        if (!checkpoints || checkpoints.length === 0) return;
        console.log('[sw-runtime] resuming ' + checkpoints.length + ' interrupted run(s)');
        // 130-port-bridge.js exposes resumeRunningCheckpoints on self;
        // call it so the bookkeeping (parked-tool restore) is identical
        // to the alarm-driven resume path.
        if (typeof resumeRunningCheckpoints === 'function') {
            resumeRunningCheckpoints(checkpoints);
        }
    }).catch(function(e) {
        console.error('[sw-runtime] boot/resume error', e);
        // Failsafe: still open the boot gate so background.js's alarm
        // path can attempt resume even after a partial loader failure.
        if (_swBootReadyResolve) { _swBootReadyResolve(); _swBootReadyResolve = null; }
    });
})();
