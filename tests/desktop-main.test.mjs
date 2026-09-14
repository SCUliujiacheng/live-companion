import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import vm from 'node:vm';

const UI='companion://app/desktop/ui/index.html';
async function fixture({failBoot=false}={}){
  const windows=[],views=[],handles=new Map(),listeners=new Map(),dialogs=[],sent=[];
  let controller;
  const makeSession=()=>({setPermissionCheckHandler(fn){this.check=fn;},setPermissionRequestHandler(fn){this.request=fn;},clearStorageData:async()=>{}});
  const uiSession=makeSession();
  class Contents{
    constructor(session){this.session=session;this.url='about:blank';this.events=new Map();this.mainFrame={url:this.url};}
    getURL(){return this.url;}getTitle(){return '测试直播间';}isDestroyed(){return false;}
    async loadURL(url){if(failBoot&&url===UI)throw Error('sensitive-boot-token');this.url=url;this.mainFrame.url=url;}
    on(name,fn){this.events.set(name,fn);}setWindowOpenHandler(fn){this.open=fn;}
    getMediaSourceId(requester){assert.equal(requester,windows[0].webContents);return 'verified-source-id';}
    send(channel,payload){sent.push({target:this,channel,payload});}
    close(){}
  }
  class Window{
    constructor(){this.webContents=new Contents(uiSession);this.events=new Map();this.contentView={addChildView(){}};windows.push(this);}
    getContentSize(){return [1500,900];}isDestroyed(){return false;}on(name,fn){this.events.set(name,fn);}loadURL(url){return this.webContents.loadURL(url);}show(){}destroy(){}
  }
  class View{constructor({webPreferences}){this.webContents=new Contents(webPreferences.session);views.push(this);}setBounds(){}}
  class Controller{
    constructor(dependencies){this.dependencies=dependencies;this.sessionId='session-one';this.room={roomId:'123',title:'测试'};this.state={status:'listening',singing:false};controller=this;}
    setRoom(room){this.room=room;this.sessionId=null;return Promise.resolve({ok:true});}
    command(){return Promise.resolve({ok:true});}onRoomEvents(){}onSegment(){}onLevel(){}onActivity(){}onCaptureEnded(){}
    safeError(){return '安全错误';}
  }
  const app={isPackaged:true,setName(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>Promise.resolve(),getPath:()=>'/test-profile',getVersion:()=>'0.2.0',quit(){app.didQuit=true;}};
  const context=vm.createContext({
    app,BrowserWindow:Window,WebContentsView:View,DesktopController:Controller,createSettingsStore:()=>({}),
    ipcMain:{handle:(name,fn)=>handles.set(name,fn),on:(name,fn)=>listeners.set(name,fn)},
    protocol:{registerSchemesAsPrivileged(){},handle(){}},net:{},session:{fromPartition:()=>makeSession()},safeStorage:{},shell:{openExternal:async()=>{}},
    powerSaveBlocker:{start:()=>1,stop(){}},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},dialog:{showErrorBox:(...args)=>dialogs.push(args)},
    readFile,join,resolve,relative,isAbsolute,fileURLToPath,pathToFileURL,URL,Response,Blob,Uint8Array,Map,Set,Promise,crypto,setTimeout,clearTimeout,process:{env:{}},
  });
  const source=(await readFile(new URL('../desktop/main.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../desktop/main.js',import.meta.url).href));
  vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
  if(views[0])await views[0].webContents.loadURL('https://live.bilibili.com/123');
  const uiEvent=()=>({sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame});
  const roomEvent=()=>({sender:views[0].webContents,senderFrame:views[0].webContents.mainFrame});
  const finish=()=>vm.runInContext('for(const entry of roomPending.values())entry.finish({ok:false});for(const entry of capturePending.values())entry.finish({ok:false});',context);
  return {context,controller,windows,views,uiSession,handles,listeners,dialogs,sent,uiEvent,roomEvent,finish,app};
}

