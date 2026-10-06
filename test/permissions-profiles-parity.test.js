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
    test('instance tier follows the call TARGET (args.instance), not just the active instance', async function() {
        for (var worker of [false,true]) {
            var w = worker ? 'worker ' : 'page ';
            var plat = {instanceUrl:'https://active.test/', instances:[{shortName:'devb',url:'https://devb.test'},{shortName:'prodc',url:'https://prodc.test'}]};
            plat.resolveInstanceUrl = function(n) {
                if (!n) return plat.instanceUrl;
                if (n.startsWith('http')) return n.replace(/\/$/, '');
                if (n.indexOf('.') !== -1) return 'https://' + n.replace(/\/$/, '');
                for (var i = 0; i < plat.instances.length; i++) if (plat.instances[i].shortName === n) return plat.instances[i].url;
                return null;
            };
            var f = await fixture(worker, {Platform:plat, instancePermissions:{'active.test':{tier:'dev',tools:{}},'devb.test':{tier:'dev',tools:{}},'prodc.test':{tier:'manual',tools:{}}}});
            var gp = function(method, args) { return f.m.getToolPermission('servicenow_api', method, 'other', f.m.resolvePermissionTargetHost(args)); };
            // Dev active, no instance arg → allow (unchanged).
            assert.strictEqual(gp('DELETE', {}), 'allow', w+'dev active, no arg');
            assert.strictEqual(gp('DELETE', {instance:''}), 'allow', w+'empty instance = active');
            // Non-Dev target while Dev is active → must NOT allow.
            assert.strictEqual(gp('DELETE', {instance:'prodc'}), 'ask', w+'manual target under dev active');
            assert.strictEqual(gp('POST', {instance:'https://prodc.test/'}), 'ask', w+'full URL target');
            assert.strictEqual(gp('GET', {instance:'prodc'}), 'allow', w+'reads still allow');
            // Unknown short name → fail safe ask (never the active Dev).
            assert.strictEqual(gp('PATCH', {instance:'nosuch'}), 'ask', w+'unresolvable short name');
            assert.strictEqual(f.m.resolvePermissionTargetHost({instance:'nosuch'}), null);
            // Dev target while a non-Dev instance is active → allow, even with confirm:true args.
            f.g.instancePermissions['active.test'].tier = 'manual';
            assert.strictEqual(gp('DELETE', {}), 'ask', w+'manual active, no arg');
            assert.strictEqual(gp('DELETE', {instance:'devb', confirm:true}), 'allow', w+'dev target short name');
            assert.strictEqual(gp('DELETE', {instance:'DEVB.test'}), 'allow', w+'host is case-insensitive');
            assert.strictEqual(f.m.getToolPermission('iframe_tool','click','other', f.m.resolvePermissionTargetHost({instance:'devb'})), 'allow', w+'browser keys too');
            // Auto target under a manual active instance.
            f.g.instancePermissions['prodc.test'].tier = 'auto';
            assert.strictEqual(gp('DELETE', {instance:'prodc'}), 'auto', w+'auto target');
            // Global keys ignore the instance target.
            f.g.toolPermissions['workspace:write'] = 'ask';
            assert.strictEqual(f.m.getToolPermission('workspace','write','other', f.m.resolvePermissionTargetHost({instance:'devb'})), 'ask', w+'global keys untouched');
            // Legacy 3-arg callers keep using the connected host.
            f.g.instancePermissions['active.test'].tier = 'dev';
            assert.strictEqual(f.m.getToolPermission('servicenow_api','DELETE','other'), 'allow', w+'3-arg = connected');
        }
    });
