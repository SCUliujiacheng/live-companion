import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const parts=await Promise.all(['desktop/room-preload.cjs','extension/content.js'].map(path=>readFile(join(root,path),'utf8')));
await mkdir(join(root,'desktop/generated'),{recursive:true});
await writeFile(join(root,'desktop/generated/room-preload.cjs'),parts.join('\n'),'utf8');
console.log('Built isolated desktop room preload from the shared content adapter.');
