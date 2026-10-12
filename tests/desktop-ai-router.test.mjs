import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAIRouter} from '../desktop/ai-router.js';
import {normalizeSettings} from '../extension/core/settings.js';

async function fixture(t,overrides={}){
  const directory=await mkdtemp(join(tmpdir(),'companion-router-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];
  const state={connected:true,sharing:true,models:[{id:'test-fast-mini',name:'Test Fast'}]};
  const speechState={cached:true,status:'ready'};
  const chatgpt={getState:async()=>({...state}),listModels:async()=>state.models,
    respond:async args=>{calls.push(args);return JSON.stringify({action:'reply',text:'这个话题好有意思',reason:'接话',scene:'chat',respondsToSelf:false,confidence:.9});},
    signIn:async()=>{},cancelSignIn:async()=>{},signOut:async()=>{state.connected=false;},selectAccount:async()=>{},close:async()=>{}};
  const speech={getState:()=>({...speechState}),prepare:async()=>{},transcribe:async(blob,options)=>{calls.push({blob,options});return '本地转写';},close:async()=>{}};
  const router=createAIRouter({directory,encryption:{},openExternal:async url=>calls.push(url),chatgpt,speech,...overrides});
  t.after(()=>router.close());
  return {router,directory,calls,state,speechState,chatgpt,speech};
}

test('account route starts without API keys but requires both plan permission and a prepared local model',async t=>{
  const f=await fixture(t);await f.router.ensureReady(normalizeSettings({}));
  assert.equal((await f.router.getState()).mode,'chatgpt-local');
  f.state.sharing=false;await assert.rejects(f.router.ensureReady(normalizeSettings({})),/授权/);
  f.state.sharing=true;f.speechState.cached=false;f.speechState.status='idle';
  await assert.rejects(f.router.ensureReady(normalizeSettings({})),/语音识别/);
});

test('ChatGPT receives bounded speech and danmaku context without the configured API credentials',async t=>{
  const f=await fixture(t);
  const result=await f.router.generate(normalizeSettings({chat:{apiKey:'secret-chat'},transcription:{apiKey:'secret-voice'}}),[
    {kind:'speech',user:'主播',text:'你们喜欢什么电影',at:1},{kind:'chat',user:'朋友',text:'最近想看喜剧',at:2},
  ]);
  assert.equal(result.action,'reply');
  const request=f.calls[0];assert.equal(request.model,'test-fast-mini');
  assert.match(request.input[0].content,/speech/);assert.match(request.input[0].content,/最近想看喜剧/);
  assert.doesNotMatch(JSON.stringify(request),/secret-chat|secret-voice/);
  assert.match(request.instructions,/不可信/);
});

test('local speech receives the captured blob and cancellation signal',async t=>{
  const f=await fixture(t),blob=new Blob(['audio']),controller=new AbortController();
  assert.equal(await f.router.transcribe(normalizeSettings({}),blob,{signal:controller.signal}),'本地转写');
  assert.equal(f.calls[0].blob,blob);assert.equal(f.calls[0].options.signal,controller.signal);
});

test('provider switch persists only its public selection and API mode retains key requirements',async t=>{
  const f=await fixture(t);
  await f.router.command('ai-set-mode',{mode:'api'});
  await assert.rejects(f.router.ensureReady(normalizeSettings({})),/API Key/);
  await f.router.ensureReady(normalizeSettings({chat:{apiKey:'chat'},transcription:{apiKey:'voice'}}));
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'ai-settings.json'),'utf8')),{mode:'api',chatgptModel:''});
  await assert.rejects(f.router.command('ai-set-mode',{mode:'website-cookie'}),/请选择/);
});

test('models must come from the selected account catalog and usage opens the official settings',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.router.command('chatgpt-select-model',{model:'made-up-model'}),/当前 ChatGPT/);
  await f.router.command('chatgpt-select-model',{model:'test-fast-mini'});
  assert.equal((await f.router.getState()).chatgptModel,'test-fast-mini');
  await f.router.command('chatgpt-usage');assert.equal(f.calls.at(-1),'https://chatgpt.com/settings/usage');
});

// Exercise the real asynchronous OAuth callback rather than a stub whose signIn
// incorrectly waits for login completion. All remote endpoints stay synthetic.
let signingKeys;
async function loginFixture(t,{modelsFail=false,modelsEmpty=false,sharing=true}={}){
  const {generateKeyPair,exportJWK,SignJWT}=await import('jose');
  signingKeys ||= await generateKeyPair('RS256');
  const jwk=await exportJWK(signingKeys.publicKey);jwk.kid='router-test';
  let authorize,modelCalls=0;
  const changes=[],remoteFetch=globalThis.fetch;
  const controls={modelsFail,modelsEmpty,sharing};
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const address=String(url);
    if(address.startsWith('http://127.0.0.1:'))return remoteFetch(url,init);
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    if(address.endsWith('/.well-known/jwks.json'))return json({keys:[jwk]});
    if(address.endsWith('/oauth/token')){
      const token=await new SignJWT({nonce:authorize.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:'router-test'})
        .setIssuer('https://auth.openai.com').setAudience('oaiapp_router_test').setSubject('router-user').setIssuedAt().setExpirationTime('1h').sign(signingKeys.privateKey);
      return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:token,token_type:'Bearer',expires_in:3600,
        scope:`openid profile email offline_access resource.invoke${controls.sharing?' chatgpt.tokens.use.direct':''}`});
    }
    if(address.endsWith('/models')){
      modelCalls++;
      if(controls.modelsFail)return new Response('{}',{status:503});
      return json({models:controls.modelsEmpty?[]:[{slug:'callback-mini',display_name:'Callback model',visibility:'list'}]});
    }
    throw new Error(`Unexpected network request: ${address}`);
  });
  const f=await fixture(t,{chatgpt:undefined,encryption:{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:data=>data.toString()},
    openExternal:async url=>{authorize=new URL(url);},onChange:state=>changes.push(state)});
  await f.router.command('chatgpt-sign-in',{enableSharing:true});
  assert.equal((await f.router.getState()).chatgpt.connected,false,'opening a browser is not login completion');
  const callback=new URL(authorize.searchParams.get('redirect_uri'));
  callback.search=new URLSearchParams({state:authorize.searchParams.get('state'),code:'synthetic-code',client_id:'oaiapp_router_test'});
  assert.equal((await remoteFetch(callback)).status,200);
  return {...f,changes,controls,get modelCalls(){return modelCalls;}};
}
async function eventually(check){
  for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Expected state update did not arrive');
}

