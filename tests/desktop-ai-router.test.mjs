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
