
// Simulated units: real worker handlers + real retry Promise; fake clock, no live UI.
var opts = { tags: ['unit'], timeout: 20000 };
async function fixture() {
    var timers = [], settled = {}, calls = [];
    var g = {
        self: {}, chrome: fakeChrome(),
        chats: { a: { id: 'a', messages: [] }, b: { id: 'b', messages: [] } },
        runningChatIds: { a: true, b: true }, pendingInjectionsByChatId: {},
        userInterruptedChats: {}, providerChangeBackoffResolversByChatId: {},
        interruptResolversByChatId: {}, currentStreamAbortControllers: {},
        _hookRunDeferInjectionByChat: {},
        setChatPausedPersistent: function(id, paused) { calls.push(['pause', id, paused]); },
        _swAnswerPendingPromptViaChat: function() { return false; }
    };
    var m = await loadModules(['src/js/worker/130-port-bridge.js'], { globals: g });
    var source = await loadFile('src/js/app/030-agent-loop.js');
    var start = source.indexOf('                await new Promise(function(resolve) {', source.indexOf('if (_throttleClass'));
    var end = source.indexOf('\n                continue;', start);
    assert.ok(start >= 0 && end > start, 'real throttle Promise found');
    var AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    var wait = new AsyncFunction('streamingChatId', '_waitMs', 'providerChangeBackoffResolversByChatId', 'setTimeout', 'clearTimeout', source.slice(start, end));
    function arm(id) {
        settled[id] = false;
        var p = wait(id, 30000, g.providerChangeBackoffResolversByChatId,
            function(fn, ms) { timers.push({ fn: fn, ms: ms, cancelled: false }); return timers.length; },
            function(handle) { timers[handle - 1].cancelled = true; });
        p.then(function() { settled[id] = true; }); return p;
    }
    function effects(id) {
        g.interruptResolversByChatId[id] = function() { calls.push(['tool', id]); };
        g.currentStreamAbortControllers[id] = { abort: function() { calls.push(['stream', id]); } };
    }
    return { m: m, g: g, timers: timers, settled: settled, calls: calls, arm: arm, effects: effects,
        send: function(msg) { return m._handlePanelSendMessage(Object.assign({ chatId: 'a', text: 'new' }, msg)); },
        interrupt: function(msg) { return m._handlePanelMessage({}, Object.assign({ type: 'interrupt', chatId: 'a' }, msg)); } };
}
async function ticks() { await Promise.resolve(); await Promise.resolve(); }
function effectCalls(f) { return f.calls.filter(function(c) { return c[0] !== 'pause'; }); }
function released(f) {
    assert.strictEqual(f.settled.a, true);
    assert.strictEqual(f.timers[0].cancelled, true);
    assert.strictEqual(f.g.providerChangeBackoffResolversByChatId.a, undefined);
}

test('send synchronously wakes/cancels/cleans and retains text/images while isolating another chat', async function() {
    var f = await fixture(); f.arm('a'); f.arm('b');
    f.g.pendingInjectionsByChatId.a = { text: 'old', images: ['old-image'], subNotices: ['notice'] };
    var p = f.send({ text: 'new', images: ['new-image'] });
    assert.strictEqual(f.timers[0].cancelled, true, 'synchronous before awaiting send');
    assert.strictEqual(f.g.providerChangeBackoffResolversByChatId.a, undefined);
    assert.strictEqual(f.g.userInterruptedChats.a, true);
    assert.deepStrictEqual(f.g.pendingInjectionsByChatId.a, { text: 'old\n\nnew', images: ['old-image', 'new-image'], subNotices: ['notice'], hasUserText: true });
    await p; await ticks(); released(f);
    assert.strictEqual(f.settled.b, false);
    assert.strictEqual(f.timers[1].cancelled, false);
    assert.strictEqual(typeof f.g.providerChangeBackoffResolversByChatId.b, 'function');
    assert.strictEqual(f.g.userInterruptedChats.b, undefined);
}, opts);

test('rapid image-only sends retain both injections without invented text', async function() {
    var f = await fixture(); f.arm('a');
    var p = f.send({ text: null, images: ['one'] });
    var q = f.send({ text: '', images: ['two'] });
    await p; await q; await ticks(); released(f);
    assert.deepStrictEqual(f.g.pendingInjectionsByChatId.a, { text: null, images: ['one', 'two'] });
}, opts);

test('no-backoff send and interrupt retain existing tool and stream effects', async function() {
    var f = await fixture(); f.effects('a');
    await f.send(); f.interrupt({ fromUserMessage: true });
    assert.deepStrictEqual(effectCalls(f), [['tool', 'a'], ['stream', 'a'], ['tool', 'a'], ['stream', 'a']]);
    assert.strictEqual(f.g.pendingInjectionsByChatId.a.text, 'new');
    assert.strictEqual(f.g.userInterruptedChats.a, true);
}, opts);

test('hook deferral queues without waking, interrupting or checking prompt', async function() {
    var f = await fixture(); f.arm('a'); f.effects('a');
    f.g._hookRunDeferInjectionByChat.a = true;
    f.m.__scope._swAnswerPendingPromptViaChat = function() { throw new Error('must not consult prompt during hook'); };
    await f.send(); await ticks();
    assert.strictEqual(f.settled.a, false);
    assert.strictEqual(f.timers[0].cancelled, false);
    assert.strictEqual(typeof f.g.providerChangeBackoffResolversByChatId.a, 'function');
    assert.strictEqual(f.g.userInterruptedChats.a, undefined);
    assert.strictEqual(f.g.pendingInjectionsByChatId.a.text, 'new');
    assert.deepStrictEqual(effectCalls(f), []);
}, opts);

