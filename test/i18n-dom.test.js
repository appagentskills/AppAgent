// i18n DOM layer: src/js/ui/245-i18n-dom.js (applyI18n key rule + byte-identical
// restore, setAppLanguage order, boot apply, Language <option>s) and its wiring:
// head.html first paint, core/120 boot hooks, the Settings > Language row (ui/040,
// rendered for real) and the SW hooks (worker/190 boot loader, worker/130 run gate
// + the 'ui-language' message).
// The REAL core/025-i18n.js is auto-included by the harness (U.loadUi); catalogs
// come from i18nSetCatalog or a fake fetch of locales/<code>.json.
// Run: run_tests { files: ['test/i18n-dom.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var DOM_FILE = 'src/js/ui/245-i18n-dom.js';
var ICONS = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js'];
// 245/040/240 probe optional globals behind typeof guards; behaviour is asserted below.
var ANY_UNSTUBBED = { indexOf: function() { return 0; } };
var CATALOGS = {
    fr: { 'New chat': 'Nouvelle discussion', 'Settings': 'Paramètres', 'Close': 'Fermer', 'Search chats': 'Rechercher',
        'Type a message': 'Écrire un message', 'Save & close': 'Enregistrer et fermer', 'Language': 'Langue',
        'Auto (browser language)': 'Auto (langue du navigateur)' },
    de: { 'New chat': 'Neuer Chat', 'Settings': 'Einstellungen', 'Close': 'Schließen', 'Search chats': 'Chats suchen',
        'Type a message': 'Nachricht eingeben' },
    ar: { 'New chat': 'محادثة جديدة' }
};
var HTML_EL = document.documentElement;
var ORIG_LANG = HTML_EL.getAttribute('lang'), ORIG_DIR = HTML_EL.getAttribute('dir');
function restoreHtmlAttrs() {
    if (ORIG_LANG === null) HTML_EL.removeAttribute('lang'); else HTML_EL.setAttribute('lang', ORIG_LANG);
    if (ORIG_DIR === null) HTML_EL.removeAttribute('dir'); else HTML_EL.setAttribute('dir', ORIG_DIR);
}
function memStorage(log) {
    var data = {};
    return { data: data, getItem: function(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function(k, v) { if (log) log.push('mirror:' + k + '=' + v); data[k] = String(v); }, removeItem: function(k) { delete data[k]; } };
}
function timerGlobals() {
    return { setTimeout: function(f, ms) { return setTimeout(f, ms); }, clearTimeout: function(id) { return clearTimeout(id); } };
}
// opts: {pref: stored IDB preference, prefGate: promise getSetting waits on, globals}
async function load(opts) {
    opts = opts || {};
    var log = [];
    var globals = Object.assign(timerGlobals(), {
        appStorage: memStorage(log),
        setSetting: async function(k, v) { log.push('setSetting:' + k + '=' + v); },
        getSetting: function(k, d) {
            log.push('getSetting:' + k);
            var v = (k === 'uiLanguage' && opts.pref !== undefined) ? opts.pref : d;
            return Promise.resolve(opts.prefGate).then(function() { return v; });
        },
        chrome: fakeChrome(),
        fetch: function(url) {
            var code = String(url).replace(/^.*locales\//, '').replace(/\.json$/, '');
            log.push('fetch:' + code);
            var cat = CATALOGS[code];
            return Promise.resolve(cat ? { ok: true, status: 200, json: function() { return Promise.resolve(cat); } } : { ok: false, status: 404 });
        },
        _agentBusPort: { postMessage: function(msg) { log.push('post:' + msg.type + '=' + msg.uiLanguage); } },
        currentView: 'settings-page',
        renderSettingsPage: function() { log.push('render:settings-page'); },
        navigator: { languages: ['en-US'], language: 'en-US' }
    }, opts.globals || {});
    var m = await U.loadUi([DOM_FILE], { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED });
    return { m: m, log: log, st: globals.appStorage };
}
async function useLang(m, code) {
    if (code !== 'en') assert.ok(m.i18nSetCatalog(code, CATALOGS[code]), 'catalog accepted: ' + code);
    assert.strictEqual(await m.i18nInit({ language: code }), code, 'active language ' + code);
}

describe('i18n DOM layer: applyI18n key rule', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('own text node translated; child element + surrounding whitespace kept; key normalized', async function() {
        var s = await load();
        assert.strictEqual(s.m.i18nNormalizeKey('  New\n  chat '), 'New chat');
        assert.strictEqual(s.m.i18nNormalizeKey('New\u00a0chat'), 'New chat', 'NBSP collapses too (the extractor uses the same rule)');
        assert.strictEqual(s.m.i18nNormalizeKey(null), '');
        var dom = await U.mountDom({ html: '<button id="b" data-i18n><span class="icon">+</span>  New\n  chat </button>' });
        await useLang(s.m, 'fr');
        assert.strictEqual(s.m.applyI18n(dom.root), 1, 'one element touched');
        var b = dom.$('#b');
        assert.strictEqual(b.querySelector('.icon').outerHTML, '<span class="icon">+</span>', 'child element untouched');
        assert.strictEqual(b.lastChild.nodeValue, '  Nouvelle discussion ', 'leading/trailing whitespace kept');
    }, { tags: ['unit'] });

    test('en is byte-identical; fr -> de -> en re-applies from the stored originals', async function() {
        var s = await load();
        var html = '<div id="w"><h2 data-i18n>Settings</h2><p data-i18n>Close <b>x</b> Search chats</p>' +
            '<span data-i18n>Save &amp; close</span><span data-i18n>Not in any catalog</span>' +
            '<input id="i" data-i18n-attr="placeholder, title" placeholder="Type a message" title="Close">' +
            '<button id="k" data-i18n-attr="aria-label,title,placeholder" aria-label="Settings" title="New chat">*</button></div>';
        var dom = await U.mountDom({ html: html });
        var w = dom.$('#w'), orig = w.innerHTML;
        assert.strictEqual(s.m.applyI18n(dom.root), 6, 'en: every tagged element visited');
        assert.strictEqual(w.innerHTML, orig, 'en apply is byte-identical');
        await useLang(s.m, 'fr'); s.m.applyI18n(dom.root);
        assert.strictEqual(w.querySelector('h2').textContent, 'Paramètres');
        assert.strictEqual(w.querySelector('p').innerHTML, 'Fermer <b>x</b> Rechercher', 'one key per own text node');
        assert.strictEqual(w.querySelectorAll('span')[0].textContent, 'Enregistrer et fermer', 'entity-decoded key');
        assert.strictEqual(w.querySelectorAll('span')[1].textContent, 'Not in any catalog');
        assert.strictEqual(dom.$('#i').getAttribute('placeholder'), 'Écrire un message');
        assert.strictEqual(dom.$('#i').getAttribute('title'), 'Fermer');
        assert.strictEqual(dom.$('#k').getAttribute('aria-label'), 'Paramètres');
        assert.strictEqual(dom.$('#k').getAttribute('title'), 'Nouvelle discussion');
        assert.ok(!dom.$('#k').hasAttribute('placeholder'), 'a listed but absent attribute is not created');
        assert.strictEqual(dom.$('#k').textContent, '*', 'no data-i18n: text untouched');
        await useLang(s.m, 'de'); s.m.applyI18n(dom.root);
        assert.strictEqual(w.querySelector('p').innerHTML, 'Schließen <b>x</b> Chats suchen');
        assert.strictEqual(dom.$('#i').getAttribute('placeholder'), 'Nachricht eingeben');
        assert.strictEqual(w.querySelectorAll('span')[0].textContent, 'Save & close', 'missing in de -> the original');
        await useLang(s.m, 'en'); s.m.applyI18n(dom.root);
        assert.strictEqual(w.innerHTML, orig, 'back to en: byte-identical');
    }, { tags: ['unit'] });

    test('a node or attribute rewritten by code becomes the new source', async function() {
        var s = await load();
        var dom = await U.mountDom({ html: '<h2 id="h" data-i18n>Settings</h2><input id="i" data-i18n-attr="placeholder" placeholder="Type a message">' });
        await useLang(s.m, 'fr'); s.m.applyI18n(dom.root);
        assert.strictEqual(dom.$('#h').textContent, 'Paramètres');
        dom.$('#h').firstChild.nodeValue = 'Close';
        dom.$('#i').setAttribute('placeholder', 'Search chats');
        s.m.applyI18n(dom.root);
        assert.strictEqual(dom.$('#h').textContent, 'Fermer');
        assert.strictEqual(dom.$('#i').getAttribute('placeholder'), 'Rechercher');
        await useLang(s.m, 'en'); s.m.applyI18n(dom.root);
        assert.strictEqual(dom.$('#h').textContent, 'Close', 'restores the NEW source, not the stale one');
        assert.strictEqual(dom.$('#i').getAttribute('placeholder'), 'Search chats');
        assert.strictEqual(s.m.applyI18n(dom.$('#h')), 1, 'the root element itself is included');
        assert.strictEqual(s.m.applyI18n({}), 0, 'non-DOM root -> 0');
    }, { tags: ['unit'] });
});

describe('i18n DOM layer: setAppLanguage re-renders (never reloads)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('order: IDB write -> mirror -> catalog -> DOM + re-render -> SW message LAST; ar -> rtl; bad code -> auto', async function() {
        var s = await load();
        var dom = await U.mountDom({ html: '<span id="x" data-i18n>New chat</span>' });
        assert.strictEqual(await s.m.setAppLanguage('fr'), 'fr');
        var L = s.log, iSet = L.indexOf('setSetting:uiLanguage=fr'), iMirror = L.indexOf('mirror:uiLanguage=fr'),
            iFetch = L.indexOf('fetch:fr'), iRender = L.indexOf('render:settings-page'), iPost = L.indexOf('post:ui-language=fr');
        assert.ok(iSet >= 0 && iMirror > iSet && iFetch > iMirror && iRender > iFetch && iPost > iRender, 'order: ' + L.join(' | '));
        assert.strictEqual(iPost, L.length - 1, 'SW notified LAST');
        assert.strictEqual(L.indexOf('getSetting:uiLanguage'), -1, 'the switch passes the pref explicitly (no IDB re-read)');
        assert.strictEqual(s.st.data.uiLanguage, 'fr'); assert.strictEqual(s.st.data.uiLanguageDir, 'ltr');
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'fr'); assert.strictEqual(HTML_EL.getAttribute('dir'), 'ltr');
        assert.strictEqual(dom.$('#x').textContent, 'Nouvelle discussion');
        assert.ok(s.m.i18nLanguageOptionsHtml().indexOf('value="fr" lang="fr" selected') > 0, 'the select re-renders with the new pref');

        assert.strictEqual(await s.m.setAppLanguage('ar'), 'ar');
        assert.strictEqual(HTML_EL.getAttribute('dir'), 'rtl'); assert.strictEqual(s.st.data.uiLanguageDir, 'rtl');
        assert.strictEqual(dom.$('#x').textContent, 'محادثة جديدة');

        assert.strictEqual(await s.m.setAppLanguage('xx-bogus'), 'en', 'unknown code -> auto -> browser en-US -> en');
        assert.ok(L.indexOf('setSetting:uiLanguage=auto') >= 0);
        assert.strictEqual(L[L.length - 1], 'post:ui-language=auto');
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'en'); assert.strictEqual(HTML_EL.getAttribute('dir'), 'ltr');
        assert.strictEqual(dom.$('#x').textContent, 'New chat');
    }, { tags: ['unit'] });

    test('a catalog that fails to load falls back to en and rewrites the mirror', async function() {
        var s = await load();
        assert.strictEqual(await s.m.setAppLanguage('pt-br'), 'en');
        assert.ok(s.log.indexOf('setSetting:uiLanguage=pt-BR') >= 0, 'the (normalized) preference is still stored');
        assert.ok(s.log.indexOf('fetch:pt-BR') >= 0, s.log.join(' | '));
        assert.strictEqual(s.st.data.uiLanguage, 'en'); assert.strictEqual(s.st.data.uiLanguageDir, 'ltr');
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'en');
        assert.strictEqual(s.log[s.log.length - 1], 'post:ui-language=pt-BR');
    }, { tags: ['unit'] });

    test('rapid switches are serialized (last one wins, SW messages in order)', async function() {
        var s = await load();
        var r = await Promise.all([s.m.setAppLanguage('de'), s.m.setAppLanguage('fr')]);
        assert.strictEqual(r.join(','), 'de,fr');
        assert.strictEqual(s.m.i18nLang(), 'fr');
        assert.strictEqual(s.log.filter(function(x) { return x.indexOf('post:') === 0; }).join(','), 'post:ui-language=de,post:ui-language=fr');
    }, { tags: ['unit'] });
});

