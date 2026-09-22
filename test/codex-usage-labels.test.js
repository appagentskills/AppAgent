// Run: run_tests { pattern: 'codex-usage-labels' } (js_eval sandbox; no Node).
// Label-only regressions against the actual source-derived Codex usage model.
// No network, runtime UI, or real rate-limit cache is read or changed.
'use strict';

function runCodexUsageLabelAudit(source) {
    var start = source.indexOf('function codexUsageModelFromRl(');
    var end = source.indexOf('\n}', start);
    if (start < 0 || end <= start) throw new Error('Codex usage model declaration missing');
    var model = new Function(source.slice(start, end + 2) + '\nreturn codexUsageModelFromRl;')();
    var cases = [
        ['missing', undefined, 'Secondary limit'],
        ['null', null, 'Secondary limit'],
        ['empty', '', 'Secondary limit'],
        ['whitespace', '  ', 'Secondary limit'],
        ['invalid', 'not-a-number', 'Secondary limit'],
        ['numeric prefix is not a valid duration', '300junk', 'Secondary limit'],
        ['boolean', true, 'Secondary limit'],
        ['array', [300], 'Secondary limit'],
        ['NaN', NaN, 'Secondary limit'],
        ['infinity', Infinity, 'Secondary limit'],
        ['infinite string', 'Infinity', 'Secondary limit'],
        ['zero', 0, 'Secondary limit'],
        ['negative', -60, 'Secondary limit'],
        ['fractional minute', 0.5, '0.5-minute limit'],
        ['one minute', 1, '1-minute limit'],
        ['below hour', 59, '59-minute limit'],
        ['one hour', '60', '1-hour limit'],
        ['non-integral hours', 90, '90-minute limit'],
        ['five hours', 300, '5-hour limit'],
        ['below half-day', 719, '719-minute limit'],
        ['half-day', 720, '12-hour limit'],
        ['below day', 1439, '1439-minute limit'],
        ['one day', 1440, '1-day limit'],
        ['non-integral days', 1441, '1441-minute limit'],
        ['one and a half days', 2160, '36-hour limit'],
        ['two days', 2880, '2-day limit'],
        ['do not round to a week', 10079.6, '10079.6-minute limit'],
        ['one week', '10080', 'Weekly limit'],
        ['two weeks', 20160, '14-day limit']
    ];
    var results = cases.map(function(c) {
        var headers = { 'x-codex-primary-used-percent': '17.25', 'x-codex-secondary-used-percent': '0' };
        if (c[1] !== undefined) headers['x-codex-secondary-window-minutes'] = c[1];
        var result = model(headers);
        var label = result.limits[1].label;
        var percentResetUnchanged = result.pill.percent === 17.25 && result.pill.resetStr === '' &&
            result.limits[0].percent === 17.25 && result.limits[0].resets_at === null &&
            result.limits[1].percent === 0 && result.limits[1].resets_at === null;
        return { name: c[0], actual: label, expected: c[2],
            passed: label === c[2] && result.weeklyTip === c[2].toLowerCase() + ': 0.0%' && percentResetUnchanged };
    });
    var secondaryOnly = model({ 'x-codex-secondary-used-percent': '12.5', 'x-codex-secondary-window-minutes': '0' });
    results.push({ name: 'secondary-only fallback keeps reported percent and neutral label',
        passed: secondaryOnly.pill.percent === 12.5 && secondaryOnly.limits[0].label === 'Secondary limit' && secondaryOnly.weeklyTip === '' });
    var primaryOnly = model({ 'x-codex-primary-used-percent': '7' });
    results.push({ name: 'primary-only model does not invent secondary label',
        passed: primaryOnly.pill.percent === 7 && primaryOnly.limits.length === 1 && primaryOnly.weeklyTip === '' });
    results.push({ name: 'missing usable buckets remain null', passed: model(null) === null && model({}) === null });
    var resets = model({ 'x-codex-primary-used-percent': '17.25', 'x-codex-primary-reset-at': '4102444800',
        'x-codex-secondary-used-percent': '42.5', 'x-codex-secondary-reset-at': '4102448400',
        'x-codex-secondary-window-minutes': '300' });
    results.push({ name: 'reported percentages and absolute reset values preserved',
        passed: resets.pill.percent === 17.25 && resets.limits[0].resets_at === 4102444800 &&
            resets.limits[1].percent === 42.5 && resets.limits[1].resets_at === 4102448400 });
    return results;
}

// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/ui/170-chat-management.js"];
await registerRunner('codex-usage-labels', async function() { return runCodexUsageLabelAudit(await loadFile(PATHS[0])); });
