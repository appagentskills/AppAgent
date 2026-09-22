// Complete event bus + SW bridge. Ports perform structured cloning like Chrome.
describe('agent event bus and broadcast composition', function() {
    var m,chats,errors,sent,saves,idles;
    beforeEach(async function(){
        chats={a:{id:'a',messages:[]},b:{id:'b',messages:[]}};errors=[];sent=[];saves=0;idles=0;
        m=await loadModules(['src/js/app/035-agent-events.js','src/js/worker/100-agent-event-broadcast.js'],{globals:{
            chats:chats,runningChatIds:{},self:{markOffscreenMaybeIdle:function(){idles++;}},
            saveChatsToStorage:function(){saves++;return Promise.resolve();},
            console:{error:function(){errors.push([].slice.call(arguments));},warn:function(){}}
        }});
        m._agentSubscribers.add({postMessage:function(e){sent.push(JSON.parse(JSON.stringify(e)));}});
    });
    test('dispatch snapshots listeners and isolates listener failures before broadcasting',function(){
        var seen=[],late=function(){seen.push('late');},second=function(){seen.push('second');};
        m.AgentEvents.on('custom',function(){seen.push('first');m.AgentEvents.off('custom',second);m.AgentEvents.on('custom',late);throw new Error('listener');});
        m.AgentEvents.on('custom',second);
        m.AgentEvents.emit('custom',{v:1});
        assert.deepStrictEqual(seen,['first','second']);
        assert.strictEqual(errors.length,1);assert.strictEqual(sent.length,1);
        assert.deepStrictEqual(sent[0],{type:'agent-event',eventType:'custom',detail:{v:1}});
        seen.length=0;m.AgentEvents.emit('custom');
        assert.deepStrictEqual(seen,['first','late']);
        assert.deepStrictEqual(sent[1].detail,{});
    });
    test('broken ports are removed without starving healthy subscribers',function(){
        var calls=0;m._agentSubscribers.add({postMessage:function(){calls++;throw new Error('disconnected');}});
        var later=[];m._agentSubscribers.add({postMessage:function(e){later.push(e.eventType);}});
        m.AgentEvents.emit('custom',{});m.AgentEvents.emit('custom',{});
        assert.strictEqual(calls,1);assert.strictEqual(m.countAgentSubscribers(),2);
        assert.deepStrictEqual(later,['custom','custom']);assert.strictEqual(sent.length,2);
    });
    test('snapshot strips heavy payloads without mutating live objects or details',function(){
        chats.a.screenshots={s:{base64:'heavy',width:5}};chats.a.cachedToolResults={c:{fullContent:'large',name:'call'}};
        var d={chatId:'a'};m.AgentEvents.emit('runStarted',d);
        assert.strictEqual(chats.a.screenshots.s.base64,'heavy');assert.strictEqual(chats.a.cachedToolResults.c.fullContent,'large');
        assert.deepStrictEqual(d,{chatId:'a'});
        assert.deepStrictEqual(sent[0].detail.chat.screenshots,{s:{width:5,_b64Evicted:true}});
        assert.deepStrictEqual(sent[0].detail.chat.cachedToolResults,{c:{name:'call',_fcEvicted:true}});
        assert.strictEqual(sent[0].detail.chat._payloadsEvicted,true);assert.strictEqual(chats.a.rev,1);
    });
    test('delta includes appended rows and mutable old rows with per-chat watermarks',function(){
        var prompt={role:'prompt_user',status:'pending'},assistant={role:'assistant',content:'old'};
        chats.a.messages=[prompt,assistant];m.AgentEvents.emit('assistantMessageStarted',{chatId:'a'});
        prompt.status='submitted';assistant.content='final';chats.a.messages.push({role:'tool',content:'result'});
        m.AgentEvents.emit('assistantMessage',{chatId:'a',message:assistant});
        var d=sent[1].detail.chatDelta;
        assert.strictEqual(d.fromIndex,2);assert.deepStrictEqual(d.tail,[{role:'tool',content:'result'}]);
        assert.deepStrictEqual(d.updates,[{index:0,message:prompt},{index:1,message:assistant}]);
        assert.strictEqual(d.meta.rev,2);assert.strictEqual(d.meta.messages,undefined);
        m.AgentEvents.emit('messagesAppended',{chatId:'b'});
        assert.ok(sent[2].detail.chat);assert.strictEqual(sent[2].detail.chatDelta,undefined);
    });
    test('replacement and truncation invalidate delta watermarks',function(){
        chats.a.messages=[{role:'user',content:'old'}];m.AgentEvents.emit('runStarted',{chatId:'a'});
        chats.a.messages=[{role:'user',content:'new'}];m.AgentEvents.emit('messagesAppended',{chatId:'a'});
        assert.strictEqual(sent[1].detail.chat.messages[0].content,'new');assert.strictEqual(sent[1].detail.chatDelta,undefined);
        chats.a.messages=[];m.AgentEvents.emit('messagesAppended',{chatId:'a'});
        assert.deepStrictEqual(sent[2].detail.chat.messages,[]);
        m.AgentEvents.emit('messagesAppended',{chatId:'a'});
        assert.strictEqual(sent[3].detail.chatDelta.fromIndex,0);
    });
    test('stream chunks never inline full chat and tombstones cannot resurrect it',function(){
        m.AgentEvents.emit('runStarted',{chatId:'a'});var rev=chats.a.rev;
        m.AgentEvents.emit('streamDelta',{chatId:'a',msgIndex:0,message:{content:'chunk'}});
        assert.strictEqual(sent[1].detail.chat,undefined);assert.strictEqual(sent[1].detail.chatDelta,undefined);
        assert.strictEqual(chats.a.rev,rev);
        chats.a._deleted=true;m.AgentEvents.emit('toolCallResult',{chatId:'a'});
        assert.strictEqual(sent[2].detail.chat,undefined);assert.strictEqual(m._chatDeltaSync.a,undefined);
    });
    test('terminal listeners stamp before broadcast and work with no subscribers',function(){
        chats.a.lastResponseAt=Date.now()+100000;var future=chats.a.lastResponseAt;
        m.AgentEvents.emit('runFinished',{chatId:'a'});
        assert.strictEqual(sent[0].detail.chat.lastResponseAt,future);assert.ok(sent[0].detail.chat.updatedAt>0);
        assert.strictEqual(saves,1);assert.strictEqual(idles,1);
        m._agentSubscribers.clear();m.AgentEvents.emit('runCrashed',{chatId:'b'});
        assert.ok(chats.b.lastResponseAt>0);assert.strictEqual(saves,2);assert.strictEqual(sent.length,1);
        chats.b.isSubAgent=true;m.AgentEvents.emit('runFinished',{chatId:'b'});
        assert.strictEqual(saves,2);
    });
});
