// Tests the complete browser skill module's exported guards, NOT the Node build.
async function buildGuardModule(){return runFile('skills/extension-dev/build.js');}
describe('browser-build guard behavior',function(){
    test('write-site counts distinguish writes from comparisons, properties and comments',async function(){
        var m=await buildGuardModule(),counts=m.computeWriteSiteRatchetCounts({'b.js':'chats[id] = row; chat.meta.flag = true; delete chats[id]; chrome.storage.local.set({x:1});','a.js':'// chats[id] = comment;\n/* renderMessages(); */\nchats[x] === y; obj.chats[x] = y; pausedChats[x] = y; currentChatId = id; obj.currentChatId = id; renderMessages();'});
        assert.deepStrictEqual(counts.chatsAssign,{'b.js':1});assert.deepStrictEqual(counts.chatFieldPoke,{'b.js':1});assert.deepStrictEqual(counts.deleteChatsEntry,{'b.js':1});assert.deepStrictEqual(counts.storageLocalSet,{'b.js':1});assert.deepStrictEqual(counts.currentChatIdAssign,{'a.js':1});assert.deepStrictEqual(counts.renderMessages,{'a.js':1});
    });
    test('store deletion tripwire includes stores and cursors but not keyed Map.delete',async function(){var m=await buildGuardModule();var c=m.computeWriteSiteRatchetCounts({'x.js':'store.delete(id); chatStore.delete(id); tx.objectStore("chats").delete(id); cursor.delete(); map.delete(key); store.clear();'});assert.deepStrictEqual(c.idbStoreDelete,{'x.js':4});});
    test('ratchet rejects increases and records decreases independently per file',async function(){
        var m=await buildGuardModule(),r=m.compareWriteSiteRatchet({chatsAssign:{'a.js':2,'gone.js':1}},{chatsAssign:{'a.js':3,'new.js':1}});
        assert.deepStrictEqual(r.violations.map(function(v){return [v.file,v.baseline,v.current];}),[['a.js',2,3],['new.js',0,1]]);assert.deepStrictEqual(r.tightenable.map(function(v){return [v.file,v.baseline,v.current];}),[['gone.js',1,0]]);assert.deepStrictEqual(m.compareWriteSiteRatchet({},{}),{violations:[],tightenable:[]});
    });
    test('shared vocabulary succeeds only with shared lists in both assembled outputs',async function(){
        var m=await buildGuardModule(),src="var CHAT_META_TS_FIELDS = ['updatedAt', 'lastReadAt'];\nvar CHAT_META_FLAG_FIELDS = ['archived'];";
        assert.deepStrictEqual(m.checkChatMetaSharedLists({'src/js/core/030-config.js':src},{'app.js':src,'sw-bundle.js':src}),[]);
        var failures=m.checkChatMetaSharedLists({'src/js/core/030-config.js':src},{'app.js':src,'sw-bundle.js':''});assert.strictEqual(failures.length,2);assert.match(failures[0],/no declaration.*sw-bundle/);
    });
    test('shared vocabulary detects missing source, duplicate declaration and bundle drift',async function(){
        var m=await buildGuardModule(),src="var CHAT_META_TS_FIELDS = ['time'];\nvar CHAT_META_FLAG_FIELDS = ['flag'];",files={'src/js/core/030-config.js':src,'src/js/worker/115-storage.js':"var CHAT_META_FLAG_FIELDS = ['other'];"};
        var f=m.checkChatMetaSharedLists(files,{'app.js':src.replace("['time']","['wrong']")});assert.strictEqual(f.length,2);assert.ok(f.some(function(x){return /duplicate.*115-storage/.test(x);}));assert.ok(f.some(function(x){return /shadows the shared/.test(x);}));
        assert.strictEqual(m.checkChatMetaSharedLists({},{}).length,2);
    });
    test('guard-region comparison ignores surrounding build-only code but rejects byte drift',async function(){
        var m=await buildGuardModule(),region='// '+m.GUARD_REGION_START+'\nvar value = 1;\n// '+m.GUARD_REGION_END;
        assert.deepStrictEqual(m.compareGuardRegions('prefix\n'+region+'\nnode code',region+'\nskill code'),[]);
        var f=m.compareGuardRegions(region,region.replace('value = 1','value = 2'));assert.strictEqual(f.length,1);assert.match(f[0],/first drift at region line 2/);assert.match(f[0],/fnv1a [0-9a-f]{8}/);
    });
    test('missing region markers fail closed and hash matches published FNV vectors',async function(){var m=await buildGuardModule();assert.strictEqual(m.compareGuardRegions('', '').length,2);assert.strictEqual(m.extractGuardRegion('no markers'),null);assert.strictEqual(m.fnv1aHex(''),'811c9dc5');assert.strictEqual(m.fnv1aHex('hello'),'4f9f2cab');});
    test('real checked-in build guard regions remain byte-identical',async function(){var m=await buildGuardModule();assert.deepStrictEqual(m.compareGuardRegions(await loadFile('build/build.js'),await loadFile('skills/extension-dev/build.js')),[]);});
});

