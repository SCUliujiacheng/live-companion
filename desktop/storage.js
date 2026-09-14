import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_SETTINGS,normalizeSettings,splitSettings} from '../extension/core/settings.js';

export function createSettingsStore(directory, encryption) {
  const path=join(directory,'settings.json');
  let current=null;
  return {
    async loadSettings(){
      if(current)return normalizeSettings(current);
      let record;
      try{record=JSON.parse(await readFile(path,'utf8'));}
      catch(error){if(error.code==='ENOENT')return normalizeSettings(DEFAULT_SETTINGS);throw new Error('本机设置无法读取，请关闭程序后备份或重置设置文件');}
      let keys={};
      if(record.encryptedKeys){
        try{keys=JSON.parse(encryption.decryptString(Buffer.from(record.encryptedKeys,'base64')));}
        catch{throw new Error('保存的密钥无法解密，请清除本机设置后重新填写');}
      }
      current=normalizeSettings({...record.settings,chat:{...record.settings?.chat,apiKey:keys.chatApiKey||''},transcription:{...record.settings?.transcription,apiKey:keys.transcriptionApiKey||''}});
      return normalizeSettings(current);
    },
    async saveSettings(value){
      const settings=normalizeSettings(value),{publicSettings,secrets}=splitSettings(settings);
      const record={version:1,settings:publicSettings};
      if(settings.rememberKeys){
        if(!encryption.isEncryptionAvailable())throw new Error('系统密钥加密不可用，请取消“记住 API Key”后重试');
        record.encryptedKeys=encryption.encryptString(JSON.stringify(secrets)).toString('base64');
      }
      await mkdir(directory,{recursive:true});
      await writeFile(path+'.tmp',JSON.stringify(record),{encoding:'utf8',mode:0o600});
      await rename(path+'.tmp',path);
      current=settings;
    },
    async clearSettings(){
      current=null;
      await rm(path,{force:true});
      await rm(path+'.tmp',{force:true});
    },
  };
}
