// Adaptive (AIMD) sub-agent pool limits: real core/097 registry via
// loadModules + the real app/010 classifiers cut with test/extract.js.
// Key requirement: a credits/quota-exhausted 429 must NEVER shrink the limit.
var EX = await runFile('test/extract.js', { i18n: false });
var T = { tags: ['unit'], timeout: 8000 };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
var REG = ['src/js/core/095-handle-registry.js', 'src/js/core/097-sub-agent-registry.js'];
var PROVIDERS = {
    claude: { isClaudeOAuth: true, apiKey: 'oauth' },
    orx: { endpoint: 'https://openrouter.ai/api/v1/chat/completions' }
};

async function loadReg() {
    var self = {}, timers = [];
    var m = await loadModules(REG, { lenient: true, globals: {
        self: self, window: fakeWindow(), chrome: fakeChrome(), Platform: { isWorker: true },
        chats: { root: { messages: [] } }, pausedChats: {}, runningChatIds: {}, pendingInjectionsByChatId: {},
        isChatPaused: function() { return false; },
        runAgent: function() { return new Promise(function() {}); },
        saveChatsToStorage: function() { return Promise.resolve(); },
        openDatabase: function() { return new Promise(function() {}); },
        releaseIdleDbConnection: function() {}, readAgentCheckpoint: function() { return Promise.resolve(null); },
        pendingWakesStoreName: 'sub_agent_pending_wakes', console: quiet,
        getProviderById: function(id) { return PROVIDERS[id] || null; },
        resolveChatProviderName: function(chatId) { return chatId === 'top_claude' ? 'claude' : chatId === 'top_orx' ? 'orx' : null; },
        // Captured, never fired: tests inspect the armed delays.
        setTimeout: function(fn, ms) { timers.push({ fn: fn, ms: ms, live: true }); return timers.length; },
        clearTimeout: function(id) { if (timers[id - 1]) timers[id - 1].live = false; }
    } });
    for (var k in m._subPoolDyn) delete m._subPoolDyn[k];
    return { m: m, SA: m.SubAgents || self.SubAgents, timers: timers };
}
function sub(m, id, provider) {
    m._subAgents[id] = { agent_id: id, chat_id: 'c_' + id, name: id, state: 'running', provider: provider,
        parent_chat_id: 'root', root_chat_id: 'root', depth: 1, created_at: Date.now(), last_activity_at: Date.now() };
}
var CL = 'anthropic-oauth', OR = 'ep:https://openrouter.ai/api/v1/chat/completions';

var C = null;
async function classifiers() {
    if (C) return C;
    var src = await loadFile('src/js/app/010-llm-streaming.js');
    var names = ['_poolHdr', '_poolParseResetMs', '_poolClassifyHttpOutcome', '_poolParseResetsIn', '_poolClassifyEnvelope', '_poolPauseSuffix'];
    var body = EX.extractFunctions(src, names) + '\nreturn {' + names.map(function(n) { return n + ':' + n; }).join(',') + '};';
    C = new Function(body)();
    return C;
}
function H(map) { return { get: function(n) { return map[n.toLowerCase()] != null ? map[n.toLowerCase()] : null; } }; }

