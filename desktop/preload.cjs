const {contextBridge,ipcRenderer}=require('electron');
const subscribe=channel=>callback=>{
  if(typeof callback!=='function')return ()=>{};
  const listener=(_event,data)=>callback(data);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
};
contextBridge.exposeInMainWorld('desktopAPI',Object.freeze({
  command:(type,payload={})=>ipcRenderer.invoke('companion-command',{type,payload}),
  onState:subscribe('companion-state'),
  onCapture:subscribe('companion-capture'),
  onRoomStatus:subscribe('companion-room-status'),
  captureEvent:(type,payload={})=>ipcRenderer.send('companion-capture-event',{type,payload}),
  getVersion:()=>ipcRenderer.invoke('companion-version'),
}));
