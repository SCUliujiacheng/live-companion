import {DEFAULT_SETTINGS,normalizeSettings,splitSettings,permissionOrigins} from './core/settings.js';
import {testProvider} from './core/provider.js';

const panelUrl=chrome.runtime.getURL('sidepanel.html');
const offscreenUrl=chrome.runtime.getURL('offscreen.html');
let selectedRoom=null, activeSession=null, starting=false, lifecycle=0, sendEpoch=0, blockedSends=0;
let state={status:'idle',room:null,mode:'review',singing:false,level:0,events:[],logs:[],pending:null,sentCount:0,error:'',activity:'请在 B站直播间点击扩展图标'};
const ready=(async()=>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const data=await chrome.storage.session.get(['room','state','activeSession']);
  selectedRoom=data.room||null;state=data.state||state;activeSession=data.activeSession||null;
})();
const roomOf=tab=>{const match=/^https:\/\/live\.bilibili\.com\/(\d+)(?:[/?#]|$)/.exec(tab.url||'');return match?{tabId:tab.id,roomId:match[1],title:tab.title||'B站直播间'}:null;};
async function publish(next){state=next;await chrome.storage.session.set({state});chrome.runtime.sendMessage({target:'panel',type:'state',state}).catch(()=>{});}
async function config(){
  const [{settings,savedSecrets},{secrets}]=await Promise.all([chrome.storage.local.get(['settings','savedSecrets']),chrome.storage.session.get('secrets')]);
  const base=settings||DEFAULT_SETTINGS;const keys=secrets||savedSecrets||{};
  return normalizeSettings({...base,chat:{...base.chat,apiKey:keys.chatApiKey||''},transcription:{...base.transcription,apiKey:keys.transcriptionApiKey||''}});
}
async function save(settings){
  if(activeSession)throw new Error('请先停止监听，再修改 API 设置');
  const normalized=normalizeSettings(settings);
  if(!await chrome.permissions.contains({origins:permissionOrigins(normalized)}))throw new Error('请在设置中允许访问填写的 API 域名');
  const {publicSettings,secrets}=splitSettings(normalized);
  await chrome.storage.local.set({settings:publicSettings});
  if(normalized.rememberKeys)await chrome.storage.local.set({savedSecrets:secrets});
  else await chrome.storage.local.remove('savedSecrets');
  await chrome.storage.session.set({secrets});
  return {ok:true};
}
async function hasOffscreen(){return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[offscreenUrl]})).length>0;}
async function off(type,data={}){if(!await hasOffscreen())return {ok:false,error:'监听尚未开始'};return chrome.runtime.sendMessage({target:'offscreen',type,...data});}
async function stop(){
  lifecycle++;
  sendEpoch++;
  const previous=activeSession;activeSession=null;
  const detached=previous?chrome.tabs.sendMessage(previous.tabId,{target:'content',type:'detach',sessionId:previous.id}).catch(()=>{}):null;
  await chrome.storage.session.remove('activeSession');
  await off('stop').catch(()=>{});
  await detached;
  if(await hasOffscreen())await chrome.offscreen.closeDocument().catch(()=>{});
  await publish({...state,status:'idle',pending:null,level:0,activity:'已停止监听'});
  return {ok:true};
}
async function start(mode){
  if(starting)throw new Error('正在开始监听');
  if(activeSession)throw new Error('请先停止当前监听');
  starting=true;
  const epoch=++lifecycle;
  const stillStarting=()=>{if(epoch!==lifecycle)throw new Error('开始操作已取消');};
  try{
    if(!selectedRoom)throw new Error('请先打开 B站直播间，再点击工具栏的直播搭子图标');
    const current=roomOf(await chrome.tabs.get(selectedRoom.tabId));
    if(!current||current.roomId!==selectedRoom.roomId)throw new Error('直播间已切换，请重新点击扩展图标');
    const settings=await config();
    stillStarting();
    if(!settings.chat.apiKey||!settings.transcription.apiKey)throw new Error('请先在 API 设置里填写聊天和语音转写密钥');
    if(!await chrome.permissions.contains({origins:permissionOrigins(settings)}))throw new Error('请保存 API 设置并允许访问服务域名');
    await chrome.scripting.executeScript({target:{tabId:current.tabId},files:['content.js']});
    const id=crypto.randomUUID();
    const attached=await chrome.tabs.sendMessage(current.tabId,{target:'content',type:'attach',sessionId:id});
    stillStarting();
    if(!attached?.ok)throw new Error(attached?.error||'未找到直播间弹幕区域');
    activeSession={id,tabId:current.tabId,roomId:current.roomId};
    await chrome.storage.session.set({activeSession});
    await publish({...state,status:'starting',room:current,error:'',pending:null,events:[],logs:[],sentCount:0,activity:'正在连接直播声音'});
    if(!await hasOffscreen())await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'按用户操作读取直播标签页声音，用于语音转写和陪聊'});
    stillStarting();
    const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:current.tabId});
    const result=await off('start',{streamId,sessionId:id,room:current,mode:mode==='auto'?'auto':'review',settings});
    stillStarting();
    if(!result?.ok)throw new Error(result?.error||'无法开始监听');
    return {ok:true};
  }catch(error){await stop();await publish({...state,status:'error',error:error.message,activity:error.message});throw error;}
  finally{starting=false;}
}

