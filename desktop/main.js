import {app,BrowserWindow,WebContentsView,ipcMain,protocol,net,session,safeStorage,shell,powerSaveBlocker,Menu,dialog} from 'electron';
import {readFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DesktopController} from './controller.js';
import {createSettingsStore} from './storage.js';
import {createAIRouter} from './ai-router.js';
import {createCapturePermissionGate} from './capture-permission.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const UI_URL='companion://app/desktop/ui/index.html';
const capturePermission=createCapturePermissionGate({trustedURL:UI_URL});
const PUBLIC_LINKS=new Set(['github.com','platform.openai.com','developers.openai.com']);
let win,liveView,controller,roomSession,aiRouter,powerBlock=null,closing=false;
const AI_COMMANDS=new Set(['ai-get-state','ai-set-mode','chatgpt-sign-in','chatgpt-cancel-sign-in','chatgpt-sign-out','chatgpt-select-account','chatgpt-select-model','chatgpt-test','chatgpt-usage','local-speech-prepare']);
const roomPending=new Map(),capturePending=new Map();
let captureSession=null,roomState={url:'',title:'',loading:false,loggedIn:null};
protocol.registerSchemesAsPrivileged([{scheme:'companion',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setName('直播搭子');
// Package acceptance uses a fresh profile and no remote page. Both a launch
// switch and an environment opt-in are required; no IPC privileges are added.
const packageSmoke=process.env.LIVE_COMPANION_PACKAGE_SMOKE==='1'&&Boolean(process.argv?.includes('--package-smoke'))&&isAbsolute(process.env.LIVE_COMPANION_TEST_USER_DATA||'');
if((!app.isPackaged||packageSmoke)&&process.env.LIVE_COMPANION_TEST_USER_DATA)app.setPath('userData',process.env.LIVE_COMPANION_TEST_USER_DATA);
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(boot).catch(()=>{
    // Startup exceptions can contain local paths or third-party details. Show a
    // fixed recovery message rather than silently quitting or exposing them.
    dialog.showErrorBox('直播搭子无法启动','应用启动没有完成。请重新打开应用；如果仍然失败，请重新安装完整安装包，或向维护者反馈“启动失败”。不要发送 API Key 或账号密码。');
    app.quit();
  });
}
function isUI(event){return event.sender===win?.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame?.url===UI_URL;}
function isRoom(event){return event.sender===liveView?.webContents&&event.senderFrame===liveView.webContents.mainFrame&&Boolean(roomInfo(event.senderFrame?.url));}
function roomInfo(url){
  try{const parsed=new URL(url),match=/^\/([1-9]\d*)\/?$/.exec(parsed.pathname);
    return parsed.protocol==='https:'&&parsed.hostname==='live.bilibili.com'&&match?{roomId:match[1],title:liveView?.webContents.getTitle()||`直播间 ${match[1]}`}:null;
  }catch{return null;}
}
function roomURL(value){
  const input=String(value||'').trim();
  const url=/^[1-9]\d*$/.test(input)?`https://live.bilibili.com/${input}`:input;
  const room=roomInfo(url);if(!room)throw new Error('请填写 B站直播间链接或数字房间号');
  return `https://live.bilibili.com/${room.roomId}`;
}
function bilibiliURL(value){try{const url=new URL(value);return url.protocol==='https:'&&(url.hostname==='bilibili.com'||url.hostname.endsWith('.bilibili.com'));}catch{return false;}}
function sendUI(channel,payload){if(win&&!win.isDestroyed())win.webContents.send(channel,payload);}
function status(patch){roomState={...roomState,...patch};sendUI('companion-room-status',roomState);}
function rpc(map,target,channel,message,timeout=12000){
  return new Promise(resolveResult=>{
    if(!target||target.isDestroyed()){resolveResult({ok:false,error:'页面尚未就绪'});return;}
    const requestId=crypto.randomUUID();
    const timer=setTimeout(()=>{map.delete(requestId);resolveResult({ok:false,error:'页面响应超时，请重新打开直播间'});},timeout);
    map.set(requestId,{finish:result=>{clearTimeout(timer);map.delete(requestId);resolveResult(result);}});
    try{target.send(channel,{requestId,...message});}
    catch{map.get(requestId)?.finish({ok:false,error:'页面连接已结束，请重新打开直播间'});}
  });
}
function roomCommand(type,payload={}){
  const contents=liveView?.webContents;
  if(!contents||contents.isDestroyed())return Promise.resolve({ok:false,error:'直播页面尚未就绪'});
  const room=roomInfo(contents.getURL());
  if(type==='cancel-send'||type==='detach'){
    if(!room)return Promise.resolve({ok:true});
  }else if(type==='attach'||type==='send'){
    // Read the actual document immediately before dispatch, independently of
    // asynchronously reconciled room state. The page also binds the session.
    if(!room||room.roomId!==payload.roomId||controller?.room?.roomId!==room.roomId||controller?.sessionId!==payload.sessionId)return Promise.resolve({ok:false,error:'直播间或监听会话已改变'});
    if(type==='send'&&(controller.state.status!=='listening'||controller.state.singing))return Promise.resolve({ok:false,error:'发送已暂停或取消'});
  }else return Promise.resolve({ok:false,error:'不支持的直播间命令'});
  return rpc(roomPending,contents,'room-command',{type,payload});
}
async function captureStart(sessionId){
  const room=roomInfo(liveView?.webContents.getURL());
  if(!room||room.roomId!==controller?.room?.roomId||sessionId!==controller?.sessionId||win?.webContents.getURL()!==UI_URL)return {ok:false,error:'直播间或声音捕获会话已改变'};
  captureSession=sessionId;
  let grant;
  try{
    grant=capturePermission.grant(liveView.webContents,win.webContents);
    const streamId=liveView.webContents.getMediaSourceId(win.webContents);
    const result=await rpc(capturePending,win.webContents,'companion-capture',{type:'start',streamId,sessionId},15000);
    if(captureSession!==sessionId||controller?.sessionId!==sessionId||roomInfo(liveView?.webContents.getURL())?.roomId!==room.roomId)return {ok:false,error:'声音捕获已取消或直播间已改变'};
    if(!result?.ok)captureSession=null;
    return result;
  }catch{if(captureSession===sessionId)captureSession=null;return {ok:false,error:'无法连接直播声音，请重新打开直播间后再试'};}
  finally{if(grant)capturePermission.revoke(grant);}
}
async function captureStop(){captureSession=null;capturePermission.revoke();return rpc(capturePending,win?.webContents,'companion-capture',{type:'stop'},16000);}
function emit(state){
  const active=['listening','starting','paused'].includes(state.status);
  if(active&&powerBlock===null)powerBlock=powerSaveBlocker.start('prevent-app-suspension');
  if(!active&&powerBlock!==null){powerSaveBlocker.stop(powerBlock);powerBlock=null;}
  sendUI('companion-state',state);
}
function layout(){if(win&&liveView){const [width,height]=win.getContentSize();liveView.setBounds({x:0,y:72,width:Math.max(1,width-420),height:Math.max(1,height-72)});}}
async function openRoom(value){
  const url=roomURL(value);await controller.setRoom(null);
  status({url,loading:true,error:'',loggedIn:null});
  try{await liveView.webContents.loadURL(url);return {ok:true};}
  catch{status({loading:false,error:'直播网页加载失败，请检查网络后刷新'});return {ok:false,error:'直播网页加载失败，请检查网络后刷新'};}
}
async function reconcileRoom(){
  const url=liveView.webContents.getURL(),room=roomInfo(url);
  await controller.setRoom(room);
  status({url,title:liveView.webContents.getTitle(),loading:false});
}
async function boot(){
  protocol.handle('companion',request=>{
    const url=new URL(request.url);
    if(url.hostname!=='app')return new Response('',{status:403});
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('',{status:400});}
    const path=resolve(root,'.'+pathname),part=relative(root,path);
    if(part.startsWith('..')||isAbsolute(part)||!/^\/(desktop\/ui\/|extension\/)/.test(pathname)||/\.(?:env|pem|key)$/i.test(path))return new Response('',{status:403});
    return net.fetch(pathToFileURL(path).href);
  });
  const store=createSettingsStore(app.getPath('userData'),safeStorage);
  roomSession=session.fromPartition('persist:bilibili-room');
  roomSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(Boolean(captureSession&&captureSession===controller?.sessionId&&capturePermission.request(contents,permission,details))));
  roomSession.setPermissionCheckHandler(()=>false);
  win=new BrowserWindow({width:1500,height:940,minWidth:1120,minHeight:700,show:false,title:'直播搭子',backgroundColor:'#131619',icon:join(root,'extension/icons/icon-128.png'),webPreferences:{preload:join(root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,spellcheck:false}});
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  liveView=new WebContentsView({webPreferences:{preload:join(root,'desktop/generated/room-preload.cjs'),session:roomSession,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,spellcheck:false}});
  win.contentView.addChildView(liveView);layout();
  aiRouter=createAIRouter({directory:app.getPath('userData'),encryption:safeStorage,openExternal:url=>shell.openExternal(url),onChange:state=>sendUI('companion-ai-state',state)});
  controller=new DesktopController({...store,roomCommand,captureStart,captureStop,emit,
    generate:aiRouter.generate,transcribe:aiRouter.transcribe,validateProviders:aiRouter.ensureReady});
  ipcMain.handle('companion-version',event=>{if(!isUI(event))throw new Error('消息来源无效');return app.getVersion();});
  ipcMain.handle('companion-command',async(event,{type,payload={}}={})=>{
    if(!isUI(event))return {ok:false,error:'消息来源无效'};
    try{
      if(AI_COMMANDS.has(type)){
        if(type==='chatgpt-sign-out')await controller.command('stop');
        else if(!['ai-get-state','chatgpt-usage','chatgpt-cancel-sign-in'].includes(type)&&(controller.sessionId||controller.starting||controller.stopping))return {ok:false,error:'请先结束陪聊，再更换或测试 AI 接入'};
        return await aiRouter.command(type,payload);
      }
      if(type==='open-room')return openRoom(payload.url);
      if(type==='reload-room'){await controller.setRoom(null);liveView.webContents.reload();return {ok:true};}
      if(type==='logout-room'){await controller.setRoom(null);await roomSession.clearStorageData();await liveView.webContents.loadURL('https://www.bilibili.com/');status({loggedIn:false});return {ok:true};}
      if(type==='get-state')status(roomState);
      return await controller.command(type,payload);
    }catch(error){return {ok:false,error:controller.safeError(error,'操作失败')};}
  });
  ipcMain.on('room-result',(event,{requestId,result}={})=>{if(isRoom(event))roomPending.get(requestId)?.finish(result);});
  ipcMain.on('room-event',(event,message)=>{
    if(!isRoom(event)||!message||typeof message.sessionId!=='string')return;
    if(message.type==='room-events')controller.onRoomEvents((Array.isArray(message.events)?message.events:[]).slice(-100),message.sessionId);
    if(message.type==='room-gone')void controller.setRoom(null);
  });
  ipcMain.on('companion-capture-event',(event,{type,payload={}}={})=>{
    if(!isUI(event))return;
    if(type==='result'){capturePending.get(payload.requestId)?.finish({ok:payload.ok===true,error:String(payload.error||'').slice(0,300)});return;}
    if(!captureSession||payload.sessionId!==captureSession)return;
    if(type==='segment'){
      if(!(payload.bytes instanceof Uint8Array)||payload.bytes.byteLength>2*1024*1024)return;
      void controller.onSegment(new Blob([payload.bytes],{type:'audio/wav'}),{...payload.metadata,sessionId:payload.sessionId});
    }
    if(type==='level')controller.onLevel(Number(payload.level)||0,payload.sessionId);
    if(type==='activity')controller.onActivity({speaking:Boolean(payload.speaking),at:Date.now()},payload.sessionId);
    if(type==='ended'||type==='error')controller.onCaptureEnded(new Error(String(payload.error||'直播声音已断开，请结束后重新开始').slice(0,300)),payload.sessionId);
  });
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.setWindowOpenHandler(({url})=>{try{const target=new URL(url);if(target.protocol==='https:'&&PUBLIC_LINKS.has(target.hostname))void shell.openExternal(url);}catch{}return {action:'deny'};});
  liveView.webContents.on('will-navigate',(event,url)=>{if(!bilibiliURL(url))event.preventDefault();});
  liveView.webContents.on('will-redirect',(event,url)=>{if(!bilibiliURL(url))event.preventDefault();});
  liveView.webContents.setWindowOpenHandler(({url})=>{if(bilibiliURL(url))void controller.setRoom(null).then(()=>liveView.webContents.loadURL(url)).catch(()=>{});return {action:'deny'};});
  liveView.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame){status({loading:true,error:''});void controller.setRoom(null);}});
  liveView.webContents.on('did-finish-load',()=>void reconcileRoom().catch(()=>{}));
  liveView.webContents.on('did-navigate-in-page',()=>void reconcileRoom().catch(()=>{}));
  liveView.webContents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)status({loading:false,error:'直播网页加载失败，请检查网络后刷新'});});
  liveView.webContents.on('render-process-gone',()=>{void controller.setRoom(null);status({loading:false,error:'直播页面已退出，请刷新后重新开始'});});
  win.webContents.on('render-process-gone',()=>void controller.command('stop').catch(()=>{}));
  win.on('resize',layout);
  win.on('close',event=>{
    if(closing)return;event.preventDefault();closing=true;
    void controller.command('stop').then(()=>aiRouter.close()).finally(()=>{if(liveView&&!liveView.webContents.isDestroyed())liveView.webContents.close();win.destroy();app.quit();}).catch(()=>{});
    setTimeout(()=>{if(win&&!win.isDestroyed())win.destroy();app.quit();},2000).unref();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'直播搭子',submenu:[{label:'结束陪聊',click:()=>void controller.command('stop')},{type:'separator'},{role:'quit',label:'退出'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]}]));
  await win.loadURL(UI_URL);
  win.show();
  // A login session is scoped to this app; no existing browser profile is copied.
  await liveView.webContents.loadURL(packageSmoke?'about:blank':'https://www.bilibili.com/').catch(()=>status({loading:false,error:'请检查网络后打开直播间'}));
}
app.on('window-all-closed',()=>app.quit());
