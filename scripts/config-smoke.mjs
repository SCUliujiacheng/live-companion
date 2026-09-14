// Real browser + local fake provider. The shipping manifest is never changed.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {cp,mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=resolve(import.meta.dirname,'..');
const directory=await mkdtemp(join(tmpdir(),'live-companion-qa-'));const extension=join(directory,'extension');
const requests=[];
const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({path:req.url,method:req.method,authorization:req.headers.authorization,body});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/chat/v1/chat/completions')res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));
  else if(req.url==='/speech/v1/models')res.end(JSON.stringify({data:[{id:'local-test-transcribe'}]}));
  else{res.statusCode=404;res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
await cp(join(root,'extension'),extension,{recursive:true});
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
const context=await chromium.launchPersistentContext('',{headless:true,channel:'chromium',executablePath:process.env.LIVE_COMPANION_BROWSER,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:380,height:900}});
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.locator('#open-settings').click();
  for(const [kind,path,key,model] of [['chat','chat','test-chat-not-a-secret','local-test-chat'],['transcription','speech','test-audio-not-a-secret','local-test-transcribe']]){
    await page.locator(`#${kind}-base-url`).fill(`${base}/${path}/v1`);await page.locator(`#${kind}-api-key`).fill(key);await page.locator(`#${kind}-model`).fill(model);
  }
  await page.locator('#save-settings').click();
  try {
    await page.waitForFunction(()=>document.querySelector('#feedback').textContent.includes('设置已保存'));
  } catch (error) {
    // Only inspect non-secret controls in this isolated fake-provider test.
    console.error('Save diagnostics', await page.evaluate(async()=>({
      feedback:document.querySelector('#feedback').textContent,
      button:document.querySelector('#save-settings').textContent,
      invalid:[...document.querySelectorAll(':invalid')].map(el=>({id:el.id,message:el.validationMessage})),
      urls:['chat','transcription'].map(kind=>document.querySelector(`#${kind}-base-url`).value),
      permissions:await chrome.permissions.getAll(),
    })));
    throw error;
  }
  const sessionOnly=await page.evaluate(async()=>{const l=await chrome.storage.local.get(null),s=await chrome.storage.session.get('secrets');return {publicEmpty:!l.settings.chat.apiKey&&!l.settings.transcription.apiKey,saved:!!l.savedSecrets,sessionPresent:!!s.secrets?.chatApiKey&&!!s.secrets?.transcriptionApiKey};});
  assert.deepEqual(sessionOnly,{publicEmpty:true,saved:false,sessionPresent:true});
  await page.locator('#test-chat').click();await page.waitForFunction(()=>document.querySelector('#chat-test-result').textContent.includes('连接测试通过'));
  await page.locator('#test-transcription').click();await page.waitForFunction(()=>document.querySelector('#transcription-test-result').textContent.includes('未测试实际音频转写'));
  assert.equal(requests.length,2);assert.equal(requests[0].authorization,'Bearer test-chat-not-a-secret');assert.equal(requests[1].authorization,'Bearer test-audio-not-a-secret');
  assert.equal(JSON.parse(requests[0].body).model,'local-test-chat');
  await page.locator('#remember-keys').check();await page.locator('#save-settings').click();
  await page.waitForFunction(async()=>Boolean((await chrome.storage.local.get('savedSecrets')).savedSecrets));
  await page.locator('#remember-keys').uncheck();await page.locator('#save-settings').click();
  await page.waitForFunction(async()=>!((await chrome.storage.local.get('savedSecrets')).savedSecrets));
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await page.locator('#open-settings').click();await page.waitForFunction(()=>document.querySelector('#chat-model').value==='local-test-chat');
  assert.equal(await page.locator('#chat-base-url').inputValue(),`${base}/chat/v1`);
  await page.locator('#chat-base-url').fill(`${base}/changed/v1`);assert.equal(await page.locator('#chat-api-key').inputValue(),'');
  await page.locator('#chat-api-key').fill('test-key-for-second-endpoint');
  await page.locator('#chat-base-url').fill(`${base}/chat/v1`);assert.equal(await page.locator('#chat-api-key').inputValue(),'','returning to the old URL must also clear the other endpoint key');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#clear-data').click();
  await page.waitForFunction(async()=>{const l=await chrome.storage.local.get(null),s=await chrome.storage.session.get(null);return !l.settings&&!l.savedSecrets&&!s.secrets;});
  assert.equal(await page.locator('#chat-api-key').inputValue(),'');
  assert.equal(await page.locator('#chat-base-url').inputValue(),'https://api.openai.com/v1');
  console.log('PASS: editable independent providers, actual local HTTP requests, session key storage, opt-in persistence/removal, reload, endpoint A/B/A isolation, clear-data reset.');
}finally{await context.close();await new Promise(r=>server.close(r));
  // Only remove the temp directory returned by mkdtemp, beneath the OS temp root.
  if(resolve(directory).startsWith(resolve(tmpdir())+'\\')||resolve(directory).startsWith(resolve(tmpdir())+'/'))await rm(directory,{recursive:true,force:true});
}