describe('i18n DOM layer: boot apply + Language options', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('i18nBootApply: a settled load applies lang/dir, mirror, DOM and the stored preference', async function() {
        var s = await load({ pref: 'fr' });
        var dom = await U.mountDom({ html: '<span id="x" data-i18n>Settings</span>' });
        assert.strictEqual(await s.m.i18nBootApply(s.m.i18nInit(), 5000), true);
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'fr');
        assert.strictEqual(s.st.data.uiLanguage, 'fr');
        assert.strictEqual(dom.$('#x').textContent, 'Paramètres');
        assert.ok(s.m.i18nLanguageOptionsHtml().indexOf('value="fr" lang="fr" selected') > 0, 'IDB preference loaded for the select');
        assert.strictEqual(s.log.indexOf('render:settings-page'), -1, 'no re-render on the fast path (PHASE 2 renders next)');
    }, { tags: ['unit'] });

    test('i18nBootApply: a wedged IDB returns after the deadline, then applies + re-renders late', async function() {
        var release; var gate = new Promise(function(r) { release = r; });
        var s = await load({ pref: 'de', prefGate: gate });
        var dom = await U.mountDom({ html: '<span id="x" data-i18n>Settings</span>' });
        assert.strictEqual(await s.m.i18nBootApply(s.m.i18nInit(), 0), false, 'bounded wait');
        assert.strictEqual(dom.$('#x').textContent, 'Settings', 'nothing applied yet');
        release();
        for (var i = 0; i < 8 && s.log.indexOf('render:settings-page') < 0; i++) await U.flush();
        assert.ok(s.log.indexOf('render:settings-page') >= 0, 'late re-render: ' + s.log.join(' | '));
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'de');
        assert.strictEqual(dom.$('#x').textContent, 'Einstellungen');
    }, { tags: ['unit'] });

    test('Language options: auto + every I18N_LANGUAGES entry, native (English) labels, one selected', async function() {
        var s = await load();
        var doc = U.parse('<select>' + s.m.i18nLanguageOptionsHtml('fr') + '</select>');
        var opts = doc.querySelectorAll('option');
        assert.strictEqual(opts.length, 26, 'auto + 25 languages');
        assert.strictEqual(opts[0].value, 'auto'); assert.strictEqual(opts[0].textContent, 'Auto (browser language)');
        var fr = doc.querySelector('option[value="fr"]');
        assert.ok(fr.hasAttribute('selected')); assert.strictEqual(fr.textContent, 'Français (French)'); assert.strictEqual(fr.getAttribute('lang'), 'fr');
        assert.strictEqual(doc.querySelectorAll('option[selected]').length, 1);
        assert.strictEqual(doc.querySelector('option[value="en"]').textContent, 'English', 'nativeName === name -> one label');
        assert.strictEqual(doc.querySelector('option[value="ar"]').textContent, 'العربية (Arabic)');
        var auto = U.parse('<select>' + s.m.i18nLanguageOptionsHtml() + '</select>');
        assert.ok(auto.querySelector('option[value="auto"]').hasAttribute('selected'), 'default pref = auto');
        assert.strictEqual(s.m.normalizeAppLanguagePref('PT-br'), 'pt-BR');
        assert.strictEqual(s.m.normalizeAppLanguagePref(' fr '), 'fr');
        ['', null, undefined, 'xx', 'AUTO'].forEach(function(v) { assert.strictEqual(s.m.normalizeAppLanguagePref(v), 'auto', String(v)); });
        await useLang(s.m, 'fr');
        assert.ok(s.m.i18nLanguageOptionsHtml().indexOf('>Auto (langue du navigateur)<') > 0, 'the auto label is translated');
    }, { tags: ['unit'] });
});

