const { app, BrowserWindow, WebContentsView, session, protocol } = require('electron');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const root = process.argv[process.argv.indexOf('--smoke-root') + 1];
const profile = process.argv[process.argv.indexOf('--smoke-profile') + 1];
if (!root || !profile) throw new Error('Audio smoke fixture requires explicit root and temporary profile paths');
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: 'audio-smoke', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

globalThis.audioSmoke = { ready: null, permissionLog: [] };
globalThis.audioSmoke.ready = app.whenReady().then(async () => {
  const trustedSession = session.fromPartition('persist:audio-smoke-trusted');
  const sourceSession = session.fromPartition('persist:audio-smoke-source');
  const otherSession = session.fromPartition('persist:audio-smoke-other');
  const fixtureDir = __dirname;
  const allowed = new Map([
    ['/receiver.html', [path.join(fixtureDir, 'receiver.html'), 'text/html']],
    ['/receiver.js', [path.join(fixtureDir, 'receiver.js'), 'text/javascript']],
    ...['capture.js', 'pcm-worklet.js', 'wav.js'].map(name => [`/extension/audio/${name}`, [path.join(root, 'extension/audio', name), 'text/javascript']]),
  ]);
  trustedSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    const file = url.hostname === 'capture.audio-smoke.invalid' && allowed.get(url.pathname);
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(await readFile(file[0]), { headers: { 'content-type': file[1] } });
  });
  const sourceHtml = await readFile(path.join(fixtureDir, 'source.html'));
  for (const ses of [sourceSession, otherSession]) {
    ses.protocol.handle('https', request => new URL(request.url).hostname.endsWith('.audio-smoke.invalid')
      ? new Response(sourceHtml, { headers: { 'content-type': 'text/html' } })
      : new Response('External networking disabled', { status: 403 }));
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => { globalThis.audioSmoke.permissionLog.push({ sourceSession: true, phase: 'request', permission, details }); callback(false); });
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => { globalThis.audioSmoke.permissionLog.push({ sourceSession: true, phase: 'check', permission, origin, details }); return false; });
  }
  const preferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false };
  const receiver = new BrowserWindow({ show: false, webPreferences: { ...preferences, session: trustedSession } });
  trustedSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    globalThis.audioSmoke.permissionLog.push({ phase: 'request', permission, receiver: wc === receiver.webContents, details });
    callback(wc === receiver.webContents && permission === 'media');
  });
  trustedSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    globalThis.audioSmoke.permissionLog.push({ phase: 'check', permission, receiver: wc === receiver.webContents, requestingOrigin, details });
    return wc === receiver.webContents && permission === 'media';
  });
  const host = new BrowserWindow({ show: false, webPreferences: preferences });
  const source = new WebContentsView({ webPreferences: { ...preferences, session: sourceSession } });
  const other = new WebContentsView({ webPreferences: { ...preferences, session: otherSession } });
  host.contentView.addChildView(source);
  host.contentView.addChildView(other);
  source.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  other.setBounds({ x: 400, y: 0, width: 400, height: 300 });
  Object.assign(globalThis.audioSmoke, { receiver, host, source, other });
  host.on('closed', () => {
    for (const view of [source, other]) if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  await Promise.all([
    receiver.loadURL('https://capture.audio-smoke.invalid/receiver.html'),
    source.webContents.loadURL('https://source.audio-smoke.invalid/'),
    other.webContents.loadURL('https://other.audio-smoke.invalid/'),
  ]);
  await source.webContents.executeJavaScript('window.startTone(440)', true);
  await other.webContents.executeJavaScript('window.startTone(880)', true);
  return true;
});
app.on('window-all-closed', () => app.quit());
