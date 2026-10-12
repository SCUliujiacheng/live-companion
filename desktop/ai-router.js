import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createChatGPTClient} from './chatgpt-client.js';
import {createLocalSpeech} from './local-speech.js';
import {generateReply,transcribeAudio,SYSTEM_PROMPT,parseCandidate} from '../extension/core/provider.js';
import {normalizeSettings} from '../extension/core/settings.js';

// Provider choice is desktop-specific. The shared extension/API settings and
// conversation policy stay independent of account-based authentication.
export function createAIRouter({directory,encryption,openExternal,onChange=()=>{},chatgpt:providedChatGPT,speech:providedSpeech}) {
  const file=join(directory,'ai-settings.json');
  let config={mode:'chatgpt-local',chatgptModel:''},saving=false,closed=false;
  let catalogAttempt=null,modelOperation=null;
  const notify=()=>{if(!closed)void getState().then(onChange).catch(()=>{});};
  const chatgpt=providedChatGPT||createChatGPTClient({directory:join(directory,'chatgpt'),encryption,openExternal,onChange:accountChanged});
  const speech=providedSpeech||createLocalSpeech({directory:join(directory,'speech'),onChange:notify});
  const ready=readFile(file,'utf8').then(raw=>{
    const saved=JSON.parse(raw);config={mode:saved.mode==='api'?'api':'chatgpt-local',chatgptModel:typeof saved.chatgptModel==='string'?saved.chatgptModel.slice(0,200):''};
  }).catch(()=>{});
  function accountChanged(state){
    notify();
    if(closed)return;
    if(!state.connected||!state.sharing||state.signingIn){catalogAttempt=null;return;}
    // signIn returns when the browser opens. The eventual OAuth callback must
    // refresh the picker itself; listing models also emits this notification.
    if(!state.models?.length)void loadModels(state).catch(()=>{});
  }
  function loadModels(state,{retry=false}={}){
    if(catalogAttempt&&catalogAttempt.accountId===state.activeAccountId&&!(retry&&catalogAttempt.settled))return catalogAttempt.promise;
    const attempt={accountId:state.activeAccountId,failed:false,settled:false,promise:null};
    catalogAttempt=attempt;
    attempt.promise=Promise.resolve().then(()=>chatgpt.listModels()).catch(error=>{attempt.failed=true;if(catalogAttempt===attempt)notify();throw error;}).finally(()=>{attempt.settled=true;});
    return attempt.promise;
  }
  async function getState(){
    await ready;
    const account=await chatgpt.getState();
    if(catalogAttempt?.failed&&catalogAttempt.accountId===account.activeAccountId&&!account.error)account.error='ChatGPT 模型列表加载失败，请点击测试聊天重试';
    return {...config,chatgpt:account,speech:await speech.getState()};
  }
  async function save(patch){
    if(saving)throw new Error('正在保存 AI 接入设置，请稍后再试');
    saving=true;
    try{
      await ready;const next={...config,...patch};
      await mkdir(directory,{recursive:true});
      await writeFile(file+'.tmp',JSON.stringify(next),{encoding:'utf8',mode:0o600});
      await rename(file+'.tmp',file);config=next;
    }finally{saving=false;notify();}
  }
  async function model(){
    const state=await chatgpt.getState();
    if(!state.connected)throw new Error('请先在 AI 设置中登录 ChatGPT');
    if(!state.sharing)throw new Error('请先授权直播搭子使用 ChatGPT 套餐用量');
    if(modelOperation&&modelOperation.accountId===state.activeAccountId)return modelOperation.promise;
    const operation={accountId:state.activeAccountId,promise:null};
    modelOperation=operation;
    operation.promise=resolveModel(state).finally(()=>{if(modelOperation===operation)modelOperation=null;});
    return operation.promise;
  }
  async function resolveModel(state){
    const models=state.models?.length?state.models:await loadModels(state,{retry:true});
    if(!Array.isArray(models)||!models.length)throw new Error('当前 ChatGPT 账号没有可用模型，请检查套餐与用量');
    let selected=models.find(item=>item.id===config.chatgptModel);
    if(!selected){selected=models.find(item=>/luna|mini/i.test(item.id))||models[0];await save({chatgptModel:selected.id});}
    return selected.id;
  }
  async function ensureReady(settings){
    await ready;if(saving&&!modelOperation)throw new Error('请等待 AI 接入设置保存完成');
    if(config.mode==='api'){
      if(!settings.chat.apiKey||!settings.transcription.apiKey)throw new Error('请填写聊天和语音转写 API Key');
    }else{
      await model();const local=await speech.getState();
      if(local.status==='downloading'||local.status==='loading')throw new Error('本地语音模型正在准备，请稍候');
      if(!local.cached&&local.status!=='ready')throw new Error('请先在 AI 设置中下载并准备本地语音识别模型');
    }
  }
  async function generate(settings,events,options={}){
    await ready;
    if(config.mode==='api')return generateReply(settings,events,options);
    const normalized=normalizeSettings(settings);
    const context=(Array.isArray(events)?events:[]).slice(-80).map(event=>({
      kind:['speech','chat','self'].includes(event.kind)?event.kind:'chat',
      user:typeof event.user==='string'?event.user.slice(0,80):'',
      text:typeof event.text==='string'?event.text.slice(0,1200):'',
      at:Number.isFinite(event.at)?event.at:null,
    }));
    const text=await chatgpt.respond({model:await model(),instructions:`${SYSTEM_PROMPT}\n弹幕最多 ${normalized.maxLength} 个字符。`,
      input:[{role:'user',content:JSON.stringify({nickname:normalized.nickname,style:normalized.style,roomNotes:normalized.roomNotes,events:context})}],signal:options.signal});
    return parseCandidate(text);
  }
  async function transcribe(settings,blob,options={}){
    await ready;
    return config.mode==='api'?transcribeAudio(settings,blob,options):speech.transcribe(blob,options);
  }
  async function command(type,payload={}){
    await ready;
    switch(type){
      case 'ai-get-state':return {ok:true,ai:await getState()};
      case 'ai-set-mode':
        if(!['chatgpt-local','api'].includes(payload.mode))throw new Error('请选择登录账号或填写 API');
        await save({mode:payload.mode});break;
      case 'chatgpt-sign-in':
        await chatgpt.signIn({addAccount:payload.addAccount===true,enableSharing:payload.enableSharing===true});
        if((await chatgpt.getState()).sharing)await model();break;
      case 'chatgpt-cancel-sign-in':await chatgpt.cancelSignIn();break;
      case 'chatgpt-sign-out':await chatgpt.signOut();break;
      case 'chatgpt-select-account':
        await chatgpt.selectAccount(String(payload.accountId||''));await save({chatgptModel:''});
        if((await chatgpt.getState()).sharing)await model();break;
      case 'chatgpt-select-model':{
        const models=await chatgpt.listModels();
        if(!models.some(item=>item.id===payload.model))throw new Error('请选择当前 ChatGPT 账号提供的模型');
        await save({chatgptModel:payload.model});break;
      }
      case 'chatgpt-test':{
        const response=await chatgpt.respond({model:await model(),instructions:'请只用一句简短中文回答。',input:[{role:'user',content:'请说：连接成功，可以开始陪聊。'}]});
        return {ok:true,ai:await getState(),message:`ChatGPT 已完成真实请求：${response.slice(0,160)}`};
      }
      case 'chatgpt-usage':await openExternal('https://chatgpt.com/settings/usage');break;
      case 'local-speech-prepare':await speech.prepare();break;
      default:throw new Error('未知的 AI 接入操作');
    }
    notify();return {ok:true,ai:await getState()};
  }
  return {getState,command,generate,transcribe,ensureReady,
    async close(){closed=true;await Promise.allSettled([chatgpt.close(),speech.close()]);},
  };
}
