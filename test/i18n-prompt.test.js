// i18n C: the agent reply language. {{RESPONSE_LANGUAGE}} in the DEFAULT system
// prompt (core/110-system-prompt.js) and the custom-prompt fallback
// _maybeAppendResponseLanguage (core/100-cached-results.js), both driven by
// i18nResponseLanguageInstruction (core/025-i18n.js). Real source files via
// loadModules; globals stub only storage/runtime plumbing.
var T = { tags: ['unit'], timeout: 5000 };
var PATHS = ['src/js/core/025-i18n.js', 'src/js/core/110-system-prompt.js', 'src/js/core/100-cached-results.js'];
var DATE_OPTS = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
var quiet = { log: function() {}, warn: function() {}, error: function() {}, info: function() {} };
function count(s, sub) { return String(s).split(sub).length - 1; }
function usDate() { return new Date().toLocaleDateString('en-US', DATE_OPTS); }

async function load(paths, opts) {
    return loadModules(paths || PATHS, Object.assign({ lenient: true, globals: {
        window: fakeWindow(), chrome: fakeChrome(), console: quiet,
        getSetting: function() { return Promise.resolve(null); }, setSetting: function() { return Promise.resolve(); },
        getDisabledTools: function() { return []; }, TOOL_DISPLAY_NAMES: {}, getSkillsSummaryForPrompt: function() { return ''; },
        chats: { p: { messages: [] }, s: { isSubAgent: true, messages: [] } }
    }}, opts || {}));
}
// Activate a language without a network fetch: an injected catalog satisfies i18nInit.
async function useLang(m, code) {
    if (code !== 'en') m.i18nSetCatalog(code, { 'Settings': code + ':Settings' });
    return m.i18nInit({ language: code, browserLanguages: ['en-US'] });
}