async function policyArtifactsFixture(){
    var policy=await loadFile('src/js/core/075-test-run-policy.js');
    return {policy:policy,artifacts:{'app.js':policy+'\n// app','sw-bundle.js':policy+'\n// worker','background.js':'// background','offscreen.html':'<script src="test-run-policy.js"></script><script src="offscreen-helper.js"></script>','offscreen-helper.js':'// helper','sandbox.html':'<html></html>','test-run-policy.js':policy}};
}
describe('browser-build assembled policy artifact guard',function(){
    test('accepts canonical bytes and ordered classic script dependencies',async function(){var m=await buildGuardModule(),f=await policyArtifactsFixture();assert.deepStrictEqual(m.checkTestPolicyArtifacts(f.artifacts,f.policy),[]);});
    test('rejects policy bundle prefixes, duplicates, redeclarations and concatenation without newline',async function(){var m=await buildGuardModule();for(var variant of ['prefix','duplicate','redeclare','boundary']){var f=await policyArtifactsFixture();if(variant==='prefix')f.artifacts['app.js']='/* prefix */'+f.policy;if(variant==='duplicate')f.artifacts['app.js']=f.policy+'\n'+f.policy;if(variant==='redeclare')f.artifacts['app.js']=f.policy+'\nlet TestRunPolicy = {};';if(variant==='boundary')f.artifacts['app.js']=f.policy+'/* tail */';var failures=m.checkTestPolicyArtifacts(f.artifacts,f.policy);assert.ok(failures.some(function(x){return /^app.js: expected exactly one canonical/.test(x);}),variant);}});
    test('rejects missing artifacts, noncanonical host copy and bad canonical declaration',async function(){var m=await buildGuardModule(),f=await policyArtifactsFixture();delete f.artifacts['background.js'];f.artifacts['test-run-policy.js']='altered';var failures=m.checkTestPolicyArtifacts(f.artifacts,f.policy);assert.ok(failures.some(function(x){return /background.js: required/.test(x);}));assert.ok(failures.some(function(x){return /test-run-policy.js: differs/.test(x);}));assert.ok(m.checkTestPolicyArtifacts(f.artifacts,'/* prefix */'+f.policy).some(function(x){return /canonical policy declaration missing/.test(x);}));});
    test('dependency script attributes fail closed for async, module, duplicate and legacy language selection',async function(){var m=await buildGuardModule();for(var attrs of ['async','defer','nomodule','type="module"','language="JavaScript"','src="test-run-policy.js"','type="application/json"']){var f=await policyArtifactsFixture();f.artifacts['offscreen.html']='<script src="test-run-policy.js" '+attrs+'></script><script src="offscreen-helper.js"></script>';assert.ok(m.checkTestPolicyArtifacts(f.artifacts,f.policy).some(function(x){return /^offscreen.html: load/.test(x);}),attrs);}});
    test('comments and raw script bodies cannot spoof dependency loading, and wrong order fails',async function(){var m=await buildGuardModule();for(var html of ['<!-- <script src="test-run-policy.js"></script> --><script src="offscreen-helper.js"></script>','<script>var fake = \'<script src="test-run-policy.js">\';</script><script src="offscreen-helper.js"></script>','<script src="offscreen-helper.js"></script><script src="test-run-policy.js"></script>','<script src="test-run-policy.js"><script src="offscreen-helper.js">']){var f=await policyArtifactsFixture();f.artifacts['offscreen.html']=html;assert.ok(m.checkTestPolicyArtifacts(f.artifacts,f.policy).some(function(x){return /^offscreen.html: load/.test(x);}));}});
    test('quoted attribute text is not confused with execution flags and classic MIME is accepted',async function(){var m=await buildGuardModule(),f=await policyArtifactsFixture();f.artifacts['offscreen.html']='<SCRIPT data-note="type=module async" SRC="test-run-policy.js" type="text/javascript"></SCRIPT ><script src="offscreen-helper.js" type="application/javascript"></script>';assert.deepStrictEqual(m.checkTestPolicyArtifacts(f.artifacts,f.policy),[]);});
});
