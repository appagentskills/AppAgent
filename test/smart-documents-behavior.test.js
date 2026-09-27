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
    // S0B-09: the real importDocuments onchange against the fake IDB above; only UI hooks are stubbed.
    describe('S0B-09 importDocuments',function(){
        var input,modal,snacks;
        beforeEach(function(){
            input=null;modal={answer:'cancel',calls:[]};snacks=[];var sc=m.__scope;
            sc.document={createElement:function(t){var el={tagName:t,click:function(){}};if(t==='input')input=el;return el;},getElementById:function(){return null;}};
            sc.showModal=async function(t,msg,btns){modal.calls.push({msg:msg,btns:btns.map(function(b){return b.value;})});return modal.answer;};
            sc.showSnackbar=function(msg,type){snacks.push([msg,type]);};sc.renderVersionSidebar=function(){};
            sc.escDisplay=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
        });
        async function importFile(docs){m.importDocuments();await input.onchange({target:{files:[{text:async function(){return JSON.stringify({type:'appagent-documents',version:1,documents:docs});}}]}});}
        function row(over){return Object.assign({id:'review_notes',title:'Review Notes',currentContent:'imported',versions:[{version:1,content:'imported'}],scope:'chat',ownerChatId:'evil',file_id:'file_evil'},over||{});}
        function last(){return snacks[snacks.length-1];}
        test('S0B-09 Cancel on a clash writes nothing',async function(){
            await create('first');var before=clone(rows);
            await importFile([row(),row({id:'other',title:'Other'})]);
            assert.strictEqual(modal.calls.length,1);assert.deepStrictEqual(modal.calls[0].btns,['cancel','keep','replace']);
            assert.match(modal.calls[0].msg,/Review Notes[\s\S]*version history/);
            assert.deepStrictEqual(rows,before);assert.strictEqual(m.smartDocuments.other,undefined);assert.strictEqual(m.smartDocuments.review_notes.currentContent,'first');
            assert.deepStrictEqual(snacks,[]);
        },{tags:['unit']});
        test('S0B-09 Keep both adds a copy and keeps the original',async function(){
            var a=await create('first');modal.answer='keep';
            await importFile([row()]);
            assert.strictEqual(rows.review_notes.currentContent,'first');assert.strictEqual(rows.review_notes.file_id,a.file_id);
            var c=rows.review_notes_2;assert.strictEqual(c.currentContent,'imported');assert.strictEqual(c.scope,'shared');assert.strictEqual(c.ownerChatId,undefined);
            assert.ok(c.file_id&&c.file_id!=='file_evil'&&c.file_id!==a.file_id);assert.strictEqual(m.smartDocuments.review_notes_2.currentContent,'imported');
            assert.deepStrictEqual(last(),['Imported 1 document(s) (0 replaced, 1 copied, 0 skipped)','success']);
        },{tags:['unit']});
        test('S0B-09 Replace keeps the local file_id and scope',async function(){
            var a=await create('first');var local=clone(rows.review_notes);modal.answer='replace';
            await importFile([row()]);
            var d=rows.review_notes;assert.strictEqual(d.currentContent,'imported');assert.deepStrictEqual(d.versions,[{version:1,content:'imported'}]);
            assert.strictEqual(d.file_id,a.file_id);assert.strictEqual(d.scope,'shared');assert.strictEqual(d.ownerChatId,local.ownerChatId);assert.strictEqual(rows.review_notes_2,undefined);
            assert.deepStrictEqual(last(),['Imported 1 document(s) (1 replaced, 0 copied, 0 skipped)','success']);
        },{tags:['unit']});
        test('S0B-09 a chat-scoped clash is never replaced',async function(){
            var c=await create('secret','chat','child');var local=clone(rows[c.doc_id]);modal.answer='replace';
            await importFile([row()]);
            assert.strictEqual(modal.calls.length,0,'no modal');assert.deepStrictEqual(rows[c.doc_id],local);
            var copy=rows[c.doc_id+'_2'];assert.strictEqual(copy.currentContent,'imported');assert.strictEqual(copy.scope,'shared');assert.strictEqual(copy.ownerChatId,undefined);
        },{tags:['unit']});
        test('S0B-09 a null row is skipped, not an abort',async function(){
            await importFile([null,7,{id:{},title:'Bad'},row({id:'n1',title:'N1'}),row({id:'n1',title:'N1'})]);
            assert.strictEqual(rows.n1.currentContent,'imported');assert.strictEqual(rows.n1.scope,'shared');assert.strictEqual(rows.n1_2.currentContent,'imported');
            assert.deepStrictEqual(last(),['Imported 2 document(s) (0 replaced, 1 copied, 3 skipped)','success']);
        },{tags:['unit']});
        // RC2A3-F4: seen/taken were {} literals and the clash check read smartDocuments[id],
        // so constructor/toString posed as in-file duplicates (imported as renamed copies).
        test('S0B-09 ids like constructor/toString import as themselves, __proto__ skipped',async function(){
            rows=Object.create(null); // real IDB has no prototype keys (the fake get reads rows[id])
            modal.answer='replace';
            await importFile([row({id:'constructor',title:'Ctor'}),row({id:'toString',title:'ToStr'}),row({id:'__proto__',title:'Proto'})]);
            assert.strictEqual(modal.calls.length,0,'no clash modal: nothing exists yet');
            assert.deepStrictEqual(Object.keys(rows).sort(),['constructor','toString']);
            assert.strictEqual(rows.constructor.currentContent,'imported');assert.strictEqual(rows.constructor.scope,'shared');assert.strictEqual(rows.toString.title,'ToStr');
            assert.ok(Object.prototype.hasOwnProperty.call(m.smartDocuments,'constructor'));assert.strictEqual(m.smartDocuments.toString.currentContent,'imported');
            assert.strictEqual(m.smartDocuments.title,undefined,'the cache prototype was not replaced');
            assert.deepStrictEqual(last(),['Imported 2 document(s) (0 replaced, 0 copied, 1 skipped)','success']);
        },{tags:['unit']});
        // RC2A3-F5: the post-commit renders ran bare in `finally`, so their throw became "Import failed".
        test('S0B-09 a render error after commit still reports Imported N',async function(){
            var sc=m.__scope,sidebar=0;
            sc.document.getElementById=function(){throw new Error('dom boom');}; // renderDocumentsPage throws
            sc.renderVersionSidebar=function(){sidebar++;throw new Error('render boom');};
            await importFile([row({id:'fresh',title:'Fresh'})]);
            assert.strictEqual(rows.fresh.currentContent,'imported');assert.strictEqual(m.smartDocuments.fresh.currentContent,'imported');
            assert.strictEqual(sidebar,1,'sidebar still re-rendered after the page render threw');
            assert.deepStrictEqual(snacks,[['Imported 1 document(s) (0 replaced, 0 copied, 0 skipped)','success']]);
        },{tags:['unit']});
        test('S0B-09 withStore rejection leaves the cache untouched and shows an error',async function(){
            m.__scope.renderVersionSidebar=function(){throw new Error('render boom');}; // must not mask the write error
            rows=new Proxy(Object.create(null),{set:function(){throw new Error('disk full');}}); // fake store.put throws
            await importFile([row({id:'fresh',title:'Fresh'})]);
            assert.strictEqual(m.smartDocuments.fresh,undefined,'cache untouched');assert.deepStrictEqual(Object.keys(rows),[]);
            assert.deepStrictEqual(snacks,[['Import failed: disk full','error']]);
        },{tags:['unit']});
        // TA4-7: the REAL core/130 deadline path (deadlines shortened via its module vars) on a
        // congested fake backend: the import's readwrite tx never commits in time while tiny
        // readonly probes answer (slow: left queued) or never answer (wedged: aborted + retried).
        async function congested(wedged){
            var sc=m.__scope,real=await m.openDatabase(),st={queued:[],listeners:{},aborted:0};
            st.db={close:function(){},transaction:function(names,mode){
                if(mode==='readwrite'&&names[0]==='documents')return {addEventListener:function(t,f){(st.listeners[t]=st.listeners[t]||[]).push(f);},abort:function(){st.aborted++;},
                    objectStore:function(){return {put:function(doc){st.queued.push(clone(doc));return {};}};}};
                var tx=real.transaction(names,mode),os=tx.objectStore;
                tx.objectStore=function(n){var s=os(n);s.count=function(){var r={};if(!wedged)queueMicrotask(function(){r.onsuccess();});return r;};return s;};
                return tx;
            }};
            sc.DB_TX_DEADLINE_WRITE_MS=20;sc.DB_TX_PROBE_TIMEOUT_MS=30;sc.db=st.db;sc._dbOpenPromise=null;
            sc.indexedDB={open:function(){var r={result:st.db};queueMicrotask(function(){r.onsuccess();});return r;}};
            return st;
        }
        test('TA4-7 a slow-tx TimeoutError still caches + registers the imported docs and warns',async function(){
            var st=await congested(false);
            await importFile([row({id:'fresh',title:'Fresh'})]);
            assert.strictEqual(st.aborted,0,'left queued, not aborted');assert.deepStrictEqual(st.queued.map(function(d){return d.id;}),['fresh']);
            assert.strictEqual(rows.fresh,undefined,'not committed yet: the timeout path ran');
            var c=m.smartDocuments.fresh;assert.strictEqual(c.currentContent,'imported');assert.strictEqual(c.scope,'shared');
            assert.deepStrictEqual(m.__scope.fileIndex.get(c.file_id),{type:'document',docId:'fresh'});
            assert.deepStrictEqual(snacks,[['Imported 1 document(s) (0 replaced, 0 copied, 0 skipped). Storage is busy, so they are still saving in the background.','warning']]);
            (st.listeners.abort||[]).forEach(function(f){f({});}); // a late abort of the queued write is surfaced
            assert.deepStrictEqual(last(),['Import did not finish saving: transaction aborted. The imported documents will not survive a reload.','error']);
        },{tags:['unit']});
        test('TA4-7 a wedged-tx TimeoutError (aborted, retried once) is still Import failed',async function(){
            var st=await congested(true);
            await importFile([row({id:'fresh',title:'Fresh'})]);
            assert.strictEqual(st.aborted,2,'both attempts aborted');assert.strictEqual(m.smartDocuments.fresh,undefined,'cache untouched');
            assert.deepStrictEqual(Array.from(m.__scope.fileIndex.values()).filter(function(p){return p.docId==='fresh';}),[]);
            assert.strictEqual(snacks.length,1);assert.strictEqual(snacks[0][1],'error');
            assert.match(snacks[0][0],/^Import failed: IndexedDB transaction on \[documents\] \(readwrite\) timed out after 20ms$/);
        },{tags:['unit']});
        test('S0B-15 exportAllDocuments + sdocDownloadMd: a throwing currentContent getter gives an error snackbar',async function(){
            var sc=m.__scope,mk=sc.document.createElement,made=[];
            sc.document.createElement=function(t){var el=mk(t);made.push(el);return el;};
            var bad={id:'bad_doc',title:'Bad',scope:'shared',currentVersion:1,versions:[]};
            Object.defineProperty(bad,'currentContent',{enumerable:true,get:function(){throw new Error('content boom');}});
            m.smartDocuments.bad_doc=bad;
            m.exportAllDocuments();
            assert.deepStrictEqual(snacks,[['Download failed: content boom','error']],'was an uncaught exception');
            m.sdocDownloadMd('bad_doc');m.sdocExportMd('bad_doc');
            assert.deepStrictEqual(snacks.slice(1),[['Download failed: content boom','error'],['Download failed: content boom','error']]);
            assert.strictEqual(made.length,0,'no download link created');
            m.smartDocuments.ok_doc={id:'ok_doc',title:'OK doc',scope:'shared',currentContent:'# hi',currentVersion:1,versions:[]};
            m.sdocDownloadMd('ok_doc');
            assert.strictEqual(made.length,1);assert.strictEqual(made[0].download,'OK_doc.md');assert.strictEqual(snacks.length,3,'happy path: no error snackbar');
        },{tags:['unit']});
    });
});