chrome.action.onClicked.addListener(tab=>{
  // open() must run directly in the action event's user gesture.
  chrome.sidePanel.open({windowId:tab.windowId}).catch(()=>{});
  (async()=>{
    await ready;const room=roomOf(tab);
    if(!room){if(!activeSession)await publish({...state,error:'请在 B站直播间打开本插件',activity:'等待直播间'});return;}
    if(activeSession&&activeSession.tabId!==room.tabId){await publish({...state,error:'正在监听另一个直播间，请先停止'});return;}
    selectedRoom=room;await chrome.storage.session.set({room});
    if(!activeSession)await publish({...state,room,error:'',activity:'直播间已就绪，填写 API 后开始'});
  })().catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id=>{ready.then(()=>{if(activeSession?.tabId===id)return stop();}).catch(()=>{});});
chrome.tabs.onUpdated.addListener((id,change)=>{ready.then(()=>{if(activeSession?.tabId===id&&(change.status==='loading'||change.url))return stop();}).catch(()=>{});});

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='background'||sender.id!==chrome.runtime.id)return;
  const trustedPanel=sender.url===panelUrl&&!sender.tab?.url?.startsWith('https://');
  const trustedOff=sender.url===offscreenUrl;
  const content=sender.tab&&/^https:\/\/live\.bilibili\.com\/\d+(?:[/?#]|$)/.test(sender.url||'');
  if(!trustedPanel&&!trustedOff&&!content){respond({ok:false,error:'消息来源无效'});return;}
  (async()=>{
    await ready;
    if(content){
      if(!activeSession||sender.tab.id!==activeSession.tabId||message.sessionId!==activeSession.id)return {ok:false};
      if(message.type==='room-gone')return stop();
      if(message.type==='room-events'){
        const events=(Array.isArray(message.events)?message.events:[]).slice(-30).map(e=>({id:String(e.id||crypto.randomUUID()).slice(0,120),kind:'chat',text:String(e.text||'').slice(0,500),user:String(e.user||'').slice(0,80),at:Date.now()}));
        return off('events',{sessionId:activeSession.id,events});
      }
      return {ok:false};
    }
    if(trustedOff){
      if(message.type==='state'){
        if(!activeSession||message.sessionId!==activeSession.id)return {ok:false};
        await publish(message.state);return {ok:true};
      }
      if(message.type==='send'){
        if(blockedSends||!activeSession||message.sessionId!==activeSession.id||state.status!=='listening'||state.singing)return {ok:false,error:'会话已暂停或改变'};
        const session=activeSession,version=sendEpoch;
        const tab=roomOf(await chrome.tabs.get(session.tabId));
        if(blockedSends||version!==sendEpoch||activeSession?.id!==session.id||state.status!=='listening'||state.singing)return {ok:false,error:'发送已取消'};
        if(!tab||tab.roomId!==session.roomId)return {ok:false,error:'直播间已切换'};
        return chrome.tabs.sendMessage(tab.tabId,{target:'content',type:'send',sessionId:session.id,text:message.text,messageId:message.messageId});
      }
      return {ok:false};
    }
    switch(message.type){
      case 'get-state':{
        if(activeSession&&!starting&&!await hasOffscreen()){activeSession=null;await chrome.storage.session.remove('activeSession');await publish({...state,status:'idle',pending:null,activity:'监听已结束，请重新开始'});}
        return {ok:true,state,settings:await config()};
      }
      case 'save-settings':return save(message.settings);
      case 'start':return start(message.mode);
      case 'stop':return stop();
      case 'clear-data':{
        await stop();
        const permissions=await chrome.permissions.getAll();
        const requiredOrigins=new Set(chrome.runtime.getManifest().host_permissions||[]);
        const optionalOrigins=(permissions.origins||[]).filter(origin=>!requiredOrigins.has(origin));
        if(optionalOrigins.length)await chrome.permissions.remove({origins:optionalOrigins});
        await chrome.storage.local.clear();await chrome.storage.session.clear();
        selectedRoom=null;
        state={status:'idle',room:null,mode:'review',singing:false,level:0,events:[],logs:[],pending:null,sentCount:0,error:'',activity:'已清除本机数据，请在直播间重新点击扩展图标'};
        chrome.runtime.sendMessage({target:'panel',type:'state',state}).catch(()=>{});
        return {ok:true,state,settings:DEFAULT_SETTINGS};
      }
      case 'pause': case 'cancel': case 'singing':{
        // Disarm pending sends in this worker before awaiting offscreen.
        sendEpoch++;blockedSends++;
        if(activeSession)void chrome.tabs.sendMessage(activeSession.tabId,{target:'content',type:'cancel-send',sessionId:activeSession.id}).catch(()=>{});
        try{
          await publish({...state,pending:null,...(message.type==='pause'?{status:'paused'}:{}),...(message.type==='singing'?{singing:Boolean(message.value)}:{})});
          return await off(message.type,{value:message.value});
        }finally{blockedSends--;}
      }
      case 'resume':case 'send-now':return off(message.type);
      case 'test-api':{
        if(activeSession)throw new Error('请先停止监听再测试 API');
        const settings=await config();
        if(!await chrome.permissions.contains({origins:permissionOrigins(settings)}))throw new Error('API 访问权限已撤销，请重新保存设置并授权');
        const result=await testProvider(settings,message.kind==='transcription'?'transcription':'chat');
        return {ok:true,message:typeof result==='string'?result:result?.message||'连接检查成功'};
      }
      default:return {ok:false,error:'未知操作'};
    }
  })().then(respond,error=>respond({ok:false,error:error.message||'操作失败'}));
  return true;
});
chrome.permissions?.onRemoved?.addListener(()=>{
  ready.then(async()=>{
    if(activeSession&&!await chrome.permissions.contains({origins:permissionOrigins(await config())})){
      await stop();await publish({...state,error:'API 访问权限已撤销，监听已停止',activity:'请重新保存设置并授权'});
    }
  }).catch(()=>{});
});
