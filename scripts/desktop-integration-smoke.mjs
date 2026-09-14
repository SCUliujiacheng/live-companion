// Real desktop app, real IPC/audio, local fake website and fake AI provider.
// No real account, microphone, provider key or public message is involved.
import {_electron} from 'playwright';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const profile=await mkdtemp(join(tmpdir(),'live-companion-app-smoke-'));
const requests=[];
const server=createServer(async(req,res)=>{
  const buffers=[];for await(const chunk of req)buffers.push(chunk);
  const body=Buffer.concat(buffers);requests.push({path:req.url,bytes:body.length});
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/audio/transcriptions'))res.end(JSON.stringify({text:'今天聊聊喜欢的电影，你们最近有看什么电影吗？'}));
  else if(req.url.endsWith('/models'))res.end(JSON.stringify({data:[{id:'test-transcription'}]}));
  else if(req.url.endsWith('/chat/completions')){
    const request=JSON.parse(body),isTest=request.max_tokens===12;
    res.end(JSON.stringify({choices:[{message:{content:isTest?'OK':JSON.stringify({action:'reply',text:'最近想找部轻松的电影看',reason:'接电影话题',confidence:.96,scene:'chat',respondsToSelf:false})}}]}));
  }else{res.statusCode=404;res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/v1`;
const env={...process.env,LIVE_COMPANION_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let application;
try{
  application=await _electron.launch({args:[join(root,'tests/fixtures/desktop-integration/main.cjs')],env,timeout:40000});
  const ui=await application.firstWindow();
  await ui.waitForFunction(()=>document.body.dataset.ready==='true');
  await application.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.hide();});
  const errors=[];ui.on('pageerror',error=>errors.push(error.message));
  await ui.locator('#room-url').fill('12345');await ui.locator('#open-room-button').click();
  await ui.waitForFunction(()=>document.querySelector('#room-detail').textContent.includes('12345'));
  const roomId=await application.evaluate(({webContents})=>webContents.getAllWebContents().find(page=>page.getURL()==='https://live.bilibili.com/12345')?.id);
  assert.ok(roomId,'embedded room exists');
  const roomEval=source=>application.evaluate(({webContents},{id,source})=>webContents.fromId(id).executeJavaScript(source,true),{id:roomId,source});
  assert.equal(await roomEval('typeof window.desktopAPI'),'undefined','remote room cannot access privileged API');
  assert.equal(await roomEval('typeof window.require'),'undefined','remote room has no Node require');
  assert.equal(await roomEval('Boolean(document.querySelector("#play"))'),true,await roomEval('JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,400)})'));
  await ui.locator('#open-settings').click();
  for(const kind of ['chat','transcription']){await ui.locator(`#${kind}-base-url`).fill(base);await ui.locator(`#${kind}-api-key`).fill('test-only-fake-key');await ui.locator(`#${kind}-model`).fill(`test-${kind}`);}
  await ui.locator('#nickname').fill('测试观众');
  await ui.locator('#save-settings').click();await ui.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('设置已保存'));
  await ui.locator('#test-chat').click();await ui.waitForFunction(()=>document.querySelector('#chat-test-result').textContent.includes('连接测试通过'));
  await ui.locator('#test-transcription').click();await ui.waitForFunction(()=>document.querySelector('#transcription-test-result').textContent.includes('未测试实际音频转写'));
  await ui.locator('#close-settings').click();
  await roomEval('document.querySelector("#play").click(); true');
  await ui.locator('#start-button').click();
  await ui.waitForFunction(()=>['陪聊中','需要处理'].includes(document.querySelector('#status-label').textContent));
  assert.equal(await ui.locator('#status-label').textContent(),'陪聊中',await ui.locator('#feedback').textContent());
  await roomEval('addChat("观众A","有没有推荐的电影呀"); true');
  await ui.waitForFunction(()=>document.querySelector('#candidate-text').textContent.length>0,undefined,{timeout:22000});
  assert.ok(requests.some(request=>request.path.endsWith('/audio/transcriptions')&&request.bytes>1000),'real captured WAV reached fake transcription endpoint');
  assert.equal(await roomEval('sent.length'),0,'review mode never posts by timer');
  await ui.locator('#send-now-button').click();
  await ui.waitForFunction(()=>document.querySelector('#sent-count').textContent.includes('1 条'));
  assert.deepEqual(await roomEval('sent'),['最近想找部轻松的电影看']);
  await ui.locator('#pause-button').click();await ui.waitForFunction(()=>document.querySelector('#status-label').textContent==='已暂停');
  await ui.locator('#stop-button').click();await ui.waitForFunction(()=>document.querySelector('#status-label').textContent==='未开始');
  assert.deepEqual(errors,[]);
  await mkdir(join(root,'output/playwright'),{recursive:true});
  await ui.screenshot({path:join(root,'output/playwright/desktop-integration.png')});
  const results={ok:true,checks:['desktop bootstrap','remote isolation','API settings','local chat and transcription tests','real tab audio to WAV to HTTP','model candidate','manual send and echo','pause and stop'],requests};
  await writeFile(join(root,'output/playwright/desktop-integration.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}finally{
  await application?.close();await new Promise(resolve=>server.close(resolve));
  assert.equal(dirname(resolve(profile)),resolve(tmpdir()));assert.ok(basename(profile).startsWith('live-companion-app-smoke-'));
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
