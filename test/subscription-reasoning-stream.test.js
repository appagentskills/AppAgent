// Run: run_tests { pattern: 'subscription-reasoning-stream' } (js_eval sandbox; no Node).
// Executes actual adapter, request transforms and parser branches. No live model/network.
'use strict';
async function runSubscriptionReasoningTests(sources) {
    var checks = [];
    function check(name, value) { if (!value) throw new Error('FAIL: ' + name); checks.push(name); }
    function slice(source, start, end) {
        var a = source.indexOf(start), b = source.indexOf(end, a + start.length);
        if (a < 0 || b < 0) throw new Error('Source extraction failed: ' + start);
        return source.slice(a, b);
    }
    var bg = sources.background;
    var normalize = slice(bg, 'function _openaiNormalizeModelSlug(', 'self._openaiNormalizeModelSlug');
    var astra = slice(sources.config, 'function isChatGPTAstraModel(', '// API providers');
    var transform = slice(bg, 'function _openaiTextOf(', '// --- ChatGPT OAuth streaming proxy ---');
    var streamSource = slice(bg, 'async function runChatGPTOAuthStream(', 'self.runChatGPTOAuthStream');
    // This is the production delta/details parser body, not a parallel implementation.
    var parseDelta = new Function('provider', 'delta', 'thinking', 'reasoningDetailsMap', 'onThinking',
        'var thinkingChunk = null;\n' + slice(sources.streaming, '                    // ALWAYS accumulate reasoning_details', "                    if (typeof delta.content === 'string'") + '\nreturn thinking;');
    async function stream(events, options) {
        options = options || {};
        var envelopes = [], requests = [], errors = options.errors || [], fragments = [];
        var wire = events.map(function(e) { return 'data: ' + JSON.stringify(e) + '\n\n'; }).join('');
        var bytes = new TextEncoder().encode(wire);
        var size = options.fragmentSize || bytes.length || 1;
        for (var i = 0; i < bytes.length; i += size) fragments.push(bytes.slice(i, i + size));
        var chrome = { storage: { local: { get: async function() { return {openaiOAuth:{accessToken:'fixture',accountId:'fixture',expiresAt:Date.now()+3600000}}; } } }, runtime:{getPlatformInfo:function(){}} };
        var fetchStub = async function(url, init) {
            requests.push(JSON.parse(init.body));
            var failure = errors[requests.length - 1];
            if (failure) return {ok:false,status:failure.status || 400,text:async function(){return typeof failure.body === 'string' ? failure.body : JSON.stringify(failure.body);},headers:{get:function(){return null;}}};
            var n = 0;
            return {ok:true,status:200,headers:{forEach:function(){}},body:{getReader:function(){return {read:async function(){return n < fragments.length ? {done:false,value:fragments[n++]} : {done:true};},cancel:async function(){}};}}};
        };
        var dependencies = 'var OPENAI_REASONING_FORMAT="openai-responses-v1", OPENAI_REFRESH_MARGIN_MS=300000, OPENAI_OAUTH={responsesUrl:"https://fixture.invalid",originator:"fixture"}, _openaiModelQuirks={}; function resolveCodexClientVersion(){return Promise.resolve("1.0.0");} function _openaiAwaitWithSignal(p){return p;} function _openaiWithClientVersion(u){return u;} function conciseApiErrorBody(v){return v;} function _openaiAbortableDelay(){return Promise.resolve();} function describeChatGPTUsageLimit(){return null;}';
        var api = new Function('chrome','fetch','crypto','setInterval','clearInterval','console', normalize + astra + dependencies + transform + streamSource + '\nreturn {run:runChatGPTOAuthStream,convert:transformToResponses,quirks:_openaiModelQuirks};')(chrome,fetchStub,{randomUUID:function(){return 'fixture';}},function(){return 1;},function(){},{warn:function(){},error:function(){},log:function(){}});
        await api.run(Object.assign({model:'gpt-6-astra',parallel_tool_calls:false}, options.body),function(e){envelopes.push(e);});
        var chunks = envelopes.filter(function(e){return e.type === 'sse' && !e.data.includes('[DONE]');}).map(function(e){return JSON.parse(e.data.slice(6));});
        var thinking = '', snapshots = [], details = {};
        chunks.forEach(function(chunk) {
            var choice = chunk.choices && chunk.choices[0];
            if (choice && choice.delta) thinking = parseDelta({isChatGPTOAuth:true},choice.delta,thinking,details,function(text){snapshots.push(text);});
        });
        var hasError = chunks.some(function(c){return c.error;}) || envelopes.some(function(e){return e.type === 'error';});
        check(options.expectError ? 'expected stream error surfaced' : 'stream has no unexpected error', options.expectError ? hasError : !hasError);
        return {text:thinking,snapshots:snapshots,details:details,chunks:chunks,envelopes:envelopes,requests:requests,api:api};
    }
    function delta(text, index, id, part) { return {type:'response.reasoning_summary_text.delta',delta:text,output_index:index,item_id:id,summary_index:part || 0}; }
    function textDone(text, index, id, part) { return {type:'response.reasoning_summary_text.done',text:text,output_index:index,item_id:id,summary_index:part || 0}; }
    function reasoning(id, texts, encrypted) { return {type:'reasoning',id:id,summary:texts.map(function(text){return {type:'summary_text',text:text};}),encrypted_content:encrypted}; }
    function itemDone(item, index) { return {type:'response.output_item.done',item:item,output_index:index}; }
    function completed(output) { return {type:'response.completed',response:{output:output || [],usage:{input_tokens:10,output_tokens:20,total_tokens:30,input_tokens_details:{cached_tokens:4},output_tokens_details:{reasoning_tokens:12}}}}; }
    var a = await stream([itemDone(reasoning('r1',['Full public summary'],'opaque'),0),completed([reasoning('r1',['Full public summary'],'opaque')])]);
    check('terminal-only item recovered once', a.text === 'Full public summary' && a.snapshots.length === 1);
    check('encrypted replay captured once', Object.keys(a.details).length === 1 && a.details[0].data === 'opaque' && Array.isArray(a.details[0].summary));
    check('usage and successful finish preserved', a.chunks.some(function(c){return c.usage && c.usage.prompt_tokens_details.cached_tokens === 4 && c.usage.completion_tokens_details.reasoning_tokens === 12;}) && a.chunks.some(function(c){return c.choices && c.choices[0] && c.choices[0].finish_reason === 'stop';}));
    check('auto summary requested by default (OpenCode/Pi/Codex parity)', a.requests[0].reasoning.summary === 'auto');
    check('explicit caller summary honoured, unknown values fall back to auto', a.api.convert({model:'gpt-6-astra',reasoning:{summary:'detailed'}}).reasoning.summary === 'detailed' && a.api.convert({model:'gpt-6-astra',reasoning:{summary:'concise'}}).reasoning.summary === 'concise' && a.api.convert({model:'gpt-6-astra',reasoning:{summary:'verbose'}}).reasoning.summary === 'auto' && a.api.convert({model:'gpt-5.6-sol',reasoning:{effort:'high'}}).reasoning.summary === 'auto');
    check('reference request shape: store false, encrypted include, stream, no experimental fields', a.requests[0].store === false && a.requests[0].stream === true && JSON.stringify(a.requests[0].include) === '["reasoning.encrypted_content"]' && !('stream_options' in a.requests[0]) && !('text' in a.requests[0]));
    var replay = a.api.convert({model:'gpt-6-astra',messages:[{role:'assistant',reasoning_details:Object.values(a.details)}]}).input;
    check('opaque and summary replay unchanged', replay[0].encrypted_content === 'opaque' && replay[0].summary[0].text === a.text);
    for (var mode of ['partial','full','terminal']) {
        var events = mode === 'terminal' ? [] : [delta(mode === 'partial' ? 'Full' : 'Full summary',0,'r1')];
        var fullItem = reasoning('r1',['Full summary']);
        events.push(textDone('Full summary',0,'r1'),textDone('Full summary',0,'r1'),{type:'response.reasoning_summary_part.done',output_index:0,item_id:'r1',summary_index:0,part:{type:'summary_text',text:'Full summary'}},itemDone(fullItem,0),itemDone(fullItem,0),completed([fullItem]));
        var result = await stream(events);
        check(mode + ' reconciles full/same/repeated snapshots', result.text === 'Full summary');
        check(mode + ' no duplicate text', result.snapshots.every(function(text){return 'Full summary'.startsWith(text);}));
    }
    a = await stream([completed([reasoning(undefined,['No id or encryption'])])]);
    check('completed-only no id/encryption recovered by output index', a.text === 'No id or encryption' && !Object.keys(a.details).length);
    a = await stream([delta('First',0,undefined),completed([reasoning(undefined,['First complete','Second part']),{type:'message'},reasoning(undefined,['Other item'])])]);
    check('multiple parts/items preserve boundaries and index-only identity', a.text === 'First complete\n\nSecond part\n\nOther item');
    a = await stream([delta('Old conclusion',0,'r1'),textDone('Old conclusion more',0,'r1'),itemDone(reasoning('r1',['Correct conclusion']),0),completed([reasoning('r1',['Final conclusion'])])]);
    check('divergent authoritative snapshots replace, never concatenate', a.text === 'Final conclusion' && a.snapshots.includes('Correct conclusion'));
    a = await stream([delta('Second',0,'r1',1),textDone('Second',0,'r1',1),completed([reasoning('r1',['First','Second'])])]);
    check('earlier part insertion replaces with ordered full text', a.text === 'First\n\nSecond' && a.snapshots[0] === 'Second');
    a = await stream([delta('Later item',2,'later'),delta('Earlier item',0,'earlier'),completed([reasoning('earlier',['Earlier item']),{type:'message'},reasoning('later',['Later item'])])]);
    check('out-of-order items reorder through snapshot', a.text === 'Earlier item\n\nLater item');
    a = await stream([delta('By id',undefined,'r1'),itemDone(reasoning('r1',['By id full']),0),completed([reasoning('r1',['By id full'])])]);
    check('id-only to indexed identity bridge', a.text === 'By id full');
    a = await stream([delta('Same',undefined,'r1'),delta('Same',0,undefined),itemDone(reasoning('r1',['Same final']),0),completed([reasoning('r1',['Same final'])])]);
    check('independently introduced id/index aliases merge on bridge', a.text === 'Same final' && Object.keys(a.details).length === 0);
    a = await stream([delta('Keep me',0,'r1'),textDone('',0,'r1'),itemDone(reasoning('r1',['']),0),completed([reasoning('r1',[])])]);
    check('empty/missing summaries are not erasure', a.text === 'Keep me');
    a = await stream([textDone('Complete',0,'r1'),delta('late duplicate',0,'r1'),textDone('Com',0,'r1'),completed([reasoning('r1',['Done'])]),delta('after success',0,'r1'),completed([reasoning('r1',['Wrong late'])])]);
    check('terminal rank blocks stale deltas/prefixes; completed beats prior', a.text === 'Done');
    check('repeated completion cannot mutate usage/final state', a.chunks.filter(function(c){return c.usage;}).length === 1);
    a = await stream([{type:'response.reasoning_summary_part.added',output_index:0,item_id:'r1',part:{type:'summary_text',text:'Prefill'}},delta(' tail',0,'r1'),completed([reasoning('r1',['Prefill tail'])])]);
    check('nonempty part-added snapshot plus deltas', a.text === 'Prefill tail');
    a = await stream([{type:'response.output_item.added',output_index:0,item:reasoning('r1',['Prefill'])},delta(' tail',0,'r1'),completed([reasoning('r1',['Prefill tail'])])]);
    check('item-added snapshot plus deltas', a.text === 'Prefill tail');
    a = await stream([{type:'response.reasoning_text.delta',item_id:'r1',output_index:0,content_index:0,delta:'Visible'},{type:'response.reasoning_text.done',item_id:'r1',output_index:0,content_index:0,text:'Visible text'},completed([{type:'reasoning',id:'r1',content:[{type:'reasoning_text',text:'Visible text complete'},{type:'reasoning_text',text:'Next text'}]}])]);
    check('reasoning_text delta/done/content variants recover', a.text === 'Visible text complete\n\nNext text');
    a = await stream([completed([{type:'reasoning',encrypted_content:'SECRET',summary:[{type:'redacted_thinking',text:'SECRET2'},{type:'summary_text',text:42},null,{type:'summary_text',text:'Public'}],content:[{type:'redacted_thinking',text:'SECRET3'},{type:'text',text:'not a public reasoning part'}]}])]);
    check('only allowlisted string public parts display; opaque/redacted excluded', a.text === 'Public');
    a = await stream([delta('Résumé 🧠',0,'r1'),completed([reasoning('r1',['Résumé 🧠 complete'])])],{fragmentSize:1});
    check('UTF-8/SSE fragmentation preserves full summary', a.text === 'Résumé 🧠 complete');
    a = await stream([itemDone(reasoning('r1',['Draft'],'cipher1'),0),completed([reasoning('r1',['Final'],'cipher2')])]);
    check('updated replay retains one index and array summary', Object.keys(a.details).length === 1 && a.details[0].data === 'cipher2' && a.details[0].summary[0].text === 'Final');
    var map = {}, calls = [];
    check('OAuth snapshot wins same-event display delta/details', parseDelta({isChatGPTOAuth:true},{reasoning_snapshot:'Replace',reasoning:'append',reasoning_details:[{index:0,text:'fallback'}]},'Old',map,function(t){calls.push(t);}) === 'Replace' && calls[0] === 'Replace' && map[0].text === 'fallback');
    var clearCalls = [];
    check('explicit empty snapshot clears displayed thinking', parseDelta({isChatGPTOAuth:true},{reasoning_snapshot:'',reasoning:' tail'},'Old',{},function(t){clearCalls.push(t);}) === '' && clearCalls.length === 1 && clearCalls[0] === '');
    check('non-OAuth ignores internal snapshot', parseDelta({isChatGPTOAuth:false},{reasoning_snapshot:'Replace',reasoning:' tail'},'Old',{},function(){}) === 'Old tail');
    check('non-string snapshot ignored', parseDelta({isChatGPTOAuth:true},{reasoning_snapshot:42,thinking:' tail'},'Old',{},function(){}) === 'Old tail');
    var unsupportedValue = {body:{error:{param:'reasoning.summary',code:'unsupported_value',message:"Unsupported value: 'detailed' is not supported. Supported values: 'auto'."}}};
    var detailedBody = {reasoning:{summary:'detailed'}};
    a = await stream([completed()],{errors:[unsupportedValue],body:detailedBody});
    check('explicit detailed rejection retries auto once', a.requests.length === 2 && a.requests[0].reasoning.summary === 'detailed' && a.requests[1].reasoning.summary === 'auto');
    check('fallback preserves effort and remembers normalized model', a.requests[1].reasoning.effort === 'high' && a.api.convert({model:'openai/gpt-6-astra'}).reasoning.summary === 'auto');
    for (var code of ['unsupported_value','invalid_value']) {
        a = await stream([completed()],{errors:[{body:{error:{param:'reasoning.summary',code:code,message:'Invalid value.'}}}],body:detailedBody});
        check('structured '+code+' need not echo requested detailed value', a.requests.length === 2 && a.requests[1].reasoning.summary === 'auto');
    }
    for (var message of ["Unsupported value: 'reasoning.summary' does not support 'detailed'.", "'detailed' is not supported for 'reasoning.summary'.", "Unsupported value 'detailed' for parameter 'reasoning.summary'."]) {
        a = await stream([completed()],{errors:[{body:{error:{message:message}}}],body:detailedBody});
        check('untargeted metadata requires clause-linked explicit rejection '+message, a.requests.length === 2 && a.requests[1].reasoning.summary === 'auto');
    }
    a = await stream([],{errors:[{body:{error:{message:"Invalid tools schema. reasoning.summary 'detailed' is supported."}}}],expectError:true,body:detailedBody});
    check('unrelated absent-param rejection cannot borrow summary words from supported clause', a.requests.length === 1 && a.requests[0].reasoning.summary === 'detailed' && !a.api.quirks['gpt-6-astra'].reasoningSummary);
    var unsupportedParam = {body:{error:{param:'reasoning.summary',code:'unsupported_parameter',message:"Unsupported parameter: 'reasoning.summary'."}}};
    a = await stream([completed()],{errors:[unsupportedValue,unsupportedParam],body:detailedBody});
    check('explicit parameter rejection omits only summary, bounded pre-stream', a.requests.length === 3 && !('summary' in a.requests[2].reasoning) && a.requests[2].reasoning.effort === 'high' && a.requests[2].include[0] === 'reasoning.encrypted_content');
    check('omit memo applied to later transforms', !('summary' in a.api.convert({model:'gpt-6-astra'}).reasoning));
    a = await stream([completed()],{errors:[{body:"Unsupported parameter: 'reasoning.summary'."}]});
    check('plain-text explicit parameter error handled', a.requests.length === 2 && !('summary' in a.requests[1].reasoning));
    for (var error of [{body:{error:{param:'tools',message:'Unsupported tool schema'}}},{body:{error:{param:'tools',message:'Invalid tools; reasoning.summary detailed is supported'}}},{status:403,body:'Forbidden'},{status:429,body:'usage_limit_reached: quota exhausted'},{body:{error:{param:'reasoning.summary',message:'Temporary processing failure'}}}]) {
        a = await stream([],{errors:[error],expectError:true,body:detailedBody});
        check('unrelated/auth/quota errors do not downgrade summary ' + JSON.stringify(error), a.requests.length === 1 && a.requests[0].reasoning.summary === 'detailed' && a.envelopes.some(function(e){return e.type === 'error';}));
    }
    a = await stream([],{errors:[unsupportedValue,unsupportedValue,unsupportedValue,unsupportedValue],expectError:true,body:detailedBody});
    check('auto default: value rejection of auto never retries a summary rung', (await stream([],{errors:[{body:{error:{param:'reasoning.summary',code:'unsupported_value',message:'Invalid value.'}}}],expectError:true})).requests.length === 1);
    check('auto rejection cannot loop summary fallback', a.requests.length === 2 && a.requests[1].reasoning.summary === 'auto');
    a = await stream([delta('Partial',0,'r1'),{type:'response.failed',response:{error:{message:'reasoning.summary detailed unsupported'}}}],{expectError:true});
    check('no request replay once stream content began', a.requests.length === 1 && a.text === 'Partial' && a.chunks.some(function(c){return c.error;}));
    // Execute the real Claude forced-thinking branch with production predicates.
    var claudeBranch = new Function('body','result','isThinkingBindingModel','isAdaptiveOnlyClaude','ADAPTIVE_CAPABLE_CLAUDE_RE', slice(bg,'    var thinkingBound = isThinkingBindingModel(body.model);','    // output_config.effort only exists') + '\nreturn result;');
    var claude = claudeBranch({model:'claude-fable-5-1',reasoning:{enabled:false}}, {}, function(){return true;}, function(){return true;}, /fixture/);
    check('Fable remains unconditional adaptive, now public summarized + binding', claude.thinking.type === 'adaptive' && claude.thinking.display === 'summarized' && claude.thinking.block_binding.prefix_mismatch_behavior === 'drop_block');
    var startThinking = new Function('block','eventData','sink', 'var msgId="fixture",ts=0,model="fixture";\n' + slice(bg,"                    else if (block.type === 'thinking') {", "                    else if (block.type === 'redacted_thinking') {").replace(/^\s*else if/, 'if'));
    var starts = [];
    startThinking({type:'thinking',thinking:'Initial public text'},{index:3},function(e){starts.push(JSON.parse(e.data.slice(6)));});
    check('Claude nonempty thinking-start preserved', starts[0].choices[0].delta.reasoning_details[0].thinking === 'Initial public text');
    startThinking({type:'thinking'},{index:0},function(e){starts.push(JSON.parse(e.data.slice(6)));});
    check('Claude empty start remains empty not opaque', starts[1].choices[0].delta.reasoning_details[0].thinking === '');
    var claudeEvents = new Function('eventType','eventData','sink', 'var msgId="fixture",ts=0,model="fixture",currentToolId=null,toolIdx=0;' + slice(bg,"                else if (eventType === 'content_block_start') {", "                else if (eventType === 'message_delta') {").replace(/^\s*else if/, 'if'));
    var claudeThinking = '', claudeDetails = {};
    function claudeSink(e) { var d = JSON.parse(e.data.slice(6)).choices[0].delta; claudeThinking = parseDelta({isChatGPTOAuth:false}, d, claudeThinking, claudeDetails, function(){}); }
    claudeEvents('content_block_start',{index:0,content_block:{type:'thinking',thinking:'Start '}},claudeSink);
    claudeEvents('content_block_delta',{index:0,delta:{type:'thinking_delta',thinking:'continued'}},claudeSink);
    claudeEvents('content_block_delta',{index:0,delta:{type:'signature_delta',signature:'signature-fixture'}},claudeSink);
    claudeEvents('content_block_stop',{index:0},claudeSink);
    claudeEvents('content_block_start',{index:1,content_block:{type:'redacted_thinking',data:'redacted-fixture'}},claudeSink);
    check('Claude start/delta text complete; signature and redacted data remain replay-only', claudeThinking === 'Start continued' && claudeDetails[0].thinking === claudeThinking && claudeDetails[0].signature === 'signature-fixture' && claudeDetails[1].data === 'redacted-fixture');
    // Legacy event names accepted by OpenCode at 830d5eb53548 (openai-responses.ts).
    // Delta carries delta/item_id/summary_index; marker-only done has no public text.
    // A done event with canonical string text uses our existing snapshot contract.
    function alias(event) { return Object.assign({}, event, {type:event.type.replace('reasoning_summary_text.', 'reasoning_summary.')}); }
    var aliasEvents = [alias(delta('Legacy ',0,'legacy')),alias(delta('summary',0,'legacy')),completed()];
    var aliasRun = await stream(aliasEvents);
    check('alias delta-only output survives without terminal item recovery', aliasRun.text === 'Legacy summary');
    a = await stream([alias(textDone('Done only',0,'legacy')),alias(textDone('Done only',0,'legacy')),completed()]);
    check('alias done-only string snapshot recovered and deduplicated', a.text === 'Done only' && a.snapshots.length === 1);
    a = await stream([alias(delta('Keep',0,'legacy')),{type:'response.reasoning_summary.done',item_id:'legacy',output_index:0,summary_index:0},completed()]);
    check('marker-only alias done is inert, not fabricated text', a.text === 'Keep' && a.snapshots.length === 1);
    a = await stream([{type:'response.reasoning_summary.done',item_id:'legacy'},completed()]);
    check('marker-only alias done without prior text displays nothing', a.text === '' && a.snapshots.length === 0);
    for (var order of [false,true]) {
        a = await stream([order ? alias(delta('Mixed',0,'legacy')) : delta('Mixed',0,'legacy'),order ? delta(' body',0,'legacy') : alias(delta(' body',0,'legacy')),alias(textDone('Mixed body',0,'legacy')),textDone('Mixed body',0,'legacy'),alias(textDone('Mixed',0,'legacy')),alias(delta(' stale',0,'legacy')),completed()]);
        check('mixed alias/canonical variants share part identity and terminal rank '+order, a.text === 'Mixed body' && a.snapshots.length === 2);
    }
    a = await stream([alias(delta('Later',2,'later',1)),alias(textDone('First',0,'first',0)),textDone('Earlier',2,'later',0),alias(textDone('Later final',2,'later',1)),completed()]);
    check('alias preserves output and summary indexes across reordered items/parts', a.text === 'First\n\nEarlier\n\nLater final');
    a = await stream([alias(delta('By id',undefined,'legacy')),textDone('By id full',0,'legacy'),alias(textDone('By id full',0,undefined)),completed()]);
    check('alias id-only/index-only bridge shares canonical record', a.text === 'By id full');
    a = await stream([alias(delta('Default',undefined,undefined)),textDone('Default part',undefined,undefined),completed()]);
    check('alias missing indexes use existing default part and unkeyed record', a.text === 'Default part');
    a = await stream([delta('Draft',0,'legacy'),alias(textDone('Corrected',0,'legacy')),alias(textDone('Corrected',0,'legacy')),completed()]);
    check('alias terminal correction replaces canonical delta without itemdone fallback', a.text === 'Corrected' && a.snapshots.join('|') === 'Draft|Corrected');
    a = await stream([alias(delta('Draft',0,'legacy')),alias(textDone('First revision',0,'legacy')),{type:'response.reasoning_summary_part.done',item_id:'legacy',output_index:0,summary_index:0,part:{type:'summary_text',text:'Part revision'}},alias(textDone('Stale revision',0,'legacy')),itemDone(reasoning('legacy',['Item revision'],'alias-cipher1'),0),alias(delta(' stale',0,'legacy')),completed([reasoning('legacy',['Final revision'],'alias-cipher2')]),alias(textDone('After completion',0,'legacy'))]);
    check('alias obeys part/item/completed authority and ignores after completion', a.text === 'Final revision' && !a.snapshots.includes('Stale revision') && !a.snapshots.includes('After completion'));
    var aliasReplay = a.api.convert({model:'gpt-6-astra',messages:[{role:'assistant',reasoning_details:Object.values(a.details)}]}).input;
    check('alias leaves encrypted replay separate and updates one stable index', Object.keys(a.details).length === 1 && a.details[0].data === 'alias-cipher2' && aliasReplay[0].encrypted_content === 'alias-cipher2' && aliasReplay[0].summary[0].text === 'Final revision' && !a.text.includes('cipher'));
    a = await stream([alias(delta('Keep',0,'legacy')),alias(textDone('',0,'legacy')),alias(textDone({text:'not public'},0,'legacy')),alias(delta(42,0,'legacy')),completed()]);
    check('alias empty/non-string payloads cannot erase or create display text', a.text === 'Keep' && a.snapshots.length === 1);
    var canonicalRun = await stream(aliasEvents.map(function(e){return Object.assign({},e,{type:e.type.replace('reasoning_summary.','reasoning_summary_text.')});}));
    check('alias and canonical names yield identical public output and replay', canonicalRun.text === aliasRun.text && JSON.stringify(canonicalRun.details) === JSON.stringify(aliasRun.details));
    check('alias names do not change provider requests', JSON.stringify(aliasRun.requests) === JSON.stringify(canonicalRun.requests) && aliasRun.requests[0].reasoning.summary === 'auto' && aliasRun.requests[0].reasoning.effort === 'high');
    return checks;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = {"background":"src/platform/extension/background.js","streaming":"src/js/app/010-llm-streaming.js","config":"src/js/core/030-config.js"};
await registerRunner('subscription-reasoning-stream', async function() { return runSubscriptionReasoningTests(await loadSources(PATHS)); });