describe('adaptive pool: registry (core/097)', function() {
    test('429 + retry-after halves the group limit and holds it', async function() {
        var R = await loadReg();
        var r = R.SA.reportLLMOutcome(CL, { kind: 'rate_limited', retryAfterMs: 30000 });
        assert.strictEqual(r.limit, 1, '2 → 1');
        assert.ok(R.m._poolGroupBlockedMs(CL) > 25000, 'held until retry-after');
        assert.ok(R.timers.some(function(t) { return t.live && t.ms >= 30000; }), 'drain timer armed');
        var o = R.SA.reportLLMOutcome(OR, { kind: 'rate_limited' });
        assert.strictEqual(o.limit, 1, 'unknown ep: key starts at static 2 → 1');
        assert.strictEqual(R.m._poolGroupBlockedMs(OR), 0, 'no retry-after → no hold');
    }, T);

    test('rate-limit burst within the decrease gap halves only once; floor is 1', async function() {
        var R = await loadReg();
        sub(R.m, 'a', 'orx');
        R.SA.reportLLMOutcome('c_a', { kind: 'rate_limited' }); // pinned ep: 4 → 2
        R.SA.reportLLMOutcome('c_a', { kind: 'rate_limited' });
        assert.strictEqual(R.m._subPoolDyn[OR].limit, 2, 'same burst: one decrease');
        R.m._subPoolDyn[OR].last_rl_at = 0;
        R.SA.reportLLMOutcome('c_a', { kind: 'rate_limited' });
        R.m._subPoolDyn[OR].last_rl_at = 0;
        R.SA.reportLLMOutcome('c_a', { kind: 'rate_limited' });
        assert.strictEqual(R.m._subPoolDyn[OR].limit, 1, 'never below 1');
    }, T);

    test('overloaded (529/5xx) leaves the limit untouched', async function() {
        var R = await loadReg();
        var r = R.SA.reportLLMOutcome(CL, { kind: 'overloaded', detail: 'HTTP 529' });
        assert.strictEqual(r.limit, 2);
        assert.strictEqual(R.m._subPoolDyn[CL].limit, null);
        assert.strictEqual(R.m._poolGroupBlockedMs(CL), 0);
    }, T);

    test('quota_exhausted pauses the group until reset WITHOUT shrinking', async function() {
        var R = await loadReg();
        var reset = Date.now() + 3600000;
        var r = R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: reset, detail: 'Anthropic spend limit reached' });
        assert.strictEqual(r.limit, 2, 'limit unchanged');
        assert.strictEqual(R.m._subPoolDyn[CL].limit, null);
        assert.strictEqual(r.paused_until, reset);
        assert.ok(R.m._poolGroupBlockedMs(CL) > 3500000);
        var snap = R.SA.poolSnapshot().group_limits[CL];
        assert.strictEqual(snap.paused_until, new Date(reset).toISOString());
        assert.strictEqual(snap.limit, 2);
    }, T);

    test('quota pause with unknown reset re-probes after the fallback; ok and resume clear it', async function() {
        var R = await loadReg();
        var r = R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: null });
        var left = R.m._poolGroupBlockedMs(CL);
        assert.ok(left > 0 && isFinite(left) && left <= R.m.SUBAGENT_POOL_QUOTA_FALLBACK_MS, 'finite fallback pause');
        assert.ok(r.paused_until > Date.now());
        R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._poolGroupBlockedMs(CL), 0, 'ok clears the pause');
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted' });
        assert.strictEqual(R.SA.resumePoolGroup(CL), true);
        assert.strictEqual(R.m._poolGroupBlockedMs(CL), 0, 'manual resume clears it');
        assert.strictEqual(R.SA.resumePoolGroup('nope'), false);
    }, T);

    test('F2: an expired quota pause (no ok) is cleared, so group_limits shows no stale past pause', async function() {
        var R = await loadReg();
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 60000, detail: 'spend limit' });
        // Reset time passes without any ok outcome.
        R.m._subPoolDyn[CL].paused_until = Date.now() - 1000;
        var snap = R.SA.poolSnapshot().group_limits[CL];
        assert.strictEqual(snap.paused_until, undefined, 'no stale past paused_until');
        assert.strictEqual(snap.pause_reason, undefined, 'no stale pause_reason');
        assert.strictEqual(R.m._subPoolDyn[CL].pause_reason, null);
        assert.strictEqual(R.m._subPoolDyn[CL].paused_until, 0);
        assert.strictEqual(snap.last_signal.kind, 'quota_exhausted', 'last_signal kept');
        // Timer/drain path clears it too and reports the group open.
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 60000 });
        R.m._subPoolDyn[CL].paused_until = Date.now() - 1;
        assert.strictEqual(R.m._poolGroupBlockedMs(CL), 0);
        assert.strictEqual(R.m._subPoolDyn[CL].pause_reason, null, 'cleared on the blocked-ms check');
        // A still-active pause and a no-reset (manual) pause are untouched.
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 60000 });
        assert.ok(R.SA.poolSnapshot().group_limits[CL].pause_reason, 'active pause still shown');
        R.m._subPoolDyn[CL].paused_until = 0;
        assert.strictEqual(R.m._poolGroupBlockedMs(CL), Infinity, 'manual pause stays');
        assert.strictEqual(R.SA.poolSnapshot().group_limits[CL].paused_until, 'manual resume');
    }, T);

    test('drain timer keeps the EARLIEST deadline and re-arms for the rest', async function() {
        var R = await loadReg();
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 3600000 });
        R.SA.reportLLMOutcome(OR, { kind: 'rate_limited', retryAfterMs: 2000 });
        var live = R.timers.filter(function(t) { return t.live; });
        assert.strictEqual(live.length, 1);
        assert.ok(live[0].ms < 5000, 'short hold wins');
        // A later, longer deadline must not replace the armed earlier one.
        R.SA.reportLLMOutcome('top_orx', { kind: 'quota_exhausted', resetAt: Date.now() + 7200000 });
        live = R.timers.filter(function(t) { return t.live; });
        assert.strictEqual(live.length, 1);
        assert.ok(live[0].ms < 5000);
        // Fire it after the short hold elapsed: it must re-arm for the 1h quota pause.
        R.m._subPoolDyn[OR].hold_until = 0;
        live[0].live = false; live[0].fn();
        live = R.timers.filter(function(t) { return t.live; });
        assert.strictEqual(live.length, 1, 're-armed');
        assert.ok(live[0].ms > 3000000, 'for the long pause');
    }, T);

    test('success streak grows +1 only when the limit binds, up to the ceiling 8', async function() {
        var R = await loadReg();
        var i;
        for (i = 0; i < 5; i++) R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._subPoolDyn[CL].limit, null, 'idle group (0 running < 2) does not grow');
        for (var n = 0; n < 10; n++) R.m._subPool.running['r' + n] = CL;
        for (i = 0; i < 5 * 10; i++) R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._subPoolDyn[CL].limit, 8, 'capped at SUBAGENT_POOL_CEILING');
        R.m._subPoolDyn[CL].last_rl_at = Date.now();
        R.m._subPoolDyn[CL].limit = 4;
        for (i = 0; i < 5; i++) R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._subPoolDyn[CL].limit, 4, 'no growth inside the quiet window');
    }, T);

    test('drain skips a paused group, honors the dynamic limit and the global max', async function() {
        var R = await loadReg();
        ['p1', 'p2', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'].forEach(function(id) {
            sub(R.m, id, id[0] === 'p' ? 'claude' : 'orx');
            R.m._subPool.queue.push(id);
        });
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 60000 });
        R.m._subPoolDyn[OR] = R.m._poolDyn(OR); R.m._subPoolDyn[OR].limit = 8;
        R.m._drainPool();
        var running = Object.keys(R.m._subPool.running);
        assert.strictEqual(running.filter(function(a) { return a[0] === 'p'; }).length, 0, 'paused group never starts');
        assert.strictEqual(running.length, R.m.SUBAGENT_POOL_GLOBAL_MAX, 'global max 6 still enforced');
        assert.ok(R.m._subPool.queue.indexOf('p1') === 0, 'paused subs keep their queue position');
    }, T);

    test('drain: halved limit caps starts in that group', async function() {
        var R = await loadReg();
        ['o1', 'o2', 'o3', 'o4'].forEach(function(id) { sub(R.m, id, 'orx'); R.m._subPool.queue.push(id); });
        R.SA.reportLLMOutcome('c_o1', { kind: 'rate_limited' }); // 4 → 2, no hold
        R.m._drainPool();
        assert.strictEqual(Object.keys(R.m._subPool.running).length, 2);
        assert.strictEqual(R.SA.poolSnapshot().group_limits[OR].limit, 2);
    }, T);

    function claudeAtLimit(R) {
        ['r1', 'r2', 'q1', 'q2'].forEach(function(id) { sub(R.m, id, 'claude'); });
        R.m._subPool.running.r1 = CL; R.m._subPool.running.r2 = CL;
        R.m._subPool.queue.push('q1', 'q2');
    }

    test('success streak raising the limit 2 → 3 starts exactly one queued sub', async function() {
        var R = await loadReg();
        claudeAtLimit(R);
        R.m._drainPool();
        assert.strictEqual(R.m._poolGroupRunningCount(CL), 2, 'limit 2 binds');
        for (var i = 0; i < R.m.SUBAGENT_POOL_AIMD_STREAK; i++) R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._subPoolDyn[CL].limit, 3);
        assert.strictEqual(R.m._poolGroupRunningCount(CL), 3, 'raise drained the queue');
        assert.strictEqual(R.m._subPool.running.q1, CL, 'FIFO: q1 started');
        assert.deepStrictEqual(R.m._subPool.queue, ['q2'], 'q2 still queued');
    }, T);

    test('ok clearing a quota pause and resumePoolGroup both drain queued subs', async function() {
        var R = await loadReg();
        claudeAtLimit(R);
        delete R.m._subPool.running.r2; // 1 running, room for 1 more
        R.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted', resetAt: Date.now() + 3600000 });
        R.m._drainPool();
        assert.strictEqual(R.m._poolGroupRunningCount(CL), 1, 'paused: nothing starts');
        R.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R.m._poolGroupRunningCount(CL), 2, 'ok un-pause drained');
        assert.deepStrictEqual(R.m._subPool.queue, ['q2']);

        var R2 = await loadReg();
        claudeAtLimit(R2);
        delete R2.m._subPool.running.r2;
        R2.SA.reportLLMOutcome(CL, { kind: 'quota_exhausted' });
        R2.m._drainPool();
        assert.strictEqual(R2.m._poolGroupRunningCount(CL), 1);
        assert.strictEqual(R2.SA.resumePoolGroup(CL), true);
        assert.strictEqual(R2.m._poolGroupRunningCount(CL), 2, 'manual resume drained');
        // Safe with nothing queued / repeated calls.
        R2.m._subPool.queue.length = 0;
        assert.strictEqual(R2.SA.resumePoolGroup(CL), true);
        for (var i = 0; i < 2 * R2.m.SUBAGENT_POOL_AIMD_STREAK; i++) R2.SA.reportLLMOutcome(CL, { kind: 'ok' });
        assert.strictEqual(R2.m._poolGroupRunningCount(CL), 2, 'no phantom starts');
    }, T);
});