describe('Settings > Language row (ui/040, rendered for real)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('the row renders the options; onchange switches and re-renders the page in place', async function() {
        var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
        var win = fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(), matchMedia: function() { return mq; } });
        var sets = [];
        var globals = Object.assign(timerGlobals(), { window: win, appStorage: memStorage(), showApiStats: true, renderMessages: U.recorder(),
            appTheme: 'light', sidebarCollapsed: true, historyExpanded: true, CSS: CSS, showSnackbar: U.recorder(), apiProviders: [],
            llmEndpoints: [], currentProvider: null, DEFAULT_API_PROVIDERS: [], getAssumedContextTokens: function() { return 200000; },
            getGlobalMaxTokens: function() { return 16000; }, getGlobalThinkingBudget: function() { return 0; }, hooksEnabled: {},
            setSetting: async function(k, v) { sets.push(k + '=' + v); }, currentView: 'settings-page',
            navigator: { languages: ['en-US'], language: 'en-US' } });
        var m = await U.loadUi(ICONS.concat(['src/js/ui/040-tools-settings.js', 'src/js/ui/240-layout.js', DOM_FILE]),
            { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: win });
        var dom = await U.mountDom({ body: true });
        var renderErr = null;
        try { m.renderSettingsPage(); } catch (e) { renderErr = e; }
        var sel = dom.$('#settings-page-content #settings-language-select');
        assert.ok(sel, 'Language select rendered' + (renderErr ? ' (render error: ' + renderErr.message + ')' : ''));
        assert.strictEqual(sel.getAttribute('onchange'), 'setAppLanguage(this.value)');
        assert.strictEqual(sel.querySelectorAll('option').length, 26);
        assert.strictEqual(sel.value, 'auto');
        assert.ok(m.i18nSetCatalog('fr', CATALOGS.fr));
        sel.value = 'fr';
        U.fireInline(sel, 'change', m);
        for (var i = 0; i < 10 && dom.$('#settings-page-content #settings-language-select') === sel; i++) await U.flush();
        assert.ok(sets.indexOf('uiLanguage=fr') >= 0, 'preference stored: ' + sets.join(','));
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'fr');
        var sel2 = dom.$('#settings-page-content #settings-language-select');
        assert.ok(sel2 && sel2 !== sel, 'the page was re-rendered in place (new select, no reload)');
        assert.strictEqual(sel2.value, 'fr', 'the re-rendered select shows the new preference');
        assert.strictEqual(sel2.parentNode.querySelector('.settings-page-row-label').textContent, 'Langue', 'the row label is translated on re-render');
    }, { tags: ['unit'] });
});

