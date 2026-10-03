// PR chip hover flash: identical sidebar/doc re-renders must not replace nodes.
// Run: run_tests { files: ['test/sidebar-hover-flash.test.js'] }
var WS = args.workspace;

async function sliceFn(file, name) {
    var src = await loadFile(file, WS);
    var a = src.indexOf('\nfunction ' + name + '('), b = src.indexOf('\n}\n', a);
    if (a < 0 || b < a) throw new Error(name + ' not found in ' + file);
    return src.slice(a, b + 2);
}

describe('sidebar hover flash', function() {
    test('_sdocSetHtmlKeepFocus skips identical writes, rewrites when replaced elsewhere', async function() {
        var code = await sliceFn('src/js/tools/110-smart-documents.js', '_sdocSetHtmlKeepFocus');
        var fn = Function(code + '\nreturn _sdocSetHtmlKeepFocus;')();
        var host = document.createElement('div');
        fn(host, '<span class="x">a</span>');
        var first = host.firstElementChild;
        fn(host, '<span class="x">a</span>');
        assert.strictEqual(host.firstElementChild, first, 'identical html keeps the node');
        host.innerHTML = '<b>other</b>';
        fn(host, '<span class="x">a</span>');
        assert.strictEqual(host.querySelector('.x').textContent, 'a', 'rewritten after external replace');
        fn(host, '<span class="x">b</span>');
        assert.strictEqual(host.querySelector('.x').textContent, 'b', 'changed html is written');
    }, { tags: ['unit'], timeout: 3000 });

    test('renderVersionSidebar guards innerHTML with __lastHtml; PR item has no transition: all', async function() {
        var code = await sliceFn('src/js/ui/120-ui-utils.js', 'renderVersionSidebar');
        assert.ok(/container\.__lastHtml === html/.test(code), 'compares last html');
        assert.ok(/if \(!_vsUnchanged\) \{\s*container\.innerHTML = html;/.test(code), 'innerHTML guarded');
        var css = await loadFile('src/css/11-version.css', WS);
        var rule = css.match(/\.pr-sidebar-item \{[^}]*\}/)[0];
        assert.ok(rule.indexOf('transition: all') < 0 && rule.indexOf('transition: background-color') >= 0);
    }, { tags: ['unit'], timeout: 3000 });
});