test('OAuth callback refreshes available models in UI without a test or start command',async t=>{
  const f=await loginFixture(t);
  await eventually(()=>f.changes.some(state=>state.chatgpt.models.some(model=>model.id==='callback-mini')));
  assert.equal(f.modelCalls,1,'model-list notifications must not recursively fetch models');
  await f.router.ensureReady(normalizeSettings({}));
  assert.equal(f.modelCalls,1);
});

test('catalog failure is visible, does not loop, and a user start can retry',async t=>{
  const f=await loginFixture(t,{modelsFail:true});
  await eventually(()=>f.changes.some(state=>/模型列表/.test(state.chatgpt.error||'')));
  assert.equal(f.modelCalls,1);
  f.controls.modelsFail=false;
  await f.router.ensureReady(normalizeSettings({}));
  assert.equal(f.modelCalls,2);
  assert.equal((await f.router.getState()).chatgpt.error,'');
});

test('login without plan-sharing permission does not fetch models or require an API key',async t=>{
  const f=await loginFixture(t,{sharing:false});
  await eventually(()=>f.changes.some(state=>state.chatgpt.connected&&!state.chatgpt.signingIn));
  assert.equal(f.modelCalls,0);
  await assert.rejects(f.router.ensureReady(normalizeSettings({})),/授权/);
});

test('API route uses configured chat and speech endpoints without ChatGPT or local speech',async t=>{
  const f=await fixture(t),requests=[];
  f.state.connected=false;f.speechState.cached=false;f.speechState.status='idle';
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    requests.push({url,init});
    return new Response(JSON.stringify(String(url).endsWith('/chat/completions')?
      {choices:[{message:{content:JSON.stringify({action:'wait',text:'',reason:'听主播说',scene:'chat',respondsToSelf:false,confidence:.8})}}]}:
      {text:'来自自选 API 的转写'}),{headers:{'Content-Type':'application/json'}});
  });
  const settings=normalizeSettings({chat:{baseUrl:'https://chat.example/v1',apiKey:'synthetic-chat-key',model:'chat-model'},
    transcription:{baseUrl:'https://speech.example/v1',apiKey:'synthetic-speech-key',model:'speech-model'}});
  await f.router.command('ai-set-mode',{mode:'api'});
  await f.router.ensureReady(settings);
  assert.equal((await f.router.generate(settings,[])).action,'wait');
  assert.equal(await f.router.transcribe(settings,new Blob(['wave'],{type:'audio/wav'})),'来自自选 API 的转写');
  assert.equal(requests[0].url,'https://chat.example/v1/chat/completions');
  assert.equal(requests[0].init.headers.Authorization,'Bearer synthetic-chat-key');
  assert.equal(JSON.parse(requests[0].init.body).model,'chat-model');
  assert.equal(requests[1].url,'https://speech.example/v1/audio/transcriptions');
  assert.equal(requests[1].init.headers.Authorization,'Bearer synthetic-speech-key');
  assert.equal(requests[1].init.body.get('model'),'speech-model');
  assert.equal(f.calls.length,0);
});


test('an initially empty catalog can be retried explicitly after models become available',async t=>{
  const f=await loginFixture(t,{modelsEmpty:true});
  await eventually(()=>f.modelCalls===1);
  await assert.rejects(f.router.ensureReady(normalizeSettings({})),/没有可用模型/);
  f.controls.modelsEmpty=false;
  await f.router.ensureReady(normalizeSettings({}));
  assert.equal((await f.router.getState()).chatgptModel,'callback-mini');
});

for(const cached of [false,true])test(`concurrent first readiness checks share default-model persistence (${cached?'cached':'pending'} catalog)`,async t=>{
  const f=await fixture(t);
  if(!cached){
    f.state.models=[];
    f.chatgpt.listModels=async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      return [{id:'test-fast-mini',name:'Test Fast'}];
    };
  }
  const results=await Promise.allSettled([f.router.ensureReady(normalizeSettings({})),f.router.ensureReady(normalizeSettings({}))]);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled']);
  assert.equal((await f.router.getState()).chatgptModel,'test-fast-mini');
  assert.equal(JSON.parse(await readFile(join(f.directory,'ai-settings.json'),'utf8')).chatgptModel,'test-fast-mini');
});
