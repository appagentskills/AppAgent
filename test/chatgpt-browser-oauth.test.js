// Run: run_tests { pattern: 'chatgpt-browser-oauth' } (js_eval sandbox; no Node). No real login, cookies or network.
'use strict';
async function runBrowserOAuthTests(source, cryptoImpl) {
    var checks = [];
    function check(name, ok) { if (!ok) throw new Error('FAIL: ' + name); checks.push(name); }
    function region(start, end) { var a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Missing fixture region');return source.slice(a,b); }
    var code = region('var OPENAI_OAUTH =', 'function _openaiTextOf(');
    var pkce = region('function base64url(', 'function getClaudeCookie(');
    var local={},session={},tabs=new Map(),nextTab=1,handlers={},broadcasts=[],requests=[];
    var fetchGate=null, storageGate=null, credentialGate=null, consumeGate=null;
    var tokenReply={access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600};
    function gate() { var release,entered;var promise=new Promise(function(r){release=r;});var reached=new Promise(function(r){entered=r;});return {promise:promise,reached:reached,release:release,entered:entered}; }
    function holdCredentials() { credentialGate=gate();return credentialGate; }
    function clone(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }
    function area(data, name) {
        return {
            get: function(keys, callback) { var result={};(Array.isArray(keys)?keys:[keys]).forEach(function(k){if(k in data) result[k]=clone(data[k]);});if(callback)callback(result);return Promise.resolve(result); },
            set: async function(values) {
                if(name==='session' && storageGate) await storageGate;
                if(name==='local' && values.openaiOAuth && credentialGate) { var held=credentialGate;credentialGate=null;held.entered();await held.promise; }
                Object.assign(data,clone(values));
            },
            remove: async function(keys) {
                (Array.isArray(keys)?keys:[keys]).forEach(function(k){delete data[k];});
                if(name==='session' && consumeGate) { var held=consumeGate;consumeGate=null;held.entered();await held.promise; }
            }
        };
    }
    function event(name) { return {addListener:function(fn){(handlers[name]||(handlers[name]=[])).push(fn);}}; }
    var chrome={
        storage:{local:area(local,'local'),session:area(session,'session')},
        runtime:{id:'fixture-extension',getURL:function(p){return 'chrome-extension://fixture-extension/'+p;},onMessage:event('message'),sendMessage:async function(message){broadcasts.push(clone(message));},getPlatformInfo:function(){}},
        tabs:{onUpdated:event('updated'),onRemoved:event('removed'),
            create:async function(options){var tab={id:nextTab++,url:options.url};tabs.set(tab.id,tab);return clone(tab);},
            update:async function(id,options){if(!tabs.has(id))throw new Error('Missing tab');Object.assign(tabs.get(id),options);return clone(tabs.get(id));},
            get:async function(id){if(!tabs.has(id))throw new Error('Missing tab');return clone(tabs.get(id));},
            remove:async function(id){tabs.delete(id);(handlers.removed||[]).forEach(function(fn){fn(id);});},
            query:async function(){return [];}
        }
    };
    async function fetchStub(url, options) {
        requests.push({url:url,body:options.body,signal:options.signal});
        if(fetchGate) await fetchGate;
        return {ok:true,status:200,json:async function(){return clone(tokenReply);},text:async function(){return JSON.stringify(tokenReply);}};
    }
    function boot() {
        handlers.message=[];handlers.updated=[];handlers.removed=[];
        return new Function('chrome','fetch','crypto','self', pkce + code + '\nreturn {start:_openaiStartBrowserLogin,cancel:_openaiCancelPendingLogin,capture:_openaiHandleBrowserCallback,validate:_openaiBrowserCallback,status:_openaiBrowserStatus,flush:function(){return openaiOAuthStorageQueue;},generation:function(){return openaiAuthGeneration;},stubDevice:function(){startChatGPTOAuth=async function(){return {pending:true,userCode:"DEVICE-FIXTURE",verificationUrl:OPENAI_OAUTH.verifyUrl,tabOpened:true};};},deviceStart:_startChatGPTOAuth,save:saveChatGPTOAuthCreds,renew:renewChatGPTToken,exchangeDevice:exchangeChatGPTDeviceCode,stubDeviceNetwork:function(){requestChatGPTDeviceCode=async function(){return {deviceAuthId:"device-fixture",userCode:"DEVICE-FIXTURE",expiresAt:Date.now()+900000};};pollChatGPTDeviceAuthUntilDone=function(){};}};')(chrome,fetchStub,cryptoImpl,{});
    }
    var api=boot();
    var sender={id:chrome.runtime.id,url:chrome.runtime.getURL('app.html')};
    function message(payload, from) { return new Promise(function(resolve,reject){var replied=false;var accepted=handlers.message.some(function(fn){return fn(payload,from||sender,function(value){replied=true;resolve(value);})===true;});if(!accepted&&!replied)reject(new Error('Message not handled'));}); }
    function pending(){return session.openaiPendingBrowserAuth;}
    function callback(p, extra){return 'http://localhost:1455/auth/callback?state='+encodeURIComponent(p.state)+'&'+(extra||'code=fixture-code');}
    var started=await message({type:'openai-oauth-login'}), p=clone(pending());
    check('Browser is default and public response contains no secrets', started.method==='browser' && !JSON.stringify(started).includes(p.state) && !JSON.stringify(started).includes(p.verifier));
    var authorize=new URL(tabs.get(p.tabId).url);
    check('Exact Codex browser authorize contract', authorize.origin==='https://auth.openai.com' && authorize.pathname==='/oauth/authorize' && authorize.searchParams.get('redirect_uri')==='http://localhost:1455/auth/callback' && authorize.searchParams.get('code_challenge_method')==='S256' && authorize.searchParams.get('client_id')==='app_EMoamEEZ73f0CkXaXp7hrann');
    check('Cryptographic state and verifier', p.state.length===43 && p.verifier.length===43 && p.state!==p.verifier);
    var hash=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(p.verifier));
    var challenge=btoa(String.fromCharCode.apply(null,new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    check('PKCE S256 challenge matches verifier', authorize.searchParams.get('code_challenge')===challenge);
    var reused=await message({type:'openai-oauth-login'});
    check('Browser click reuses owned tab', reused.method==='browser' && tabs.size===1 && pending().state===p.state);
    var invalid=[callback(p).replace('localhost','127.0.0.1'),callback(p).replace(':1455',':1456'),callback(p).replace('/auth/callback','/auth/callback/'),callback(p).replace('http:','https:'),callback(p).replace(p.state,'wrong-state'),callback(p)+'&state='+p.state,callback(p)+'&code=duplicate',callback(p)+'#fragment','http://user@localhost:1455/auth/callback?state='+p.state+'&code=fixture'];
    invalid.forEach(function(url,i){check('Reject invalid callback '+i,api.validate(url,p,p.tabId)===null);});
    check('Reject callback from other tab', !(await api.capture(p.tabId+1,callback(p))) && requests.length===0);
    check('Reject expired state', api.validate(callback(p),Object.assign({},p,{expiresAt:Date.now()-1}),p.tabId)===null);
    var untrusted=await message({type:'openai-oauth-browser-callback',url:callback(p)},{id:chrome.runtime.id,url:'https://attacker.invalid',tab:{id:p.tabId}});
    check('Web content cannot paste callbacks', !!untrusted.error && requests.length===0);
    api=boot(); // worker eviction: no memory survives; session storage and owned tab do
    check('Pending survives worker restart', (await api.status()).method==='browser');
    var won=await Promise.all([api.capture(p.tabId,callback(p)),api.capture(p.tabId,callback(p))]);
    check('Callback state is consumed once', won.filter(Boolean).length===1 && requests.length===1 && !pending());
    var form=new URLSearchParams(requests[0].body);
    check('Exact token exchange redirect and verifier', form.get('grant_type')==='authorization_code' && form.get('redirect_uri')==='http://localhost:1455/auth/callback' && form.get('code_verifier')===p.verifier && !form.has('client_secret'));
    check('Success stores credentials and closes only owned tab', local.openaiOAuth.accessToken==='fixture-access' && !tabs.has(p.tabId));
    check('Callback URL/state/verifier never broadcast', !JSON.stringify(broadcasts).includes('fixture-code') && !JSON.stringify(broadcasts).includes(p.verifier) && !JSON.stringify(broadcasts).includes(p.state));
    delete local.openaiOAuth;
    await message({type:'openai-oauth-login'});p=clone(pending());
    var requestCount=requests.length;
    check('OAuth denial does not exchange or retry', !(await api.capture(p.tabId,callback(p,'error=access_denied&error_description=SECRET'))) && requests.length===requestCount && !pending());
    check('Denial message is secret-redacted', broadcasts.some(function(m){return /declined/.test(m.error||'');}) && !JSON.stringify(broadcasts).includes('SECRET'));
    await message({type:'openai-oauth-login'});p=clone(pending());
    var release;fetchGate=new Promise(function(r){release=r;});
    var exchanging=api.capture(p.tabId,callback(p));
    for(var i=0;i<20 && requests.length===requestCount;i++)await Promise.resolve();
    check('Race fixture reached token fetch',requests.length===requestCount+1);
    await message({type:'openai-oauth-cancel'});release();await exchanging;fetchGate=null;
    check('Cancel during exchange cannot resurrect credentials', !local.openaiOAuth && !pending() && requests[requests.length-1].signal.aborted);
    await message({type:'openai-oauth-login'});p=clone(pending());await chrome.tabs.remove(p.tabId);await api.flush();
    check('Closing owned tab removes pending state',!pending());
    await message({type:'openai-oauth-login'});p=clone(pending());session.openaiPendingBrowserAuth.expiresAt=Date.now()-1;
    check('Expiry cleans pending and tab',await api.status()===null && !pending() && !tabs.has(p.tabId));
    await message({type:'openai-oauth-login'});p=clone(pending());
    api.stubDevice();var device=await message({type:'openai-oauth-login',method:'device'});
    check('Explicit device switch remains accessible', device.userCode==='DEVICE-FIXTURE' && device.tabOpened && !pending() && !tabs.has(p.tabId));
    api=boot();api.stubDeviceNetwork();
    var freshDevice=await api.deviceStart();var reusedDevice=await api.deviceStart();
    check('Original device start and reuse still open approval page',freshDevice.userCode==='DEVICE-FIXTURE' && freshDevice.tabOpened && reusedDevice.reused && reusedDevice.tabOpened);
    await message({type:'openai-oauth-login'});p=clone(pending());
    check('Switching device to browser removes stale device auth',!local.openaiPendingDeviceAuth && !!p);
    await message({type:'openai-oauth-logout'});
    check('Logout clears pending and suppresses auto-login',!pending() && !local.openaiPendingDeviceAuth && !local.openaiOAuth && local.openaiOAuthSuppressAutoLogin===true);
    var sessionWritesBefore=nextTab, releaseStorage;storageGate=new Promise(function(r){releaseStorage=r;});
    var slowStart=message({type:'openai-oauth-login'});
    for(i=0;i<30 && nextTab===sessionWritesBefore;i++)await Promise.resolve();
    var cancelled=message({type:'openai-oauth-cancel'});releaseStorage();storageGate=null;await Promise.all([slowStart,cancelled]);await api.flush();
    check('Cancel during persisted start cannot leave auth tab/state',!pending() && Array.from(tabs.values()).every(function(t){return !t.url.includes('/oauth/authorize') && t.url!=='about:blank';}));
    // Switch methods while the browser start is blocked on session persistence.
    api.stubDevice();
    sessionWritesBefore=nextTab;storageGate=new Promise(function(r){releaseStorage=r;});
    slowStart=message({type:'openai-oauth-login'});
    for(i=0;i<40 && nextTab===sessionWritesBefore;i++)await Promise.resolve();
    var switched=message({type:'openai-oauth-login',method:'device'});
    releaseStorage();storageGate=null;var switchResults=await Promise.all([slowStart,switched]);await api.flush();
    check('Device switch wins over stale browser start',switchResults[1].userCode==='DEVICE-FIXTURE' && !!switchResults[0].error && !pending());
    await message({type:'openai-oauth-login'});p=clone(pending());
    var trustedPaste=await message({type:'openai-oauth-browser-callback',url:callback(p)});
    check('Local extension paste exchanges owned callback',trustedPaste.success && !!local.openaiOAuth && !pending());
    delete local.openaiOAuth;
    await message({type:'openai-oauth-login'});p=clone(pending());requestCount=requests.length;
    fetchGate=new Promise(function(r){release=r;});exchanging=api.capture(p.tabId,callback(p));var closeBroadcasts=broadcasts.length;
    for(i=0;i<30 && requests.length===requestCount;i++)await Promise.resolve();
    await chrome.tabs.remove(p.tabId);release();var closedExchange=await exchanging;fetchGate=null;await api.flush();
    // USA-1: once the callback is captured, closing the auth tab no longer cancels the ~1s token exchange.
    check('Tab close during exchange lets the exchange finish',closedExchange===true && !!local.openaiOAuth && !requests[requests.length-1].signal.aborted && !pending());
    check('Tab close during exchange does not broadcast a closed-window error',!broadcasts.slice(closeBroadcasts).some(function(m){return /window was closed/.test(m.error||'');}));
    delete local.openaiOAuth;
    // Exchange ownership survives consumption of the pending record/start promise.
    await message({type:'openai-oauth-login'});p=clone(pending());requestCount=requests.length;
    fetchGate=new Promise(function(r){release=r;});exchanging=api.capture(p.tabId,callback(p));
    for(i=0;i<80 && requests.length===requestCount;i++)await Promise.resolve();
    check('Method-switch fixture is in token fetch with no pending state',requests.length===requestCount+1 && !pending());
    var generation=api.generation();
    device=await message({type:'openai-oauth-login',method:'device'});
    check('Device switch invalidates and aborts consumed browser exchange',device.userCode==='DEVICE-FIXTURE' && api.generation()>generation && requests[requests.length-1].signal.aborted);
    release();fetchGate=null;
    check('Switched browser exchange cannot return success or persist credentials',!(await exchanging) && !local.openaiOAuth);
    // Also cover the smaller gap while session.remove has consumed state but has
    // not resolved. Ownership must exist before this await, not only at fetch.
    await message({type:'openai-oauth-login'});p=clone(pending());
    var consumed=gate();consumeGate=consumed;requestCount=requests.length;
    exchanging=api.capture(p.tabId,callback(p)).catch(function(e){return e.name==='AbortError'?false:Promise.reject(e);});
    await consumed.reached;generation=api.generation();
    switched=message({type:'openai-oauth-login',method:'device'});
    check('Method switch invalidates synchronously during state consumption',!pending() && api.generation()>generation);
    consumed.release();await switched;
    check('Consumed stale claim never reaches token endpoint',!(await exchanging) && requests.length===requestCount && !tabs.has(p.tabId));
    // Cancellation cannot abort chrome.storage.local.set once issued. Exercise
    // absent AND pre-existing credentials at each cancellation entry point.
    var prior={accessToken:'prior-access',refreshToken:'prior-refresh',accountId:'prior-account',expiresAt:Date.now()+900000};
    for(var cause of ['cancel','switch']) {
        for(var hadPrior of [false,true]) {
            if(hadPrior)local.openaiOAuth=clone(prior);else delete local.openaiOAuth;
            await message({type:'openai-oauth-login'});p=clone(pending());
            var held=holdCredentials(),broadcastCount=broadcasts.length;
            exchanging=api.capture(p.tabId,callback(p));await held.reached;
            generation=api.generation();
            var cancellation=cause==='close'?chrome.tabs.remove(p.tabId):message({type:cause==='cancel'?'openai-oauth-cancel':'openai-oauth-login',method:'device'});
            check(cause+' during credential write invalidates immediately ('+hadPrior+')',api.generation()>generation && requests[requests.length-1].signal.aborted);
            held.release();await cancellation;
            check(cause+' during credential write rejects callback ('+hadPrior+')',!(await exchanging));await api.flush();
            check(cause+' rolls back only its credential commit ('+hadPrior+')',JSON.stringify(local.openaiOAuth)===JSON.stringify(hadPrior?prior:undefined));
            check(cause+' does not broadcast stale credentials ('+hadPrior+')',!broadcasts.slice(broadcastCount).some(function(m){return !!m.openaiOAuth;}));
        }
    }
    // Newer writers and logout enter the SAME lane behind the rollback. Neither
    // stale restoration nor stale removal may clobber their final credentials.
    for(var successor of ['login','refresh','logout']) {
        local.openaiOAuth=clone(prior);
        await message({type:'openai-oauth-login'});p=clone(pending());
        held=holdCredentials();exchanging=api.capture(p.tabId,callback(p));await held.reached;
        cancellation=message({type:'openai-oauth-cancel'});
        tokenReply.access_token='newer-'+successor;
        var next=successor==='logout'?message({type:'openai-oauth-logout'}):successor==='refresh'?api.renew(prior):api.save(tokenReply,null,api.generation());
        held.release();await cancellation;await next;
        check('Stale callback loses before newer '+successor,!(await exchanging));await api.flush();
        check('Rollback preserves newer '+successor,successor==='logout'?!local.openaiOAuth:local.openaiOAuth.accessToken==='newer-'+successor);
    }
    tokenReply.access_token='fixture-access';
    // The shared save helper also protects device exchanges and token refreshes.
    for(var producer of ['device','refresh']) {
        local.openaiOAuth=clone(prior);held=holdCredentials();
        var saving=(producer==='device'?api.exchangeDevice('device-code','device-verifier',api.generation()):api.renew(prior)).then(function(){return false;},function(e){return e.name==='AbortError';});
        await held.reached;cancellation=message({type:'openai-oauth-cancel'});held.release();await cancellation;
        check(producer+' credential write cancellation rejects and restores prior',await saving && JSON.stringify(local.openaiOAuth)===JSON.stringify(prior));
    }
    api=boot();api.stubDeviceNetwork();
    freshDevice=await message({type:'openai-oauth-login',method:'device'});generation=api.generation();
    reusedDevice=await message({type:'openai-oauth-login',method:'device'});
    check('Same-method device clicks preserve code and generation',freshDevice.userCode===reusedDevice.userCode && reusedDevice.reused && api.generation()===generation);
    await message({type:'openai-oauth-cancel'});
    // No new permission/API assumptions and no direct token/cookie shortcut.
    check('No forbidden browser interception APIs',!code.includes('chrome.webNavigation') && !code.includes('launchWebAuthFlow') && !code.includes('chrome.scripting'));
    return checks;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/platform/extension/background.js"];
await registerRunner('chatgpt-browser-oauth', async function() { return runBrowserOAuthTests(await loadFile(PATHS[0]), crypto /* sandbox WebCrypto: crypto.subtle + getRandomValues */); });
