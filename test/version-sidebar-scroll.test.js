#!/usr/bin/env node
// Focused tests for preserving the version sidebar's scroll owner across
// renderVersionSidebar()'s innerHTML rebuild.
// Run: node test/version-sidebar-scroll.test.js
'use strict';

var fs = require('fs');
var path = require('path');
var assert = require('assert');
var source = fs.readFileSync(path.join(__dirname, '..', 'src/js/ui/120-ui-utils.js'), 'utf8');
var start = source.indexOf('function _captureVersionSidebarScroll(container) {');
var end = source.indexOf('function renderVersionSidebar() {');
if (start < 0 || end <= start) throw new Error('Could not find sidebar scroll helpers');
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

// The current CSS makes the inner content node the scroll owner.
var oldContent = element(240, 1200, 400);
var container = listWithContent(element(0, 400, 400), oldContent);
var state = api.capture(container);
var newContent = element(0, 2200, 400);
api.restore(listWithContent(element(0, 400, 400), newContent), state);
assert.strictEqual(newContent.scrollTop, 240, 'absolute inner position is preserved');

// A user who was already at the bottom remains at the bottom when content grows.
oldContent = element(800, 1200, 400); // max scrollTop = 800
container = listWithContent(element(0, 400, 400), oldContent);
state = api.capture(container);
newContent = element(0, 2200, 400);
api.restore(listWithContent(element(0, 400, 400), newContent), state);
assert.strictEqual(newContent.scrollTop, 1800, 'bottom-follow position is preserved');

// A non-scrollable old rail must not be treated as an intentional bottom pin.
oldContent = element(0, 400, 400);
container = listWithContent(element(0, 400, 400), oldContent);
state = api.capture(container);
newContent = element(0, 1000, 400);
api.restore(listWithContent(element(0, 400, 400), newContent), state);
assert.strictEqual(newContent.scrollTop, 0, 'non-scrollable rail stays at the top');

// If layout changes make the outer list the scroll owner, it is preserved too.
var oldList = element(300, 1000, 400);
container = listWithContent(oldList, element(0, 400, 400));
state = api.capture(container);
var newList = element(0, 1500, 400);
api.restore(listWithContent(newList, element(0, 400, 400)), state);
assert.strictEqual(newList.scrollTop, 300, 'outer list position is preserved');

// Shrinking content clamps an absolute position instead of leaving an invalid value.
oldContent = element(300, 1000, 400);
container = listWithContent(element(0, 400, 400), oldContent);
state = api.capture(container);
newContent = element(0, 500, 400);
api.restore(listWithContent(element(0, 400, 400), newContent), state);
assert.strictEqual(newContent.scrollTop, 100, 'position is clamped after content shrink');

console.log('All version sidebar scroll tests passed.');
