import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const parts=await Promise.all(['desktop/room-preload.cjs','extension/content.js'].map(path=>readFile(join(root,path),'utf8')));
await mkdir(join(root,'desktop/generated'),{recursive:true});
await writeFile(join(root,'desktop/generated/room-preload.cjs'),parts.join('\n'),'utf8');
// ICO can contain PNG frames directly. Preserve the shared app artwork without
// introducing a platform-specific image converter into the build.
const sizes=[16,32,48,128,256];
const frames=await Promise.all(sizes.map(size=>readFile(join(root,size===256?'desktop/assets/icon-256.png':`extension/icons/icon-${size}.png`))));
const header=Buffer.alloc(6+16*frames.length);
header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
let offset=header.length;
frames.forEach((frame,index)=>{
  const entry=6+index*16;header[entry]=sizes[index]%256;header[entry+1]=sizes[index]%256;
  header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);
  header.writeUInt32LE(frame.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=frame.length;
});
await writeFile(join(root,'desktop/generated/app.ico'),Buffer.concat([header,...frames]));
console.log('Built isolated room preload and Windows application icon.');