describe('Quick settings (gear panel) > Language picker (body.html #settings-panel-language)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('shares options + setAppLanguage with Settings; a switch from either picker refreshes the panel select', async function() {
        var s = await load({ pref: 'de' });
        var dom = await U.mountDom({ body: true });
        var sel = dom.$('#settings-panel #settings-panel-language');
        assert.ok(sel, 'picker is in the gear panel');
        assert.strictEqual(sel.getAttribute('onchange'), 'setAppLanguage(this.value)', 'same handler as Settings > Language');
        assert.strictEqual(sel.options.length, 1, 'static fallback option before the first sync');
        await s.m.i18nBootApply(s.m.i18nInit(), 5000); // loads the stored pref 'de'
        assert.strictEqual(s.m.syncSettingsPanelLanguage(), true);
        assert.strictEqual(sel.options.length, 26, 'auto + 25 languages (shared list)');
        assert.strictEqual(sel.value, 'de', 'panel opens on the stored preference');
        assert.ok(s.m.i18nSetCatalog('fr', CATALOGS.fr));
        sel.value = 'fr';
        U.fireInline(sel, 'change', s.m);
        for (var i = 0; i < 10 && s.log.indexOf('post:ui-language=fr') < 0; i++) await U.flush();
        assert.ok(s.log.indexOf('setSetting:uiLanguage=fr') >= 0, 'preference stored: ' + s.log.join(' | '));
        assert.strictEqual(s.log[s.log.length - 1], 'post:ui-language=fr', 'SW (agent reply language) notified last');
        assert.ok(s.log.indexOf('render:settings-page') >= 0, 'the settings page re-renders its select from the same pref');
        assert.strictEqual(sel.value, 'fr');
        assert.strictEqual(sel.options[0].textContent, 'Auto (langue du navigateur)', 'options re-rendered in the new language');
        assert.strictEqual(dom.$('label[for="settings-panel-language"]').textContent, 'Langue', 'label translated via the existing key');
        assert.strictEqual(await s.m.setAppLanguage('ar'), 'ar', 'switch from the Settings page picker');
        assert.strictEqual(sel.value, 'ar', 'panel picker follows'); assert.strictEqual(HTML_EL.getAttribute('dir'), 'rtl');
        dom.$('#settings-panel-language').remove();
        assert.strictEqual(s.m.syncSettingsPanelLanguage(), false, 'no picker -> no-op');
    }, { tags: ['unit'] });
});