test('getTargetedToolPermission: iframe_tool unions every host it may hit; strictest wins', async function() {
        for (var worker of [false,true]) {
            var w = worker ? 'worker ' : 'page ';
            var plat = {instanceUrl:'https://prod.service-now.com', instances:[{shortName:'dev1',url:'https://dev1.service-now.com'}]};
            plat.resolveInstanceUrl = function(n) { if (!n) return plat.instanceUrl; if (n.startsWith('http')) return n; if (n.indexOf('.')!==-1) return 'https://'+n; for (var i=0;i<plat.instances.length;i++) if (plat.instances[i].shortName===n) return plat.instances[i].url; return null; };
            var tabs = {7:{url:'https://prod.service-now.com/x'}, 8:{url:'https://dev1.service-now.com/y'},
                9:{url:'https://dev1.service-now.com/y', pendingUrl:'https://prod.service-now.com/z'},
                10:{url:'https://www.google.com/'}, 11:{url:'', pendingUrl:'https://dev1.service-now.com/p'}};
            var active = {id:7}, stored = {instanceUrl:'https://prod.service-now.com'};
            var doc = {addEventListener:function(){}, body:{classList:{contains:function(){ return false; }}}};
            var loc = {search:''};
            var chromeStub = {tabs:{get:async function(id){ if (!tabs[id]) throw new Error('no tab'); return tabs[id]; },
                    query:async function(q){ return active.id == null ? [] : [Object.assign({id:active.id}, tabs[active.id])]; }},
                    storage:{local:{get:async function(){ return stored; }}}};
            var f = await fixture(worker, {Platform:plat, chats:{root:{targetTabId:8},other:{}}, document:doc, location:loc, chrome:chromeStub,
                instancePermissions:{'dev1.service-now.com':{tier:'dev',tools:{}},'prod.service-now.com':{tier:'manual',tools:{}}}});
            var T = function(tool, m, args, chat) { return f.m.getTargetedToolPermission(tool, m, chat || 'other', args); };
            var H = function(args, chat) { return f.m.resolvePermissionTargetHosts('iframe_tool', args, chat || 'other'); };
            // Prod active: no iframe write is Dev-allowed, whatever tab/instance is named.
            assert.strictEqual((await T('iframe_tool','click',{action:'click',instance:'dev1',tab_id:7})).permission, 'ask', w+'fake instance on prod tab');
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:8})).permission, 'ask', w+'dev tab, prod active');
            assert.strictEqual((await T('iframe_tool','fill',{action:'fill'},'root')).permission, 'ask', w+'pinned dev tab, prod active');
            assert.strictEqual((await T('iframe_tool','navigate',{action:'navigate',url:'/x',instance:'dev1'})).permission, 'allow', w+'navigate is a read');
            // servicenow_api routes by instance (unchanged).
            var r = await T('servicenow_api','DELETE',{instance:'dev1',confirm:true});
            assert.strictEqual(r.permission, 'allow', w+'sn dev target'); assert.strictEqual(r.host, 'dev1.service-now.com');
            r = await T('servicenow_api','POST',{instance:{x:1}});
            assert.strictEqual(r.permission, 'ask', w+'non-string'); assert.strictEqual(r.host, null);
            // ── Dev active from here on ──
            plat.instanceUrl = 'https://dev1.service-now.com';
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:7})).permission, 'ask', w+'prod tab under dev active');
            // H1: unpinned action runs on the ACTIVE tab — prod active tab → ask.
            assert.strictEqual((await T('iframe_tool','click',{action:'click'})).permission, 'ask', w+'H1 no tab, dev active, prod active tab');
            active.id = 8;
            r = await T('iframe_tool','click',{action:'click'});
            assert.strictEqual(r.permission, 'allow', w+'H1 no tab, dev active tab'); assert.strictEqual(r.host, 'dev1.service-now.com');
            assert.strictEqual((await T('iframe_tool','click',{action:'click',instance:'prod.service-now.com'})).permission, 'ask', w+'instance only adds strictness');
            // M2: url OR pendingUrl on prod → ask; url empty but pendingUrl dev → allow.
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:9})).permission, 'ask', w+'M2 pendingUrl prod');
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:11})).permission, 'allow', w+'M2 pendingUrl only');
            // M1: unknown host / failed lookup → null (manual).
            r = await T('iframe_tool','click',{action:'click',tab_id:10});
            assert.strictEqual(r.permission, 'ask', w+'M1 unknown tab host'); assert.strictEqual(r.host, null, w+'M1 host null (L2)');
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:99})).permission, 'ask', w+'closed tab');
            assert.ok((await H({action:'navigate',url:'https://evil.example/x'})).indexOf(null) !== -1, w+'M1 absolute unknown → null');
            assert.ok((await H({action:'navigate',url:'https://dev1.service-now.com/x'})).indexOf('dev1.service-now.com') !== -1);
            // H2 sidepanel: tab_id is IGNORED (tool routes to pinned/active), relative
            // navigate uses the STORED instanceUrl, not args.instance.
            doc.body.classList.contains = function(c){ return c === 'sidepanel-mode'; };
            active.id = 7;
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:8})).permission, 'ask', w+'H2 sidepanel ignores dev tab_id; active tab prod');
            active.id = 8;
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:7})).permission, 'allow', w+'H2 sidepanel ignores prod tab_id');
            var hs = await H({action:'navigate',url:'/x',instance:'dev1'});
            assert.ok(hs.indexOf('prod.service-now.com') !== -1, w+'H2 sidepanel relative → stored base');
            stored.instanceUrl = null;
            assert.ok((await H({action:'navigate',url:'/x'})).indexOf(null) !== -1, w+'no stored base → null');
            stored.instanceUrl = 'https://prod.service-now.com';
            // H2 full-tab: tab_id wins over the pin and the active tab.
            doc.body.classList.contains = function(){ return false; }; loc.search = '?mode=tab';
            active.id = 7;
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:8},'root')).permission, 'allow', w+'full-tab tab_id dev');
            assert.ok((await H({action:'navigate',url:'/x',instance:'dev1'},'root')).indexOf('prod.service-now.com') === -1, w+'full-tab relative ignores stored base');
            // L1: the tool falls back to currentChatId — its pin counts too.
            f.m.__scope.currentChatId = 'pinprod'; f.g.chats.pinprod = {targetTabId:7}; active.id = 8;
            assert.strictEqual((await T('iframe_tool','click',{action:'click'},'root')).permission, 'ask', w+'L1 currentChatId pin on prod');
            f.m.__scope.currentChatId = undefined; delete f.g.chats.pinprod;
            loc.search = '';
            // Offscreen worker path: no chrome.tabs → SW message (background perm-target-info).
            delete chromeStub.tabs; delete chromeStub.storage;
            chromeStub.runtime = {sendMessage:function(msg, cb){ var t = msg.activeTab ? tabs[msg.tabId != null ? msg.tabId : active.id] : null; cb({ok:true, tab: t ? {url:t.url||null, pendingUrl:t.pendingUrl||null} : null, instanceUrl: stored.instanceUrl}); }};
            assert.strictEqual((await T('iframe_tool','click',{action:'click'})).permission, 'allow', w+'msg path dev active tab');
            assert.strictEqual((await T('iframe_tool','click',{action:'click',tab_id:7})).permission, 'ask', w+'msg path prod tab');
            chromeStub.runtime = {sendMessage:function(msg, cb){ cb(undefined); }};
            assert.strictEqual((await T('iframe_tool','click',{action:'click'})).permission, 'ask', w+'no tab info → manual');
        }
    });
    test('page gate: fake instance on iframe write prompts; host stamped; Always allow saves to target host', async function() {
        var prompts = [], saved = 0;
        var plat = {instanceUrl:'https://prod.service-now.com', instances:[{shortName:'dev1',url:'https://dev1.service-now.com'}]};
        plat.resolveInstanceUrl = function(n) { if (!n) return plat.instanceUrl; for (var i=0;i<plat.instances.length;i++) if (plat.instances[i].shortName===n) return plat.instances[i].url; return null; };
        var f = await fixture(false, {Platform:plat, activeStreamingChatId:null, currentChatId:'other',
            instancePermissions:{'dev1.service-now.com':{tier:'dev',tools:{}},'prod.service-now.com':{tier:'manual',tools:{}}},
            showToolApprovalPrompt:async function(d,a,k,id,t,c,o){ prompts.push(o.permissionHost); return true; },
            saveInstancePermissions:function(){ saved++; }, saveToolPermissions:function(){}, renderToolPermissions:function(){}});
        var gate = await loadModules(['src/js/ui/150-tool-approval.js','src/js/ui/130-data-management.js'], {lenient:true, globals:Object.assign(f.g, f.m,
            {saveInstancePermissions:function(){ saved++; }, saveToolPermissions:function(){}, renderToolPermissions:function(){}})});
        var res = await gate.requestProgrammaticToolApproval('iframe_tool', {action:'click', instance:'dev1'}, {chatId:'other'});
        assert.strictEqual(prompts.length, 1, 'fake dev instance on iframe write still prompts');
        assert.strictEqual(prompts[0], null, 'active tab unknown (no chrome) → null host, nothing to save');
        res = await gate.requestProgrammaticToolApproval('servicenow_api', {method:'DELETE', instance:'dev1', confirm:true}, {chatId:'other'});
        assert.strictEqual(res.allowed, true); assert.strictEqual(prompts.length, 1, 'dev target never prompts');
        f.g.instancePermissions['dev1.service-now.com'].tier = 'manual';
        await gate.requestProgrammaticToolApproval('servicenow_api', {method:'POST', instance:'dev1'}, {chatId:'other'});
        assert.strictEqual(prompts[1], 'dev1.service-now.com', 'row host = target');
        gate.setToolPermissionByKey('sn:create', 'allow', prompts[1]);
        assert.strictEqual(f.g.instancePermissions['dev1.service-now.com'].tools['sn:create'], 'allow');
        assert.strictEqual(f.g.instancePermissions['prod.service-now.com'].tools['sn:create'], undefined, 'not saved to active');
        gate.setToolPermissionByKey('sn:update', 'allow', null);
        assert.strictEqual(Object.keys(f.g.instancePermissions).length, 2, 'null host saves nothing');
        assert.strictEqual(saved, 1);
    });
    test('L2: Always allow on a null-host row allows once and saves nothing', async function() {
        var f = await fixture(false), saves = [], snacks = [];
        var row = {role:'approval', status:'pending', toolCallId:'tc1', permissionKey:'browser:click', permissionHost:null};
        var row2 = {role:'approval', status:'pending', toolCallId:'tc2', permissionKey:'browser:click', permissionHost:'dev1.service-now.com'};
        var g = Object.assign({}, f.g, f.m, {chats:{c1:{messages:[row,row2]}}, currentChatId:'c1', pendingToolApprovals:{},
            saveChatsToStorage:function(){}, showSnackbar:function(m){ snacks.push(m); },
            setToolPermissionByKey:function(k,v,h){ saves.push([k,v,h]); }, renderMessages:function(){}});
        var n = await loadModules(['src/js/ui/160-notifications.js'], {lenient:true, globals:g});
        try { await n.handleApproval(0, 'auto', true, 'c1'); } catch (e) { /* post-status UI plumbing not stubbed */ }
        assert.strictEqual(row.status, 'allowed', 'null host → allowed once, not always_allowed');
        assert.strictEqual(saves.length, 0, 'nothing saved');
        assert.strictEqual(snacks.length, 1, 'user told why');
        try { await n.handleApproval(1, 'auto', true, 'c1'); } catch (e) {}
        assert.strictEqual(row2.status, 'always_allowed');
        assert.deepStrictEqual(saves[0], ['browser:click','allow','dev1.service-now.com']);
    });
    test('worker gate (worker/120): iframe_tool on Dev auto-allows only when the active tab is Dev', async function() {
        var tabs = {7:{url:'https://prod.service-now.com/x'}, 8:{url:'https://dev1.service-now.com/y'}}, active = {id:8};
        var plat = {instanceUrl:'https://dev1.service-now.com', instances:[{shortName:'dev1',url:'https://dev1.service-now.com'}]};
        plat.resolveInstanceUrl = function(n){ return n === 'dev1' ? 'https://dev1.service-now.com' : null; };
        var f = await fixture(true, {Platform:plat, chats:{root:{},other:{}},
            instancePermissions:{'dev1.service-now.com':{tier:'dev',tools:{}},'prod.service-now.com':{tier:'manual',tools:{}}}});
        var chromeStub = fakeChrome();
        chromeStub.runtime = Object.assign({}, chromeStub.runtime || {}, {sendMessage:function(msg, cb){ var t = msg.activeTab ? tabs[msg.tabId != null ? msg.tabId : active.id] : null; if (cb) cb({ok:true, tab:t ? {url:t.url, pendingUrl:null} : null, instanceUrl:null}); }});
        var m = await loadModules(['src/js/core/070-permissions.js','src/js/worker/025-permissions-helpers.js','src/js/worker/120-tool-routing.js'],
            {lenient:true, globals:Object.assign({}, f.g, {window:fakeWindow(), chrome:chromeStub, requestProgrammaticToolApproval:null,
                activeStreamingChatId:null, _swPermsDirty:{}, parkedToolCallsByChatId:{}, getToolDisplayName:function(t){ return t; }})});
        var gate = m.__scope.requestProgrammaticToolApproval;
        assert.strictEqual(typeof gate, 'function', 'worker gate installed');
        var res = await gate('iframe_tool', {action:'click', confirm:true}, {chatId:'other'});
        assert.strictEqual(res.allowed, true, 'dev active + dev active tab → allowed even with confirm:true');
        active.id = 7;
        var settled = await Promise.race([gate('iframe_tool', {action:'click'}, {chatId:'other'}).then(function(r){ return r; }, function(){ return {allowed:false}; }),
            new Promise(function(r){ setTimeout(function(){ r('pending'); }, 50); })]);
        assert.ok(settled === 'pending' || settled.allowed !== true, 'prod active tab → not auto-allowed');
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
