// MSG-EVICT send guard: sendMessage (app/040-send-message.js) must not throw
// on an evicted skeleton current chat (no `messages` array). It hydrates via
// ensureChatPayloads first; if the chat stays a skeleton it shows a snackbar
// and returns WITHOUT clearing the input or the saved draft. Evaluates the
// REAL sendMessage text cut out of the source (same pattern as
// test/chat-eviction-store-b.test.js) with in-memory stubs. After hydration
// sendMessage RE-ENTERS itself by name (`return sendMessage();`) — the cut
// function is a declaration inside the Function body, so that name binds.

function _cutFns(src, names) {
    return names.map(function(name) {
        var re = new RegExp('^(async )?function ' + name + '\\(', 'm');
        var m = re.exec(src);
        if (!m) throw new Error('function not found: ' + name);
        var end = src.indexOf('\n}\n', m.index);
        if (end === -1) throw new Error('function end not found: ' + name);
        return src.slice(m.index, end + 2);
    }).join('\n');
}

// env: { chats, currentChatId, hydrate: bool, stored: messages[], switchTo, ensureMissing,
//        gate: Promise (ensureChatPayloads resolves only after it), overlap: bool (two
//        concurrent sendMessage() calls), release(input) (runs after the calls start) }
async function _send(env) {
    var src = await loadFile('src/js/app/040-send-message.js');
    var st = { hydrates: [], snackbars: [], runs: 0, saves: 0, renders: 0, persists: 0, injected: 0 };
    var input = { value: env.text == null ? 'hello' : env.text, style: {} };
    var drafts = { ctx: input.value };
    var body = ''
        + 'var currentChatId = env.currentChatId, pendingInjection = null, pendingInjectionImages = null;\n'
        + 'var currentEditingWidget = null, stickToBottom = false, paused = false, isRunning = false, activeStreamingChatId = null;\n'
        + 'var pendingImageAttachments = [], runningChatIds = {}, pausedChats = {}, pendingInjectionsByChatId = {};\n'
        + 'var chatPendingTexts = env.drafts, _silentHookChats = {};\n'
        + 'var document = { getElementById: function() { return env.input; } };\n'
        + 'function t(s) { return s; }\n'
        + 'function showSnackbar(m, k) { st.snackbars.push([m, k]); }\n'
        + 'function getCurrentPendingContext() { return "ctx"; }\n'
        + 'function persistPendingTextsToStorage() { st.persists++; }\n'
        + 'function injectInterruptedToolResults(c) { st.injected++; c.messages.length; return false; }\n'
        + 'function consumeWidgetComposerTarget() { return null; }\n'
        + 'function clearPendingImages() {}\n'
        + 'function updateChatTitle() {}\n'
        + 'function saveChatsToStorage() { st.saves++; }\n'
        + 'function renderMessages() { st.renders++; }\n'
        + 'function renderChatList() {}\n'
        + 'function setChatPausedPersistent() {}\n'
        + 'function syncPauseButtonUI() {}\n'
        + 'async function runAgent() { st.runs++; }\n'
        + (env.ensureMissing ? '' :
          'async function ensureChatPayloads(id) {\n'
        + '    st.hydrates.push(id); await (env.gate || null);\n'
        + '    if (env.switchTo) currentChatId = env.switchTo;\n'
        + '    if (env.hydrate && !Array.isArray(chats[id].messages)) { chats[id].messages = (env.stored || []).slice(); delete chats[id]._messagesEvicted; }\n'
        + '}\n')
        + _cutFns(src, ['sendMessage']) + '\n'
        + 'return sendMessage;';
    env.input = input; env.drafts = drafts;
    var f = new Function('env', 'st', 'chats', body);
    var sendMessage = f(env, st, env.chats);
    var threw = null;
    var calls = env.overlap ? [sendMessage(), sendMessage()] : [sendMessage()];
    if (env.release) env.release(input);
    try { await Promise.all(calls); } catch (e) { threw = e; }
    return { st: st, input: input, drafts: drafts, threw: threw };
}
function _skel(id) { return { id: id, title: 'T', _messagesEvicted: true, _payloadsEvicted: true, _msgCount: 1 }; }