describe('i18n wiring: head.html first paint, core/120 boot, SW hooks', function() {
    test('head.html: ONE attribute-less inline script sets lang/dir from the (iframe_-prefixed) mirror', async function() {
        var head = await loadFile('src/html/head.html', WS);
        var tags = head.match(/<script\b[^>]*>/g) || [];
        assert.strictEqual(tags.length, 1, 'exactly one script tag'); assert.strictEqual(tags[0], '<script>', 'attribute-less');
        var body = /<script>\n?([\s\S]*?)\n?\s*<\/script>/.exec(head)[1];
        function paint(ls, framed, dark) {
            var attrs = {}, win = { matchMedia: function() { return { matches: !!dark }; } };
            win.self = win; win.top = framed ? {} : win;
            var store = { getItem: typeof ls === 'function' ? ls : function(k) { return Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null; } };
            new Function('window', 'localStorage', 'document', body)(win, store, { documentElement: { setAttribute: function(k, v) { attrs[k] = v; } } });
            return attrs;
        }
        var a = paint({});
        assert.strictEqual(a.lang + '/' + a.dir + '/' + a['data-theme'], 'en/ltr/light', 'empty mirror -> en/ltr');
        var b = paint({ uiLanguage: 'ar', uiLanguageDir: 'rtl', appTheme: 'dark' });
        assert.strictEqual(b.lang + '/' + b.dir + '/' + b['data-theme'], 'ar/rtl/dark');
        var c = paint({ uiLanguage: 'ar', uiLanguageDir: 'rtl', iframe_uiLanguage: 'fr', iframe_uiLanguageDir: 'ltr' }, true);
        assert.strictEqual(c.lang + '/' + c.dir, 'fr/ltr', 'iframe_ prefix, like appTheme');
        assert.strictEqual(paint({ uiLanguage: 'de', uiLanguageDir: 'sideways' }).dir, 'ltr', 'only rtl flips dir');
        var e = paint(function(k) { if (/uiLanguage/.test(k)) throw new Error('denied'); return null; }, false, true);
        assert.strictEqual(e['data-theme'], 'dark', 'a throwing language read never breaks the theme');
    }, { tags: ['unit'] });

    test('core/120: kickoff before the theme slice; bounded apply after the icon pass, before PHASE 2', async function() {
        var src = await loadFile('src/js/core/120-init.js', WS);
        var iKick = src.indexOf("_i18nBootP = (typeof i18nInit === 'function') ? i18nInit() : null;");
        var iTheme = src.indexOf("var savedTheme = appStorage.getItem('appTheme');");
        var iEnd = src.indexOf('// Restore sidebar state', iTheme);
        var iApply = src.indexOf("if (typeof i18nBootApply === 'function') { try { await i18nBootApply(_i18nBootP); } catch (e) {} }");
        var iPhase2 = src.indexOf('// PHASE 2: IndexedDB async loading');
        assert.ok(iKick > 0 && iKick < iTheme, 'kickoff precedes the theme');
        assert.ok(iEnd > iTheme && src.slice(iTheme, iEnd).indexOf('i18n') < 0, 'the widget-print slice stays i18n-free');
        assert.ok(iApply > iEnd && iApply < iPhase2, 'the typeof-guarded apply sits right before PHASE 2');
    }, { tags: ['unit'] });

    test('SW: boot loader, run gate and the ui-language message are typeof-guarded', async function() {
        var w190 = await loadFile('src/js/worker/190-entry.js', WS);
        assert.ok(w190.indexOf("var loadLang = (typeof i18nInit === 'function') ? i18nInit() : Promise.resolve();") > 0, 'boot loader');
        assert.ok(w190.indexOf("safe(loadLang, 'uiLanguage'),") > w190.indexOf('Promise.all(['), 'awaited with the other boot loaders');
        var w130 = await loadFile('src/js/worker/130-port-bridge.js', WS);
        var iGate = w130.indexOf('loadAssumedContextTokens() : null; })');
        assert.ok(iGate > 0 && w130.slice(iGate, iGate + 700).indexOf(".then(function() { return (typeof i18nInit === 'function') ? Promise.resolve(i18nInit()).catch(function() {}) : null; })") > 0,
            'the run gate re-reads the language and never blocks the run');
        var iCase = w130.indexOf("case 'ui-language':"), iNext = w130.indexOf("case 'skills-refresh':", iCase);
        assert.ok(iCase > 0 && iNext > iCase, "case 'ui-language' precedes skills-refresh");
        var body = w130.slice(iCase, iNext);
        assert.ok(/typeof i18nInit === 'function'/.test(body) && /\.catch\(function\(\) \{\}\)/.test(body) && /return;/.test(body), body);
    }, { tags: ['unit'] });
});