test('accepted prompt answer does not interrupt; stop/rejected answer wakes', async function() {
    var f = await fixture(); f.arm('a'); f.effects('a');
    f.m.__scope._swAnswerPendingPromptViaChat = function(id, text) { return text !== 'stop'; };
    await f.send({ text: 'yes' }); await ticks();
    assert.strictEqual(f.settled.a, false);
    assert.strictEqual(f.timers[0].cancelled, false);
    assert.strictEqual(f.g.userInterruptedChats.a, undefined);
    assert.deepStrictEqual(effectCalls(f), []);
    await f.send({ text: 'stop' }); await ticks(); released(f);
    assert.strictEqual(f.g.pendingInjectionsByChatId.a.text, 'yes\n\nstop');
    assert.deepStrictEqual(effectCalls(f), [['tool', 'a'], ['stream', 'a']]);
}, opts);

test('bare stop wakes and discards only its injection without marking user-message interrupt', async function() {
    var f = await fixture(); f.arm('a'); f.arm('b'); f.effects('a');
    f.g.pendingInjectionsByChatId.a = { text: 'discard' };
    f.g.pendingInjectionsByChatId.b = { text: 'keep' };
    f.interrupt({ fromUserMessage: false }); await ticks(); released(f);
    assert.strictEqual(f.g.pendingInjectionsByChatId.a, undefined);
    assert.strictEqual(f.g.userInterruptedChats.a, undefined);
    assert.strictEqual(f.g.pendingInjectionsByChatId.b.text, 'keep');
    assert.strictEqual(f.settled.b, false);
    assert.deepStrictEqual(effectCalls(f), [['tool', 'a'], ['stream', 'a']]);
}, opts);

test('user-message interrupt retains payload; missing chat id leaves timer untouched', async function() {
    var f = await fixture(); f.arm('a');
    f.g.pendingInjectionsByChatId.a = { text: 'keep', images: ['img'] };
    f.interrupt({ chatId: null });
    assert.strictEqual(f.timers[0].cancelled, false);
    f.interrupt({ fromUserMessage: true }); await ticks(); released(f);
    assert.strictEqual(f.g.userInterruptedChats.a, true);
    assert.deepStrictEqual(f.g.pendingInjectionsByChatId.a, { text: 'keep', images: ['img'] });
}, opts);

test('throwing callback is removed without blocking existing interrupt effects', async function() {
    var f = await fixture(); f.effects('a');
    function bad() { throw new Error('resolver failed'); }
    f.g.providerChangeBackoffResolversByChatId.a = bad;
    await f.send();
    assert.strictEqual(f.g.providerChangeBackoffResolversByChatId.a, undefined);
    f.g.providerChangeBackoffResolversByChatId.a = bad; f.interrupt();
    assert.strictEqual(f.g.providerChangeBackoffResolversByChatId.a, undefined);
    assert.deepStrictEqual(effectCalls(f), [['tool', 'a'], ['stream', 'a'], ['tool', 'a'], ['stream', 'a']]);
}, opts);

test('natural retry expiry still settles and removes callback', async function() {
    var f = await fixture(); f.arm('a');
    assert.strictEqual(f.timers[0].ms, 30000);
    f.timers[0].fn(); await ticks();
    assert.strictEqual(f.settled.a, true);
    assert.strictEqual(f.g.providerChangeBackoffResolversByChatId.a, undefined);
    assert.strictEqual(f.g.userInterruptedChats.a, undefined);
}, opts);

test('mutation-lite detects removing wake, removing cleanup and inverting the new guard in both handlers', async function() {
    var FunctionCtor = Function;
    for (var lane of ['send', 'interrupt']) {
        for (var mutation of ['baseline', 'no-wake', 'no-delete', 'inverted-guard']) {
            var f = await fixture(); f.arm('a');
            var bridge = await loadFile('src/js/worker/130-port-bridge.js');
            var signature = lane === 'send' ? 'async function _handlePanelSendMessage(' : 'function _handlePanelMessage(';
            var fnStart = bridge.indexOf(signature);
            var fnEnd = bridge.indexOf('\n}', fnStart) + 2;
            assert.ok(fnStart >= 0 && fnEnd > fnStart, 'extract untransformed real handler');
            var key = lane === 'send' ? 'chatId' : 'icid';
            var lookup = 'providerChangeBackoffResolversByChatId[' + key + ']';
            var source = bridge.slice(fnStart, fnEnd);
            if (mutation === 'no-wake') source = source.replace(lookup + '();', 'void 0;');
            if (mutation === 'no-delete') source = source.replace('delete ' + lookup + ';', 'void 0;');
            if (mutation === 'inverted-guard') source = source.replace('if (' + lookup + ')', 'if (!' + lookup + ')');
            var handler = new FunctionCtor('scope', 'with (scope) { return (' + source + '); }')(f.g);
            if (lane === 'send') await handler({ chatId: 'a', text: 'new' });
            else handler({}, { type: 'interrupt', chatId: 'a' });
            await ticks();
            var observed = [f.settled.a, f.timers[0].cancelled, f.g.providerChangeBackoffResolversByChatId.a === undefined];
            if (mutation === 'baseline') assert.deepStrictEqual(observed, [true, true, true], lane + ' mutation baseline');
            else assert.ok(JSON.stringify(observed) !== '[true,true,true]', lane + ' kills ' + mutation);
        }
    }
}, opts);