describe('i18n reply language: DEFAULT system prompt (core/110)', function() {
    test('template: exactly one {{RESPONSE_LANGUAGE}}, on the line right after CURRENT DATE', async function() {
        var m = await load();
        assert.strictEqual(count(m.DEFAULT_SYSTEM_PROMPT_TEMPLATE, '{{RESPONSE_LANGUAGE}}'), 1);
        assert.ok(m.DEFAULT_SYSTEM_PROMPT_TEMPLATE.indexOf('CURRENT DATE: {{CURRENT_DATE}}\n{{RESPONSE_LANGUAGE}}\n\nCHAT VS TASK:') !== -1);
    }, T);

    test('English: no instruction, no leftover placeholder, byte-identical to the template without it', async function() {
        var m = await load();
        assert.strictEqual(m.i18nLang(), 'en');
        assert.strictEqual(m.i18nResponseLanguageInstruction(), '');
        var p = m.getSystemPromptWithContext('p');
        assert.strictEqual(p.indexOf('{{RESPONSE_LANGUAGE}}'), -1);
        assert.strictEqual(p.indexOf("The user's interface language is"), -1);
        assert.ok(/CURRENT DATE: [^\n]+\n\nCHAT VS TASK:/.test(p), 'one blank line between CURRENT DATE and CHAT VS TASK');
        assert.strictEqual(p.indexOf('\n\n\n'), -1, 'no blank-line artifact');
        var legacy = m.DEFAULT_SYSTEM_PROMPT_TEMPLATE.replace('\n{{RESPONSE_LANGUAGE}}', '');
        assert.strictEqual(m.expandSystemPromptPlaceholders(m.DEFAULT_SYSTEM_PROMPT_TEMPLATE, 'p'), m.expandSystemPromptPlaceholders(legacy, 'p'));
    }, T);

    test('French: the instruction sits right under CURRENT DATE, once; CURRENT DATE stays en-US', async function() {
        var m = await load();
        assert.strictEqual(await useLang(m, 'fr'), 'fr');
        var fr = m.i18nResponseLanguageInstruction();
        assert.ok(/^The user's interface language is French \(/.test(fr) && / Reply in French unless /.test(fr), fr);
        var d0 = usDate(), p = m.getSystemPromptWithContext('p'), d1 = usDate();
        assert.ok([d0, d1].some(function(d) { return p.indexOf('CURRENT DATE: ' + d + '\n' + fr + '\n\nCHAT VS TASK:') !== -1; }),
            'en-US date line, then the reply-language line, then one blank line');
        assert.strictEqual(count(p, fr), 1, 'default template: not appended a second time');
        assert.strictEqual(p.indexOf('{{RESPONSE_LANGUAGE}}'), -1);
        assert.strictEqual(count(m.getSystemPromptWithContext('s'), fr), 1, 'sub-agent chats get it too, once');
    }, T);

    test('RTL language (Arabic) renders its own instruction', async function() {
        var m = await load();
        assert.strictEqual(await useLang(m, 'ar'), 'ar');
        var p = m.getSystemPromptWithContext('p');
        assert.ok(/The user's interface language is Arabic \([^)]+\)\. Reply in Arabic unless /.test(p));
    }, T);

    test('the prompt follows a language switch and returns byte-identical to English', async function() {
        var m = await load();
        var en = m.getSystemPromptWithContext('p');
        await useLang(m, 'fr');
        assert.notStrictEqual(m.getSystemPromptWithContext('p'), en);
        assert.strictEqual(await useLang(m, 'en'), 'en');
        assert.strictEqual(m.getSystemPromptWithContext('p'), en);
    }, T);
});

describe('i18n reply language: CUSTOM prompts (core/100 _maybeAppendResponseLanguage)', function() {
    test('custom prompt without the placeholder: appended once, after the orchestrator policy', async function() {
        var m = await load();
        await useLang(m, 'fr');
        var fr = m.i18nResponseLanguageInstruction();
        await m.saveCustomSystemPrompt('My custom prompt {{CURRENT_DATE}}');
        var p = m.getSystemPromptWithContext('p');
        assert.strictEqual(p.indexOf('My custom prompt'), 0);
        assert.strictEqual(count(p, fr), 1);
        assert.strictEqual(p.lastIndexOf('\n\n' + fr), p.length - fr.length - 2, 'appended at the end');
        assert.ok(p.indexOf('SUB-AGENT DELEGATION & ORCHESTRATION') !== -1 && p.indexOf('SUB-AGENT DELEGATION & ORCHESTRATION') < p.indexOf(fr));
    }, T);

    test('idempotent: a second pass and a prompt that already carries it are unchanged', async function() {
        var m = await load();
        await useLang(m, 'fr');
        var fr = m.i18nResponseLanguageInstruction();
        await m.saveCustomSystemPrompt('Custom');
        var once = m._maybeAppendResponseLanguage('Custom');
        assert.strictEqual(once, 'Custom\n\n' + fr);
        assert.strictEqual(m._maybeAppendResponseLanguage(once), once);
        assert.strictEqual(m._maybeAppendResponseLanguage(null), null, 'non-string input returned as-is');
    }, T);

    test('custom prompt WITH the placeholder: expanded in place, not appended', async function() {
        var m = await load();
        await useLang(m, 'fr');
        var fr = m.i18nResponseLanguageInstruction();
        await m.saveCustomSystemPrompt('Head\n{{RESPONSE_LANGUAGE}}\nTail');
        var p = m.getSystemPromptWithContext('p');
        assert.strictEqual(count(p, fr), 1);
        assert.strictEqual(p.indexOf('Head\n' + fr + '\nTail'), 0);
    }, T);

    test('English: no-op on custom prompts; a placeholder line collapses without a blank line', async function() {
        var m = await load();
        await m.saveCustomSystemPrompt('Head\n{{RESPONSE_LANGUAGE}}\nTail');
        var p = m.getSystemPromptWithContext('p');
        assert.strictEqual(p.indexOf('Head\nTail'), 0);
        assert.strictEqual(p.indexOf('{{RESPONSE_LANGUAGE}}'), -1);
        assert.strictEqual(m._maybeAppendResponseLanguage('Custom'), 'Custom');
        assert.strictEqual(m.expandSystemPromptPlaceholders('Say hi {{RESPONSE_LANGUAGE}}!'), 'Say hi !');
    }, T);

    test('placeholder on the LAST line (no trailing newline): en drops the line, fr inserts the instruction', async function() {
        var m = await load();
        var en = m.expandSystemPromptPlaceholders('Head\n{{RESPONSE_LANGUAGE}}');
        assert.strictEqual(en.indexOf('{{RESPONSE_LANGUAGE}}'), -1, 'no leftover placeholder');
        assert.strictEqual(en, 'Head', 'en: the placeholder line is removed with its newline');
        assert.strictEqual(m.expandSystemPromptPlaceholders('Head\n  {{RESPONSE_LANGUAGE}} \t'), 'Head', 'en: trailing blanks on the last line too');
        assert.strictEqual(m.expandSystemPromptPlaceholders('Head\n{{RESPONSE_LANGUAGE}}\nTail'), 'Head\nTail', 'en: mid-template line unchanged');
        await useLang(m, 'fr');
        var fr = m.i18nResponseLanguageInstruction();
        assert.ok(fr, 'fr has an instruction');
        var p = m.expandSystemPromptPlaceholders('Head\n{{RESPONSE_LANGUAGE}}');
        assert.strictEqual(p, 'Head\n' + fr, 'fr: instruction inserted on the last line');
        assert.strictEqual(count(p, fr), 1);
    }, T);

    test('default template active: _maybeAppendResponseLanguage is a no-op', async function() {
        var m = await load();
        await useLang(m, 'fr');
        assert.strictEqual(m.hasCustomSystemPrompt(), false);
        assert.strictEqual(m._maybeAppendResponseLanguage('X'), 'X');
    }, T);
});

describe('i18n reply language: SW-safe typeof guards', function() {
    test('without the i18n core (i18n:false) prompts render English with no placeholder or artifact', async function() {
        var m = await load(['src/js/core/110-system-prompt.js', 'src/js/core/100-cached-results.js'], { i18n: false });
        var p = m.getSystemPromptWithContext('p');
        assert.strictEqual(p.indexOf('{{RESPONSE_LANGUAGE}}'), -1);
        assert.ok(/CURRENT DATE: [^\n]+\n\nCHAT VS TASK:/.test(p));
        await m.saveCustomSystemPrompt('Custom');
        assert.strictEqual(m._maybeAppendResponseLanguage('Custom'), 'Custom');
    }, T);
});
