// Whole smart-document implementation composed with the real slug, file,
// sub-agent lineage, event bus and IDB modules. Browser IDB alone is simulated.
describe('smart document behavior',function(){
    var m,rows,events,errors,readError;
    function clone(x){return x===undefined?undefined:JSON.parse(JSON.stringify(x));}
    beforeEach(async function(){
        rows={};events=[];errors=[];readError=false;
        // Fake tx fires 'complete' once its issued requests have settled (real IDB
        // semantics) — withStore (readwrite) waits for that commit.
        var database={close:function(){},transaction:function(){var listeners={},pending=0,committed=false;
            function settled(){pending--;queueMicrotask(function(){if(committed||pending>0)return;committed=true;(listeners.complete||[]).forEach(function(l){l({});});});}
            function request(fill){var r={};pending++;queueMicrotask(function(){fill(r);settled();});return r;}
            pending++;queueMicrotask(settled); // an empty tx still commits
            return {addEventListener:function(t,f){(listeners[t]=listeners[t]||[]).push(f);},abort:function(){},objectStore:function(){return {
            get:function(id){return request(function(r){if(readError){r.error=new Error('read failed');r.onerror();}else{r.result=clone(rows[id]);r.onsuccess();}});},
            getAll:function(){return request(function(r){r.result=clone(Object.values(rows));r.onsuccess();});},
            put:function(doc){rows[doc.id]=clone(doc);return request(function(r){if(r.onsuccess)r.onsuccess();});},delete:function(id){delete rows[id];return request(function(r){if(r.onsuccess)r.onsuccess();});}
        };}};}};
        m=await loadModules(['src/js/core/095-handle-registry.js','src/js/core/097-sub-agent-registry.js','src/js/core/130-indexeddb.js','src/js/tools/040-file-store.js','src/js/app/035-agent-events.js','src/js/tools/110-smart-documents.js'],{globals:{
            STORAGE_PREFIX:'test_',self:{},indexedDB:{open:function(){var r={result:database};queueMicrotask(function(){r.onsuccess();});return r;}},
            chats:{root:{displays:{}},child:{displays:{}},sibling:{displays:{}}},activeStreamingChatId:null,currentChatId:null,
            console:{error:function(){errors.push([].slice.call(arguments));},warn:function(){}}
        }});
        // Seed records as a persisted registry would; do not replace lineage helpers.
        m._subAgents.child={agent_id:'child',chat_id:'child',parent_chat_id:'root'};
        m._subAgents.sibling={agent_id:'sibling',chat_id:'sibling',parent_chat_id:'root'};
        m._subAgents.grandchild={agent_id:'grandchild',chat_id:'grandchild',parent_chat_id:'child'};
        m.AgentEvents.on('documentChanged',function(e){events.push(e);});
    });
    afterEach(function(){assert.deepStrictEqual(errors,[],'No swallowed document or event errors');});
    function call(args,chat){return m.executeSmartDocument(args,0,{chatId:chat||'root'});}
    async function create(content,scope,chat){return call({action:'create',title:'Review Notes',content:content,scope:scope},chat);}
    test('create persists readable revision and resolves collision with uncached IDB document',async function(){
        var a=await create('first');delete m.smartDocuments[a.doc_id];
        var b=await create('second');
        assert.strictEqual(a.doc_id,'review_notes');assert.strictEqual(b.doc_id,'review_notes_2');assert.notStrictEqual(a.file_id,b.file_id);
        assert.strictEqual((await call({action:'read',doc_id:a.doc_id})).content,'first');
        assert.strictEqual(rows[b.doc_id].versions[0].content,'second');
        assert.deepStrictEqual(events.map(function(e){return e.kind;}),['created','created']);
    });
    test('chat-private documents cross ancestors and descendants but not siblings or unrelated chats',async function(){
        var c=await create('secret','chat','child');
        for(var who of ['child','root','grandchild'])assert.strictEqual((await call({action:'read',doc_id:c.doc_id},who)).content,'secret');
        for(var who of ['sibling','unrelated']){
            for(var action of ['read','update','edit','list_versions','read_version','delete']){
                var r=await call({action:action,doc_id:c.doc_id,content:'stolen',version:1,edits:[{find:'secret',replace:'stolen'}]},who);
                assert.deepStrictEqual(r,{success:false,error:'Document not found: '+c.doc_id});
            }
            assert.deepStrictEqual((await call({action:'list'},who)).documents,[]);
        }
        assert.strictEqual(rows[c.doc_id].currentContent,'secret');assert.strictEqual(events.length,1);
    });
    test('refreshes stale cache before updates and keeps prior revisions immutable',async function(){
        var c=await create('old');var persisted=rows[c.doc_id];
        persisted.currentVersion=2;persisted.currentContent='page edit';persisted.versions.push({version:2,content:'page edit',title:persisted.title,author:'user',timestamp:1});
        var r=await call({action:'update',doc_id:c.doc_id,title:'Renamed',content:''});
        assert.strictEqual(r.version,3);assert.strictEqual(rows[c.doc_id].currentContent,'');
        assert.strictEqual((await call({action:'read_version',doc_id:c.doc_id,version:2})).content,'page edit');
        assert.strictEqual((await call({action:'read_version',doc_id:c.doc_id,version:1})).title,'Review Notes');
        assert.strictEqual((await call({action:'read_version',doc_id:c.doc_id,version:99})).success,false);
    });
    test('failed multi-edit is atomic and ambiguous text creates no revision or event',async function(){
        var c=await create('alpha beta beta');var before=clone(rows[c.doc_id]);
        var r=await call({action:'edit',doc_id:c.doc_id,edits:[{find:'alpha',replace:'changed'},{find:'beta',replace:'x'}]});
        assert.strictEqual(r.success,false);assert.strictEqual(r.error,'Edit 1: text is not unique (found multiple occurrences)');
        assert.deepStrictEqual(rows[c.doc_id],before);assert.strictEqual(events.length,1);
        var ok=await call({action:'edit',doc_id:c.doc_id,edits:[{find:'alpha',replace:'changed'},{find:'changed',replace:'final'}]});
        assert.strictEqual(ok.edits_applied,2);assert.strictEqual(rows[c.doc_id].currentContent,'final beta beta');assert.strictEqual(rows[c.doc_id].currentVersion,2);
    });
    test('deleted page-side document is removed from stale cache and cannot be resurrected by update',async function(){
        var c=await create('old');delete rows[c.doc_id];
        var r=await call({action:'update',doc_id:c.doc_id,content:'resurrect'});
        assert.strictEqual(r.success,false);assert.strictEqual(m.smartDocuments[c.doc_id],undefined);assert.strictEqual(rows[c.doc_id],undefined);
        assert.deepStrictEqual((await call({action:'list'})).documents,[]);
    });
    test('scope is fixed on update; prompts alone do not create a content revision',async function(){
        var c=await create('private','chat','child');
        await call({action:'update',doc_id:c.doc_id,scope:'shared',prompts:[{fields:[{name:'x',type:'text'}]}]},'child');
        assert.strictEqual(rows[c.doc_id].scope,'chat');assert.strictEqual(rows[c.doc_id].currentVersion,1);
        var p=rows[c.doc_id].prompts[0];assert.ok(p.id);assert.strictEqual(p.status,'pending');assert.deepStrictEqual(p.responses,{});
        p.status='answered';p.responses={x:'answer'};
        assert.deepStrictEqual((await call({action:'read',doc_id:c.doc_id},'root')).prompt_responses,{[p.id]:{x:'answer'}});
    });
    test('missing ownership safely falls back to shared and invalid actions do not write',async function(){
        var c=await m.executeSmartDocument({action:'create',title:'Ownerless',scope:'chat'},0,{});
        assert.strictEqual(c.scope,'shared');assert.strictEqual(rows[c.doc_id].ownerChatId,null);
        assert.deepStrictEqual(await call({}),{success:false,error:'action is required'});
        assert.deepStrictEqual(await call({action:'unknown'}),{success:false,error:'Unknown action: unknown'});
        assert.strictEqual(Object.keys(rows).length,1);
    });
    test('read request failure returns no stale content and delete removes durable row',async function(){
        var c=await create('secret');readError=true;
        assert.strictEqual((await call({action:'read',doc_id:c.doc_id})).success,false);
        assert.strictEqual(m.smartDocuments[c.doc_id],undefined);assert.strictEqual(rows[c.doc_id].currentContent,'secret');
        readError=false;assert.strictEqual((await call({action:'delete',doc_id:c.doc_id})).success,true);
        assert.strictEqual(rows[c.doc_id],undefined);assert.strictEqual(events[1].kind,'deleted');
    });
});
