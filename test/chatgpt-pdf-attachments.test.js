// Run: run_tests { pattern: 'chatgpt-pdf-attachments' } (js_eval sandbox; no Node). Synthetic fixtures; no network/account.
'use strict';
async function runPDFTests(sources) {
    var checks = [];
    function check(name, value) { if (!value) throw new Error('FAIL: ' + name); checks.push(name); }
    function slice(source, start, end) {
        var a = source.indexOf(start), b = source.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
        return source.slice(a, b);
    }
    function freeze(value) {
        if (value && typeof value === 'object') { Object.keys(value).forEach(function(k) { freeze(value[k]); }); Object.freeze(value); }
        return value;
    }
    var bg = sources.background;
    var predicate = slice(sources.config, 'function isChatGPTAstraModel(', '// API providers');
    var normalize = slice(bg, 'function _openaiNormalizeModelSlug(', 'self._openaiNormalizeModelSlug');
    var transform = slice(bg, 'function _openaiTextOf(', '// --- ChatGPT OAuth streaming proxy ---');
    var api = new Function(predicate + normalize + 'var _openaiModelQuirks = {};\n' + transform + '\nreturn {transform:transformToResponses,parts:_openaiContentParts};')();
    var claude = new Function(slice(bg, 'function convertContentPart(', '// Claude Fable') + '\nreturn convertContentPart;')();
    var build = new Function('formatFileSize', slice(sources.apiMessages, 'function buildAPIMessages(', '// Single source of truth') + '\nreturn buildAPIMessages;')(function(n) { return n + ' B'; });
    // This is a transport fixture, not a claim of a parseable/live PDF. The bytes
    // need only be distinct and preserved through the actual source functions.
    var data = 'data:application/pdf;base64,JVBERi0xLjQK';
    var name = 'DDT PETIT.pdf.pdf';
    var pdf = {role:'pdf',name:name,base64:data,file_id:'fixture_pdf'};
    var image = {role:'screenshot',name:'fixture image',base64:'data:image/png;base64,aW1hZ2U='};
    var csv = {role:'file',name:'rows.csv',content:'a,b\n1,2',file_id:'fixture_csv',size:7,mimeType:'text/csv'};
    var history = freeze([{role:'user',content:'Read both attachments'}, pdf, image, csv]);
    var before = JSON.stringify(history);
    function convert(rows) { return api.transform({model:'gpt-5.6-sol',messages:build(rows)}); }
    function partsOf(result) { return result.input.reduce(function(a, row) { return a.concat(row.content || []); }, []); }
    var apiRows = build(history), out = convert(history), parts = partsOf(out);
    var files = parts.filter(function(p) { return p.type === 'input_file'; });
    check('PDF bytes preserved in native input_file', files.length === 1 && files[0].file_data === data);
    check('Repeated .pdf suffix preserved exactly', files[0].filename === name);
    check('No chat-completions file wrapper in Responses', !('file' in files[0]));
    check('Mixed image retained', parts.some(function(p) { return p.type === 'input_image' && p.image_url === image.base64; }));
    check('Mixed text and CSV labels retained', parts.some(function(p) { return p.text === 'Read both attachments'; }) && parts.some(function(p) { return p.text && p.text.indexOf('rows.csv') >= 0; }));
    check('Source history not mutated', JSON.stringify(history) === before);
    var pdfPart = apiRows[1].content[1];
    var anthropic = claude(pdfPart);
    check('Claude retains native PDF conversion', anthropic.type === 'document' && anthropic.source.media_type === 'application/pdf' && anthropic.source.data === data.split(',')[1]);
    check('Provider switch does not rewrite file part', pdfPart.type === 'file' && pdfPart.file.file_data === data && JSON.stringify(history) === before);
    var repeat = partsOf(convert(history.concat([{role:'assistant',tool_calls:[{id:'tool_1',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool_1',content:'done'},{role:'user',content:'Read the PDF again'}])));
    check('PDF replayed after tool roundtrip and followup', repeat.filter(function(p) { return p.type === 'input_file'; }).length === 1 && repeat.some(function(p) { return p.file_data === data; }));
    var single = partsOf(convert([pdf]));
    check('PDF-only message retains both label and binary', single.length === 2 && single[1].type === 'input_file');
    var second = {role:'pdf',name:'SECOND.PDF',base64:'data:application/pdf;base64,c2Vjb25k'};
    var multiple = partsOf(convert([pdf,second])).filter(function(p) { return p.type === 'input_file'; });
    check('Multiple PDFs retain order, names and distinct bytes', multiple.length === 2 && multiple[0].filename === name && multiple[1].filename === 'SECOND.PDF.pdf' && multiple[1].file_data === second.base64);
    check('Padded base64 preserved verbatim', api.parts([{type:'file',file:{filename:'padded.pdf',file_data:'data:application/pdf;base64,YQ=='}}],'input_text')[0].file_data === 'data:application/pdf;base64,YQ==');
    var normal = freeze({type:'input_file',filename:name,file_data:data,local_only:'not for API'});
    var normalized = api.parts([normal], 'input_text')[0];
    check('Already-normalized input_file retained without mutation', normalized.type === 'input_file' && normalized.file_data === data && normalized.filename === name && normal.local_only === 'not for API');
    check('Internal metadata excluded and normalized part copied', normalized !== normal && !('local_only' in normalized));
    ['', null, undefined, 42].forEach(function(filename) {
        check('Default filename for ' + String(filename), api.parts([{type:'file',file:{filename:filename,file_data:data}}],'input_text')[0].filename === 'document.pdf');
    });
    [undefined, null, {}, {filename:name}, {filename:name,file_data:''}, {filename:name,file_data:42}, {filename:name,file_data:{}}, {filename:name,file_data:'JVBERi0xLjQK'}, {filename:name,file_data:'data:application/pdf;base64,'}, {filename:name,file_data:'data:application/pdf;base64,\n'}, {filename:name,file_data:'data:application/pdf;base64,not!base64'}, {filename:name,file_data:'data:application/pdf,plain'}, {filename:name,file_id:'fixture_pdf'}].forEach(function(file, i) {
        var bad = api.parts([{type:'file',file:file}], 'input_text');
        check('Malformed/missing file is explicit placeholder #' + i, bad.length === 1 && bad[0].type === 'input_text' && bad[0].text.indexOf('File content unavailable:') >= 0 && !bad[0].file_data);
    });
    check('Malformed normalized input_file also explicit', api.parts([{type:'input_file',filename:name,file_data:{}}],'input_text')[0].text.indexOf('File content unavailable:') >= 0);
    ['A','ABC==','AAAA=','AAAA===','A===','====','YQ','YWI','YQ==\n','YQ==\r\n'].forEach(function(body, i) {
        check('Invalid base64 structure/padding/end rejected #' + i, api.parts([{type:'file',file:{filename:name,file_data:'data:application/pdf;base64,' + body}}],'input_text')[0].type === 'input_text');
    });
    ['AAAA','YQ==','YWI=','QUFBYQ==','QUFBYWI='].forEach(function(body) {
        check('Valid complete base64 groups preserved: ' + body, api.parts([{type:'input_file',filename:name,file_data:'data:application/pdf;base64,' + body}],'input_text')[0].file_data === 'data:application/pdf;base64,' + body);
    });
    var largeData = 'data:application/pdf;base64,' + 'AAAA'.repeat(262144);
    check('Large base64 payload validates without grouped-regex recursion', api.parts([{type:'file',file:{filename:name,file_data:largeData}}],'input_text')[0].file_data === largeData);
    check('Missing stored PDF is existing availability placeholder', partsOf(convert([{role:'pdf',name:name}]))[0].text === '[PDF no longer available: ' + name + ']');
    // Existing helper branches: strings/scalars/empty input, image shapes, text,
    // null and unknown parts must not regress when adding the binary branch.
    check('Plain string retained', api.parts('hello','input_text')[0].text === 'hello');
    check('Null content retained as empty text', api.parts(null,'input_text')[0].text === '');
    check('Scalar fallback unchanged', api.parts(42,'input_text')[0].text === '42');
    check('Empty array fallback unchanged', api.parts([],'input_text')[0].text === '');
    var passthroughImage = {type:'input_image',image_url:'https://example.invalid/image.png'};
    var other = api.parts(['string', null, {type:'image_url',image_url:'https://example.invalid/direct.png'}, {type:'image_url'}, passthroughImage, {type:'text',text:'text'}, {type:'unknown'}, {type:'unknown',text:'fallback'}], 'input_text');
    check('Existing string/null/text/image/unknown branches', other.length === 5 && other[0].text === 'string' && other[1].image_url === 'https://example.invalid/direct.png' && other[2] === passthroughImage && other[3].text === 'text' && other[4].text === 'fallback');
    check('Output text type used for unavailable file', api.parts([{type:'file'}],'output_text')[0].type === 'output_text');
    // Tool-origin PDFs use the same native path as user-uploaded PDFs.
    var get = new Function('getFileAsync', slice(sources.fileStore, 'async function executeGetFile(', '// =============================================') + '\nreturn executeGetFile;')(async function() { return {name:name,mime:'application/pdf',data:data}; });
    var attached = await get({id:'fixture_pdf',attach:true});
    check('get_file attach fixture emits PDF without duplicate base64 result', attached._screenshotMessage.role === 'pdf' && attached.attached && !('data' in attached));
    check('get_file attached PDF reaches native Responses input', partsOf(convert([attached._screenshotMessage])).some(function(p) { return p.type === 'input_file' && p.file_data === data; }));
    // Text reader diagnostics must use owning chat, never send binary as text.
    function reader(chats, active, current, lookup) {
        return new Function('chats','activeStreamingChatId','currentChatId','getFile', sources.fileTools + '\nreturn executeReadAttachedFile;')(chats, active, current, lookup || function() { return null; });
    }
    var chats = {own:{messages:[pdf]},other:{messages:[]},mixed:{messages:[pdf,csv]},legacy:{messages:[{role:'pdf',name:'legacy.pdf'}]},text:{messages:[{role:'file',name:'note.txt',content:'hello'}]}};
    var read = reader(chats, 'other', null);
    var diagnosed = read({filename:name.toUpperCase()}, {chatId:'own'});
    check('PDF found in explicit owning chat despite unrelated active chat', !diagnosed.success && diagnosed.file_id === 'fixture_pdf' && diagnosed.error.indexOf('A PDF attachment entry exists') === 0);
    check('PDF diagnostic contains no binary content or text format', !('content' in diagnosed) && !('format' in diagnosed) && JSON.stringify(diagnosed).indexOf(data) < 0);
    check('PDF diagnostic provides valid get_file guidance', diagnosed.error.indexOf('attach: true') >= 0);
    var legacy = read({filename:'legacy.pdf'},{chatId:'legacy'});
    check('Legacy PDF without bytes/id asks for reattachment without claiming delivery', legacy.file_id === null && legacy.error.indexOf('A PDF attachment entry exists') === 0 && legacy.error.indexOf('content and file_id are unavailable') >= 0 && legacy.error.indexOf('Ask the user to reattach') >= 0 && legacy.error.indexOf('get_file') < 0);
    [undefined, '', null, {}, 42, 'not a PDF data URL'].forEach(function(bytes, i) {
        var evicted = reader({own:{messages:[{role:'pdf',name:'evicted.pdf',base64:bytes}]}},'own',null)({filename:'evicted.pdf'});
        check('Evicted/malformed PDF does not claim native delivery #' + i, !evicted.success && evicted.file_id === null && !('content' in evicted) && evicted.error.indexOf('reattach the PDF') >= 0 && evicted.error.indexOf('supplied in the conversation') < 0 && evicted.error.indexOf('can now') < 0);
    });
    var recoverable = reader({own:{messages:[{role:'pdf',name:'evicted.pdf',file_id:'maybe_available'}]}},'own',null)({filename:'evicted.pdf'});
    check('Evicted PDF id suggests lookup without promising it resolves', recoverable.file_id === 'maybe_available' && recoverable.error.indexOf('Try get_file') >= 0 && recoverable.error.indexOf('If its content is unavailable') >= 0);
    var storedLegacy = reader({own:{messages:[{role:'pdf',name:'legacy.pdf',base64:data}]}},'own',null)({filename:'legacy.pdf'});
    check('Stored PDF without id is neutral about provider delivery', storedLegacy.file_id === null && storedLegacy.error.indexOf('If you cannot access its native content') >= 0 && storedLegacy.error.indexOf('get_file') < 0);
    var typo = read({filename:'typo.pdf'},{chatId:'own'});
    check('PDF filename typo lists available PDF rather than claiming none', typo.error.indexOf('Available files: ' + name) >= 0);
    check('Mixed CSV/PDF list includes both', read({filename:'missing'},{chatId:'mixed'}).error.indexOf(name + ', rows.csv') >= 0);
    check('Mixed CSV still reads original text when file store missing', read({filename:'ROWS.CSV'},{chatId:'mixed'}).content === csv.content);
    check('Existing file-store text lookup retained', reader(chats,'other',null,function(id) { return id === 'fixture_csv' ? {data:'stored CSV'} : null; })({filename:'rows.csv'},{chatId:'mixed'}).content === 'stored CSV');
    check('Legacy text without file_id retained', read({filename:'note.txt'},{chatId:'text'}).content === 'hello');
    check('Genuinely empty conversation keeps original no-files error', read({filename:name},{chatId:'other'}).error === 'No files attached in this conversation. Ask the user to attach a file first.');
    check('Missing filename validation retained', read({}, {chatId:'own'}).error === 'filename is required');
    check('Missing chat validation retained', read({filename:name},{chatId:'missing'}).error === 'No active chat found');
    check('Active chat fallback retained', reader(chats,'own',null)({filename:name}).file_id === 'fixture_pdf');
    check('Current chat fallback retained', reader(chats,null,'own')({filename:name}).file_id === 'fixture_pdf');
    check('Explicit empty owning chat never borrows another chat attachment', reader(chats,'own','own')({filename:name},{chatId:'other'}).error.indexOf('No files attached') === 0);
    check('Nameless/nonattachment rows ignored while finding PDFs', reader({own:{messages:[{role:'user',name:name},{role:'pdf'},pdf]}},'own',null)({filename:name}).file_id === 'fixture_pdf');
    check('Existing text-file priority retained for same-name PDF', reader({own:{messages:[pdf,{role:'file',name:name,content:'text fixture'}]}},'own',null)({filename:name}).content === 'text fixture');
    return checks;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = {"background":"src/platform/extension/background.js","config":"src/js/core/030-config.js","apiMessages":"src/js/app/020-api-messages.js","fileTools":"src/js/tools/050-file-tools.js","fileStore":"src/js/tools/040-file-store.js"};
await registerRunner('chatgpt-pdf-attachments', async function() { return runPDFTests(await loadSources(PATHS)); });
