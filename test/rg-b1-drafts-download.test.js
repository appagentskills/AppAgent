// RG-B1 (ZZTEST-RG): the composer draft debounce (TA3-3, ui/010-skills-ui.js) and
// the single-chat export after payload hydration (TB-6, ui/210-chat-menus.js).
// Real sources; fake DOM, timers, settings and Blob. No live chat, IDB or setting.
// Run: run_tests { files: ['test/rg-b1-drafts-download.test.js'] }
var WS = args.workspace;

describe('TA3-3 draft debounce files the draft under the composer it was typed in', function() {
    async function load(texts) {
        var env = { onInput: null, timers: {}, next: 0, persists: 0, view: 'chat', m: null };
        var g = {
            window: {},
            document: { addEventListener: function(type, fn) { if (type === 'input') env.onInput = fn; } },
            setTimeout: function(fn) { env.next++; env.timers[env.next] = fn; return env.next; },
            clearTimeout: function(id) { delete env.timers[id]; },
            currentChatId: 'chatA', chatPendingTexts: texts,
            persistPendingTextsToStorage: function() { env.persists++; },
            // What the old code read when the timer fired (app/050-image-attachments.js).
            getCurrentPendingContext: function() { return env.view === 'home' ? 'home' : (env.m.__scope.currentChatId || 'none'); }
        };
        env.m = await loadModules(['src/js/ui/010-skills-ui.js'], { workspace: WS, globals: g });
        env.fire = function() { var t = env.timers; env.timers = {}; Object.keys(t).forEach(function(k) { t[k](); }); };
        return env;
    }

    test('a view switch inside 300 ms keeps the draft on its chat; Home and a sent/deleted draft stay put', async function() {
        var texts = { home: 'home draft' }, env = await load(texts);
        var chatInput = { id: 'message-input', value: 'A draft' };
        var homeInput = { id: 'home-message-input', value: 'home draft' };
        assert.strictEqual(typeof env.onInput, 'function', 'input listener not registered');
        env.onInput({ target: chatInput });
        env.view = 'home'; // openHomeView inside the window: the chat composer keeps A's text
        env.fire();
        assert.deepStrictEqual(texts, { home: 'home draft', chatA: 'A draft' }, 'draft filed under the wrong context');
        // Two composers typed in the same window each keep their own timer.
        env.view = 'chat';
        homeInput.value = 'home v2'; env.onInput({ target: homeInput });
        chatInput.value = 'A v2'; env.onInput({ target: chatInput });
        env.fire();
        assert.deepStrictEqual(texts, { home: 'home v2', chatA: 'A v2' }, 'one composer cancelled the other one\'s save');
        // Typed, sent, then the chat is deleted before the timer fires: the text
        // typed earlier must not come back under the old key.
        chatInput.value = 'A v3'; env.onInput({ target: chatInput });
        chatInput.value = ''; delete texts.chatA;
        env.m.__scope.currentChatId = null;
        env.fire();
        assert.deepStrictEqual(texts, { home: 'home v2' }, 'a sent / deleted draft came back');
        assert.strictEqual(env.persists, 4);
    }, { tags: ['unit'], timeout: 3000 });
});

describe('TB-6 downloadChat exports the record present after payload hydration', function() {
    test('ensureChatPayloads swaps in a restored record mid-await -> that record is exported', async function() {
        var src = await loadFile('src/js/ui/210-chat-menus.js');
        var start = src.indexOf('async function downloadChat(');
        var end = src.indexOf('\n}', start);
        assert.ok(start >= 0 && end > start, 'downloadChat declaration not found');
        var blobs = [], clicks = [], snacks = [];
        var RESTORED = 'data:image/png;base64,QQ==';
        var env = {
            chats: { c1: { id: 'c1', title: 'Old', _payloadsEvicted: true, messages: [{ role: 'screenshot', _b64Evicted: true }] } },
            ensureChatPayloads: async function(id) {
                await Promise.resolve();
                env.chats[id] = { id: id, title: 'Restored', messages: [{ role: 'screenshot', base64: RESTORED }] };
            },
            stripTransientChatFieldsForPut: function(c) { return c; },
            Blob: function(parts) { this.parts = parts; blobs.push(this); },
            URL: { createObjectURL: function() { return 'blob:x'; }, revokeObjectURL: function() {} },
            document: { createElement: function() { var el = { click: function() { clicks.push(el.download); } }; return el; },
                body: { appendChild: function() {}, removeChild: function() {} } },
            showSnackbar: function(m, t) { snacks.push(t + ':' + m); }
        };
        var fn = new Function('env', 'with (env) {\n' + src.slice(start, end + 2) + '\nreturn downloadChat;\n}')(env);
        await fn('c1');
        assert.strictEqual(blobs.length, 1, 'nothing exported');
        var exported = JSON.parse(blobs[0].parts.join('')).chat;
        assert.strictEqual(exported.title, 'Restored', 'the stale pre-await record was exported');
        assert.strictEqual(exported.messages[0].base64, RESTORED);
        assert.strictEqual(clicks.length, 1);
        assert.deepStrictEqual(snacks, ['success:Chat downloaded']);
    }, { tags: ['unit'], timeout: 3000 });
});