test('desktop main blocks room sends when the live URL or session no longer matches',async t=>{
  const f=await fixture();t.after(f.finish);const command=f.controller.dependencies.roomCommand;
  await f.views[0].webContents.loadURL('https://live.bilibili.com/456');
  const changed=await command('send',{sessionId:'session-one',roomId:'123',text:'不可发送',messageId:'one'});
  assert.equal(changed.ok,false);assert.equal(f.sent.filter(item=>item.channel==='room-command').length,0);
  await f.views[0].webContents.loadURL('https://live.bilibili.com/123');
  const stale=await command('send',{sessionId:'older-session',roomId:'123',text:'不可发送',messageId:'two'});
  assert.equal(stale.ok,false);assert.equal(f.sent.length,0);
});

test('desktop main permits an exact room-bound send and ignores a mismatched result frame',async t=>{
  const f=await fixture();t.after(f.finish);
  const pending=f.controller.dependencies.roomCommand('send',{sessionId:'session-one',roomId:'123',text:'自然接话',messageId:'one'});
  const request=f.sent.at(-1).payload;let complete=false;pending.then(()=>{complete=true;});
  f.listeners.get('room-result')({...f.roomEvent(),senderFrame:{url:'https://live.bilibili.com/123'}},{requestId:request.requestId,result:{ok:true}});
  await Promise.resolve();assert.equal(complete,false);
  f.listeners.get('room-result')(f.roomEvent(),{requestId:request.requestId,result:{ok:true}});
  assert.equal((await pending).ok,true);
});

test('desktop media permission is denied before capture and permits only active local UI audio',async t=>{
  const f=await fixture();t.after(f.finish);const wc=f.windows[0].webContents;
  assert.equal(f.uiSession.check(wc,'media','companion://app',{isMainFrame:true,mediaType:'audio',requestingUrl:UI}),false);
  const opening=f.controller.dependencies.captureStart('session-one');
  assert.equal(f.uiSession.check(wc,'media','companion://app/',{isMainFrame:true,mediaType:'audio',requestingUrl:UI}),true);
  assert.equal(f.uiSession.check(wc,'media','https://evil.example',{isMainFrame:true,mediaType:'audio'}),false);
  assert.equal(f.uiSession.check(wc,'media','companion://app',{isMainFrame:false,mediaType:'audio'}),false);
  assert.equal(f.uiSession.check(wc,'media','companion://app',{isMainFrame:true,mediaType:'video'}),false);
  let videoAllowed=true;f.uiSession.request(wc,'media',value=>{videoAllowed=value;},{isMainFrame:true,requestingUrl:UI,securityOrigin:'companion://app',mediaTypes:['video']});assert.equal(videoAllowed,false);
  const request=f.sent.at(-1).payload;f.listeners.get('companion-capture-event')(f.uiEvent(),{type:'result',payload:{requestId:request.requestId,ok:true}});assert.equal((await opening).ok,true);
});

test('desktop capture startup rejects stale sessions before creating a media source',async t=>{
  const f=await fixture();t.after(f.finish);
  assert.equal((await f.controller.dependencies.captureStart('expired')).ok,false);assert.equal(f.sent.length,0);
});

test('desktop transport send exceptions release pending entries and return a safe failure',async t=>{
  const f=await fixture();t.after(f.finish);f.views[0].webContents.send=()=>{throw Error('sensitive-page-details');};
  const result=await f.controller.dependencies.roomCommand('send',{sessionId:'session-one',roomId:'123',text:'接话',messageId:'one'});
  assert.equal(result.ok,false);assert.doesNotMatch(result.error,/sensitive-page-details/);assert.equal(vm.runInContext('roomPending.size',f.context),0);
});

test('desktop boot failure shows a safe actionable dialog before exiting',async()=>{
  const f=await fixture({failBoot:true});assert.equal(f.app.didQuit,true);assert.equal(f.dialogs.length,1);assert.match(f.dialogs[0].join(' '),/启动/);assert.doesNotMatch(f.dialogs[0].join(' '),/sensitive-boot-token/);
});
