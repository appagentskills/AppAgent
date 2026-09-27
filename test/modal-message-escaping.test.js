// S0C5-02 (a) — names interpolated into showConfirmModal messages are escaped.
// showModal parses the message as HTML (sanitizeModalMessage in ui/220), so a raw
// '<iframe>' / '<script>' / '<b>' / '<v2>' in a file or repo name would be dropped,
// swallow the rest of the message, or restyle it. Each site wraps only the value.
// Run: run_tests { files: ['test/modal-message-escaping.test.js'] }
var WS = args.workspace; // resolved workspace, passed in by run_tests
var U = await runFile('test/ui-helpers.js', { workspace: WS }, WS);

var FILES = ['src/js/core/055-emoji-shortcodes.js', 'src/js/core/060-ui-constants.js', 'src/js/ui/180-search.js', 'src/js/ui/190-json-format.js',
    'src/js/ui/220-notification-system.js'];
var ALLOW = ['_teardownWorkerChatModal', 'startClaudeOAuthLogin', 'startChatGPTOAuthLogin', 'startApprovalTitleFlash', 'syncApprovalTitleFlash',
    'setActionNeedsPermission', 'clearActionNeedsPermission', '_refreshWaitingBadges', 'resolveRootChatId', 'pushPermissionsToOffscreen',
    'clearApprovalNotificationsForChat', '_chatsHydrated', 'getApprovalCardEl', 'settlePendingModalResolve', '_dismissedApprovalKeys',
    'smartDocuments', 'currentEditingWidget', 'AgentEvents', 'invalidateCreditsRequests'];

// [file, unique anchor on the confirm-message line, required escaped value]
var SITES = [
    ['src/js/ui/115-workspace-files-sidebar.js', "'Discard uncommitted changes to \"' + ", 'escapeHtml(f.path)'],
    ['src/js/ui/100-diff-viewer.js', "showConfirmModal('Delete Record', 'Delete \"' + ", 'escapeHtml(currentDiffFile.displayName)'],
    ['src/js/ui/100-diff-viewer.js', "showConfirmModal('Revert Changes', 'Revert \"' + ", 'escapeHtml(currentDiffFile.displayName)'],
    ['src/js/ui/090-version-history.js', "showConfirmModal('Undo Changes', 'Undo changes to \"' + ", 'escapeHtml(displayName)'],
    ['src/js/ui/090-version-history.js', "showConfirmModal('Redo Changes', 'Redo changes to \"' + ", 'escapeHtml(displayName)'],
    ['src/js/ui/090-version-history.js', "showConfirmModal('Delete Record', 'Delete \"' + ", 'escapeHtml(displayName)'],
    ['src/js/ui/120-ui-utils.js', "'Merge pull request #' + info.number + ' (' + ", 'escapeHtml(info.repo)'],
    ['src/js/ui/120-ui-utils.js', "showConfirmModal('Redo Changes', 'Redo changes to \"' + ", 'escapeHtml(displayName)'],
    ['src/js/ui/120-ui-utils.js', "showConfirmModal('Undo All Changes', 'Undo all changes to \"' + ", 'escapeHtml(displayName)'],
    ['src/js/ui/120-ui-utils.js', "var fileNames = changedFiles.map(", 'return escapeHtml(f.displayName);'],
    ['src/js/ui/120-ui-utils.js', "'Undo ALL changes made in this chat? This will revert: ' + ", "revert: ' + fileNames + '."]
];

