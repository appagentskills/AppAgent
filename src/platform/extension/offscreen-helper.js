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

    // ----- SW-backed sleep -----
    // This offscreen document is permanently hidden, so Chrome's intensive
    // wake-up throttling aligns chained setTimeout timers here (and inside
    // the sandbox iframes we host) to 1/minute after ~5 min hidden. Message
    // delivery is NOT throttled, so waits are delegated to the service
    // worker ('sw-sleep' handler in background.js: setTimeout < 30s,
    // chrome.alarms >= 30s). Deadline-based re-arm loop: if the SW suspends
    // mid-wait the sendMessage channel rejects (or settles early after a
    // restart) and we simply re-request the REMAINING time — the alarm
    // survives suspension and wakes the SW for us. Never rejects; resolves
    // once the deadline has passed.
    //
    // CHUNKING: each request is capped at 4 min. The js_eval inactivity
    // watchdog (tools/020-tool-execution.js) kills an eval after 5 min
    // without sandbox activity; every 'sw-sleep' arrival stamps the
    // activity clock in the SW (see background.js), so chunked long sleeps
    // (e.g. 10 min) keep the eval alive — with a single un-chunked request
    // nothing would touch the clock between start and resolve.
    var SW_SLEEP_CHUNK_MS = 4 * 60 * 1000;
    function swSleep(totalMs, chatId) {
        var deadline = Date.now() + Math.max(0, Number(totalMs) || 0);
        function attempt() {
            var remaining = deadline - Date.now();
            if (remaining <= 0) return Promise.resolve({ ok: true });
            return chrome.runtime.sendMessage({ type: 'sw-sleep', payload: { ms: Math.min(remaining, SW_SLEEP_CHUNK_MS), chatId: chatId || null } })
                .then(function() {
                    // More to wait (next chunk, or the channel settled early
                    // after an SW restart)? Re-arm for the remaining time.
                    // 500ms slack absorbs clock jitter.
                    if (deadline - Date.now() > 500) return attempt();
                    return { ok: true };
                })
                .catch(function() {
                    // Channel dropped (SW suspended mid-wait / not up yet).
                    // Small native backoff so a dead SW never causes a hot
                    // retry loop, then re-arm for the remaining time. Worst
                    // case the backoff itself is throttled to a minute —
                    // still bounded by the deadline check above.
                    return new Promise(function(res) { setTimeout(res, 250); }).then(attempt);
                });
        }
        return attempt();
    }

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
                    if (d.name === '__sandbox_sleep') {
                        // sleep(ms) / setTimeout-shim bridge (sandbox.html):
                        // local timers in this hidden doc are throttled to
                        // 1/minute, so the wait runs in the SW (swSleep
                        // above). Handled HERE — never forwarded to the SW
                        // tool dispatcher: it is not a real tool (no approval,
                        // no transcript entry, no prog_ id needed).
                        var sleepMs = Math.max(0, Number(d.args && d.args.ms) || 0);
                        swSleep(sleepMs, chatId).then(function() {
                            if (!sandbox || !sandbox.contentWindow) return;
                            sandbox.contentWindow.postMessage({ type: MSG_TOOL_RESULT, id: d.id, result: { __sleep_ok: true, slept_ms: sleepMs } }, '*');
                        });
                        return;
                    }
                    // Forward sandbox-side tool call to the SW dispatcher.
                    // parentToolCallId is the OUTER tool's id (js_eval / skill)
                    // so display can eager-render attached to its result slot.
                    //
                    // STABLE toolCallId (double-approval fix): we DERIVE a stable
                    // `prog_…` id from the outer tool's id + the sandbox call
                    // counter (d.id) instead of letting the SW mint a fresh
                    // `prog_<timestamp>_<random>` per dispatch. Why it matters:
                    // every approval dedup is keyed on toolCallId (the worker
                    // stub's recorded-approval scan in worker/120-tool-routing.js
                    // and the page stub in ui/150-tool-approval.js). A fresh id
                    // per dispatch never matches the persisted `approval` message,
                    // so when the agent loop re-enters dispatch (SW recycle while
                    // the user is on the prompt, restart replay, reload) the outer
                    // js_eval/skill re-runs and an inner 'ask' tool (e.g.
                    // web_fetch) re-prompts — the user sees the panel twice. A
                    // STABLE id is recognized as already-approved on re-run, so it
                    // prompts exactly once.
                    // Constraints baked into the format below:
                    //  • Must be a STRING — the original reason d.id was dropped
                    //    was that the bare numeric counter threw on
                    //    `(1).startsWith('prog_')`.
                    //  • Must START WITH 'prog_' — executePendingApprovedTools
                    //    (app/030-agent-loop.js) skips `prog_` ids so the page
                    //    never re-executes a sandbox call as a top-level tool
                    //    (skipping that prefix would trade a double-prompt for a
                    //    double-EXECUTION).
                    //  • Must be DETERMINISTIC across re-dispatch — d.id is
                    //    ++window._callId, which re-increments in the same order
                    //    when the sandbox code re-runs from the top.
                    chrome.runtime.sendMessage({
                        type: 'sw-exec-tool',
                        payload: {
                            name: d.name,
                            args: d.args,
                            chatId: chatId,
                            messageIndex: messageIndex,
                            toolCallId: 'prog_' + (parentToolCallId || 'np') + '_' + d.id,
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
        // messageIndex: type-checked (not `|| null`) because index 0 is a
        // legitimate value — `payload.messageIndex || null` coerced the first
        // message's index to null, so nested record mutations from js_eval at
        // message 0 were stamped -1 and dropped from the inline Artifacts block.
        return runSandboxWithCode(code, globals, payload.chatId || null,
            (typeof payload.messageIndex === 'number' && payload.messageIndex >= 0) ? payload.messageIndex : null,
            payload.parentToolCallId || null);
    }

    function runSkillSandbox(payload) {
        var toolCode = String(payload.toolCode || '');
        var toolName = String(payload.toolName || '');
        var args = payload.args || {};
        var code = toolCode + ';\nreturn await ' + toolName + '(' + JSON.stringify(args) + ');';
        // messageIndex: plumbed from core/140-skills-engine.js so nested
        // record mutations stamp a real per-message index instead of -1.
        // Type-checked (not `|| null`) because index 0 is a legitimate value.
        return runSandboxWithCode(code, {}, payload.chatId || null,
            (typeof payload.messageIndex === 'number' && payload.messageIndex >= 0) ? payload.messageIndex : null,
            payload.parentToolCallId || null);
    }
})();
