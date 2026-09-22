// Exact live-render identity. Never consult getWidgetIframe(savedId), restore a
// widget, or execute in the offscreen document. IDs and pending requests are
// page-local and disappear with their DOM render, not persisted widget records.
var _liveWidgetInstances = new Map();
var _liveWidgetFrames = new WeakMap();
var _widgetInstanceObserver = null;
var _widgetInstancePruneQueued = false;
var _widgetInstanceObserverGeneration = 0;

function scheduleWidgetInstancePrune() {
    if (_widgetInstancePruneQueued || !_liveWidgetInstances.size) return;
    _widgetInstancePruneQueued = true;
    var generation = _widgetInstanceObserverGeneration;
    Promise.resolve().then(function() {
        // A callback queued by a retired observer cannot prune a new lifecycle.
        if (generation !== _widgetInstanceObserverGeneration) return;
        _widgetInstancePruneQueued = false;
        pruneWidgetInstances();
    });
}

function syncWidgetInstanceObserver() {
    if (_liveWidgetInstances.size && !_widgetInstanceObserver) {
        _widgetInstanceObserver = new MutationObserver(scheduleWidgetInstancePrune);
        _widgetInstanceObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else if (!_liveWidgetInstances.size && _widgetInstanceObserver) {
        _widgetInstanceObserver.disconnect();
        _widgetInstanceObserver = null;
        _widgetInstanceObserverGeneration++;
        _widgetInstancePruneQueued = false;
    }
}

function unregisterWidgetInstance(iframe, expectedEntry) {
    var entry = _liveWidgetFrames.get(iframe);
    // A stale closure (old probeTimer / old port) must not remove the entry
    // that is CURRENTLY bound to the same iframe after a re-register.
    if (!entry || expectedEntry && entry !== expectedEntry) return;
    _liveWidgetFrames.delete(iframe);
    _liveWidgetInstances.delete(entry.instance_id);
    iframe.removeEventListener('load', entry.onLoad);
    if (entry.observer) entry.observer.disconnect();
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    if (entry.port) entry.port.close();
    if (entry.cancel) entry.cancel('INDETERMINATE', 'Widget document was lost after dispatch; side effects may have occurred. Verify state before a new call.');
    syncWidgetInstanceObserver();
}

function registerWidgetInstance(iframe, widgetId) {
    unregisterWidgetInstance(iframe);
    // Screenshot/deep-link temporary mounts have no owning saved widget ID.
    if (!widgetId) return null;
    var entry = {
        instance_id: 'wi_' + crypto.randomUUID(), widget_id: widgetId,
        iframe: iframe, ready: false, cancel: null, port: null
    };
    entry.onLoad = function() {
        if (_liveWidgetFrames.get(iframe) !== entry || !entry.ready) return;
        // A delayed initial load is NOT document replacement. Probe the
        // original document's capability without cancelling dispatched work.
        entry.ready = false;
        entry.probeId = 'wp_' + crypto.randomUUID();
        entry.probeTimer = setTimeout(function() { unregisterWidgetInstance(iframe, entry); }, 1000);
        try { entry.port.postMessage({ type: 'widgetInstanceProbe', probe_id: entry.probeId }); }
        catch (error) { unregisterWidgetInstance(iframe, entry); }
    };
    iframe.addEventListener('load', entry.onLoad);
    _liveWidgetFrames.set(iframe, entry);
    _liveWidgetInstances.set(entry.instance_id, entry);
    syncWidgetInstanceObserver();
    var root = iframe.getRootNode();
    if (root && root.host) {
        entry.observer = new MutationObserver(scheduleWidgetInstancePrune);
        entry.observer.observe(root, { childList: true, subtree: true });
    }
    return entry;
}

function pruneWidgetInstances() {
    _liveWidgetInstances.forEach(function(entry) {
        if (!entry.iframe.isConnected) unregisterWidgetInstance(entry.iframe);
    });
}

function widgetInstanceForIframe(iframe) {
    pruneWidgetInstances();
    return _liveWidgetFrames.get(iframe) || null;
}

function listWidgetInstances() {
    pruneWidgetInstances();
    return Array.from(_liveWidgetInstances.values()).map(function(entry) {
        var frame = entry.iframe;
        var root = frame.getRootNode();
        var host = root && root.host;
        var fullscreen = frame.closest('#widget-fullscreen-overlay');
        return {
            instance_id: entry.instance_id, widget_id: entry.widget_id,
            ready: entry.ready,
            surface: fullscreen ? 'fullscreen' : host ? 'dashboard' : 'chat',
            visible: !!frame.getClientRects().length
        };
    });
}

window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.type !== 'widgetEvalChannel') return;
    var port = event.ports && event.ports[0];
    var entry = _liveWidgetInstances.get(data.instance_id);
    // The sandbox creates/transfers the capability OUTWARD after rendering.
    // Never transfer a capability or send eval payloads to a WindowProxy: it
    // survives navigation. A replacement does not know the original render ID;
    // even a late/duplicate bootstrap cannot replace an already-bound port.
    if (!port) return;
    if (!entry || entry.port || !entry.iframe.isConnected || event.source !== entry.iframe.contentWindow) { port.close(); return; }
    entry.port = port;
    port.onmessage = function(message) {
        var reply = message.data;
        if (!reply || _liveWidgetFrames.get(entry.iframe) !== entry) return;
        if (reply.type === 'widgetDocumentGone') { unregisterWidgetInstance(entry.iframe, entry); return; }
        if (reply.type === 'widgetContentLoaded' && reply.probe_id === entry.probeId) {
            if (entry.probeTimer) clearTimeout(entry.probeTimer);
            entry.probeId = null;
            entry.probeTimer = null;
            entry.ready = true;
        }
        if (entry.onResult) entry.onResult(reply);
    };
    port.start();
    entry.ready = true;
});
// The document-wide observer exists only while live instances exist (see
// syncWidgetInstanceObserver). Light/shadow mutations share one queued detach
// sweep; exact identity is still checked synchronously at use.

