// Run: run_tests { files: ['test/pdf-modal-download.test.js'] } (js_eval sandbox; no Node).
// A3A2-01: the PDF modal's Download button must not double the .pdf extension.
'use strict';
async function loadDownloadPdfFromModal(doc) {
    var src = await loadFile('src/js/app/050-image-attachments.js');
    var start = src.indexOf('function downloadPdfFromModal(');
    var end = src.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, 'downloadPdfFromModal not found');
    return new Function('document', src.slice(start, end + 2) + '\nreturn downloadPdfFromModal;')(doc);
}
function fakeDoc(dataset) {
    var links = [];
    return {
        links: links,
        getElementById: function(id) { return id === 'modal-body' ? { dataset: dataset } : null; },
        createElement: function(tag) {
            var a = { tag: tag, clicks: 0, click: function() { this.clicks++; } };
            links.push(a);
            return a;
        }
    };
}
describe('pdf modal › download', function() {
    test('PDF modal Download keeps a single .pdf extension', async function() {
        var cases = [['x.pdf', 'x.pdf'], ['SECOND.PDF', 'SECOND.PDF'], ['report', 'report.pdf'], [undefined, 'document.pdf']];
        for (var i = 0; i < cases.length; i++) {
            var doc = fakeDoc({ pdfSrc: 'data:application/pdf;base64,AA', pdfName: cases[i][0] });
            (await loadDownloadPdfFromModal(doc))();
            assert.strictEqual(doc.links.length, 1, 'one link for ' + cases[i][0]);
            assert.strictEqual(doc.links[0].download, cases[i][1], 'download name for ' + cases[i][0]);
            assert.strictEqual(doc.links[0].href, 'data:application/pdf;base64,AA');
            assert.strictEqual(doc.links[0].clicks, 1);
        }
        var none = fakeDoc({ pdfName: 'x.pdf' });
        (await loadDownloadPdfFromModal(none))();
        assert.strictEqual(none.links.length, 0, 'no pdfSrc: nothing is downloaded');
    }, { tags: ['unit'] });
});

// NEW-T25-1: openPdfModal parks the PDF data URL + name on the SHARED #modal-body
// dataset. Every reset path (closeModal, showModal, ...) must drop them, or the
// last previewed PDF stays pinned in the DOM and rides along on later dialogs.
async function loadModalLifecycle(doc) {
    var src = await loadFile('src/js/ui/220-notification-system.js');
    var code = ['settlePendingModalResolve', 'resetModalContentMode', 'showModal', 'closeModal'].map(function(name) {
        var start = src.indexOf('function ' + name + '(');
        var end = src.indexOf('\n}', start);
        assert.ok(start >= 0 && end > start, name + ' not found');
        return src.slice(start, end + 2);
    }).join('\n');
    return new Function('document', 'screenshotNav', 'screenshotModalKeyHandler', 'sanitizeModalMessage',
        'normalizeModalVariant', 'escapeHtml', 'escapeJsString',
        'var modalResolve = null;\n' + code + '\nreturn { showModal: showModal, closeModal: closeModal };')(
        doc, { list: ['s1'], index: 0 }, function() {}, function(m) { return { text: String(m) }; },
        function() { return 'normal'; }, String, String);
}
function modalDoc(dataset) {
    var links = [];
    var set = new Set(['show', 'pdf-modal']);
    var els = {
        'modal-overlay': { classList: {
            add: function() { for (var i = 0; i < arguments.length; i++) set.add(arguments[i]); },
            remove: function() { for (var i = 0; i < arguments.length; i++) set.delete(arguments[i]); },
            contains: function(c) { return set.has(c); } } },
        'modal-header': { textContent: '' },
        'modal-body': { dataset: dataset, textContent: '', children: [], appendChild: function(n) { this.children.push(n); } },
        'modal-actions': { innerHTML: '' }
    };
    return {
        links: links, els: els,
        getElementById: function(id) { return els[id] || null; },
        removeEventListener: function() {},
        createElement: function(tag) {
            var a = { tag: tag, clicks: 0, click: function() { this.clicks++; } };
            links.push(a);
            return a;
        }
    };
}
describe('pdf modal › dataset reset (NEW-T25-1)', function() {
    test('closeModal drops the parked PDF data URL and name', async function() {
        var doc = modalDoc({ pdfSrc: 'data:application/pdf;base64,AA', pdfName: 'big.pdf' });
        (await loadModalLifecycle(doc)).closeModal();
        var ds = doc.els['modal-body'].dataset;
        assert.strictEqual(doc.els['modal-overlay'].classList.contains('pdf-modal'), false, 'pdf-modal class kept');
        assert.strictEqual('pdfSrc' in ds, false, 'closeModal kept dataset.pdfSrc');
        assert.strictEqual('pdfName' in ds, false, 'closeModal kept dataset.pdfName');
        (await loadDownloadPdfFromModal(doc))();
        assert.strictEqual(doc.links.length, 0, 'the closed PDF was still downloadable');
    }, { tags: ['unit'] });
    test('a later confirm dialog (showModal) does not carry the PDF', async function() {
        var doc = modalDoc({ pdfSrc: 'data:application/pdf;base64,AA', pdfName: 'big.pdf' });
        var m = await loadModalLifecycle(doc);
        var p = m.showModal('Discard changes?', 'You have unsaved changes.', [{ label: 'Discard', value: 'discard' }]);
        assert.strictEqual(doc.els['modal-header'].textContent, 'Discard changes?');
        assert.strictEqual(doc.els['modal-body'].children.length, 1, 'message rendered');
        var ds = doc.els['modal-body'].dataset;
        assert.strictEqual('pdfSrc' in ds, false, 'showModal kept dataset.pdfSrc');
        assert.strictEqual('pdfName' in ds, false, 'showModal kept dataset.pdfName');
        (await loadDownloadPdfFromModal(doc))();
        assert.strictEqual(doc.links.length, 0, 'the confirm dialog could still download the stale PDF');
        m.closeModal();
        assert.strictEqual(await p, null, 'closeModal settles the pending confirm as cancelled');
    }, { tags: ['unit'] });
});
