// Page bus and complete handler module. Render/persistence boundaries are spies;
// transport-status clearing and stream-slot guards execute production code.
describe('page event handler behavior',function(){
    var m,chats,g,errors,paint,docEvents,windowEvents,classes;
    beforeEach(async function(){
        chats={a:{id:'a',messages:[]},b:{id:'b',messages:[]}};errors=[];paint=[];docEvents={};windowEvents={};classes=new Set();
        var document={hidden:false,hasFocus:function(){return true;},
            addEventListener:function(t,f){(docEvents[t]||(docEvents[t]=[])).push(f);},
            getElementById:function(id){return id==='messages'?{classList:{add:function(c){classes.add(c);},remove:function(c){classes.delete(c);}}}:null;}};
        g={chats:chats,document:document,window:{addEventListener:function(t,f){(windowEvents[t]||(windowEvents[t]=[])).push(f);}},
            currentChatId:'a',currentView:'chat',runningChatIds:{a:true,b:false},isRunning:false,lastApiError:'focused error',activeStreamingChatId:null,
            console:{error:function(){errors.push([].slice.call(arguments));}},
            updateStreamingMessage:function(i,msg,id){paint.push(['stream',id,i,msg]);},
            renderMessages:function(){paint.push(['messages']);},hideSpinner:function(id){paint.push(['hideSpinner',id]);},
            renderChatList:function(){paint.push(['list']);},renderJobsBadge:function(){paint.push(['badge']);},
            hideRetryButton:function(){paint.push(['hideRetry']);},hideContinueButton:function(){paint.push(['hideContinue']);},showPauseButton:function(){paint.push(['pause']);}
        };
        m=await loadModules(['src/js/app/035-agent-events.js','src/js/app/036-agent-event-handlers-page.js'],{globals:g});
        g=m.__scope; // loadModules copies primitive globals into its scope.
    });
    afterEach(function(){assert.deepStrictEqual(errors,[],'No swallowed listener/renderer errors');});
    test('stream replaces only an actively streaming assistant slot',function(){
        chats.a.messages=[{role:'assistant',isStreaming:true,content:'old'}];
        var next={role:'assistant',isStreaming:true,content:'new'};
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:0,message:next});
        assert.strictEqual(chats.a.messages[0],next);assert.deepStrictEqual(paint,[['stream','a',0,next]]);
    });
    test('drifted index never overwrites a prompt, user row, or completed answer',function(){
        var rows=[{role:'prompt_user'},{role:'user'},{role:'assistant',isStreaming:false,content:'final'}];
        chats.a.messages=rows.slice();
        rows.forEach(function(row,i){m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:i,message:{role:'assistant',isStreaming:true}});assert.strictEqual(chats.a.messages[i],row);});
        assert.strictEqual(paint.length,3);
    });
    test('missed-start recovery appends only exact-tail active streams, not gaps or finalized rows',function(){
        var row={role:'assistant',isStreaming:true,content:'resume'};
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:0,message:row});
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:3,message:row});
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:1,message:{role:'assistant',isStreaming:false}});
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:-1,message:row});
        assert.deepStrictEqual(chats.a.messages,[row]);assert.strictEqual(paint.length,4);
    });
    test('stream updates remain chat-scoped and progress clears only matching transport status',function(){
        m._transportInlineStatus.a='a retry';m._transportInlineStatus.b='b retry';
        var row={role:'assistant',isStreaming:true,content:'background'};
        m.AgentEvents.emit('streamDelta',{chatId:'b',msgIndex:0,message:row});
        assert.deepStrictEqual(chats.a.messages,[]);assert.deepStrictEqual(chats.b.messages,[row]);
        assert.strictEqual(m._transportInlineStatus.a,'a retry');assert.strictEqual(m._transportInlineStatus.b,undefined);
        assert.deepStrictEqual(paint,[['stream','b',0,row]]);
    });
    test('background start preserves focused toolbar error and foreground run flags',function(){
        m.AgentEvents.emit('runStarted',{chatId:'b'});
        assert.strictEqual(g.lastApiError,'focused error');assert.strictEqual(g.isRunning,false);
        assert.strictEqual(g.activeStreamingChatId,null);assert.deepStrictEqual(paint,[['list'],['badge']]);
        assert.strictEqual(classes.has('is-streaming'),false);
    });
    test('foreground start owns toolbar and marks the visible transcript streaming',function(){
        m.AgentEvents.emit('runStarted',{chatId:'a'});
        assert.strictEqual(g.lastApiError,null);assert.strictEqual(g.isRunning,true);assert.strictEqual(g.activeStreamingChatId,'a');
        assert.deepStrictEqual(paint,[['list'],['badge'],['hideRetry'],['hideContinue'],['pause']]);
        assert.strictEqual(classes.has('is-streaming'),true);
    });
    test('background assistant start clears its backoff without repainting visible messages',function(){
        m._transportInlineStatus.b='retry';m.AgentEvents.emit('assistantMessageStarted',{chatId:'b'});
        assert.strictEqual(m._transportInlineStatus.b,undefined);assert.deepStrictEqual(paint,[['hideSpinner','b']]);
    });
    test('visibility and blur record only actively running chats',function(){
        g.document.hidden=true;docEvents.visibilitychange.forEach(function(f){f();});
        assert.strictEqual(m._agentEventsHiddenDuringRun.a,true);assert.strictEqual(m._agentEventsHiddenDuringRun.b,undefined);
        g.runningChatIds.b=true;windowEvents.blur.forEach(function(f){f();});
        assert.strictEqual(m._agentEventsHiddenDuringRun.b,true);
    });
});
