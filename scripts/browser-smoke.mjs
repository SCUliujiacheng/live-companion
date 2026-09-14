// Isolated extension integration check. No real provider calls or public messages.
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=resolve(import.meta.dirname,'..'),ext=join(root,'extension'),out=join(root,'output/playwright');
await mkdir(out,{recursive:true});
const context=await chromium.launchPersistentContext('',{headless:true,channel:'chromium',executablePath:process.env.LIVE_COMPANION_BROWSER,
  args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:430,height:940}});
const failures=[];
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host;
  const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
  await page.goto(`chrome-extension://${id}/sidepanel.html`);await page.waitForLoadState('networkidle');
  const initial=await page.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'get-state'}));
  assert.equal(initial.ok,true);assert.equal(initial.settings.chat.baseUrl,'https://api.openai.com/v1');assert.equal(initial.settings.chat.apiKey,'');
  await page.screenshot({path:join(out,'panel.png'),fullPage:true});
  await page.locator('#open-settings').click();
  await page.screenshot({path:join(out,'settings.png'),fullPage:true});
  await page.screenshot({path:join(out,'settings-viewport.png')});
  const passwordCount=await page.locator('input[type=password]').count();assert.ok(passwordCount>=2,'two masked key fields');
  await page.locator('#close-settings').click();
  await page.setViewportSize({width:320,height:820});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'narrow panel fits without horizontal scrolling');
  await page.screenshot({path:join(out,'panel-narrow.png'),fullPage:true});
  const blocked=await page.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'start',mode:'auto'}));
  assert.equal(blocked.ok,false);assert.match(blocked.error,/直播间/);
  await worker.evaluate(async()=>{await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'Isolated test of extension message routing; no audio capture'});});
  const snapshot=await worker.evaluate(()=>chrome.runtime.sendMessage({target:'offscreen',type:'snapshot'}));
  assert.equal(snapshot.ok,false);assert.match(snapshot.error,/尚未开始/);
  await worker.evaluate(()=>chrome.offscreen.closeDocument());
  assert.deepEqual(failures,[]);
  await writeFile(join(out,'browser-results.json'),JSON.stringify({ok:true,extensionId:id,checks:['MV3 load','background config','missing-room start blocked','service worker to offscreen messaging','two masked API fields','UI screenshots','no page errors']},null,2));
  console.log('PASS: actual MV3 extension load, config, start guard, offscreen messaging, API UI; no live external calls.');
}finally{await context.close();}
