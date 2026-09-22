// Run: run_tests { pattern: 'chatgpt-login-ui' } (js_eval sandbox; no Node). Simulated UI callbacks; no DOM/account.
'use strict';
async function runChatGPTLoginUITests(source) {
    var checks=[];
    function check(name,ok){if(!ok)throw new Error('FAIL: '+name);checks.push(name);}
    function region(start,end){var a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Missing UI fixture region');return source.slice(a,b);}
    var sent=[],shown=[],snacks=[],input={value:''},feedback={textContent:''},button={disabled:false};
    var chrome={runtime:{lastError:null,sendMessage:function(message,callback){sent.push({message:JSON.parse(JSON.stringify(message)),callback:callback});}}};
    var document={activeElement:{},getElementById:function(id){return {'chatgpt-browser-callback':input,'chatgpt-browser-feedback':feedback,'chatgpt-browser-submit':button}[id];},contains:function(node){return node===feedback;}};
    var api=new Function('chrome','document','shown','snacks', 'var _chatGPTLoginGeneration=0, _chatGPTDeviceReturnFocus=null,currentProvider="fixture";function getProviderById(){return {isChatGPTOAuth:true};}function setLLMConnectionStatus(){}function closeChatGPTDeviceCodeModal(){}function closeChatGPTBrowserModal(){shown.push("closed");}function updateChatGPTOAuthStatus(){}function showSnackbar(text){snacks.push(text);}function showChatGPTBrowserModal(info){shown.push({browser:info});}function showChatGPTDeviceCodeModal(info){shown.push({device:info});}\n' + region('function startChatGPTOAuthLogin(', '// Browser dialog reuses') + region('function submitChatGPTBrowserCallback(', 'function showChatGPTBrowserModal(') + '\nreturn {start:startChatGPTOAuthLogin,paste:submitChatGPTBrowserCallback,cancel:function(){_chatGPTLoginGeneration++;}};')(chrome,document,shown,snacks);
    api.start();check('Connect defaults to browser',sent[0].message.method==='browser');
    sent[0].callback({method:'browser',pending:true,expiresAt:Date.now()+900000});
    check('Browser pending opens browser dialog',shown[0].browser.method==='browser');
    api.start(null,'device');check('Device option sends explicit method',sent[1].message.method==='device');
    sent[1].callback({userCode:'DEVICE',verificationUrl:'https://auth.openai.com/codex/device',expiresAt:123,tabOpened:true});
    check('Existing device modal gets code, expiry and tab result',shown[2].device.userCode==='DEVICE' && shown[2].device.expiresAt===123 && shown[2].device.tabOpened);
    api.start();var before=shown.length;api.cancel();sent[2].callback({method:'browser',pending:true});
    check('Cancelled start does not reopen dialog',shown.length===before);
    api.start();sent[3].callback({error:'SECRET callback/token error'});
    check('Failure offers explicit fallback with redacted notice',shown[shown.length-1].browser && !JSON.stringify(snacks).includes('SECRET'));
    input.value='http://localhost:1455/auth/callback?state=fixture&code=fixture';api.paste();
    check('Paste sent only through dedicated runtime message',sent[4].message.type==='openai-oauth-browser-callback' && sent[4].message.url.includes('code=fixture'));
    check('Pasted callback cleared immediately and submission locked',input.value==='' && button.disabled);
    sent[4].callback({error:'SECRET'});
    check('Callback error is generic and unlocks submission',!button.disabled && feedback.textContent.includes('not accepted') && !feedback.textContent.includes('SECRET'));
    check('Callback field is password/autocomplete-off',source.includes('type="password" autocomplete="off" spellcheck="false"'));
    check('Browser dialog includes keyboard and explicit fallback controls',source.includes("event.key === 'Escape'") && source.includes("'#chatgpt-browser-device').addEventListener('click', useChatGPTDeviceLogin)"));
    return checks;
}
// ─── harness registration (js_eval sandbox; see test/harness.js) ─────────────
var PATHS = ["src/js/ui/160-notifications.js"];
await registerRunner('chatgpt-login-ui', async function() { return runChatGPTLoginUITests(await loadFile(PATHS[0])); });
