// Actual checkpoint queue, event bus, openDatabase and withStore. Only the
// browser IDB interface is fake; request completion is explicit and cloned.
describe('checkpoint persistence behavior',function(){
    var m,rows,ops,held,holdPuts,failures,opens,closes,warnings,errors;
    function clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));}
    function request(kind,key,value,onSettle){
        var req={};ops.push([kind,key]);
        function finish(){
            var error=failures[kind]&&failures[kind].shift();
            if(error){req.error=Object.assign(new Error(error),{name:error});if(req.onerror)req.onerror({target:req});if(onSettle)onSettle();return;}
            if(kind==='put')rows[key]=clone(value);
            if(kind==='delete')delete rows[key];
            req.result=kind==='get'?clone(rows[key]):key;
            if(req.onsuccess)req.onsuccess({target:req});
            if(onSettle)onSettle();
        }
        if(kind==='put'&&holdPuts)held.push(finish);else queueMicrotask(finish);
        return req;
    }
    function connection(){return {close:function(){closes++;},transaction:function(names){
        // Like real IDB, the fake tx fires 'complete' once every request it issued
        // has settled and no handler queued another one — withStore (readwrite)
        // waits for that commit, not just request success.
        var listeners={},pending=0,committed=false;
        function settled(){pending--;queueMicrotask(function(){if(committed||pending>0)return;committed=true;(listeners.complete||[]).forEach(function(l){l({});});});}
        function issue(kind,key,value){pending++;return request(kind,key,value,settled);}
        return {addEventListener:function(type,fn){(listeners[type]=listeners[type]||[]).push(fn);},abort:function(){},objectStore:function(){return {
            put:function(r){return issue('put',r.chatId,r);},get:function(k){return issue('get',k);},delete:function(k){return issue('delete',k);},
            openCursor:function(){var req={},keys=Object.keys(rows),i=0;pending++;function step(){var key=keys[i++];req.result=key===undefined?null:{value:clone(rows[key]),delete:function(){delete rows[key];},continue:function(){queueMicrotask(step);}};if(req.onsuccess)req.onsuccess({target:req});if(key===undefined)settled();}queueMicrotask(step);return req;}
        };}};
    }};}
    async function drain(){for(var i=0;i<80&&Object.keys(m._ckptChannels).length;i++)await Promise.resolve();assert.deepStrictEqual(Object.keys(m._ckptChannels),[],'checkpoint channel drained');}
    beforeEach(async function(){
        rows={};ops=[];held=[];holdPuts=false;failures={};opens=0;closes=0;warnings=[];errors=[];
        m=await loadModules(['src/js/core/130-indexeddb.js','src/js/app/035-agent-events.js','src/js/worker/110-agent-checkpoint.js'],{globals:{
            STORAGE_PREFIX:'test_',indexedDB:{open:function(){opens++;var r={result:connection()};queueMicrotask(function(){r.onsuccess({target:r});});return r;}},
            chats:{a:{id:'a',messages:[{role:'user',content:'hello'},{role:'assistant',content:'answer'}]}},parkedToolCallsByChatId:{},
            console:{warn:function(){warnings.push([].slice.call(arguments));},error:function(){errors.push([].slice.call(arguments));}}
        }});
    });
    afterEach(function(){assert.deepStrictEqual(errors,[],'No swallowed bus errors');});
    test('writes clone snapshots and read back through actual withStore',async function(){
        var snap={status:'running',turn:2};await m.writeAgentCheckpoint('a',snap);
        assert.deepStrictEqual(snap,{status:'running',turn:2});
        var r=await m.readAgentCheckpoint('a');assert.strictEqual(r.chatId,'a');assert.strictEqual(r.turn,2);assert.ok(r.lastEventAt>0);
        r.turn=9;assert.strictEqual((await m.readAgentCheckpoint('a')).turn,2);
        assert.strictEqual(opens,1);assert.strictEqual(await m.readAgentCheckpoint('missing'),null);
    });
    test('coalesces queued writes but preserves a terminal delete after the in-flight put',async function(){
        holdPuts=true;var first=m.writeAgentCheckpoint('a',{turn:1});
        for(var i=0;i<20&&!held.length;i++)await Promise.resolve();assert.strictEqual(held.length,1);
        var middle=m.writeAgentCheckpoint('a',{turn:2}),latest=m.writeAgentCheckpoint('a',{turn:3}),del=m.deleteAgentCheckpoint('a');
        assert.deepStrictEqual(ops,[['put','a']]);holdPuts=false;held.shift()();
        await Promise.all([first,middle,latest,del]);
        assert.deepStrictEqual(ops,[['put','a'],['delete','a']]);assert.strictEqual(rows.a,undefined);
        assert.deepStrictEqual(Object.keys(m._ckptChannels),[]);
    });
    test('one stalled chat does not block another chat channel',async function(){
        holdPuts=true;var a=m.writeAgentCheckpoint('a',{turn:1});
        for(var i=0;i<20&&!held.length;i++)await Promise.resolve();
        holdPuts=false;await m.writeAgentCheckpoint('b',{turn:2});
        assert.strictEqual(rows.b.turn,2);assert.strictEqual(rows.a,undefined);
        held.shift()();await a;assert.strictEqual(rows.a.turn,1);
    });
    test('connection-shaped request error reopens and retries once',async function(){
        failures.put=['InvalidStateError'];await m.writeAgentCheckpoint('a',{turn:5});
        assert.strictEqual(rows.a.turn,5);assert.strictEqual(opens,2);assert.strictEqual(closes,1);
        assert.deepStrictEqual(ops,[['put','a'],['put','a']]);assert.strictEqual(warnings.length,1);
    });
    test('exhausted connection retry is logged and never rejects or poisons later writes',async function(){
        failures.put=['UnknownError','UnknownError'];await m.writeAgentCheckpoint('a',{turn:1});
        assert.strictEqual(rows.a,undefined);assert.strictEqual(opens,2);assert.strictEqual(warnings.length,2);
        await m.writeAgentCheckpoint('a',{turn:2});assert.strictEqual(rows.a.turn,2);
        assert.deepStrictEqual(Object.keys(m._ckptChannels),[]);
    });
    test('nonconnection errors are not retried and reads fail closed',async function(){
        failures.put=['QuotaExceededError'];await m.writeAgentCheckpoint('a',{turn:1});
        assert.strictEqual(opens,1);assert.strictEqual(ops.length,1);assert.strictEqual(rows.a,undefined);
        failures.get=['DataError'];assert.strictEqual(await m.readAgentCheckpoint('a'),null);assert.strictEqual(opens,1);
        assert.strictEqual(warnings.length,2);
    });
    test('reaper preserves old live runs while removing stale diagnostics and finished rows',async function(){
        rows={running:{chatId:'running',status:'running'},parked:{chatId:'parked',status:'parked',lastEventAt:1},done:{chatId:'done',status:'finished',lastEventAt:Date.now()},old:{chatId:'old',status:'errored',lastEventAt:1},recent:{chatId:'recent',status:'paused',lastEventAt:Date.now()}};
        assert.strictEqual(await m.sweepFinishedAgentCheckpoints(),2);
        assert.deepStrictEqual(Object.keys(rows).sort(),['parked','recent','running']);
        assert.deepStrictEqual((await m.listRunningAgentCheckpoints()).map(function(r){return r.chatId;}).sort(),['parked','running']);
    });
    test('event lifecycle resets resume budget on progress, persists crashes, and deletes clean finish',async function(){
        m._ckptResumeCounts.a=3;m.AgentEvents.emit('runStarted',{chatId:'a'});await drain();
        assert.strictEqual(rows.a.resume_count,3);assert.strictEqual(rows.a.turn,0);assert.strictEqual(rows.a.messagesSnapshot,undefined);
        m.AgentEvents.emit('assistantMessage',{chatId:'a'});await drain();assert.strictEqual(rows.a.resume_count,undefined);
        m.AgentEvents.emit('runCrashed',{chatId:'a',error:{message:'x'.repeat(600)}});await drain();
        assert.strictEqual(rows.a.status,'errored');assert.strictEqual(rows.a.lastError.length,500);assert.deepStrictEqual(await m.listRunningAgentCheckpoints(),[]);
        m.AgentEvents.emit('runStarted',{chatId:'a'});await drain();assert.strictEqual(rows.a.status,'running');
        m.AgentEvents.emit('runFinished',{chatId:'a',isPaused:true});await drain();assert.strictEqual(rows.a.status,'paused');
        m.AgentEvents.emit('runFinished',{chatId:'a'});await drain();assert.strictEqual(rows.a,undefined);
    });
});
