// Run: run_tests { pattern: 'chat-streaming-worker-dialogue' } (js_eval sandbox; no Node).
// Executes extracted production functions in a private fake DOM/registry.
// No live events, runtime state, network, deployment or transport mocks as proof of delivery.
'use strict';
function runChatStreamingWorkerDialogueTests(sources, domDocument) {
    var results = [];
    var render = sources['src/js/ui/250-message-render.js'];
    var ui = sources['src/js/ui/175-sub-agent-ui.js'];
    var core = sources['src/js/core/097-sub-agent-registry.js'];
    function check(ok, message) { if (!ok) throw new Error(message); }
    function test(name, fn) { try { fn(); results.push({name:name, passed:true}); } catch(e) { results.push({name:name, passed:false, error:e.message}); } }
    function declaration(source, name, indent) {
        var start = source.indexOf('function ' + name + '(');
        var end = source.indexOf('\n' + (indent || '') + '}', start);
        check(start >= 0 && end > start, 'Missing source declaration ' + name);
        return source.slice(start, end + (indent || '').length + 2);
    }
    function load(env, parts, names) {
        return new Function('env', 'with(env){\n' + parts.join('\n') + '\nreturn {' + names.map(function(n){return n+':'+n;}).join(',') + '};}')(env);
    }
    function noop() {}
    function escape(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function fixture(compact, count, ownArea) {
        var nodes = {}, frames = [], paints = [], rebuilds = 0, replacements = 0, copies = 0;
        function node() {
            var n = {textContent:'', attrs:{}, map:{}, open:true, style:{}, classList:{contains:function(c){return c==='assistant';}},
                querySelector:function(s){return this.map[s] || null;}, querySelectorAll:function(){return [];},
                getAttribute:function(k){return this.attrs[k] || null;}, setAttribute:function(k,v){this.attrs[k]=v;},
                appendChild:function(v){this.map['.tool-status-message']=v;},
                insertAdjacentHTML:function(_,html){
                    var m = html.match(/id="(tc-[^"]+)"/); if(m) nodes[m[1]]=tool();
                    var th=html.match(/data-thinking-msg="(\d+)"/); if(th) this.map['[data-thinking-msg="'+th[1]+'"] .thinking-content']=node();
                    this.inserted=(this.inserted||'')+html;
                }};
            Object.defineProperty(n,'innerHTML',{get:function(){return this.html||'';},set:function(v){this.html=v;replacements++;}});
            return n;
        }
        function tool(id) {
            var t=node(), a=node(), w=node(); if(id) w.attrs['data-copy-id']=id;
            t.map['.tool-args']=a; t.map['.tool-args-wrapper']=w; t.map['summary']=node(); return t;
        }
        var msg=node(), thinking=node(), area=node(), content=node(), status=node();
        nodes['msg-0']=msg; msg.map['.thinking-content']=thinking; msg.map['.thinking-status']=node();
        area.map['.compact-tools-content']=content; area.map['.compact-tools-status']=status;
        content.map['[data-thinking-msg="0"] .thinking-content']=thinking;
        if(ownArea!==false) msg.map['.compact-tools-area']=area;
        for(var i=0;i<count;i++) nodes['tc-0-'+i]=tool('existing-'+i);
        var env={currentChatId:'A',currentView:'chat',compactToolCalls:compact,isRunning:true,stickToBottom:false,
            chats:{A:{messages:[]}},window:{_rawCopyStore:{}},thinkingExpandedState:{},_usmScheduled:false,_usmLatest:null,
            document:{getElementById:function(id){return nodes[id]||null;},createElement:node,querySelector:function(){return null;},querySelectorAll:function(){return [area];}},
            requestAnimationFrame:function(f){frames.push(f);},_isChatInSilentHook:function(){return false;},
            updateStreamingText:function(m){paints.push(m.content);},renderMessages:function(){rebuilds++;},
            storeRawCopy:function(s){var id='rc-'+(++copies);env.window._rawCopyStore[id]=s;return id;},
            extractStatusMessage:function(s){var m=String(s).match(/"status_message":"([^"]*)"/);return m?m[1]:null;},
            TOOL_DISPLAY_NAMES:{},UI_ICONS:{copy:'copy'},getToolIcon:function(){return '';},escapeHtml:escape,formatJsonPretty:escape,
            scrollToBottomIfAllowed:noop,restoreChatScrollTop:noop,pinToBottom:noop,setupStickyObserver:noop};
        var names=['_renderCompactThinking','_patchStreamingToolRow','_updateStreamingMessageNow','updateStreamingMessage'];
        var api=load(env,names.map(function(n){return declaration(render,n);}),names);
        return {env:env,api:api,nodes:nodes,msg:msg,thinking:thinking,content:content,frames:frames,paints:paints,
            counts:function(){return {rebuilds:rebuilds,replacements:replacements,copies:copies};}};
    }
    function message(n) {return {isStreaming:true,content:'answer grows',thinking:'thought grows',tool_calls:Array.from({length:n},function(_,i){return {function:{name:'tool'+i,arguments:'{"status_message":"step '+i+'"}'}};})};}
    [false,true].forEach(function(compact){
        test((compact?'compact':'standard')+' parallel args + thinking + text, stable nodes and copy IDs',function(){
            var f=fixture(compact,2), m=message(2); f.api._updateStreamingMessageNow(0,m,'A');
            check(f.paints.length===1,'text must paint once'); check(f.thinking.textContent===m.thinking,'thinking stalled');
            check(f.counts().replacements===0 && f.counts().rebuilds===0,'unnecessary DOM replacement');
            var earlier=f.nodes['tc-0-0']; m.tool_calls[0].function.arguments='earlier changed'; m.content+=' again';
            f.api._updateStreamingMessageNow(0,m,'A');
            check(earlier===f.nodes['tc-0-0'] && earlier.map['.tool-args'].textContent==='earlier changed','earlier parallel call stalled');
            check(f.env.window._rawCopyStore['existing-0']==='earlier changed','stale raw copy');
            check(f.paints.length===2 && f.counts().copies===0,'double pacing or reminted copy ID');
        });
        test((compact?'compact':'standard')+' missing copy ID and empty args',function(){
            var f=fixture(compact,1), row=f.nodes['tc-0-0']; delete row.map['.tool-args-wrapper'].attrs['data-copy-id'];
            var m=message(1); m.tool_calls[0].function.arguments=''; f.api._updateStreamingMessageNow(0,m,'A');
            var id=row.map['.tool-args-wrapper'].attrs['data-copy-id'];check(!!id && f.env.window._rawCopyStore[id]==='','missing empty raw copy');
            m.tool_calls[0].function.arguments='now complete'; f.api._updateStreamingMessageNow(0,m,'A');
            check(f.env.window._rawCopyStore[id]==='now complete' && f.counts().copies===1,'copy ID not reused');
        });
        test((compact?'compact':'standard')+' missing parallel rows preserve insertion path',function(){
            var f=fixture(compact,0),m=message(2);f.api._updateStreamingMessageNow(0,m,'A');
            var html=compact?f.content.inserted:f.msg.innerHTML;
            check(html.indexOf('tc-0-0')>=0 && html.indexOf('tc-0-1')>=0,'missing parallel insertion');
            check(f.paints.length===1,'insertion doubled text pacing');
        });
    });
    test('compact hidden later assistant updates correct thinking, without touching earlier thinking',function(){
        var f=fixture(true,1,false);var earlier={textContent:'keep previous turn'};f.content.map['.thinking-content']=earlier;
        f.api._updateStreamingMessageNow(0,message(1),'A');check(f.thinking.textContent==='thought grows','hidden thinking stalled');check(earlier.textContent==='keep previous turn','overwrote earlier thinking');
    });
    test('compact first thinking creates owned node, then updates it in place',function(){
        var f=fixture(true,1);delete f.content.map['[data-thinking-msg="0"] .thinking-content'];
        f.api._updateStreamingMessageNow(0,message(1),'A');var el=f.content.map['[data-thinking-msg="0"] .thinking-content'];check(!!el,'thinking not inserted');
        f.api._updateStreamingMessageNow(0,message(1),'A');check(el.textContent==='thought grows','thinking not updated');
    });
    test('background, skills, silent hook and recycled user node are no-ops',function(){
        var f=fixture(false,1),m=message(1);f.api._updateStreamingMessageNow(0,m,'B');f.env.currentView='skills';f.api._updateStreamingMessageNow(0,m,'A');
        f.env.currentView='chat';f.env._isChatInSilentHook=function(){return true;};f.api._updateStreamingMessageNow(0,m,'A');
        f.env._isChatInSilentHook=function(){return false;};f.msg.classList.contains=function(){return false;};f.api._updateStreamingMessageNow(0,m,'A');
        check(f.paints.length===0 && f.counts().replacements===0,'guard allowed paint');
    });
    test('rAF coalesces, rejects background overwrite and rereads live message',function(){
        var f=fixture(false,1),m=message(1);f.env.chats.A.messages=[m];f.api.updateStreamingMessage(0,message(1),'A');
        f.api.updateStreamingMessage(0,message(1),'B');m.content='latest live';f.frames.shift()();check(f.paints[0]==='latest live','wrong frame payload');
    });
    test('queued rAF after finalize and A to B navigation never paints',function(){
        var f=fixture(false,1),m=message(1);f.env.chats.A.messages=[m];f.api.updateStreamingMessage(0,message(1),'A');m.isStreaming=false;f.frames.shift()();
        m.isStreaming=true;f.api.updateStreamingMessage(0,m,'A');f.env.currentChatId='B';f.frames.shift()();check(f.paints.length===0,'stale frame painted');
    });
    var uiNames=['_subActionStateHtml','_subParentMessageState','_subParentHistoryKey','_subThreadEntries','_workerModalContentKey','_hasStandaloneSubMessage','renderSubReportNotices','renderSubAgentMessage','_subRenderNewlines','renderSubMarkdown','_applySectionIcons','_liftSectionIcon'];
    function uiFixture(chats, realMarkdown) {
        var env={chats:chats||{},escapeHtml:escape,formatContent:function(s){return '<md>'+escape(s)+'</md>';},
            SUB_NOTICE_VIEW_ICON:'eye',_subNoticeCardHtml:function(name,id,state,text){return '<notice>'+escape(text)+'</notice>';},_parentMsgCardHtml:function(n,text){return '<inbox>'+escape(text)+'</inbox>';}};
        var vars=['SUB_ACTION_STATES','SUB_ACTION_TASK_STATUSES','SUB_LIFECYCLE_RE','PARENT_INBOX_RE','SUB_NOTICE_RE'].map(function(n){var m=ui.match(new RegExp('^var '+n+' = .*;$','m'));check(m,'missing '+n);return m[0];});
        // renderSubMarkdown (the shared sub renderer) lifts section icons — load the real emoji-lead regex block.
        vars.push(ui.slice(ui.indexOf('var _SECTION_EMOJI_RE = '), ui.indexOf('function _liftSectionIcon(')));
        if (realMarkdown) {
            env.window={currentSearchHighlight:null};env.UI_ICONS={copy:'copy'};env.storeRawCopy=function(){return 'copy';};
            env.highlightJS=escape;env._knownDocIdRegex=function(){return null;};
            vars.push(sources['src/js/core/055-emoji-shortcodes.js'],declaration(render,'decorateIdMentions'),declaration(render,'formatContent'));
        }
        return load(env,vars.concat(uiNames.map(function(n){return declaration(ui,n);})),uiNames);
    }
    test('every action state and prototype-key fallbacks',function(){
        var u=uiFixture();['running','waiting','stuck','done','error','finished','pr_opened','finished_with_caveat'].forEach(function(st){
            check(u._subActionStateHtml({state:st,label:'work'}).indexOf('sub-action-'+st+'"')>=0,'state lost '+st);
        });
        ['__proto__','constructor','toString','unknown'].forEach(function(st){var html=u._subActionStateHtml({state:st,label:'x',tasks:[{status:st,label:'x'}]});check(html.indexOf('sub-action-running')>=0 && html.indexOf('sub-task-pending')>=0,'unsafe prototype '+st);});
        check(u._subActionStateHtml(null)==='' && u._subActionStateHtml({})==='','empty action not empty');
    });
    test('matching duplicate segment only; coalesced markdown, other lifecycle and unmatched IDs retained',function(){
        var u=uiFixture(),rows=[{role:'sub_msg',subAgentId:'sub_a',text:'**hello**\n\nworld'}];
        var text='keep **user** text\n\n[sub-agent lifecycle] Alpha (sub_a): sent a message: **hello** world\n\n[sub-agent lifecycle] Beta (sub_b): STUCK\n\nkeep tail';
        var html=u.renderSubReportNotices(text,rows);check(html.indexOf('sent a message')<0 && html.indexOf('keep **user** text')>=0 && html.indexOf('STUCK')>=0 && html.indexOf('keep tail')>=0,'coalesced content lost');
        check(u.renderSubReportNotices('[sub-agent lifecycle] Alpha (sub_a): sent a message: **hello** world',rows)==='','standalone duplicate not empty');
        check(u.renderSubReportNotices('[sub-agent lifecycle] Alpha (sub_b): sent a message: **hello** world',rows).indexOf('sent a message')>=0,'different agent suppressed');
        check(u.renderSubReportNotices('[sub-agent lifecycle] Alpha (sub_a): sent a message: different',rows).indexOf('different')>=0,'different text suppressed');
    });
    test('duplicate pairing is one-to-one across coalesced and separate rows',function(){
        var u=uiFixture(), row={role:'sub_msg',subAgentId:'sub_a',text:'same'}, used=[];
        var life='[sub-agent lifecycle] Alpha (sub_a): sent a message: same';
        check(u.renderSubReportNotices(life,[row],used)==='','first pair not suppressed');
        check(u.renderSubReportNotices(life,[row],used).indexOf('same')>=0,'unpaired repeated legacy text suppressed');
        var html=u.renderSubReportNotices(life+'\n\n'+life,[row]);
        check((html.match(/<notice>/g)||[]).length===1,'coalesced duplicate matching was not one-to-one');
    });
    test('actual copy consumer preserves empty strings, latest args and missing-entry fallback',function(){
        var copied=[],wrapper={getAttribute:function(){return 'args';},querySelector:function(){return {textContent:'DOM fallback'};}};
        var env={window:{_rawCopyStore:{args:''}},navigator:{clipboard:{writeText:function(text){copied.push(text);return {then:function(){return {catch:noop};}};}}},showSnackbar:noop};
        var copy=load(env,[declaration(sources['src/js/ui/200-ui-interactions.js'],'copyCodeBlock')],['copyCodeBlock']).copyCodeBlock;
        var btn={closest:function(){return wrapper;}},event={stopPropagation:noop};
        copy(btn,event);check(copied.pop()==='','empty raw string replaced with placeholder');
        env.window._rawCopyStore.args='latest raw';copy(btn,event);check(copied.pop()==='latest raw','raw content stale');
        delete env.window._rawCopyStore.args;copy(btn,event);check(copied.pop()==='DOM fallback','missing raw fallback broken');
        wrapper.getAttribute=function(){return '__proto__';};copy(btn,event);check(copied.pop()==='DOM fallback','prototype treated as raw entry');
    });
    test('legacy/unmatched notices, producer truncation and full standalone markdown',function(){
        var u=uiFixture(),text='x'.repeat(3900)+'\nend',row={role:'sub_msg',subAgentId:'sub_a',text:text};
        var life='[sub-agent lifecycle] Alpha (sub_a): sent a message: '+'x'.repeat(3800);
        check(u.renderSubReportNotices(life).indexOf('sent a message')>=0,'legacy notice suppressed');
        check(u.renderSubReportNotices(life,[row])==='','producer truncation mismatch');
        check(u.renderSubAgentMessage(row,3).indexOf('<md>'+text+'</md>')>=0,'standalone markdown truncated');
        check(u.renderSubReportNotices('plain text')===null,'plain fallback changed');
    });
    function registryFixture(state, live) {
        var card={role:'sub_report',subAgentId:'sub_a',subChatId:'child',createdAt:1,spawnArgs:{instructions:'brief'},report:{status:state==='sleeping'?'done':'running',at:2},progress:[]};
        var rec={agent_id:'sub_a',name:'Alpha',parent_chat_id:'parent',chat_id:'child',state:state,inbox:[],wake_parent:false};
        var env={_subAgents:{sub_a:rec},chats:{parent:{messages:[card]},child:{isSubAgent:true,subAgentId:'sub_a',messages:[]}},
            _subPool:{running:live?{sub_a:true}:{},queue:[]},runningChatIds:{},pendingInjectionsByChatId:{},pausedChats:{},SUBAGENT_INBOX_CAP:50,
            _findSubAgentCard:function(){return card;},_repaintParent:noop,_subAgentsPersist:noop,saveChatsToStorage:noop,_notifyListeners:noop,
            _callerOwnsTarget:function(){return true;},_drainPool:noop,_mintNewSpawnHandle:function(){return 'h';},_saturationWarning:function(){return null;},
            _escalationSuggestion:function(){return null;},_applyChatModelStamp:noop,_notifySubLifecycle:noop,_providerToTier:function(){return 'same';},console:console};
        var names=['agentMessage','_withWakeFinalReminder','_wakeSubAgentImpl','_recordSubParentMessage','_formatInboxDrain','_subNormalizeNewlines','_subNoticeMeta','_subNoticeList','_queueNoticeInjection','_noticeRow','_inboxDrainMeta'];
        var api=load(env,names.map(function(n){return declaration(core,n);}),names);
        return {env:env,api:api,card:card,rec:rec,ui:uiFixture(env.chats)};
    }
    test('running message is visible pending; only exact real transcript evidence upgrades it',function(){
        var f=registryFixture('running',true);check(f.api.agentMessage({to:'sub_a',content:'reply'},{chatId:'parent'}).success,'send failed');
        var item=f.card.parentMessages[0];check(f.ui._subThreadEntries(f.card,f.rec).some(function(e){return e.text==='reply' && e.kind==='message · pending';}),'running reply invisible');
        var key=f.ui._workerModalContentKey(f.card,f.rec);delete f.env.pendingInjectionsByChatId.child;
        check(f.ui._subParentMessageState(item,f.card)==='pending','queue disappearance faked acknowledgment');
        f.env.chats.child.messages.push({role:'user',injected:true,content:item.deliveryText+' suffix'});check(f.ui._subParentMessageState(item,f.card)==='pending','prefix falsely acknowledged');
        f.env.chats.child.messages.push({role:'user',injected:true,content:'other\n\n'+item.deliveryText+'\n\nmore'});
        check(f.ui._subParentMessageState(item,f.card)==='injected','coalesced injection not found');check(key!==f.ui._workerModalContentKey(f.card,f.rec),'delivery key stale');
    });
    test('running pool-queued message is injected, not falsely pending',function(){var f=registryFixture('running',false);f.api.agentMessage({to:'sub_a',content:'reply'},{chatId:'parent'});check(f.card.parentMessages[0].state==='injected' && f.env.chats.child.messages.length===1,'direct injection not reflected');});
    [true,false].forEach(function(live){test('running wake instruction recorded ('+(live?'live':'pool queued')+')',function(){var f=registryFixture('running',live);check(f.api._wakeSubAgentImpl({agent_id:'sub_a',instruction:'next'},{chatId:'parent'},false).success,'wake failed');check(f.card.parentMessages.length===1 && f.card.parentMessages[0].kind==='instruction','wake invisible');check(f.card.parentMessages[0].state===(live?'pending':'injected'),'wake state inaccurate');});});
    test('sleeping wake:false queued once; normal wake drains into input without duplicate history',function(){
        var f=registryFixture('sleeping',false);f.api.agentMessage({to:'sub_a',content:'queued reply',wake:false},{chatId:'parent'});
        check(f.rec.inbox.length===1 && !f.card.parentMessages,'sleeping entry duplicated');
        check(f.ui._subThreadEntries(f.card,f.rec).filter(function(e){return e.text==='queued reply' && e.kind==='queued';}).length===1,'queued entry invisible');
        f.api._wakeSubAgentImpl({agent_id:'sub_a'},{chatId:'parent'},false);check(f.rec.inbox.length===0 && f.card.currentInput.indexOf('queued reply')>=0,'wake did not drain');check(f.card.parentMessages.length===0,'wake duplicated into history');
    });
    test('parent history bounded and archived with completed phase',function(){
        var f=registryFixture('running',false);for(var i=0;i<51;i++) f.api.agentMessage({to:'sub_a',content:'reply '+i},{chatId:'parent'});
        check(f.card.parentMessages.length===50 && f.card.parentMessagesDropped===1,'history cap failed');
        f.rec.state='sleeping';f.card.report={status:'done',summary:'done',at:10};f.api._wakeSubAgentImpl({agent_id:'sub_a',instruction:'next phase'},{chatId:'parent'},false);
        check(f.card.phases[0].parentMessages.length===50 && f.card.phases[0].parentMessagesDropped===1,'archive lost history');check(f.card.parentMessages.length===0,'new phase retains stale history');
    });
    test('progress 49 to 50 to 51 updates modal, inline and self keys without timestamp changes',function(){
        var f=registryFixture('running',true),keys=[],inline=[];
        var env={currentChatId:'parent',chats:f.env.chats,SubAgents:{getById:function(){return f.rec;}},_subActivityKey:function(){return '';},_subParentHistoryKey:f.ui._subParentHistoryKey};
        var ik=load(env,[declaration(ui,'_subReportKey','    ')],['_subReportKey']);
        for(var i=1;i<=51;i++){f.api.agentMessage({to:'parent',content:'progress '+i},{chatId:'child'});if(i>=49){keys.push(f.ui._workerModalContentKey(f.card,f.rec));inline.push(ik._subReportKey());}}
        check(f.card.progress.length===50 && f.card.progressDropped===1,'producer cap failed');check(new Set(keys).size===3 && new Set(inline).size===3,'capped repaint key froze');
        check(ui.indexOf("+ _workerModalContentKey(msg, rec);")>=0,'self key no longer derives modal key');
        check(f.env.chats.parent.messages.filter(function(m){return m.role==='sub_msg';}).length===51,'wake_parent:false lost standalone rows');
    });
    // Use the exact full-render user branch, not a hand-written prefix filter.
    function noticeRenderFixture(rows, winStart) {
        var u=uiFixture(), env={chat:{messages:rows},winStart:winStart||0,usedSubMessages:[],renderSubReportNotices:u.renderSubReportNotices};
        var begin=render.indexOf("                var rawUser = "), end=render.indexOf("\n            }\n            return '<div class=\"message user",begin);
        check(begin>=0 && end>begin,'full-render notice branch missing');
        return load(env,['function renderNotice(msg,index){var userBodyHtml,isSubNoticeRow;'+render.slice(begin,end)+';return userBodyHtml;}'],['renderNotice']).renderNotice;
    }
    test('actual render branch keeps old unmatched lifecycle and suppresses only later pair',function(){
        var life='[sub-agent lifecycle] Alpha (sub_a): sent a message: same';
        var old={role:'user',injected:true,content:life},answer={role:'assistant',content:'old answer'},standalone={role:'sub_msg',subAgentId:'sub_a',text:'same'},later={role:'user',injected:true,content:life};
        var rows=[old,answer,standalone,later],paint=noticeRenderFixture(rows);
        check(paint(old,0).indexOf('same')>=0,'OLD unmatched lifecycle suppressed by future standalone');
        check(paint(later,3).indexOf('hidden')>=0,'NEW duplicate retained');
        check(rows[0].content===life && rows[3].content===life,'model transcript mutated');
    });
    test('actual render branch pairs repeated occurrences and respects visible-window boundary',function(){
        var life='[sub-agent lifecycle] Alpha (sub_a): sent a message: same';
        var sub=function(){return {role:'sub_msg',subAgentId:'sub_a',text:'same'};},notice=function(text){return {role:'user',injected:true,content:text||life};};
        var rows=[sub(),notice(),notice(),sub(),notice('keep before\n\n'+life+'\n\nkeep after')],paint=noticeRenderFixture(rows);
        check(paint(rows[1],1).indexOf('hidden')>=0,'first duplicate visible');
        check(paint(rows[2],2).indexOf('same')>=0,'unpaired repeated notice lost');
        var mixed=paint(rows[4],4);check(mixed.indexOf('same')<0 && mixed.indexOf('keep before')>=0 && mixed.indexOf('keep after')>=0,'coalesced unrelated segments lost');
        var windowed=noticeRenderFixture(rows,1);check(windowed(rows[1],1).indexOf('same')>=0,'off-window standalone suppressed visible history');
        var fresh=noticeRenderFixture(rows);check(fresh(rows[1],1).indexOf('hidden')>=0,'re-render retained stale consumed candidates');
    });
    test('identical resend after queue loss never confirms two attempts from one transcript row',function(){
        var f=registryFixture('running',true);
        f.api.agentMessage({to:'sub_a',content:'same'},{chatId:'parent'});
        delete f.env.pendingInjectionsByChatId.child;
        f.api.agentMessage({to:'sub_a',content:'same'},{chatId:'parent'});
        var first=f.card.parentMessages[0],second=f.card.parentMessages[1];
        check(first.startIndex===second.startIndex && first.deliveryText===second.deliveryText,'fixture is not identical resend');
        f.env.chats.child.messages.push({role:'user',injected:true,content:f.env.pendingInjectionsByChatId.child.text});
        check(f.ui._subParentMessageState(first,f.card)==='pending' && f.ui._subParentMessageState(second,f.card)==='pending','ambiguous attempt falsely injected');
        check(first.ambiguousDelivery && second.ambiguousDelivery,'ambiguity not persisted');
    });
    test('legacy, archived, coalesced and pruned duplicate evidence stays unconfirmed',function(){
        var f=registryFixture('running',true),text='[1 message(s) from parent / inbox]\n- (message) same';
        var first={text:'same',state:'pending',startIndex:0,deliveryText:text},second=Object.assign({},first);
        f.card.phases=[{parentMessages:[first]}];f.card.parentMessages=[second];
        f.env.chats.child.messages.push({role:'user',injected:true,content:'unrelated\n\n'+text+'\n\nother'});
        check(f.ui._subParentMessageState(first,f.card)==='pending' && f.ui._subParentMessageState(second,f.card)==='pending','legacy phase collision confirmed');
        f.card.phases=[];f.card.parentMessages=[second];f.card.parentMessagesDropped=1;
        check(f.ui._subParentMessageState(second,f.card)==='pending','pruned competing history ignored');
        second.state='injected';check(f.ui._subParentMessageState(second,f.card)==='injected','direct producer proof lost');
    });
    test('producer marks cross-phase resends and preserves ambiguity after pruning',function(){
        var f=registryFixture('running',true);f.api.agentMessage({to:'sub_a',content:'same'},{chatId:'parent'});
        var first=f.card.parentMessages[0];f.card.phases=[{parentMessages:f.card.parentMessages}];f.card.parentMessages=[];
        delete f.env.pendingInjectionsByChatId.child;f.api.agentMessage({to:'sub_a',content:'same'},{chatId:'parent'});
        var second=f.card.parentMessages[0];check(first.ambiguousDelivery && second.ambiguousDelivery,'archived attempt not considered');
        f.card.phases=[];f.env.chats.child.messages.push({role:'user',injected:true,content:second.deliveryText});
        check(f.ui._subParentMessageState(second,f.card)==='pending','removing competing phase fabricated proof');
    });
    test('different coalesced payloads confirm independently; repeated payloads remain conservative',function(){
        var f=registryFixture('running',true);['one','two'].forEach(function(s){f.api.agentMessage({to:'sub_a',content:s},{chatId:'parent'});});
        f.env.chats.child.messages.push({role:'user',injected:true,content:f.env.pendingInjectionsByChatId.child.text});
        check(f.card.parentMessages.every(function(item){return f.ui._subParentMessageState(item,f.card)==='injected';}),'distinct coalesced segments not confirmed');
        f.api.agentMessage({to:'sub_a',content:'one'},{chatId:'parent'});
        check(f.ui._subParentMessageState(f.card.parentMessages[2],f.card)==='pending','later equal payload inherited earlier proof');
    });
    test('real producer retains model notice and markdown; wake_parent false remains UI-only',function(){
        var f=registryFixture('running',true);f.rec.wake_parent=true;f.env.runningChatIds.parent=true;
        f.api.agentMessage({to:'parent',content:'**bold**\n\n- item'},{chatId:'child'});
        var notice=f.env.pendingInjectionsByChatId.parent.text,rows=f.env.chats.parent.messages;
        check(notice.indexOf('sent a message: **bold** - item')>=0,'model injection missing');
        // C1: the model notice ends with the cumulative-final reminder, and meta.text covers it (UI hides the span).
        check(/ - item\nReminder: your final message must be a cumulative digest of everything since the user's last message\.$/.test(notice),'cumulative-final reminder missing from model notice');
        var _nm=f.env.pendingInjectionsByChatId.parent.subNotices;
        check(Array.isArray(_nm) && _nm.length===1 && _nm[0].text===notice && _nm[0].summary==='**bold**\n\n- item','meta.text must cover the whole notice incl. reminder');
        var u=uiFixture({},true),standalone=rows[rows.length-1],html=u.renderSubAgentMessage(standalone,1);
        check(html.indexOf('<strong>bold</strong>')>=0 && html.indexOf('<li>')>=0,'real markdown pipeline lost block formatting');
        var mixed=u.renderSubReportNotices('**before**\n\n'+notice+'\n\n**after**',rows);
        check(mixed.indexOf('sent a message')<0 && mixed.indexOf('<strong>before</strong>')>=0 && mixed.indexOf('<strong>after</strong>')>=0,'real markdown coalesced segments lost');
        check(f.env.pendingInjectionsByChatId.parent.text===notice,'UI dedup mutated model notice');
        delete f.env.pendingInjectionsByChatId.parent;f.rec.wake_parent=false;
        f.api.agentMessage({to:'parent',content:'no wake'},{chatId:'child'});
        check(!f.env.pendingInjectionsByChatId.parent && rows[rows.length-1].role==='sub_msg','wake_parent false opt-out changed');
    });
    // Real DOM is supplied by the isolated browser runner. No connected page,
    // synthetic preseeded thinking node, or mocked renderMessages proves this.
    if (domDocument) {
        function domFixture() {
            var doc=domDocument.implementation.createHTMLDocument('isolated thinking regression');
            var env={document:doc,currentChatId:'A',thinkingExpandedState:{},escapeHtml:escape};
            var names=['_renderCompactThinking'],api=load(env,[declaration(render,names[0]),declaration(sources['src/js/ui/120-ui-utils.js'],'toggleThinkingState')],names.concat(['toggleThinkingState']));
            // Execute the actual full-render thinking arm (including its helper call).
            var begin=render.indexOf("                        if (timelineItem.type === 'thinking') {"),end=render.indexOf("                        } else if (timelineItem.type === 'content')",begin);
            check(begin>=0 && end>begin,'full-render thinking arm missing');
            env._renderCompactThinking=api._renderCompactThinking;
            var full=load(env,['function fullTimeline(items,index){var html="";items.forEach(function(timelineItem,tlIdx){'+render.slice(begin,end)+'}});return html;}'],['fullTimeline']).fullTimeline;
            // Detached documents intentionally don't execute inline attributes;
            // wire their EXACT production handler string as build/runtime does.
            function wire(root){root.querySelectorAll('[ontoggle]').forEach(function(el){var code=el.getAttribute('ontoggle');el.addEventListener('toggle',function(){load({toggleThinkingState:api.toggleThinkingState},['function fire(){'+code+'}'],['fire']).fire.call(el);});});}
            return {doc:doc,env:env,api:api,full:full,wire:wire};
        }
        test('real DOM streaming insertion -> native toggle -> full thinking timeline rebuild keeps open AND closed',function(){
            var d=domFixture(),f=fixture(true,0);d.doc.body.innerHTML='<div id="msg-0" class="message assistant"><details class="compact-tools-area streaming" open><summary>tools</summary><div class="compact-tools-status"></div><div class="compact-tools-content"></div></details></div>';
            f.env.document=d.doc;f.env.thinkingExpandedState=d.env.thinkingExpandedState;
            // Production incremental function inserts the first real details node.
            var m={isStreaming:true,thinking:'<private> first',content:'',tool_calls:[]};f.api._updateStreamingMessageNow(0,m,'A');
            var inserted=d.doc.querySelector('.thinking');check(inserted && inserted.open,'production insertion failed');d.wire(d.doc);
            check(inserted.querySelector('.thinking-content').textContent==='<private> first','thinking escaping changed');
            var items=[{type:'thinking',msgIdx:0,thinking:'first'}];
            var before=d.full(items,0);d.doc.querySelector('.compact-tools-content').innerHTML=before;
            check(d.doc.querySelector('.thinking').open,'beforeOpen true became false on full render');
            d.wire(d.doc);var collapsed=d.doc.querySelector('.thinking');collapsed.open=false;collapsed.dispatchEvent(new Event('toggle'));
            check(d.env.thinkingExpandedState['A:msg-0']===false,'toggle did not store explicit false');
            d.doc.querySelector('.compact-tools-content').innerHTML=d.full(items,0);
            check(!d.doc.querySelector('.thinking').open,'collapsed state lost on full render');
            d.wire(d.doc);var opened=d.doc.querySelector('.thinking');opened.open=true;opened.dispatchEvent(new Event('toggle'));
            d.doc.querySelector('.compact-tools-content').innerHTML=d.full(items,0);check(d.doc.querySelector('.thinking').open,'explicit true lost on full render');
        });
        test('whole renderMessages rebuild preserves actual streaming-inserted thinking after toggle',function(){
            var d=domFixture(),f=fixture(true,0),env=f.env;env.document=d.doc;env.thinkingExpandedState=d.env.thinkingExpandedState;
            env.compactAreaExpandedState={};env.hooksEnabled={showHookMessages:true};env.showApiStats=false;env.showMessageSource=false;env._lastRenderState={chatId:null,count:0,sigs:[]};env.activeStreamingChatId='A';
            env.window.isRunning=false;env.isChatRunning=function(){return false;};env._getWindowStart=function(){return 0;};env.formatContent=escape;
            env.isAttachmentRole=function(){return false;};env.findAdjacentForAttachmentGroup=function(){return null;};env.renderInlineChanges=function(){return '';};
            ['updateContextIndicator','updateInputPosition','renderQueuedUserBubble','updateVersionSidebarVisibility','renderVersionSidebar','initializeWidgetsInView','renderWidgetSidebar','initDisplayChecklists','updateSubAgentSelfCard'].forEach(function(n){env[n]=noop;});
            var names=['_renderCompactThinking','_renderSig','_tryIncrementalRender','_sweepOrphanedParkedWidgets','renderMessages'];
            var api=load(env,names.map(function(n){return declaration(render,n);}),names);
            var m={role:'assistant',isStreaming:true,thinking:'',content:''};env.chats.A.messages=[{role:'user',content:'task'},m];
            d.doc.body.innerHTML='<div id="messages"></div>';
            api.renderMessages();check(d.doc.querySelector('.compact-tools-content'),'full render did not create compact container');
            m.thinking='new thought';f.api._updateStreamingMessageNow(1,m,'A');var first=d.doc.querySelector('[data-thinking-msg="1"]');check(first && first.open,'streaming insertion did not open thinking');
            // Force the legitimate full rebuild path, not the signature fast path.
            env._lastRenderState={chatId:null,count:0,sigs:[]};api.renderMessages();check(d.doc.querySelector('[data-thinking-msg="1"]').open,'whole render collapsed inserted thinking');
            d.wire(d.doc);var details=d.doc.querySelector('[data-thinking-msg="1"]');details.open=false;details.dispatchEvent(new Event('toggle'));
            env._lastRenderState={chatId:null,count:0,sigs:[]};api.renderMessages();check(!d.doc.querySelector('[data-thinking-msg="1"]').open,'whole render ignored explicit collapse');
        });
        test('real DOM two messages keep independent expansion across shifted timeline and legacy fallback',function(){
            var d=domFixture();d.env.thinkingExpandedState['A:0-0']=true;
            d.doc.body.innerHTML='<div id="msg-0">'+d.full([{type:'thinking',msgIdx:0,thinking:'old'},{type:'thinking',msgIdx:2,thinking:'later'}],0)+'</div>';
            check(d.doc.querySelector('[data-thinking-msg="0"]').open,'legacy key fallback lost');check(!d.doc.querySelector('[data-thinking-msg="2"]').open,'message state leaked');
            d.wire(d.doc);var first=d.doc.querySelector('[data-thinking-msg="0"]'),second=d.doc.querySelector('[data-thinking-msg="2"]');first.open=false;first.dispatchEvent(new Event('toggle'));second.open=true;second.dispatchEvent(new Event('toggle'));
            d.doc.body.innerHTML=d.full([{type:'thinking',msgIdx:2,thinking:'later'},{type:'thinking',msgIdx:0,thinking:'old'}],7);
            check(!d.doc.querySelector('[data-thinking-msg="0"]').open && d.doc.querySelector('[data-thinking-msg="2"]').open,'timeline reordering swapped message state');
            d.env.thinkingExpandedState={};d.doc.body.innerHTML='<div id="msg-5"><details class="thinking" data-tl-idx="1" open></details></div>';
            var legacy=d.api._renderCompactThinking(8,'legacy DOM',5,1,false);check(/ open/.test(legacy),'legacy DOM fallback lost');
            d.doc.body.innerHTML=d.api._renderCompactThinking(2,'chat A',null,null,true);d.env.currentChatId='B';
            check(!/ open/.test(d.api._renderCompactThinking(2,'chat B',null,null,false)),'old chat DOM leaked expansion into new chat');
        });
    }
    test('modified JS parses and CSS covers every added state',function(){
        new Function(render);new Function(ui);new Function(core);
        ['waiting','finished','pr_opened','finished_with_caveat'].forEach(function(st){check(sources['src/css/24-sub-agents.css'].indexOf('.sub-action-'+st+' .sub-report-action-pill')>=0,'missing CSS '+st);});
    });
    return {passed:results.filter(function(r){return r.passed;}).length,total:results.length,domTests:domDocument?'executed in detached browser Document':'not run: pass a browser Document as second argument',results:results};
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/ui/250-message-render.js","src/js/ui/175-sub-agent-ui.js","src/js/core/097-sub-agent-registry.js","src/css/24-sub-agents.css","src/js/ui/200-ui-interactions.js","src/js/ui/120-ui-utils.js","src/js/core/055-emoji-shortcodes.js"];
await registerRunner('chat-streaming-worker-dialogue', async function() { return runChatStreamingWorkerDialogueTests(await loadSources(PATHS)); });
