// Render the existing app mark and actual extension UI; no private room images.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=resolve(import.meta.dirname,'..'),icons=join(root,'extension/icons'),store=join(root,'store/assets');
await mkdir(icons,{recursive:true});await mkdir(store,{recursive:true});
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="30" fill="#ffa477"/><g stroke="#35241c" stroke-width="7" stroke-linecap="round" transform="rotate(14 64 64)"><path d="M43 53v22M57 39v50M71 46v36M85 57v17"/></g></svg>`;
await writeFile(join(icons,'source.svg'),svg);
const browser=await chromium.launch({headless:true,executablePath:process.env.LIVE_COMPANION_BROWSER});
try{
 const page=await browser.newPage();
 for(const size of [16,32,48,128]){
   await page.setViewportSize({width:size,height:size});
   await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
   await page.screenshot({path:join(icons,`icon-${size}.png`),omitBackground:true});
 }
 await page.setViewportSize({width:440,height:280});
 await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#151b1d;height:280px;display:grid;place-items:center;overflow:hidden}.scene{width:380px;height:230px;position:relative}.mark{position:absolute;width:170px;height:170px;left:10px;top:27px}.bubble{position:absolute;right:4px;top:43px;width:180px;height:90px;border-radius:24px;background:#2a3337;border:1px solid #596461;display:flex;align-items:center;justify-content:center;gap:12px}.bubble:after{content:'';position:absolute;left:20px;bottom:-12px;border-top:15px solid #2a3337;border-right:17px solid transparent}.bubble i{width:11px;height:11px;border-radius:50%;background:#ffa477}.wave{position:absolute;right:28px;bottom:25px;display:flex;align-items:center;gap:9px;height:45px}.wave b{width:6px;border-radius:8px;background:#bed9c5;height:20px}.wave b:nth-child(2n){height:40px}.wave b:nth-child(3n){height:30px}</style><div class=scene><div class=mark>${svg}</div><div class=bubble><i></i><i></i><i></i></div><div class=wave><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div></div>`);
 await page.screenshot({path:join(store,'promo-440x280.png')});
}finally{await browser.close();}
const ext=join(root,'extension');
const context=await chromium.launchPersistentContext('',{headless:true,channel:'chromium',executablePath:process.env.LIVE_COMPANION_BROWSER,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],viewport:{width:1280,height:800}});
try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const id=new URL(worker.url()).host;const page=await context.newPage();
 await page.goto(`chrome-extension://${id}/sidepanel.html`);await page.waitForLoadState('networkidle');
 await page.screenshot({path:join(store,'screenshot-companion-1280x800.png')});
 await page.locator('#open-settings').click();
 await page.screenshot({path:join(store,'screenshot-settings-1280x800.png')});
}finally{await context.close();}
console.log('Rendered icon PNGs, 440x280 promotion and two actual 1280x800 extension screenshots.');
