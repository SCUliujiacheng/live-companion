import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSettingsStore} from '../desktop/storage.js';
import {DEFAULT_SETTINGS} from '../extension/core/settings.js';
const cipher={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text).map(b=>b^0x71),decryptString:bytes=>Buffer.from(bytes).map(b=>b^0x71).toString()};
async function fixture(fn){const path=await mkdtemp(join(tmpdir(),'companion-store-'));try{await fn(path);}finally{await rm(path,{recursive:true,force:true});}}
const config=rememberKeys=>({...DEFAULT_SETTINGS,rememberKeys,chat:{...DEFAULT_SETTINGS.chat,apiKey:'test-chat-private'},transcription:{...DEFAULT_SETTINGS.transcription,apiKey:'test-audio-private'}});
test('desktop secrets remain only in memory by default, while non-secret settings survive restart',()=>fixture(async path=>{
  const store=createSettingsStore(path,cipher);await store.saveSettings(config(false));
  assert.equal((await store.loadSettings()).chat.apiKey,'test-chat-private');
  assert.doesNotMatch(await readFile(join(path,'settings.json'),'utf8'),/test-chat-private|test-audio-private/);
  assert.equal((await createSettingsStore(path,cipher).loadSettings()).chat.apiKey,'');
}));
test('remembered keys encrypt, reload, and disappear from disk after opt-out',()=>fixture(async path=>{
  const store=createSettingsStore(path,cipher);await store.saveSettings(config(true));
  assert.doesNotMatch(await readFile(join(path,'settings.json'),'utf8'),/test-chat-private|test-audio-private/);
  assert.equal((await createSettingsStore(path,cipher).loadSettings()).transcription.apiKey,'test-audio-private');
  await store.saveSettings(config(false));
  assert.equal(JSON.parse(await readFile(join(path,'settings.json'),'utf8')).encryptedKeys,undefined);
}));
test('desktop refuses unencrypted persistent secrets and clearing removes settings',()=>fixture(async path=>{
  const store=createSettingsStore(path,{...cipher,isEncryptionAvailable:()=>false});
  await assert.rejects(store.saveSettings(config(true)),/加密不可用/);
  await store.saveSettings(config(false));await store.clearSettings();
  assert.equal((await store.loadSettings()).chat.apiKey,'');
  await assert.rejects(readFile(join(path,'settings.json')),/ENOENT/);
}));