describe('modal message escaping (S0C5-02 a)', function() {
    afterEach(function() { U.cleanupAll(); });
    test('S0C5-02 escaped names round-trip through sanitizeModalMessage as plain text', async function() {
        var m = await U.loadUi(FILES, { allowUnstubbed: ALLOW });
        ['Widget <iframe> sandbox notes', 'notes<script>.md', '<b>New', '<v2>'].forEach(function(n) {
            var plain = 'Delete "' + n + '"? This cannot be undone.';
            var host = document.createElement('div');
            host.appendChild(m.sanitizeModalMessage('Delete "' + m.escapeHtml(n) + '"? This cannot be undone.'));
            assert.strictEqual(host.textContent, plain, n);
            assert.strictEqual(host.children.length, 0, n + ': no element children');
            var rawHost = document.createElement('div');
            rawHost.appendChild(m.sanitizeModalMessage(plain));
            assert.ok(rawHost.textContent !== plain || rawHost.children.length > 0, n + ': the raw name is not plain text');
        });
    }, { tags: ['unit'] });

    test('S0C5-02 source scan (a): confirm messages escape the interpolated name', async function() {
        var cache = {};
        for (var i = 0; i < SITES.length; i++) {
            var f = SITES[i][0], anchor = SITES[i][1], need = SITES[i][2];
            if (!cache[f]) cache[f] = (await loadFile(f, WS)).split('\n');
            var rows = cache[f].filter(function(l) { return l.indexOf(anchor) >= 0; });
            assert.strictEqual(rows.length, 1, f + ': ' + anchor);
            assert.ok(rows[0].indexOf(need) >= 0, f + ': ' + rows[0].trim());
        }
    }, { tags: ['unit'] });
});

// S0C5-02 (b) — the smart-doc, skills and settings delete confirms escape the name too.
describe('modal message escaping (S0C5-02 b)', function() {
    // [file, unique anchor on the confirm-message line, required escaped value]
    var SITES_B = [
        ['src/js/tools/110-smart-documents.js', "showConfirmModal('Delete Document', 'Delete \"' + ", 'escapeHtml(title)'],
        ['src/js/ui/010-skills-ui.js', "showConfirmModal('Remove File', 'Remove ' + ", 'escapeHtml(filename)'],
        ['src/js/ui/040-tools-settings.js', "var msg = 'Delete endpoint \"' + ", 'escapeHtml(ep.name)'],
        ['src/js/ui/040-tools-settings.js', "showConfirmModal('Delete Model', 'Delete model \"' + ", 'escapeHtml(provider.name)'],
        ['src/js/ui/040-tools-settings.js', "showConfirmModal('Delete Provider', 'Delete provider \"' + ", 'escapeHtml(provider.name)']
    ];
    test('S0C5-02 source scan (b): smart-doc, skills and settings confirms escape names', async function() {
        var cache = {};
        for (var i = 0; i < SITES_B.length; i++) {
            var f = SITES_B[i][0], anchor = SITES_B[i][1], need = SITES_B[i][2];
            if (!cache[f]) cache[f] = (await loadFile(f, WS)).split('\n');
            var rows = cache[f].filter(function(l) { return l.indexOf(anchor) >= 0; });
            assert.strictEqual(rows.length, 1, f + ': ' + anchor);
            assert.ok(rows[0].indexOf(need) >= 0, f + ': ' + rows[0].trim());
        }
    }, { tags: ['unit'] });
});

// RF25-F1 — the A7A-01 "Discard changes?" and A5B2-01 "Replace file" confirms (added
// after the S0C5-02 site lists were written) escape the interpolated name too.
describe('modal message escaping (RF25-F1)', function() {
    // [file, unique anchor on the confirm-message line, required escaped value]
    var SITES_C = [
        ['src/js/tools/110-smart-documents.js', "'Unsaved edits to \"' + ", "escapeHtml((smartDocuments[docId] || {}).title || 'this document')"],
        ['src/js/ui/010-skills-ui.js', "' already exists in this skill. Replace it?'", 'escapeHtml(file.name)']
    ];
    test('RF25-F1 source scan: Discard changes and Replace file confirms escape names', async function() {
        var cache = {};
        for (var i = 0; i < SITES_C.length; i++) {
            var f = SITES_C[i][0], anchor = SITES_C[i][1], need = SITES_C[i][2];
            if (!cache[f]) cache[f] = (await loadFile(f, WS)).split('\n');
            var rows = cache[f].filter(function(l) { return l.indexOf(anchor) >= 0; });
            assert.strictEqual(rows.length, 1, f + ': ' + anchor);
            assert.ok(rows[0].indexOf(need) >= 0, f + ': ' + rows[0].trim());
        }
    }, { tags: ['unit'] });
});
