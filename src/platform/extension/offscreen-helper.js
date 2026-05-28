// =============================================================
// AppAgent offscreen helper.
//
// Loaded by offscreen.html. The service worker hosts the agent
// loop; this helper exists for two reasons:
//
//   1. Keep-alive — the persistent 'sw-keepalive' port we open to
//      the SW resets the SW's idle timer while the offscreen doc
//      lives. Conversely, the SW holds the port open as long as
//      it wants the helper alive, so the offscreen stays up too.
//
//   2. DOM-only operations — js_eval and skill-tool sandboxes need
//      a real <iframe sandbox> + window.postMessage, which the SW
//      doesn't have. The SW sends a `helper-js-eval` or
//      `helper-skill-sandbox` message; we host the sandbox here,
//      proxy any sandbox-tool-call back to the SW via
//      chrome.runtime.sendMessage type='sw-exec-tool', and return
//      the final result.
// =============================================================

(function() {
    // ----- keep-alive port -----
    var swPort = null;
    function openKeepAlive() {
        try {
            swPort = chrome.runtime.connect({ name: 'sw-keepalive' });
            swPort.onDisconnect.addListener(function() {
                swPort = null;
                // Re-open after a short delay so a brief SW restart
                // doesn't leave us cut off. setTimeout in the offscreen
                // is reliable — we always have DOM.
                setTimeout(openKeepAlive, 250);
            });
            // No message handler — the port is one-directional in this
            // architecture (SW broadcasts via this connection alive but
            // does not post messages on it). Adding an empty listener
            // anyway so the API doesn't fire warnings.
            swPort.onMessage.addListener(function() {});
        } catch (e) {
            setTimeout(openKeepAlive, 500);
        }
    }
    openKeepAlive();

    // ----- request dispatcher (chrome.runtime.sendMessage from SW) -----
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        if (!message || !message.type) return;
        // SW → offscreen requests are dispatched by type. Each handler
        // returns a promise and we resolve `sendResponse` with the
        // {ok, result|error} envelope when done. Return true to keep
        // the response channel open for the async work.
        if (message.type === 'helper-js-eval') {
            runJsEvalSandbox(message.payload || {})
                .then(function(result) { sendResponse({ ok: true, result: result }); })
                .catch(function(err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); });
            return true;
        }
        if (message.type === 'helper-skill-sandbox') {
            runSkillSandbox(message.payload || {})
                .then(function(result) { sendResponse({ ok: true, result: result }); })
                .catch(function(err) { sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }); });
            return true;
        }
    });

    // ----- sandbox iframe runner (used by both js_eval and skill tools) -----
    function runSandboxWithCode(code, globals, chatId, messageIndex, parentToolCallId) {
        var MSG_TOOL_CALL = 'sandboxToolCall';
        var MSG_TOOL_RESULT = 'sandboxToolResult';
        var MSG_DONE = 'sandboxDone';
        return new Promise(function(resolve, reject) {
            var sandbox = document.createElement('iframe');
            sandbox.style.display = 'none';
            var settled = false;
            function cleanup() {
                window.removeEventListener('message', onMessage);
                if (sandbox && sandbox.parentNode) {
                    try { sandbox.parentNode.removeChild(sandbox); } catch (e) {}
                }
            }
            function onMessage(e) {
                if (!sandbox || e.source !== sandbox.contentWindow) return;
                var d = e.data;
                if (!d || !d.type) return;
                if (d.type === 'sandboxReady') {
                    sandbox.contentWindow.postMessage({ type: 'sandboxExec', code: code, globals: globals || {} }, '*');
                    return;
                }
                if (d.type === MSG_TOOL_CALL) {
                    // Forward sandbox-side tool call to the SW dispatcher.
                    // parentToolCallId is the OUTER tool's id (js_eval / skill)
                    // so display can eager-render attached to its result slot.
                    //
                    // We deliberately do NOT pass d.id as toolCallId here. d.id is
                    // a numeric counter (++window._callId) the sandbox uses to
                    // correlate sandboxToolCall ↔ sandboxToolResult messages on
                    // the local postMessage channel — it has no meaning at the
                    // agent layer, and feeding it as toolCallId crashed the
                    // approval flow (`(1).startsWith('prog_')` throws). Letting
                    // the SW generate a fresh `prog_…` id mirrors the page-side
                    // sandbox bridge in tools/020-tool-execution.js (which also
                    // omits toolCallId) and correctly marks the inner call as
                    // programmatic.
                    chrome.runtime.sendMessage({
                        type: 'sw-exec-tool',
                        payload: {
                            name: d.name,
                            args: d.args,
                            chatId: chatId,
                            messageIndex: messageIndex,
                            parentToolCallId: parentToolCallId || null
                        }
                    }).then(function(resp) {
                        if (!sandbox || !sandbox.contentWindow) return;
                        if (resp && resp.ok) {
                            sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: d.id, result: resp.result }, '*');
                        } else {
                            sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: d.id, error: (resp && resp.error) || 'Tool call failed' }, '*');
                        }
                    }).catch(function(err) {
                        if (!sandbox || !sandbox.contentWindow) return;
                        sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: d.id, error: err && err.message ? err.message : String(err) }, '*');
                    });
                    return;
                }
                if (d.type === MSG_DONE) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    if (d.error) reject(new Error(d.error));
                    else resolve(d.result);
                    return;
                }
            }
            window.addEventListener('message', onMessage);
            sandbox.src = 'sandbox.html';
            document.body.appendChild(sandbox);
        });
    }

    function runJsEvalSandbox(payload) {
        var code = String(payload.code || '');
        var globals = payload.globals || {};
        return runSandboxWithCode(code, globals, payload.chatId || null, payload.messageIndex || null, payload.parentToolCallId || null);
    }

    function runSkillSandbox(payload) {
        var toolCode = String(payload.toolCode || '');
        var toolName = String(payload.toolName || '');
        var args = payload.args || {};
        var code = toolCode + ';\nreturn await ' + toolName + '(' + JSON.stringify(args) + ');';
        return runSandboxWithCode(code, {}, payload.chatId || null, null, payload.parentToolCallId || null);
    }
})();
