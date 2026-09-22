// Run: run_tests { pattern: 'chatgpt-astra' } (js_eval sandbox; no Node). Synthetic fixtures only: no account/network.
'use strict';
async function runAstraTests(sources) {
    var checks = [];
    function check(name, value) { if (!value) throw new Error('FAIL: ' + name); checks.push(name); }
    function slice(source, start, end) {
        var a = source.indexOf(start), b = source.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Fixture extraction failed: ' + start);
        return source.slice(a, b);
    }
    var bg = sources.background, cfg = sources.config;
    var predicate = slice(cfg, 'function isChatGPTAstraModel(', '// API providers');
    var transform = slice(bg, 'function _openaiTextOf(', '// --- ChatGPT OAuth streaming proxy ---');
    var normalize = slice(bg, 'function _openaiNormalizeModelSlug(', 'self._openaiNormalizeModelSlug');
    var api = new Function(predicate + normalize + 'var _openaiModelQuirks = {};\n' + transform + '\nreturn { transform: transformToResponses };')();
    var convert = api.transform;
    check('Astra seed is subscription-only', /name: 'GPT-6 Astra \(ChatGPT\)'[\s\S]*?model: 'gpt-6-astra'[\s\S]*?isChatGPTOAuth: true/.test(cfg));
    check('Astra fallback catalog', /OPENAI_FALLBACK_MODELS = \['gpt-6-astra'/.test(bg));
    ['low', 'medium', 'high', 'xhigh', 'max'].forEach(function(effort) {
        var out = convert({ model: 'openai/gpt-6-astra', reasoning: { effort: effort } });
        check('Astra effort ' + effort, out.reasoning.effort === effort && out.reasoning.summary === 'auto' && out.model === 'gpt-6-astra');
    });
    ['none', 'minimal'].forEach(function(effort) { check(effort + ' becomes low', convert({model:'gpt-6-astra',reasoning:{effort:effort}}).reasoning.effort === 'low'); });
    check('Astra cannot disable reasoning', convert({model:'gpt-6-astra',reasoning:{enabled:false}}).reasoning.effort === 'low');
    check('Astra default high', convert({model:'gpt-6-astra'}).reasoning.effort === 'high');
    check('Legacy clamp preserved', convert({model:'gpt-5.6-sol',reasoning:{effort:'max'}}).reasoning.effort === 'high');
    check('Legacy thinking off preserved', !convert({model:'gpt-5.6-sol',reasoning:{enabled:false}}).reasoning);
    check('Pro is not implicitly Astra', convert({model:'gpt-6-astra-pro',reasoning:{effort:'max'}}).reasoning.effort === 'high');
    var request = convert({model:'gpt-6-astra',temperature:1,top_p:1,top_logprobs:10,logprobs:true,include:['message.output_text.logprobs'],prompt_cache_retention:'24h',_codexSessionKey:'chat-test',tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],tool_choice:{type:'function',function:{name:'lookup'}},messages:[]});
    ['temperature','top_p','top_logprobs','logprobs','prompt_cache_retention'].forEach(function(key) { check('Forbidden field absent: ' + key, !(key in request)); });
    check('Only encrypted reasoning include', JSON.stringify(request.include) === '["reasoning.encrypted_content"]');
    check('No new cache retention field needed', !request.prompt_cache_options && request.prompt_cache_key === 'chat-test');
    check('Responses function schema', request.tools[0].name === 'lookup' && request.tool_choice.name === 'lookup' && !request.tools[0].function);
    var reasoning = {index:0,type:'reasoning.encrypted',format:'openai-responses-v1',id:'rs_test',data:'opaque-fixture',summary:[{type:'summary_text',text:'Summary'}]};
    var replay = convert({model:'gpt-6-astra',messages:[{role:'assistant',reasoning_details:[reasoning],tool_calls:[{id:'call_1',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_1',content:'ok'}]}).input;
    check('Opaque reasoning replay before call and result', replay[0].type === 'reasoning' && replay[0].encrypted_content === 'opaque-fixture' && replay[0].summary[0].text === 'Summary' && replay[1].type === 'function_call' && replay[2].type === 'function_call_output');
    var ui = new Function('document', 'getProviderById', 'currentProvider', predicate + 'var _EFFORT_LEVELS=[{v:"low",label:"Low"},{v:"medium",label:"Medium"},{v:"high",label:"High"},{v:"xhigh",label:"X-High"},{v:"max",label:"Max"}]; function _providerDefaultEffort(){return "high";}\n' + slice(sources.notifications,'function _effortSliderLabelHtml(', '// Live refresh while dragging') + '\nreturn _effortSliderLabelHtml;');
    check('Astra pill does not claim clamp', !ui({},function(){return {isChatGPTOAuth:true,model:'gpt-6-astra'};},'test')(4).includes('sent as high'));
    check('Legacy pill clamp visible', ui({},function(){return {isChatGPTOAuth:true,model:'gpt-5.6-sol'};},'test')(4).includes('sent as high'));
    var modal = new Function('document', predicate + slice(sources.settings,'var _MODAL_EFFORT_LEVELS =', 'function onModalEffortSliderInput(') + '\nreturn _modalEffortLabelHtml;')({});
    check('Astra modal does not claim clamp', !modal(4,'chatgpt','gpt-6-astra').includes('sent as high'));
    check('Astra modal default truthful', modal(5,'chatgpt','gpt-6-astra').includes('high on Astra'));
    check('Endpoint unaffected', !modal(4,'endpoint','gpt-6-astra').includes('sent as high'));
    var menuIndex = new Function('provider', predicate + 'var defEffort="high", _EFFORT_LEVELS=[{v:"low"},{v:"medium"},{v:"high"},{v:"xhigh"},{v:"max"}];' + slice(sources.notifications,'    var curEffort =','    var effortDots =') + 'return effortIdx;');
    var modalIndex = new Function('provider','authKind', predicate + 'var _MODAL_EFFORT_LEVELS=[{v:"low"},{v:"medium"},{v:"high"},{v:"xhigh"},{v:"max"},{v:""}],_MODAL_EFFORT_DEFAULT_IDX=5;' + slice(sources.settings,'    var displayedEffort =','    var effortDots =') + 'return {index:effortIdx,value:displayedEffort};');
    ['none','minimal'].forEach(function(effort){
        var provider={isChatGPTOAuth:true,model:'gpt-6-astra',effort:effort};
        check('Legacy '+effort+' Astra slider shows low',menuIndex(provider)===0 && modalIndex(provider,'chatgpt').index===0 && modalIndex(provider,'chatgpt').value==='low');
    });
    check('Legacy non-Astra unknown effort display unchanged',menuIndex({isChatGPTOAuth:true,model:'gpt-5.6-sol',effort:'none'})===2);
    var streamSource = slice(bg,'async function runChatGPTOAuthStream(', 'self.runChatGPTOAuthStream');
    async function stream(events) {
        var envelopes = [], bytes = new TextEncoder().encode(events.map(function(e){return 'data: '+JSON.stringify(e)+'\n\n';}).join(''));
        var chrome = {storage:{local:{get:async function(){return {openaiOAuth:{accessToken:'fixture',accountId:'fixture',expiresAt:Date.now()+3600000}};}}},runtime:{getPlatformInfo:function(){}}};
        var fetchStub = async function(){ var sent=false; return {ok:true,status:200,headers:{forEach:function(){}},body:{getReader:function(){return {read:async function(){if(sent)return {done:true};sent=true;return {value:bytes,done:false};},cancel:async function(){}};}}};};
        var run = new Function('chrome','fetch','transformToResponses','crypto',normalize + predicate + 'var OPENAI_REASONING_FORMAT="openai-responses-v1", OPENAI_REFRESH_MARGIN_MS=300000, OPENAI_OAUTH={responsesUrl:"https://fixture.invalid",originator:"fixture"}; function resolveCodexClientVersion(){return Promise.resolve("1.0.0");} function _openaiAwaitWithSignal(p){return p;} function _openaiWithClientVersion(u){return u;}\n' + streamSource + '\nreturn runChatGPTOAuthStream;')(chrome,fetchStub,convert,{randomUUID:function(){return 'fixture';}});
        await run({model:'gpt-6-astra'},function(e){envelopes.push(e);});
        return envelopes.filter(function(e){return e.type === 'sse' && !e.data.includes('[DONE]');}).map(function(e){return JSON.parse(e.data.slice(6));});
    }
    var completed = await stream([{type:'response.reasoning_summary_text.delta',delta:'Summary'},{type:'response.output_item.done',item:{type:'reasoning',id:'rs_test',encrypted_content:'opaque-fixture',summary:[]}},{type:'response.output_item.added',item:{type:'function_call',id:'fc_1',call_id:'call_1',name:'lookup'}},{type:'response.function_call_arguments.done',item_id:'fc_1',arguments:'{}'},{type:'response.completed',response:{usage:{input_tokens:10,output_tokens:20,output_tokens_details:{reasoning_tokens:12}}}}]);
    check('SSE summary delivered', completed.some(function(e){return e.choices && e.choices[0] && e.choices[0].delta.reasoning === 'Summary';}));
    check('SSE encrypted reasoning captured', completed.some(function(e){var d=e.choices && e.choices[0] && e.choices[0].delta;return d && d.reasoning_details && d.reasoning_details[0].data === 'opaque-fixture';}));
    check('Tool finish and reasoning usage', completed.some(function(e){return e.choices && e.choices[0] && e.choices[0].finish_reason === 'tool_calls';}) && completed.some(function(e){return e.usage && e.usage.completion_tokens_details.reasoning_tokens === 12;}));
    // G-3: max_output_tokens truncation ends the stream like OpenRouter finish_reason 'length' (partial text kept, no error).
    var truncated = await stream([{type:'response.output_text.delta',delta:'partial'},{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}}]);
    check('max_output_tokens finishes with length, not an error', !truncated.some(function(e){return e.error;}) && truncated.some(function(e){return e.choices && e.choices[0] && e.choices[0].finish_reason === 'length';}));
    for (var terminal of [{type:'response.incomplete',response:{incomplete_details:{reason:'content_filter'}}},{type:'response.failed',response:{error:{message:'failed fixture'}}},null]) {
        var chunks = await stream([{type:'response.output_text.delta',delta:'partial'}].concat(terminal ? [terminal] : []));
        check('No silent success: ' + (terminal ? terminal.type : 'EOF'), chunks.some(function(e){return e.error;}) && !chunks.some(function(e){return e.choices && e.choices[0] && e.choices[0].finish_reason;}));
    }
    return checks;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = {"background":"src/platform/extension/background.js","config":"src/js/core/030-config.js","notifications":"src/js/ui/160-notifications.js","settings":"src/js/ui/040-tools-settings.js"};
await registerRunner('chatgpt-astra', async function() { return runAstraTests(await loadSources(PATHS)); });