describe('adaptive pool: classifiers (app/010)', function() {
    test('429 + retry-after → rate_limited; generic 429 → rate_limited', async function() {
        var c = await classifiers();
        var o = c._poolClassifyHttpOutcome(429, H({ 'retry-after': '20' }), '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}');
        assert.strictEqual(o.kind, 'rate_limited');
        assert.ok(o.retryAfterMs > 19000 && o.retryAfterMs <= 20000);
        assert.strictEqual(c._poolClassifyHttpOutcome(429, H({}), 'Too Many Requests').kind, 'rate_limited');
    }, T);

    test('credits/quota 429s are quota_exhausted even WITH retry-after (never shrink)', async function() {
        var c = await classifiers();
        var spend = c._poolClassifyHttpOutcome(429, H({ 'retry-after': '60' }), '{"type":"error","error":{"type":"rate_limit_error","message":"x","details":{"error_code":"enforced_spend_limit_reached"}}}');
        assert.strictEqual(spend.kind, 'quota_exhausted');
        var oai = c._poolClassifyHttpOutcome(429, H({ 'retry-after': '5' }), '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}');
        assert.strictEqual(oai.kind, 'quota_exhausted');
        assert.ok(oai.resetAt > Date.now(), 'retry-after becomes the pause end');
        var orFree = c._poolClassifyHttpOutcome(429, H({}), '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}');
        assert.strictEqual(orFree.kind, 'quota_exhausted');
        assert.strictEqual(c._poolClassifyHttpOutcome(400, H({}), '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}').kind, 'quota_exhausted');
        assert.strictEqual(c._poolClassifyHttpOutcome(400, H({}), '{"error":{"message":"bad field"}}'), null, 'plain 400 is no signal');
    }, T);

    test('unified rate_limited → quota_exhausted with the window reset', async function() {
        var c = await classifiers();
        var reset = Math.floor(Date.now() / 1000) + 7200;
        var o = c._poolClassifyHttpOutcome(429, H({ 'anthropic-ratelimit-unified-5h-status': 'rate_limited', 'anthropic-ratelimit-unified-5h-reset': String(reset) }), '');
        assert.strictEqual(o.kind, 'quota_exhausted');
        assert.strictEqual(o.resetAt, reset * 1000);
        assert.strictEqual(c._poolClassifyHttpOutcome(200, H({ 'anthropic-ratelimit-unified-status': 'rate_limited' }), '').kind, 'quota_exhausted');
        assert.strictEqual(c._poolClassifyHttpOutcome(200, H({ 'anthropic-ratelimit-unified-status': 'warning' }), '').kind, 'ok');
    }, T);

    test('402: in-flight budget shrinks, insufficient credits pauses', async function() {
        var c = await classifiers();
        assert.strictEqual(c._poolClassifyHttpOutcome(402, H({}), '{"error":{"code":402,"message":"openrouter_in_flight_budget exceeded"}}').kind, 'rate_limited');
        assert.strictEqual(c._poolClassifyHttpOutcome(402, H({}), '{"error":{"code":402,"message":"Insufficient credits"}}').kind, 'quota_exhausted');
    }, T);

    test('5xx/529 → overloaded; 2xx remaining<=0 → rate_limited; 2xx plain → ok', async function() {
        var c = await classifiers();
        assert.strictEqual(c._poolClassifyHttpOutcome(529, H({}), '').kind, 'overloaded');
        assert.strictEqual(c._poolClassifyHttpOutcome(503, H({}), '').kind, 'overloaded');
        var r = c._poolClassifyHttpOutcome(200, H({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s' }), '');
        assert.strictEqual(r.kind, 'rate_limited');
        assert.ok(Math.abs(r.resetAt - (Date.now() + 360000)) < 2000);
        assert.strictEqual(c._poolClassifyHttpOutcome(200, H({ 'x-ratelimit-remaining-requests': '12' }), '').kind, 'ok');
        assert.strictEqual(c._poolClassifyHttpOutcome(404, H({}), ''), null);
    }, T);

    test('envelopes: concurrents park shrinks, usage-limit 429 and usage_exhausted pause', async function() {
        var c = await classifiers();
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'status', status: 'rate_limited', reason: 'concurrents' }).kind, 'rate_limited');
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'status', status: 'rate_limited', reason: 529 }).kind, 'overloaded');
        var q = c._poolClassifyEnvelope({ type: 'status', status: 'rate_limited', reason: 429, message: 'Usage limit reached — resets in 2h 5m' });
        assert.strictEqual(q.kind, 'quota_exhausted');
        assert.ok(Math.abs(q.resetAt - (Date.now() + 125 * 60000)) < 2000);
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'status', status: 'rate_limited', reason: 429, waitMs: 4000 }).kind, 'rate_limited');
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'error', code: 'usage_exhausted', error: 'x', resetsAt: '2030-01-01T00:00:00Z' }).resetAt, Date.parse('2030-01-01T00:00:00Z'));
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'error', error: 'API error 429: Usage limit reached — resets in 12m' }).kind, 'quota_exhausted');
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'error', error: 'API error 400: Your credit balance is too low' }).kind, 'quota_exhausted');
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'error', error: 'API error 429: rate_limit_error' }).kind, 'rate_limited');
        assert.strictEqual(c._poolClassifyEnvelope({ type: 'text', text: 'hi' }), null);
    }, T);

    test('reset parsing: epoch s/ms, RFC3339, delta secs, durations, resets-in', async function() {
        var c = await classifiers();
        var now = 1800000000000;
        assert.strictEqual(c._poolParseResetMs('1800000100', now), 1800000100000, 'epoch seconds');
        assert.strictEqual(c._poolParseResetMs('1800000100000', now), 1800000100000, 'epoch ms');
        assert.strictEqual(c._poolParseResetMs('2027-01-01T00:00:00Z', now), Date.parse('2027-01-01T00:00:00Z'));
        assert.strictEqual(c._poolParseResetMs('30', now), now + 30000, 'delta seconds');
        assert.strictEqual(c._poolParseResetMs('6m0s', now), now + 360000);
        assert.strictEqual(c._poolParseResetMs('250ms', now), now + 250);
        assert.strictEqual(c._poolParseResetMs('1h2m3s', now), now + 3723000);
        assert.strictEqual(c._poolParseResetMs('', now), null);
        assert.strictEqual(c._poolParseResetMs('garbage', now), null);
        assert.strictEqual(c._poolParseResetsIn('resets in under a minute', now), now + 60000);
        assert.strictEqual(c._poolParseResetsIn('resets in 3h', now), now + 3 * 3600000);
        assert.strictEqual(c._poolParseResetsIn('nothing here', now), null);
        assert.strictEqual(c._poolPauseSuffix({ group: 'g', pause_reason: 'q', paused_until: now }).indexOf('paused until 2027') > 0, true);
        assert.strictEqual(c._poolPauseSuffix({ group: 'g', pause_reason: null }), '');
    }, T);
});