// ---- #1032 deferred follow-ups (b, c, f, k, d) ----
describe('i18n DOM layer: refreshI18nViews per-view matrix', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });
    var RENDERERS = { home: 'renderHome', 'settings-page': 'renderSettingsPage', dashboard: 'renderDashboard', skills: 'renderSkillsList',
        docs: 'renderDocsPage', history: 'renderHistoryPage', documents: 'renderDocumentsPage' };
    var NAMES = Object.keys(RENDERERS).map(function(k) { return RENDERERS[k]; });
    async function refreshIn(view) {
        var calls = [], g = { currentView: view };
        NAMES.concat(['renderChatList']).forEach(function(n) { g[n] = function() { calls.push(n); }; });
        var s = await load({ globals: g });
        var dom = await U.mountDom({ html: '<span id="x" data-i18n>New chat</span>' });
        await useLang(s.m, 'fr');
        var ret = s.m.refreshI18nViews();
        return { views: calls.filter(function(n) { return n !== 'renderChatList'; }),
            chatList: calls.filter(function(n) { return n === 'renderChatList'; }).length, ret: ret, text: dom.$('#x').textContent };
    }
    Object.keys(RENDERERS).forEach(function(view) {
        test(view + ' -> ' + RENDERERS[view] + ' exactly once, + renderChatList + applyI18n', async function() {
            var r = await refreshIn(view);
            assert.deepStrictEqual(r.views, [RENDERERS[view]], 'only the matching renderer, once');
            assert.strictEqual(r.chatList, 1, 'renderChatList always runs');
            assert.strictEqual(r.ret, view);
            assert.strictEqual(r.text, 'Nouvelle discussion', 'applyI18n ran over the mounted [data-i18n] node');
        }, { tags: ['unit'] });
    });
    ['chat', 'widget-editor', null].forEach(function(view) {
        test(String(view) + ' -> no view renderer; renderChatList + applyI18n still run', async function() {
            var r = await refreshIn(view);
            assert.deepStrictEqual(r.views, [], 'no view renderer for ' + view);
            assert.strictEqual(r.chatList, 1);
            assert.strictEqual(r.ret, view);
            assert.strictEqual(r.text, 'Nouvelle discussion');
        }, { tags: ['unit'] });
    });
});

describe('i18n DOM layer: switch races (#1032)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test("setAppLanguage('fr') then ('ar') with a slow first setSetting ends lang=ar dir=rtl", async function() {
        var n = 0, sets = [];
        var s = await load({ globals: { setSetting: function(k, v) {
            sets.push(v);
            if (n++ === 0) return new Promise(function(r) { setTimeout(r, 40); });
            return Promise.resolve();
        } } });
        var pFr = s.m.setAppLanguage('fr'), pAr = s.m.setAppLanguage('ar');
        assert.deepStrictEqual(await Promise.all([pFr, pAr]), ['fr', 'ar']);
        assert.deepStrictEqual(sets, ['fr', 'ar'], 'IDB writes in call order');
        assert.strictEqual(HTML_EL.getAttribute('lang'), 'ar');
        assert.strictEqual(HTML_EL.getAttribute('dir'), 'rtl');
        assert.strictEqual(s.st.data.uiLanguage, 'ar'); assert.strictEqual(s.st.data.uiLanguageDir, 'rtl');
        assert.strictEqual(s.m.i18nLang(), 'ar');
    }, { tags: ['unit'] });

    test('boot race: a late _i18nLoadPref result does not override a newer setAppLanguage', async function() {
        var release; var gate = new Promise(function(r) { release = r; });
        var s = await load({ pref: 'de', prefGate: gate });
        var late = s.m._i18nLoadPref();
        assert.strictEqual(await s.m.setAppLanguage('fr'), 'fr');
        release();
        assert.strictEqual(await late, 'fr', 'the stale IDB read (de) is dropped');
        assert.ok(s.m.i18nLanguageOptionsHtml().indexOf('value="fr" lang="fr" selected') > 0, 'select keeps the newer pref');
        var ctl = await load({ pref: 'de' });
        assert.strictEqual(await ctl.m._i18nLoadPref(), 'de', 'control: without a switch the stored pref lands');
    }, { tags: ['unit'] });
});