describe('MSG-EVICT: sendMessage skeleton guard', function() {
    test('skeleton current chat that hydrates: message is sent', async function() {
        var chats = { a: _skel('a') };
        var r = await _send({ chats: chats, currentChatId: 'a', hydrate: true, stored: [{ role: 'user', content: 'old' }] });
        assert.strictEqual(r.threw, null, 'no throw');
        assert.deepStrictEqual(r.st.hydrates, ['a']);
        assert.ok(Array.isArray(chats.a.messages));
        assert.strictEqual(chats.a.messages.length, 2, 'appended after the restored history');
        assert.strictEqual(chats.a.messages[1].content, 'hello');
        assert.strictEqual(r.st.runs, 1, 'runAgent kicked off');
        assert.strictEqual(r.input.value, '', 'input cleared on a real send');
        assert.strictEqual(r.drafts.ctx, undefined, 'draft cleared on a real send');
        assert.strictEqual(r.st.snackbars.length, 0);
    }, { tags: ['unit'] });

    test('skeleton that stays a skeleton: no throw, draft + input kept, snackbar, returns', async function() {
        var chats = { a: _skel('a') };
        var r = await _send({ chats: chats, currentChatId: 'a', hydrate: false });
        assert.strictEqual(r.threw, null, 'no TypeError');
        assert.deepStrictEqual(r.st.hydrates, ['a']);
        assert.strictEqual(chats.a.messages, undefined, 'never seeds [] onto the skeleton');
        assert.strictEqual(r.drafts.ctx, 'hello', 'draft kept');
        assert.strictEqual(r.input.value, 'hello', 'input kept');
        assert.strictEqual(r.st.persists, 0);
        assert.strictEqual(r.st.injected, 0);
        assert.strictEqual(r.st.runs, 0);
        assert.strictEqual(r.st.snackbars.length, 1);
        assert.strictEqual(r.st.snackbars[0][1], 'error');
    }, { tags: ['unit'] });

    test('chat switched during hydration: returns silently, nothing pushed', async function() {
        var chats = { a: _skel('a'), b: { id: 'b', messages: [] } };
        var r = await _send({ chats: chats, currentChatId: 'a', hydrate: true, switchTo: 'b' });
        assert.strictEqual(r.threw, null);
        assert.strictEqual(chats.b.messages.length, 0, 'not sent into the other chat');
        assert.strictEqual(chats.a.messages.length, 0, 'not sent into the old chat');
        assert.strictEqual(r.drafts.ctx, 'hello');
        assert.strictEqual(r.st.runs, 0);
        assert.strictEqual(r.st.snackbars.length, 0);
    }, { tags: ['unit'] });

    test('no ensureChatPayloads available: skeleton still guarded', async function() {
        var chats = { a: _skel('a') };
        var r = await _send({ chats: chats, currentChatId: 'a', ensureMissing: true });
        assert.strictEqual(r.threw, null);
        assert.strictEqual(r.drafts.ctx, 'hello');
        assert.strictEqual(r.st.snackbars.length, 1);
    }, { tags: ['unit'] });

    test('overlapping sends on a skeleton (double Enter): ONE user message, ONE runAgent', async function() {
        var chats = { a: _skel('a') };
        var rel; var gate = new Promise(function(r) { rel = r; });
        var r = await _send({ chats: chats, currentChatId: 'a', hydrate: true,
            stored: [{ role: 'user', content: 'old' }], overlap: true, gate: gate,
            // text typed while the hydration is in flight must not be lost
            release: function(input) { input.value = 'hello again'; rel(); } });
        assert.strictEqual(r.threw, null, 'no throw');
        assert.strictEqual(r.st.hydrates.length, 2, 'both calls hit the skeleton guard');
        var users = chats.a.messages.filter(function(m) { return m.role === 'user'; });
        assert.strictEqual(users.length, 2, 'old + exactly ONE new user message');
        assert.strictEqual(chats.a.messages.length, 2);
        assert.strictEqual(chats.a.messages[1].content, 'hello again', 're-entry re-reads the live input');
        assert.strictEqual(r.st.runs, 1, 'exactly ONE runAgent');
        assert.strictEqual(r.input.value, '', 'input cleared');
        assert.strictEqual(r.st.snackbars.length, 0);
    }, { tags: ['unit'] });

    test('hydrated chat: unchanged path, no hydration call', async function() {
        var chats = { a: { id: 'a', messages: [] } };
        var r = await _send({ chats: chats, currentChatId: 'a' });
        assert.strictEqual(r.threw, null);
        assert.deepStrictEqual(r.st.hydrates, []);
        assert.strictEqual(chats.a.messages.length, 1);
        assert.strictEqual(r.st.runs, 1);
    }, { tags: ['unit'] });
});
