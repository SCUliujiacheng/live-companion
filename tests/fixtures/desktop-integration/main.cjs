const {app,session}=require('electron');
const {readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const root=resolve(__dirname,'../../..');
app.whenReady().then(()=>{
  // Entire remote-page network is replaced only in this test entry point.
  const target=session.fromPartition('persist:bilibili-room');
  target.protocol.handle('https',()=>new Response(readFileSync(join(__dirname,'room.html')),{headers:{'Content-Type':'text/html'}}));
});
void import(pathToFileURL(join(root,'desktop/main.js')).href);
