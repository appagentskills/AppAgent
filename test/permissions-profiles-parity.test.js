// Page and worker twins evaluated separately with the same real policy/profile/tool modules.
describe('permissions and profiles parity', function() {
    async function fixture(worker, overrides) {
        var g = Object.assign({document:{addEventListener:function(){}}, window:{}, self:{},
            Platform:{instanceUrl:'https://example.test/'}, toolPermissions:{}, instancePermissions:{},
            sessionPermissions:{}, chats:{root:{},child:{parentChatId:'root'},other:{}},
            hooksEnabled:{autoTitle:true,autoTldr:true,autoLinks:true,autoCaveat:true},
            activeSkills:{}, skills:{}, TOOL_DISPLAY_NAMES:{}, console:console
        }, overrides || {});
        var m = await loadModules(['src/js/core/070-permissions.js','src/js/core/078-tool-profiles.js',
            'src/js/core/080-tools.js','src/js/core/140-skills-engine.js',
            worker ? 'src/js/worker/025-permissions-helpers.js' : 'src/js/ui/140-dropdowns.js'], {globals:g});
        return {m:m,g:g};
    }
    test('both twins agree on every declared key and explicit override', async function() {
        var a = await fixture(false), b = await fixture(true);
        var keys = a.m.INSTANCE_PERMISSION_KEYS.concat(a.m.GLOBAL_PERMISSION_KEYS);
        keys.forEach(function(key) {
            assert.strictEqual(a.m.getToolPermission(key), b.m.getToolPermission(key), key);
            a.g.toolPermissions[key] = b.g.toolPermissions[key] = 'disabled';
            a.g.instancePermissions['example.test'] = b.g.instancePermissions['example.test'] = {tier:'manual',tools:{[key]:'disabled'}};
            assert.strictEqual(a.m.getToolPermission(key), 'disabled', key);
            assert.strictEqual(b.m.getToolPermission(key), 'disabled', key);
        });
    });
    test('root grants cover descendants but never unrelated chats', async function() {
        for (var worker of [false,true]) {
            var f = await fixture(worker, {sessionPermissions:{'root::sn:update':'allow','root::workspace:write':'allow'},toolPermissions:{'workspace:write':'disabled'},Platform:{}});
            assert.strictEqual(f.m.getToolPermission('servicenow_api','PATCH','child'), 'allow');
            assert.strictEqual(f.m.getToolPermission('servicenow_api','PATCH','other'), 'ask');
            // SEC-2: an explicit 'disabled' setting wins over a chat grant in both twins.
            assert.strictEqual(f.m.getToolPermission('workspace','write','child'), 'disabled');
            assert.strictEqual(f.m.getToolPermission('workspace','write','other'), 'disabled');
            f.g.toolPermissions['workspace:write'] = 'ask';
            assert.strictEqual(f.m.getToolPermission('workspace','write','child'), 'allow', 'grant still beats ask');
            f.g.Platform.instanceUrl = 'https://example.test/';
            f.g.instancePermissions['example.test'] = {tier:'manual',tools:{'sn:update':'disabled'}};
            assert.strictEqual(f.m.getToolPermission('servicenow_api','PATCH','child'), 'disabled', 'instance disabled beats grant');
            f.g.instancePermissions['example.test'].tier = 'auto';
            assert.strictEqual(f.m.getToolPermission('servicenow_api','PATCH','child'), 'allow', 'auto tier ignores per-tool disabled; grant applies');
            assert.strictEqual(f.m.hasChatPermissionGrant('sn:update',null), false);
        }
    });
    test('manual overrides, auto tier, disconnected defaults and carveouts match', async function() {
        for (var worker of [false,true]) {
            var f = await fixture(worker, {instancePermissions:{'example.test':{tier:'manual',tools:{'sn:delete':'disabled'}}}});
            assert.strictEqual(f.m.getToolPermission('servicenow_api','DELETE'),'disabled');
            f.g.instancePermissions['example.test'].tier = 'auto';
            assert.strictEqual(f.m.getToolPermission('servicenow_api','DELETE'),'auto');
            f.g.Platform.instanceUrl = '';
            assert.strictEqual(f.m.getToolPermission('servicenow_api','GET'),'allow');
            assert.strictEqual(f.m.getToolPermission('servicenow_api','POST'),'ask');
            assert.strictEqual(f.m.getToolPermission('workspace','push'),'allow');
            assert.strictEqual(f.m.getToolPermission('get_cookie'),'allow');
            f.g.toolPermissions.get_cookie='ask';
            assert.strictEqual(f.m.getToolPermission('get_cookie'),'ask');
        }
    });
    test('dev tier allows every instance key in both twins (no prompt, per-tool + disabled ignored)', async function() {
        for (var worker of [false,true]) {
            var f = await fixture(worker, {instancePermissions:{'example.test':{tier:'dev',tools:{'sn:delete':'disabled','sn:update':'ask','browser:click':'ask'}}}});
            f.m.INSTANCE_PERMISSION_KEYS.forEach(function(key) {
                assert.strictEqual(f.m.getToolPermission(key), 'allow', (worker?'worker ':'page ') + key);
            });
            assert.strictEqual(f.m.getToolPermission('servicenow_api','DELETE'), 'allow', 'dev ignores per-tool disabled');
            assert.strictEqual(f.m.getToolPermission('servicenow_api','PATCH','other'), 'allow', 'dev ignores per-tool ask, no grant needed');
            assert.strictEqual(f.m.getToolPermission('iframe_tool','click'), 'allow');
            assert.strictEqual(f.m.getToolPermission('servicenow_run_script'), 'allow');
            // Global (non-instance) keys are untouched by the instance tier.
            f.g.toolPermissions['workspace:write'] = 'ask';
            assert.strictEqual(f.m.getToolPermission('workspace','write'), 'ask', 'dev tier does not leak into global keys');
            // Dev on a DIFFERENT host than the connected one has no effect.
            // (mutate in place — the loaded modules hold the original object binding)
            delete f.g.instancePermissions['example.test'];
            f.g.instancePermissions['other.test'] = {tier:'dev',tools:{}};
            assert.strictEqual(f.m.getToolPermission('servicenow_api','DELETE'), 'ask', 'dev on another host is ignored');
            // No connected instance: dev cannot apply (host-keyed).
            f.g.instancePermissions['example.test'] = {tier:'dev',tools:{}};
            f.g.Platform.instanceUrl = '';
            assert.strictEqual(f.m.getToolPermission('servicenow_api','POST'), 'ask', 'disconnected stays ask');
        }
    });
    test('profile union is core-first, stable, deduplicated, and ignores unknown names', async function() {
        var f = await fixture(true), m=f.m;
        assert.deepStrictEqual(m.getToolNamesForProfiles(null),m.TOOL_PROFILES.core.tools);
        var list=m.getToolNamesForProfiles(['code','code','missing','research']);
        assert.deepStrictEqual(list.slice(0,m.TOOL_PROFILES.core.tools.length),m.TOOL_PROFILES.core.tools);
        assert.strictEqual(new Set(list).size,list.length);
        assert.strictEqual(list.filter(function(n){return n==='web_fetch';}).length,1);
        assert.strictEqual(list.indexOf('spawn_sub_agent'),-1);
        assert.strictEqual(m.getProfiledToolNameSet().workspace,true);
    });
    test('real enabled tool lists match with profile exclusions and do not mutate core definitions', async function() {
        var a=await fixture(false),b=await fixture(true);
        var before=JSON.stringify(a.m.TOOLS);
        var at=a.m.getEnabledTools('root'),bt=b.m.getEnabledTools('root');
        assert.deepStrictEqual(at,bt);
        var names=at.map(function(t){return t.function.name;});
        assert.ok(names.indexOf('workspace')>=0);
        assert.strictEqual(names.indexOf('iframe_tool'),-1);
        assert.strictEqual(names.indexOf('report_to_parent'),-1);
        assert.strictEqual(names.indexOf('runtime_inspect'),-1);
        assert.deepStrictEqual(at[at.length-1].cache_control,{type:'ephemeral'});
        assert.strictEqual(JSON.stringify(a.m.TOOLS),before);
    });
    test('session hydration cannot overwrite an in-flight user grant', async function() {
        var release;
        var f=await fixture(true,{sessionPermissions:{'root::sn:delete':'allow'},_swPermsDirty:{},chrome:{storage:{session:{get:function(){return new Promise(function(r){release=r;});}}}}});
        var read=f.m.loadSessionPermissionsInWorker();
        f.g._swPermsDirty.sessionPermissions=true;
        release({appagent_chatPermissionGrants:{'other::sn:delete':'allow'}}); await read;
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:delete','root'),true);
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:delete','other'),false);
    });
    test('F6 boot race: an additive grant during hydration merges stored grants (memory wins) and re-persists the union', async function() {
        var release, persisted=[], posted=[];
        var f=await fixture(true,{sessionPermissions:{},_swPermsDirty:{},_swPanelPorts:[{postMessage:function(m){posted.push(m);}}],chrome:{storage:{session:{get:function(){return new Promise(function(r){release=r;});},set:async function(p){persisted.push(p);}}}}});
        var read=f.m.loadSessionPermissionsInWorker();
        // swGrantChatPermission (worker/120) lands on the empty boot map and
        // persists a 1-entry map while the read is still in flight.
        f.g.sessionPermissions['root::sn:delete']='allow';
        f.g._swPermsDirty.sessionPermissionsAdditive=true;
        release({appagent_chatPermissionGrants:{'other::sn:update':'allow','root::sn:delete':'deny'}}); await read;
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:delete','root'),true,'new grant survives (memory wins over stale stored value)');
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:update','other'),true,'earlier stored grant survives');
        assert.strictEqual(persisted.length,1,'union re-persisted once');
        assert.deepStrictEqual(persisted[0].appagent_chatPermissionGrants,{'root::sn:delete':'allow','other::sn:update':'allow'});
        assert.strictEqual(posted.length,1); assert.strictEqual(posted[0].type,'permissions-changed');
    });
    test('F6 boot race: a reset-all (full-map replace) during hydration does NOT resurrect stored grants', async function() {
        var release, persisted=[];
        var f=await fixture(true,{sessionPermissions:{},_swPermsDirty:{},chrome:{storage:{session:{get:function(){return new Promise(function(r){release=r;});},set:async function(p){persisted.push(p);}}}}});
        var read=f.m.loadSessionPermissionsInWorker();
        f.g.sessionPermissions={}; f.g._swPermsDirty.sessionPermissions=true;
        release({appagent_chatPermissionGrants:{'other::sn:update':'allow'}}); await read;
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:update','other'),false);
        assert.deepStrictEqual(f.g.sessionPermissions,{});
        assert.strictEqual(persisted.length,0,'nothing re-persisted on skip');
        // Grant-then-reset ordering: the replace flag wins even if the additive flag is also set.
        var f2=await fixture(true,{sessionPermissions:{},_swPermsDirty:{sessionPermissionsAdditive:true,sessionPermissions:true},chrome:{storage:{session:{get:async function(){return {appagent_chatPermissionGrants:{'other::sn:update':'allow'}};},set:async function(){}}}}});
        await f2.m.loadSessionPermissionsInWorker();
        assert.deepStrictEqual(f2.g.sessionPermissions,{});
    });
    test('SEC-1: a per-key deletion delta during hydration merges stored grants but never resurrects the deleted keys', async function() {
        var release, persisted=[];
        var f=await fixture(true,{sessionPermissions:{'root::sn:update':'allow'},_swPermsDirty:{sessionPermissionsDelta:true,sessionPermissionsDeleted:{'gone::sn:delete':true}},chrome:{storage:{session:{get:function(){return new Promise(function(r){release=r;});},set:async function(p){persisted.push(p);}}}}});
        var read=f.m.loadSessionPermissionsInWorker();
        release({appagent_chatPermissionGrants:{'gone::sn:delete':'allow','other::sn:update':'allow'}}); await read;
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:delete','gone'),false,'pruned key stays deleted');
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:update','other'),true,'other chat grant survives');
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:update','root'),true);
        assert.strictEqual(persisted.length,1);
    });
    test('F6: swGrantChatPermission raises the ADDITIVE dirty flag, not the full-map-replace one', async function() {
        var m = await loadModules(['src/js/core/070-permissions.js','src/js/worker/120-tool-routing.js'],
            { lenient: true, globals: { window: fakeWindow(), chrome: fakeChrome(), sessionPermissions:{}, _swPermsDirty:{}, chats:{root:{},child:{parentChatId:'root'}}, resolveRootChatId:function(id){return id==='child'?'root':id;}, persistSessionPermissionsInWorker:function(){}, parkedToolCallsByChatId:{} } });
        m.swGrantChatPermission('child','sn:delete');
        assert.strictEqual(m.__scope._swPermsDirty.sessionPermissionsAdditive,true);
        assert.strictEqual(m.__scope._swPermsDirty.sessionPermissions,undefined);
        assert.strictEqual(m.__scope.sessionPermissions['root::sn:delete'],'allow');
    });
    test('storage rejection leaves existing grants usable', async function() {
        var warnings=[];
        var f=await fixture(true,{sessionPermissions:{'root::sn:delete':'allow'},console:{warn:function(){warnings.push([].slice.call(arguments));}},chrome:{storage:{session:{get:async function(){throw new Error('offline');},set:async function(){throw new Error('offline');}}}}});
        await f.m.loadSessionPermissionsInWorker(); f.m.persistSessionPermissionsInWorker(); await Promise.resolve();
        assert.strictEqual(f.m.hasChatPermissionGrant('sn:delete','child'),true);
        assert.strictEqual(warnings.length,2);
    });
});