function widgetEvalFailure(code, error, instanceId) {
    return { success: false, code: code, error: error, instance_id: instanceId || null };
}

async function executeWidgetEval(args, options) {
    args = args || {};
    options = options || {};
    if (args.action === 'list') return { success: true, instances: listWidgetInstances() };
    var callerError = _widgetEvalCallerError(options);
    if (callerError) return callerError;
    if (args.action !== 'eval' || typeof args.instance_id !== 'string' || !args.instance_id || typeof args.code !== 'string' || !args.code.trim()) {
        return widgetEvalFailure('INVALID_ARGUMENT', 'eval requires explicit instance_id and non-empty code.');
    }
    var timeout = args.timeout_ms === undefined ? 10000 : args.timeout_ms;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000 || args.code.length > 65536) {
        return widgetEvalFailure('INVALID_ARGUMENT', 'timeout_ms must be 100–30000; code is limited to 65536 characters.', args.instance_id);
    }
    pruneWidgetInstances();
    var entry = _liveWidgetInstances.get(args.instance_id);
    if (!entry || !entry.ready) return widgetEvalFailure('INSTANCE_UNAVAILABLE', 'Exact widget render is absent or not ready. Use action:list; saved widget IDs are not targets.', args.instance_id);
    if (entry.cancel) return widgetEvalFailure('INSTANCE_BUSY', 'This render already has a pending evaluation.', args.instance_id);
    return new Promise(function(resolve) {
        var frame = entry.iframe;
        var port = entry.port;
        var requestId = 'we_' + crypto.randomUUID();
        var timer;
        var settled = false;
        function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            entry.onResult = null;
            entry.cancel = null;
            resolve(result);
        }
        entry.cancel = function(code, message) { finish(widgetEvalFailure(code, message, entry.instance_id)); };
        function onResult(data) {
            if (!data || data.type !== 'widgetEvalResult' || data.request_id !== requestId || data.instance_id !== entry.instance_id) return;
            if (!frame.isConnected || _liveWidgetFrames.get(frame) !== entry) {
                entry.cancel('INDETERMINATE', 'Widget render was detached after dispatch; side effects may have occurred.');
                return;
            }
            if (typeof data.json !== 'string' || data.json.length > 65536) {
                entry.cancel('INVALID_RESULT', 'Widget response exceeds 65536 characters or is not JSON.');
                return;
            }
            try {
                var result = JSON.parse(data.json);
                if (!result || typeof result.success !== 'boolean') throw new Error('Invalid result envelope');
                if (result.success) finish({ success: true, instance_id: entry.instance_id, result: result.result });
                else finish(widgetEvalFailure('SCRIPT_ERROR', String(result.error).slice(0, 1024), entry.instance_id));
            } catch (error) { entry.cancel('INVALID_RESULT', 'Invalid widget response JSON.'); }
        }
        entry.onResult = onResult;
        timer = setTimeout(function() { entry.cancel('TIMEOUT', 'Response timed out; execution is NOT cancelled and side effects may continue.'); }, timeout);
        try {
            port.postMessage({ type: 'widgetEval', instance_id: entry.instance_id, request_id: requestId, code: args.code });
        } catch (error) { entry.cancel('INDETERMINATE', 'Document channel failed; execution cannot be confirmed. Verify state before retrying.'); }
    });
}
