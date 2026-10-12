const {app,session}=require('electron');
const {readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const root=resolve(__dirname,'../../..');
globalThis.__desktopFixtureDiagnostics=[];
app.on('web-contents-created',(_event,contents)=>{
  contents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{
    if(isMainFrame)globalThis.__desktopFixtureDiagnostics.push({type:'load-error',code,description,url});
  });
});
app.whenReady().then(()=>{
  // Entire remote-page network is replaced only in this test entry point.
  const target=session.fromPartition('persist:bilibili-room');
  // Electron's protocol.handle adapter builds a WHATWG Request; its ByteString
  // headers reject the Chinese app-name token in Electron's default User-Agent
  // before our callback can run. This test-only ASCII UA fixes that adapter
  // limitation without changing the production room origin or security rules.
  target.setUserAgent('LiveCompanionIntegrationFixture/1.0');
  target.protocol.handle('https',request=>{
    globalThis.__desktopFixtureDiagnostics.push({type:'request',url:request.url});
    return new Response(readFileSync(join(__dirname,'room.html')),{headers:{'Content-Type':'text/html; charset=utf-8'}});
  });
});
void import(pathToFileURL(join(root,'desktop/main.js')).href);
