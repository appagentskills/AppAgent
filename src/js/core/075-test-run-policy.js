// Host-only test tool authority. Bundled in page + SW and copied verbatim to
// offscreen. Never installed in sandbox globals. This is a TOOL boundary, not
// hostile-JavaScript isolation: sandbox CSP/direct fetch/network are unchanged.
var TestRunPolicy = (function() {
    'use strict';
    var READ_ACTIONS = ['read', 'ls', 'grep'];
    var GRANT_ACTIONS = ['status', 'diff'];
    function canonical(path) {
        return typeof path === 'string' && path.length > 0 &&
            !/[\\\x00-\x1f]/.test(path) && path.split('/').every(function(p) { return p && p !== '.' && p !== '..'; });
    }
    function scratch(path) { return canonical(path) && path.indexOf('test/.scratch/') === 0; }
    function grants(value) {
        if (value == null) return [];
        if (!Array.isArray(value)) throw new Error('allow_tools must be an array of {name:"workspace", actions:["status"|"diff"]}; legacy tool-name grants are unsupported');
        return value.map(function(g) {
            if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).some(function(k) { return k !== 'name' && k !== 'actions'; }) ||
                g.name !== 'workspace' || !Array.isArray(g.actions) || !g.actions.length ||
                g.actions.some(function(a) { return GRANT_ACTIONS.indexOf(a) < 0; })) {
                throw new Error('Unsupported allow_tools grant: only workspace status/diff are opt-in; mutations, cookies and nested execution cannot be granted');
            }
            return Object.freeze({ name: 'workspace', actions: Object.freeze(g.actions.slice()) });
        });
    }
    // Pure decision helper. The caller supplies HOST-owned config, never message data.
    function decide(config, name, args, now) {
        function deny(reason) { return { ok: false, reason: reason }; }
        if (!config || !Number.isFinite(config.deadline) || now >= config.deadline) return deny('Unknown, revoked or expired test run');
        if (!args || typeof args !== 'object' || Array.isArray(args)) return deny('Tool arguments must be an object');
        if (Object.prototype.hasOwnProperty.call(args, 'force')) return deny('force is forbidden in tests');
        if (args.workspace != null && args.workspace !== config.workspace) return deny('Foreign workspace is forbidden');
        // Timer shims schedule per-test timeouts even near the overall deadline.
        // Clamp harmless waits instead of recording a false policy violation.
        if (name === '__sandbox_sleep') return Number.isFinite(args.ms) && args.ms >= 0 ? { ok: true, args: { ms: Math.min(args.ms, config.deadline - now) } } : deny('Invalid sleep duration');
        if (name === 'run_js_file') {
            if (args.mode !== 'source') return deny('Nested module/script execution is forbidden; use loadFile + in-sandbox evalModule');
            if (!canonical(args.path)) return deny('Source path must be canonical and workspace-relative');
            return { ok: true, args: { mode: 'source', path: args.path, workspace: config.workspace } };
        }
        if (name !== 'workspace') return deny('Tool is unsupported in read-only tests');
        var action = args.action;
        if (['write', 'edit', 'delete', 'copy', 'discard'].indexOf(action) >= 0) {
            // Defensive action-specific selectors even though ALL mutations are
            // currently unsupported. files/dest never substitute for path.
            if (!scratch(args.path) || args.files != null || (action === 'copy' ? !scratch(args.dest) : args.dest != null)) return deny('Mutation requires canonical scratch path and copy dest; files/dest-only selectors are invalid');
            return deny('All real mutations, including scratch writes, are unsupported');
        }
        var allowed = READ_ACTIONS.indexOf(action) >= 0 || config.allow_tools.some(function(g) { return g.name === 'workspace' && g.actions.indexOf(action) >= 0; });
        if (!allowed) return deny('Unsupported workspace action');
        if (args.files != null || args.dest != null || args.to != null || args.repo != null || args.branch != null) return deny('Unsupported workspace selector');
        if ((action === 'read' && !canonical(args.path)) || (args.path != null && args.path !== '' && !canonical(args.path))) return deny('Path must be canonical');
        var clean = { action: action, workspace: config.workspace };
        var keys = { read: ['path', 'offset', 'limit'], ls: ['path'], grep: ['path', 'pattern', 'limit', 'ignore_case'], status: [], diff: ['path'] }[action];
        keys.forEach(function(k) { if (args[k] != null) clean[k] = args[k]; });
        return { ok: true, args: clean };
    }
    // B12: tombstones (unbound invocations) used to accumulate for the SW's
    // lifetime. Cap the map: once it exceeds MAX_INVOCATIONS, evict the OLDEST
    // inactive entries (Map iteration is insertion-ordered) until back at the
    // cap. Active bindings are never evicted. An evicted id is simply absent,
    // which relay() already treats as unknown → denied (fail-closed unchanged).
    var MAX_INVOCATIONS = 500;
    function createRegistry() {
        var contexts = new WeakMap(), invocations = new Map();
        function prune() {
            if (invocations.size <= MAX_INVOCATIONS) return;
            var it = invocations.keys(), n;
            while (invocations.size > MAX_INVOCATIONS && !(n = it.next()).done) {
                var e = invocations.get(n.value);
                if (e && !e.active) invocations.delete(n.value);
            }
        }
        function open(config) {
            if (!config || typeof config.workspace !== 'string' || !config.workspace || !Number.isFinite(config.deadline)) throw new Error('Invalid host test configuration');
            var c = Object.freeze({ workspace: config.workspace, deadline: config.deadline, allow_tools: Object.freeze(grants(config.allow_tools)) });
            var key = Object.freeze({});
            contexts.set(key, { config: c, revoked: false, denied: [] });
            return key;
        }
        function state(key) { return key && contexts.get(key); }
        function descriptor(key) {
            var s = state(key);
            if (!s || s.revoked || Date.now() >= s.config.deadline) throw new Error('Unknown, revoked or expired test run');
            return s.config;
        }
        function gate(key, name, args) {
            var s = state(key);
            var d = decide(s && !s.revoked ? s.config : null, name, args, Date.now());
            if (!d.ok && s) s.denied.push({ tool: String(name), action: args && args.action, reason: d.reason });
            return d;
        }
        function revoke(key) { var s = state(key); if (s) s.revoked = true; }
        function denials(key) { var s = state(key); return s ? s.denied.slice() : [{ reason: 'Unknown host context' }]; }
        function bind(id, key) {
            if (typeof id !== 'string' || !id || invocations.has(id)) throw new Error('Invalid or recycled sandbox invocation');
            if (key !== null) descriptor(key);
            invocations.set(id, { key: key, active: true });
            prune();
        }
        function unbind(id) {
            var i = invocations.get(id);
            if (i) { i.active = false; if (i.key !== null) revoke(i.key); }
            // Keep a tombstone: the same identifier can never be recycled
            // (until it ages out of the MAX_INVOCATIONS cap — see prune()).
        }
        function relay(id, name, args) {
            var i = invocations.get(id);
            if (!i || !i.active) return { ok: false, reason: 'Unknown or revoked sandbox invocation' };
            return i.key === null ? { ok: true, args: args } : gate(i.key, name, args);
        }
        return { open: open, descriptor: descriptor, gate: gate, revoke: revoke, denials: denials, bind: bind, unbind: unbind, relay: relay, size: function() { return invocations.size; } };
    }
    function complete(value) {
        if (!value || value.success !== true || value.capped || value.truncated || value._cached || value._more) throw new Error('Isolation snapshot failed or capped');
        return value;
    }
    async function snapshot(status, read, hash, cap) {
        var s = complete(await status());
        if (!Array.isArray(s.dirty_files) || s.dirty_files.length > cap) throw new Error('Isolation snapshot missing dirty_files or fingerprint cap exceeded');
        var fingerprints = Object.create(null);
        for (var f of s.dirty_files) {
            if (!f || !canonical(f.path) || Object.prototype.hasOwnProperty.call(fingerprints, f.path)) throw new Error('Invalid isolation path');
            var r = complete(await read(f.path));
            if (typeof r.content !== 'string') throw new Error('Isolation read missing complete content: ' + f.path);
            fingerprints[f.path] = await hash(r.content);
        }
        return { paths: Object.keys(fingerprints).sort(), fingerprints: fingerprints };
    }
    function compare(before, after) {
        if (!before || !after || !before.fingerprints || !after.fingerprints) throw new Error('Missing host isolation snapshot');
        var paths = Array.from(new Set(before.paths.concat(after.paths))).sort();
        var violations = paths.filter(function(p) { return before.fingerprints[p] !== after.fingerprints[p]; });
        return { ok: violations.length === 0, violations: violations, host_verified: true };
    }
    function bounded(promise, ms, onTimeout) {
        var timer;
        return Promise.race([promise, new Promise(function(_, reject) {
            timer = setTimeout(function() { if (onTimeout) onTimeout(); reject(new Error('Test host deadline exceeded')); }, Math.max(0, ms));
        })]).finally(function() { clearTimeout(timer); });
    }
    // Exact-frame runner used at BOTH page and offscreen test ingress. The
    // trusted caller captures context/dispatch; no policy field from e.data is read.
    function runFrame(config) {
        var reg = config.registry, key = config.context;
        var policy = reg.descriptor(key);
        return new Promise(function(resolve, reject) {
            var frame = null, settled = false, started = false, timer = null;
            function finish(error, value) {
                if (settled) return;
                settled = true;
                reg.revoke(key);
                clearTimeout(timer);
                config.window.removeEventListener('message', message);
                if (config.signal) config.signal.removeEventListener('abort', abort);
                if (frame) {
                    frame.removeEventListener('error', frameError);
                    if (frame.parentNode) frame.parentNode.removeChild(frame);
                }
                if (error) reject(error);
                else resolve({ value: value, denied_calls: reg.denials(key), host_test_boundary: true });
            }
            function abort() { finish(new Error('Test sandbox cancelled')); }
            function frameError() { finish(new Error('Test sandbox iframe failed to load')); }
            function reply(id, result) {
                if (!settled) {
                    try { frame.contentWindow.postMessage({ type: 'sandboxToolResult', id: id, result: result }, '*'); }
                    catch (error) { finish(error); }
                }
            }
            function message(e) {
                if (settled || !frame || e.source !== frame.contentWindow) return;
                var d = e.data;
                if (!d || typeof d !== 'object') return;
                if (Date.now() >= policy.deadline) { finish(new Error('Test host deadline exceeded')); return; }
                if (d.type === 'sandboxReady') {
                    if (!started) {
                        started = true;
                        try { frame.contentWindow.postMessage({ type: 'sandboxExec', code: config.code, globals: {} }, '*'); }
                        catch (error) { finish(error); }
                    }
                } else if (d.type === 'sandboxToolCall') {
                    var decision = reg.gate(key, d.name, d.args);
                    if (!decision.ok) { reply(d.id, { success: false, denied_by_host: true, error: decision.reason }); return; }
                    Promise.resolve().then(function() {
                        // A queued call may be overtaken by done/abort/deadline.
                        if (settled) throw new Error('Test sandbox closed');
                        var check = reg.gate(key, d.name, decision.args);
                        if (!check.ok) throw new Error(check.reason);
                        return config.dispatch(d.name, check.args, d.id);
                    }).then(function(result) { reply(d.id, result); }, function(error) { reply(d.id, { success: false, error: String(error && error.message || error) }); });
                } else if (d.type === 'sandboxTestTimeout') {
                    finish(new Error('Per-test timeout: aborted remaining tests and destroyed sandbox'));
                } else if (d.type === 'sandboxDone') {
                    // Even a forged early completion revokes and destroys this exact
                    // frame synchronously, before the result can be consumed.
                    finish(d.error ? new Error(String(d.error)) : null, d.result);
                }
            }
            try {
                if (config.signal && config.signal.aborted) { abort(); return; }
                frame = config.document.createElement('iframe');
                frame.style.display = 'none';
                frame.addEventListener('error', frameError);
                config.window.addEventListener('message', message);
                if (config.signal) config.signal.addEventListener('abort', abort, { once: true });
                timer = setTimeout(function() { finish(new Error('Test host deadline exceeded')); }, Math.max(0, policy.deadline - Date.now()));
                frame.src = 'sandbox.html';
                config.document.body.appendChild(frame);
            } catch (error) { finish(error); }
        });
    }
    var registry = createRegistry();
    return Object.freeze({ canonical: canonical, scratch: scratch, grants: grants, decide: decide, createRegistry: createRegistry, registry: registry, snapshot: snapshot, compare: compare, bounded: bounded, runFrame: runFrame });
})();
