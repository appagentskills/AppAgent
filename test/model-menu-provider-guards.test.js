// A8A model-menu provider guards (src/js/ui/160-notifications.js).
// A8A-01: re-selecting the active ChatGPT-OAuth model is not a provider switch, so it
//         must not name the running foreground chat for an abort. The SW still gets
//         the provider-change post, with chatId null (a pure adopt).
// A8A-02: the model-menu "Log out" rows must report chrome.runtime.lastError /
//         response.error as a failure instead of always showing a success toast.
describe('A8A model-menu provider guards (ui/160-notifications.js)', function() {
    var PROVIDERS = {
        GPT: { name: 'GPT', isChatGPTOAuth: true },
        Claude: { name: 'Claude' }
    };

    // Loads the REAL 160-notifications.js. saveProviderToStorage, updateModelDisplay and
    // setLLMConnectionStatus are defined in that file, so they run for real: appStorage,
    // a document whose getElementById returns null and a callback-style chrome fake cover
    // them. opts.reply(msg) -> { lastError?, response? } drives chrome.runtime.sendMessage:
    // lastError is set only while the callback runs, like Chrome does.
    async function load(opts) {
        opts = opts || {};
        var pushes = [], snacks = [], sent = [];
        var chrome = fakeChrome({ runtime: { sendMessage: function(msg, cb) {
            sent.push(msg && msg.type);
            var reply = opts.reply ? (opts.reply(msg) || {}) : {};
            chrome.runtime.lastError = reply.lastError || undefined;
            try { if (typeof cb === 'function') cb(reply.response); }
            finally { chrome.runtime.lastError = undefined; }
        } } });
        var m = await loadModules(['src/js/ui/160-notifications.js'], { lenient: true, globals: {
            window: fakeWindow(), chrome: chrome,
            document: { getElementById: function() { return null; }, querySelectorAll: function() { return []; },
                addEventListener: function() {}, removeEventListener: function() {},
                contains: function() { return false; }, activeElement: null },
            getProviderById: function(id) { return PROVIDERS[id] || null; },
            currentProvider: opts.currentProvider || 'GPT',
            currentChatId: 'c1', activeStreamingChatId: 'c1',
            chats: { c1: { id: 'c1' } }, runningChatIds: { c1: true },
            llmConnectionStatus: opts.llmConnectionStatus || 'unknown',
            pushProviderChangeToOffscreen: function(providerId, chatId) { pushes.push([providerId, chatId]); },
            appStorage: { setItem: function() {}, getItem: function() { return null; } },
            fetchCredits: function() {}, invalidateCreditsRequests: function() {},
            showSnackbar: function(message, type) { snacks.push([message, type]); }
        } });
        return { m: m, pushes: pushes, snacks: snacks, sent: sent };
    }

    test('A8A-01: re-selecting the active ChatGPT-OAuth model never names a chat to abort', async function() {
        var t = await load({ currentProvider: 'GPT' });
        t.m.changeProvider('GPT');
        assert.deepStrictEqual(t.pushes, [['GPT', null]], 'still posts the adopt, but with no chat to abort');
    }, { tags: ['unit'] });

    test('A8A-01 control: a real switch away from ChatGPT-OAuth still aborts', async function() {
        var t = await load({ currentProvider: 'GPT' });
        t.m.changeProvider('Claude');
        assert.deepStrictEqual(t.pushes, [['Claude', 'c1']], 'the running foreground chat is named for the abort');
    }, { tags: ['unit'] });

    test('A8A-02: model-menu logout reports lastError / response.error as an error', async function() {
        async function logout(fnName, reply) {
            // 'Claude' is a non-OAuth provider here, so the status refreshes return early.
            var t = await load({ currentProvider: 'Claude', llmConnectionStatus: 'connected', reply: function(msg) {
                return /-oauth-logout$/.test(msg && msg.type) ? reply : {};
            } });
            t.m[fnName]();
            assert.ok(t.sent.some(function(type) { return /-oauth-logout$/.test(type); }), fnName + ' sent its logout message');
            return t.snacks;
        }
        assert.deepStrictEqual(await logout('modelMenuOAuthToggle', { lastError: { message: 'X' } }),
            [['Log out failed: X', 'error']]);
        assert.deepStrictEqual(await logout('modelMenuOAuthToggle', { response: { success: true } }),
            [['Logged out from Claude', 'info']]);
        assert.deepStrictEqual(await logout('modelMenuChatGPTOAuthToggle', { response: { error: 'Use AppAgent to log out.' } }),
            [['Log out failed: Use AppAgent to log out.', 'error']]);
        assert.deepStrictEqual(await logout('modelMenuChatGPTOAuthToggle', { lastError: { message: 'Could not establish connection.' } }),
            [['Log out failed: Could not establish connection.', 'error']]);
        assert.deepStrictEqual(await logout('modelMenuChatGPTOAuthToggle', { response: { success: true } }),
            [['Logged out from ChatGPT', 'info']]);
    }, { tags: ['unit'] });
});
