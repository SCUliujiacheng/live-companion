import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
async function scan(dir){const files=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())files.push(...await scan(path));else files.push(path);}return files;}
const files=await scan(join(root,'extension'));
const desktop=(await scan(join(root,'desktop'))).filter(f=>!f.includes(`${join('desktop','generated')}`));
const sources=[...files,...desktop].filter(f=>/\.(?:js|cjs)$/.test(f));
for(const path of sources)execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
const manifest=JSON.parse(await readFile(join(root,'extension/manifest.json'),'utf8'));
for(const relative of [manifest.background.service_worker,manifest.side_panel.default_path,'offscreen.html'])await readFile(join(root,'extension',relative));
if(manifest.manifest_version!==3)throw new Error('Expected MV3');
for(const path of files.filter(f=>f.endsWith('.html'))){const html=await readFile(path,'utf8');if(/<script(?![^>]*\bsrc=)[^>]*>\s*[^<]/i.test(html))throw new Error(`Inline script violates MV3 CSP: ${path}`);}
for(const path of ['desktop/main.js','desktop/preload.cjs','desktop/ui/index.html','desktop/ui/app.js'])await readFile(join(root,path));
console.log(`Validated manifest, desktop entry points, CSP and ${sources.length} JavaScript files.`);