describe('i18n DOM layer: originals bookkeeping (#1032 mutation survivors)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });

    test('_i18nTranslateAttrs: two elements with the same attribute keep their own English originals', async function() {
        var s = await load();
        var dom = await U.mountDom({ html: '<button id="a" data-i18n-attr="title" title="Close"></button><button id="b" data-i18n-attr="title" title="Settings"></button>' });
        var a = dom.$('#a'), b = dom.$('#b');
        await useLang(s.m, 'fr');
        assert.strictEqual(s.m._i18nTranslateAttrs(a), true);
        assert.strictEqual(s.m._i18nTranslateAttrs(b), true);
        assert.deepStrictEqual([a.title, b.title], ['Fermer', 'Paramètres']);
        await useLang(s.m, 'de');
        s.m.applyI18n(dom.root);
        assert.deepStrictEqual([a.title, b.title], ['Schließen', 'Einstellungen'], 'fr -> de from each own original');
        await useLang(s.m, 'en');
        s.m.applyI18n(dom.root);
        assert.deepStrictEqual([a.title, b.title], ['Close', 'Settings'], 'en restores each own original');
    }, { tags: ['unit'] });

    test('no WeakMap: originals are not tracked, and applyI18n / attrs never throw', async function() {
        var s = await load({ globals: { WeakMap: null } });
        var dom = await U.mountDom({ html: '<span id="x" data-i18n>New chat</span><input id="i" data-i18n-attr="placeholder" placeholder="Type a message">' });
        await useLang(s.m, 'fr');
        assert.strictEqual(s.m.applyI18n(dom.root), 2);
        assert.strictEqual(dom.$('#x').textContent, 'Nouvelle discussion');
        assert.strictEqual(dom.$('#i').getAttribute('placeholder'), 'Écrire un message');
        await useLang(s.m, 'en');
        assert.strictEqual(s.m.applyI18n(dom.root), 2, 'no throw on re-apply');
        assert.strictEqual(dom.$('#x').textContent, 'Nouvelle discussion', 'null-map path taken: nothing to restore from');
        assert.strictEqual(s.m._i18nTranslateAttrs(dom.$('#i')), true);
    }, { tags: ['unit'] });

    test('i18nLanguageOptionsHtml: nativeName -> name -> code fallback, every label escaped', async function() {
        var LANGS = [{ code: 'n1', nativeName: '<b>N&1</b>' }, { code: 'n2', name: 'Name "2" <i>' }, { code: 'c3<x>' },
            { code: 'n4', nativeName: 'Same', name: 'Same' }, { code: 'n5', nativeName: 'Nat', name: '<Eng>' }];
        var m = await U.loadUi([DOM_FILE], { i18n: false, lenient: true, allowUnstubbed: ANY_UNSTUBBED,
            globals: { t: function(k) { return k; }, I18N_LANGUAGES: LANGS } });
        var html = m.i18nLanguageOptionsHtml('auto');
        var doc = U.parse('<select>' + html + '</select>');
        var opts = doc.querySelectorAll('option');
        assert.deepStrictEqual(Array.prototype.map.call(opts, function(o) { return o.textContent; }),
            ['Auto (browser language)', '<b>N&1</b>', 'Name "2" <i>', 'c3<x>', 'Same', 'Nat (<Eng>)']);
        assert.strictEqual(doc.querySelectorAll('select b, select i, select x').length, 0, 'no injected elements');
        assert.ok(html.indexOf('&lt;b&gt;N&amp;1&lt;/b&gt;') > 0, 'nativeName escaped');
        assert.ok(html.indexOf('Name &quot;2&quot; &lt;i&gt;') > 0, 'name escaped');
        assert.ok(html.indexOf('value="c3&lt;x&gt;"') > 0, 'code escaped in the value too');
    }, { tags: ['unit'] });
});

