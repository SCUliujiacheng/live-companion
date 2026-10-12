import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {selectCommittedAIMode} from '../scripts/desktop-smoke-helpers.mjs';
const require=createRequire(import.meta.url);
let playwright;
try{playwright=require('playwright');}catch{/* Optional browser regressions. */}

async function openDesktop({reject=false,inconsistent=false}={}){
  const browser=await playwright.chromium.launch({headless:true,...(process.env.LIVE_COMPANION_BROWSER?{executablePath:process.env.LIVE_COMPANION_BROWSER}:{})});
  try{
    const page=await browser.newPage();
    const paths=['desktop/ui/index.html','desktop/ui/app.js','desktop/ui/app.css','extension/sidepanel.js','extension/sidepanel.css','extension/core/settings.js','extension/audio/capture.js','extension/audio/wav.js'];
    const resources=new Map(await Promise.all(paths.map(async path=>[`/${path}`,{contentType:path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':'text/javascript',body:await readFile(new URL(`../${path}`,import.meta.url),'utf8')}])));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),resource=url.origin==='https://desktop.test'&&resources.get(url.pathname);
      return resource?route.fulfill(resource):route.abort('blockedbyclient');
    });
    await page.addInitScript(({reject,inconsistent})=>{
      let ai={mode:'chatgpt-local'};
      window.__desktopTest={switches:0};
      window.desktopAPI={
        onState(){},onCapture(){},captureEvent(){},
        async command(type,payload){
          if(type==='ai-get-state')return {ok:true,ai};
          if(type==='ai-set-mode'){
            window.__desktopTest.switches++;
            // Hold IPC open long enough to exercise the real UI's synchronous
            // re-render of the old radio, rather than relying on a timing race.
            await new Promise(resolve=>setTimeout(resolve,350));
            if(reject)return {ok:false,error:'模拟保存失败'};
            if(!inconsistent)ai={mode:payload.mode};
            return {ok:true,ai:{mode:payload.mode}};
          }
          return {ok:true,state:{status:'idle',events:[],logs:[],pending:null}};
        },
      };
    },{reject,inconsistent});
    await page.goto('https://desktop.test/desktop/ui/index.html');
    await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.body.dataset.aiReady==='true');
    await page.locator('#open-settings').click();
    return {browser,page};
  }catch(error){await browser.close();throw error;}
}

test('desktop mode switch waits for asynchronous committed radio state', {skip:!playwright},async()=>{
  const {browser,page}=await openDesktop();
  try{
    await selectCommittedAIMode(page,'api');
    assert.equal(await page.locator('input[name="ai-mode"][value="api"]').isChecked(),true);
    assert.equal(await page.evaluate(()=>window.__desktopTest.switches),1);
    assert.equal(await page.locator('#chat-base-url').isVisible(),true);
  }finally{await browser.close();}
});

test('desktop mode switch fails when persistence rejects the change', {skip:!playwright},async()=>{
  const {browser,page}=await openDesktop({reject:true});
  try{
    await assert.rejects(selectCommittedAIMode(page,'api',{timeout:1000}),/Timeout/);
    assert.equal(await page.locator('#ai-feedback').textContent(),'模拟保存失败');
    assert.equal(await page.evaluate(()=>window.__desktopTest.switches),1,'never retry rejected state changes');
  }finally{await browser.close();}
});

test('desktop mode switch verifies stored mode independently of rendered success', {skip:!playwright},async()=>{
  const {browser,page}=await openDesktop({inconsistent:true});
  try{
    await assert.rejects(selectCommittedAIMode(page,'api'),/AI mode was not committed/);
  }finally{await browser.close();}
});
