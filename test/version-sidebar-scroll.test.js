// Focused tests for preserving the version sidebar's scroll owner across
// renderVersionSidebar()'s innerHTML rebuild.
// Run: run_tests { pattern: 'version-sidebar-scroll' }   (js_eval sandbox; see test/harness.js)
'use strict';

var source = await loadFile('src/js/ui/120-ui-utils.js');
var start = source.indexOf('function _captureVersionSidebarScroll(container) {');
var end = source.indexOf('function renderVersionSidebar() {');
if (start < 0 || end <= start) throw new Error('version-sidebar-scroll: could not find sidebar scroll helpers in 120-ui-utils.js');
var helpers = source.slice(start, end);
var api = new Function(helpers + '\nreturn { capture: _captureVersionSidebarScroll, restore: _restoreVersionSidebarScroll };')();

function element(top, scrollHeight, clientHeight) {
    return { scrollTop: top, scrollHeight: scrollHeight, clientHeight: clientHeight };
}
function listWithContent(list, content) {
    list.querySelector = function(selector) {
        return selector === '.version-sidebar-content' ? content : null;
    };
    return list;
}

describe('version-sidebar-scroll', function() {
    test('absolute inner position is preserved', function() {
        // The current CSS makes the inner content node the scroll owner.
        var oldContent = element(240, 1200, 400);
        var container = listWithContent(element(0, 400, 400), oldContent);
        var state = api.capture(container);
        var newContent = element(0, 2200, 400);
        api.restore(listWithContent(element(0, 400, 400), newContent), state);
        assert.strictEqual(newContent.scrollTop, 240, 'absolute inner position is preserved');
    });

    test('bottom-follow position is preserved', function() {
        // A user who was already at the bottom remains at the bottom when content grows.
        var oldContent = element(800, 1200, 400); // max scrollTop = 800
        var container = listWithContent(element(0, 400, 400), oldContent);
        var state = api.capture(container);
        var newContent = element(0, 2200, 400);
        api.restore(listWithContent(element(0, 400, 400), newContent), state);
        assert.strictEqual(newContent.scrollTop, 1800, 'bottom-follow position is preserved');
    });

    test('non-scrollable rail stays at the top', function() {
        // A non-scrollable old rail must not be treated as an intentional bottom pin.
        var oldContent = element(0, 400, 400);
        var container = listWithContent(element(0, 400, 400), oldContent);
        var state = api.capture(container);
        var newContent = element(0, 1000, 400);
        api.restore(listWithContent(element(0, 400, 400), newContent), state);
        assert.strictEqual(newContent.scrollTop, 0, 'non-scrollable rail stays at the top');
    });

    test('outer list position is preserved', function() {
        // If layout changes make the outer list the scroll owner, it is preserved too.
        var oldList = element(300, 1000, 400);
        var container = listWithContent(oldList, element(0, 400, 400));
        var state = api.capture(container);
        var newList = element(0, 1500, 400);
        api.restore(listWithContent(newList, element(0, 400, 400)), state);
        assert.strictEqual(newList.scrollTop, 300, 'outer list position is preserved');
    });

    test('position is clamped after content shrink', function() {
        // Shrinking content clamps an absolute position instead of leaving an invalid value.
        var oldContent = element(300, 1000, 400);
        var container = listWithContent(element(0, 400, 400), oldContent);
        var state = api.capture(container);
        var newContent = element(0, 500, 400);
        api.restore(listWithContent(element(0, 400, 400), newContent), state);
        assert.strictEqual(newContent.scrollTop, 100, 'position is clamped after content shrink');
    });
});