describe('System prompt editor keeps an unsaved draft across a re-render (ui/040)', function() {
    afterEach(function() { U.cleanupAll(); restoreHtmlAttrs(); });
    var SAVED = 'Saved line\nCURRENT DATE: {{CURRENT_DATE}}';
    async function loadEditor(editing) {
        var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
        var win = fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(), matchMedia: function() { return mq; } });
        var globals = Object.assign(timerGlobals(), { window: win, appStorage: memStorage(), CSS: CSS, showSnackbar: U.recorder(),
            systemPromptEditMode: editing, hasCustomSystemPrompt: function() { return true; },
            getSystemPromptTemplate: function() { return SAVED; },
            expandSystemPromptPlaceholders: function(s) { return String(s).replace('{{CURRENT_DATE}}', 'TODAY'); },
            estimateTokens: function(s) { return String(s).length; }, getEnabledTools: function() { return []; },
            escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            navigator: { languages: ['en-US'], language: 'en-US' } });
        var m = await U.loadUi(ICONS.concat(['src/js/ui/040-tools-settings.js']), { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: win });
        var dom = await U.mountDom({ html: '<div id="system-prompt-editor-container"></div>' });
        return { m: m, dom: dom };
    }

    test('edit mode + text differs from the saved template: value and selection survive; no draft -> saved template', async function() {
        var e = await loadEditor(true);
        e.m.renderSystemPromptEditor();
        var ta = e.dom.$('#system-prompt-textarea');
        assert.ok(ta, 'textarea rendered in edit mode');
        assert.strictEqual(ta.value, SAVED, 'no draft yet: the saved template is shown');
        ta.value = 'My unsaved <draft> & more';
        ta.setSelectionRange(3, 10);
        e.m.renderSystemPromptEditor(); // DIRECT editor re-render: the old textarea is still in the DOM here
        // (a language switch goes through renderSettingsPage, which replaces it first -- covered below)
        var ta2 = e.dom.$('#system-prompt-textarea');
        assert.ok(ta2 && ta2 !== ta, 'the editor was re-rendered (new node)');
        assert.strictEqual(ta2.value, 'My unsaved <draft> & more', 'draft survives, not HTML-injected');
        assert.deepStrictEqual([ta2.selectionStart, ta2.selectionEnd], [3, 10], 'selection restored');
        assert.strictEqual(e.dom.$$('#system-prompt-editor-container draft').length, 0);
        ta2.value = SAVED; // back to the saved text -> no draft state
        assert.strictEqual(e.m._systemPromptDraftState(SAVED), null);
        e.m.renderSystemPromptEditor();
        assert.strictEqual(e.dom.$('#system-prompt-textarea').value, SAVED);
    }, { tags: ['unit'] });

    // renderSettingsPage() rewrites #settings-page-content (dropping the old textarea) BEFORE it calls
    // renderSystemPromptEditor(), so the draft must be captured before that write. This goes through the
    // real page render and refreshI18nViews() (currentView 'settings-page'), the language-switch path.
    async function loadSettingsPage() {
        var mq = { matches: false, addEventListener: function() {}, addListener: function() {} };
        var win = fakeWindow({ document: document, _rawCopyStore: {}, isRunning: false, open: U.recorder(), matchMedia: function() { return mq; } });
        var globals = Object.assign(timerGlobals(), { window: win, appStorage: memStorage(), showApiStats: true, renderMessages: U.recorder(),
            appTheme: 'light', sidebarCollapsed: true, historyExpanded: true, CSS: CSS, showSnackbar: U.recorder(), apiProviders: [],
            llmEndpoints: [], currentProvider: null, DEFAULT_API_PROVIDERS: [], getAssumedContextTokens: function() { return 200000; },
            getGlobalMaxTokens: function() { return 16000; }, getGlobalThinkingBudget: function() { return 0; }, hooksEnabled: {},
            setSetting: async function() {}, currentView: 'settings-page', getConnectedInstanceHost: function() { return null; },
            // renderSettingsToolPermissions() runs before the editor: an empty permission model.
            hasNonDefaultPermissions: function() { return false; }, instancePermissions: {}, GLOBAL_PERMISSION_KEYS: [],
            INSTANCE_PERMISSION_KEYS: [], TOOL_DISPLAY_NAMES: {}, TOOLS: [], activeSkills: {}, skills: {}, skillTools: {}, toolPermissions: {},
            escapeHtml: function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
            escapeJsString: function(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); },
            systemPromptEditMode: true, hasCustomSystemPrompt: function() { return true; },
            getSystemPromptTemplate: function() { return SAVED; },
            expandSystemPromptPlaceholders: function(s) { return String(s).replace('{{CURRENT_DATE}}', 'TODAY'); },
            estimateTokens: function(s) { return String(s).length; }, getEnabledTools: function() { return []; },
            navigator: { languages: ['en-US'], language: 'en-US' } });
        var m = await U.loadUi(ICONS.concat(['src/js/ui/040-tools-settings.js', 'src/js/ui/240-layout.js', DOM_FILE]),
            { globals: globals, lenient: true, allowUnstubbed: ANY_UNSTUBBED, window: win });
        var dom = await U.mountDom({ body: true });
        return { m: m, dom: dom };
    }
    function renderPage(e, how) {
        var err = null;
        try { if (how === 'refresh') e.m.refreshI18nViews(); else e.m.renderSettingsPage(); } catch (x) { err = x; }
        return err ? ' (render error: ' + err.message + ')' : '';
    }

    test('renderSettingsPage / refreshI18nViews keep the typed draft (value + selection); no draft -> saved template', async function() {
        var e = await loadSettingsPage();
        var why = renderPage(e);
        var ta = e.dom.$('#settings-page-content #system-prompt-textarea');
        assert.ok(ta, 'textarea rendered by the settings page' + why);
        assert.strictEqual(ta.value, SAVED, 'no draft: the saved template is shown');
        var DRAFT = 'Typed <draft> & not saved';
        ta.value = DRAFT;
        ta.setSelectionRange(2, 9);
        why = renderPage(e);
        var ta2 = e.dom.$('#settings-page-content #system-prompt-textarea');
        assert.ok(ta2 && ta2 !== ta, 'the whole page was re-rendered (new textarea)' + why);
        assert.strictEqual(ta2.value, DRAFT, 'renderSettingsPage keeps the unsaved draft');
        assert.deepStrictEqual([ta2.selectionStart, ta2.selectionEnd], [2, 9], 'selection restored');
        ta2.setSelectionRange(4, 6);
        // The sandbox document cannot take real focus: fake activeElement for the capture and spy focus().
        var focused = [], TA = Object.getPrototypeOf(ta2), origFocus = TA.focus;
        Object.defineProperty(document, 'activeElement', { configurable: true, get: function() { return ta2; } });
        TA.focus = function() { focused.push(this); };
        try { why = renderPage(e, 'refresh'); } finally { delete document.activeElement; TA.focus = origFocus; }
        var ta3 = e.dom.$('#settings-page-content #system-prompt-textarea');
        assert.ok(ta3 && ta3 !== ta2, 'refreshI18nViews re-rendered the settings page' + why);
        assert.strictEqual(ta3.value, DRAFT, 'a language switch (refreshI18nViews) keeps the draft');
        assert.deepStrictEqual([ta3.selectionStart, ta3.selectionEnd], [4, 6]);
        assert.ok(focused.length === 1 && focused[0] === ta3, 'focus follows the draft onto the new textarea');
        ta3.value = SAVED; // back to the saved text -> nothing to carry over
        renderPage(e);
        assert.strictEqual(e.dom.$('#settings-page-content #system-prompt-textarea').value, SAVED, 'no draft -> saved template');
    }, { tags: ['unit'] });

    test('preview mode ignores any textarea and shows the expanded saved template', async function() {
        var e = await loadEditor(false);
        e.m.renderSystemPromptEditor();
        assert.strictEqual(e.dom.$('#system-prompt-textarea'), null);
        assert.strictEqual(e.dom.$('.system-prompt-preview').textContent, 'Saved line\nCURRENT DATE: TODAY');
        assert.strictEqual(e.m._restoreSystemPromptDraft(null), false);
    }, { tags: ['unit'] });
});
