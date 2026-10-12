// Run only on a disposable Windows CI runner after `npm run desktop:dist`.
// Installs/uninstalls the actual NSIS artifact, then launches the portable EXE.
// No login, real room, microphone, API key, or external messages are involved.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { connectInspector } from './lib/package-inspector.mjs';
import { createServer } from 'node:net';
import { appendFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

assert.equal(process.platform, 'win32', 'Windows package acceptance must run on Windows; this is not a cross-platform substitute');
const root = resolve(import.meta.dirname, '..');
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  if (at < 0) return fallback;
  assert.ok(process.argv[at + 1] && !process.argv[at + 1].startsWith('--'), `${name} requires a path`);
  return resolve(process.argv[at + 1]);
};
const dist = option('--dist', join(root, 'dist-desktop'));
const directory = option('--directory', join(tmpdir(), 'live-companion-speech-model-cache'));
const fixture = option('--wav', join(root, 'tests/fixtures/chinese-speech.wav'));
const output = join(root, 'output/windows-package');
const temporary = await mkdtemp(join(tmpdir(), 'live-companion-package-smoke-'));
const installation = join(temporary, 'installed');
const report = { ok: false, platform: process.platform, architecture: process.arch, checks: [], applications: [] };
const run = promisify(execFile);
const exists = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const waitUntil = async (predicate, message, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(done => setTimeout(done, 300));
  }
};
let uninstaller, uninstalled = false;
await mkdir(output, { recursive: true });
async function stage(name) {
  report.stage = name;
  (report.stages ??= []).push({ name, at: new Date().toISOString() });
  console.log(`[${new Date().toISOString()}] ${name}`);
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
}
async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function localPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function inspectorEndpoint(port, child, browser = false) {
  let endpoint;
  await waitUntil(async () => {
    assert.equal(child.exitCode, null, 'application exited before inspector became ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/${browser ? 'version' : 'list'}`, { signal: AbortSignal.timeout(1000) });
      const data = await response.json();
      endpoint = browser ? data.webSocketDebuggerUrl : data.find(target => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
      return Boolean(endpoint);
    } catch { return false; }
  }, `${browser ? 'Chromium CDP' : 'Node inspector'} did not become ready`, 180000);
  return endpoint;
}

// This function is serialized into the packaged Electron main process. All
// implementation and native modules are loaded from its own resources, never
// the checkout's node_modules. Only the public test WAV and model cache are inputs.
async function packagedSpeech({ app }, { directory, fixture, allowDownload }) {
  const { join } = process.getBuiltinModule('node:path');
  const { pathToFileURL } = process.getBuiltinModule('node:url');
  const { readFile } = process.getBuiltinModule('node:fs/promises');
  // Inspector-evaluated functions have no default dynamic-import callback.
  // Give this local import the actual application's loader explicitly.
  const { compileFunction, constants } = process.getBuiltinModule('node:vm');
  const load = compileFunction('return import(specifier)', ['specifier'], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const moduleURL = pathToFileURL(join(app.getAppPath(), 'desktop/local-speech.js')).href;
  const { createLocalSpeech, LOCAL_SPEECH_MODEL } = await load(moduleURL);
  const blob = new Blob([await readFile(fixture)], { type: 'audio/wav' });
  const assertChinese = text => {
    if (!/功能/.test(text) || !/模型/.test(text) || !/强大|強大/.test(text)) throw new Error(`Packaged Chinese ASR assertion failed: ${text}`);
  };
  let speech = createLocalSpeech({ directory });
  const started = Date.now();
  let timer, ticks = 0;
  try {
    if (allowDownload) await speech.prepare();
    timer = setInterval(() => ticks++, 20);
    const text = await speech.transcribe(blob);
    assertChinese(text);
    if (ticks < 3) throw new Error('Expected main event loop to remain responsive during packaged CPU inference');
    await speech.close();
    // Reconstruct the service without prepare(): this path strictly forbids
    // downloads, so it also tests packaged worker restart and offline loading.
    speech = createLocalSpeech({ directory });
    const offlineText = await speech.transcribe(blob);
    assertChinese(offlineText);
    return { text, offlineText, model: LOCAL_SPEECH_MODEL.id, revision: LOCAL_SPEECH_MODEL.revision,
      milliseconds: Date.now() - started, mainEventLoopTicks: ticks, moduleURL };
  } finally { clearInterval(timer); await speech.close(); }
}

async function launchAndCheck(executablePath, label, allowDownload) {
  const profile = join(temporary, `${label}-profile`);
  assert.equal(await exists(profile), false, 'acceptance starts with a genuinely fresh userData directory');
  await mkdir(profile);
  const env = { ...process.env, LIVE_COMPANION_PACKAGE_SMOKE: '1', LIVE_COMPANION_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const nodePort = await localPort();
  let browserPort = await localPort();
  while (browserPort === nodePort) browserPort = await localPort();
  const logPath = join(output, `${label}-stderr.log`);
  await writeFile(logPath, '');
  let browser, inspector, child, ended, exited = false;
  try {
    await stage(`${label}: launch actual executable`);
    // Launch the real portable wrapper too. NSIS does not inherit stderr into
    // its child, so debugger discovery uses explicit loopback ports instead.
    child = spawn(executablePath, [`--inspect=127.0.0.1:${nodePort}`, `--remote-debugging-port=${browserPort}`,
      '--remote-debugging-address=127.0.0.1', '--package-smoke'], { cwd: temporary, env, windowsHide: true });
    child.stderr.on('data', bytes => appendFileSync(logPath, bytes));
    ended = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    ended.catch(() => {}); // An early spawn error is surfaced by the attach race.
    const endpoint = await Promise.race([inspectorEndpoint(nodePort, child), ended.then(result => { throw new Error(`Application exited before attach: ${JSON.stringify(result)}`); })]);
    inspector = await connectInspector(endpoint);
    const evaluate = (fn, argument, timeout = 30000) => inspector.evaluate(`(${fn.toString()})(process.getBuiltinModule('node:module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron'),${JSON.stringify(argument) ?? 'undefined'})`, { timeout });
    await stage(`${label}: attach UI and verify preload`);
    // Node's inspector appears before Chromium finishes startup. A single
    // connectOverCDP HTTP lookup does not retry ECONNREFUSED, so poll readiness.
    const browserEndpoint = await inspectorEndpoint(browserPort, child, true);
    browser = await chromium.connectOverCDP(browserEndpoint, { timeout: 60000 });
    const context = browser.contexts()[0];
    context.setDefaultTimeout(30000);
    let ui;
    await waitUntil(async () => {
      ui = context.pages().find(page => page.url() === 'companion://app/desktop/ui/index.html');
      return Boolean(ui);
    }, 'packaged local UI did not open', 60000);
    const errors = [];
    ui.on('pageerror', error => errors.push(error.message));
    await ui.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 60000 });
    assert.equal(await ui.evaluate(() => typeof window.require), 'undefined', 'privileged UI is sandboxed');
    const version = await ui.evaluate(() => window.desktopAPI.getVersion());
    assert.match(version, /^\d+\.\d+\.\d+/);
    await ui.locator('#open-settings').click();
    await ui.waitForFunction(() => document.body.dataset.aiReady === 'true');
    const state = await ui.evaluate(() => window.desktopAPI.command('ai-get-state'));
    assert.equal(state.ok, true, 'real preload and allowlisted IPC work from packaged UI');
    const info = await evaluate(({ app, BrowserWindow, webContents }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
      executable: process.execPath, resources: process.resourcesPath,
      portableFile: process.env.PORTABLE_EXECUTABLE_FILE || '',
      pages: webContents.getAllWebContents().map(contents => ({ url: contents.getURL(), api: contents.getType() })),
      preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    }));
    assert.equal(info.isPackaged, true);
    assert.equal(resolve(info.userData), resolve(profile));
    assert.match(info.appPath, /[\\/]resources[\\/]app\.asar$/);
    assert.equal(info.preferences.contextIsolation, true);
    assert.equal(info.preferences.sandbox, true);
    assert.equal(info.preferences.nodeIntegration, false);
    assert.ok(info.pages.every(page => !/^https?:/.test(page.url)), 'no external page is visited in acceptance mode');
    if (label === 'installed') assert.equal(resolve(dirname(info.executable)), resolve(installation));
    else assert.equal(resolve(info.portableFile), resolve(executablePath), 'actual NSIS portable wrapper launched this process');
    const worker = join(info.resources, 'app.asar.unpacked/desktop/local-speech-worker.js');
    assert.equal(await exists(worker), true, 'actual worker is unpacked outside ASAR');
    assert.equal(await exists(join(info.resources, 'app.asar.unpacked/node_modules/onnxruntime-node/bin')), true, 'ONNX runtime shipped with application');
    await stage(`${label}: real packaged Chinese ASR and offline restart`);
    const speech = await evaluate(packagedSpeech, { directory, fixture, allowDownload }, 240000);
    await ui.screenshot({ path: join(output, `${label}.png`) });
    assert.deepEqual(errors, [], 'packaged UI has no uncaught page errors');
    report.applications.push({ label, version, executable: basename(executablePath), speech,
      checks: ['fresh userData', 'packaged privileged UI and IPC', 'sandbox and context isolation',
        'unpacked worker and ONNX', 'real Chinese CPU ASR', 'offline service restart'] });
    await stage(`${label}: request graceful close and detach inspector`);
    // Exercise the real application window handler, then detach the inspector
    // BEFORE awaiting process exit: an attached Node debugger prevents exit.
    await evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 0); return true; });
    await inspector.close(); inspector = null;
    const result = await bounded(ended, 30000, `${label}: application did not exit after debugger detach`);
    assert.equal(result.code, 0, `application exited unsuccessfully: ${JSON.stringify(result)}`);
    report.applications.at(-1).checks.push('graceful window close');
    report.checks.push(`${label}: launch, UI, worker, real ASR, offline restart, close`);
    await stage(`${label}: graceful exit verified`);
  } finally {
    await inspector?.close().catch(error => { report.inspectorCleanupError = error.message; });
    if (browser) await bounded(browser.close(), 10000, 'CDP cleanup timed out').catch(error => { report.browserCleanupError = error.message; });
    if (child && !exited) {
      // Only our launched process tree is eligible for failure cleanup.
      await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true }).catch(error => { report.processCleanupError = error.message; });
      await bounded(ended, 10000, 'process cleanup timed out').catch(() => {});
    }
  }
}

try {
  const names = await readdir(dist);
  const select = pattern => {
    const matches = names.filter(name => pattern.test(name));
    assert.equal(matches.length, 1, `Expected exactly one current artifact matching ${pattern}; clean dist-desktop before building`);
    return join(dist, matches[0]);
  };
  const setup = select(/^LiveCompanion-Setup-.*-x64\.exe$/);
  const portable = select(/^LiveCompanion-Portable-.*-x64\.exe$/);
  await readFile(fixture);
  // NSIS /D must be last and unquoted, even for a path containing spaces.
  // /S suppresses runAfterFinish in electron-builder's one-click template.
  await stage('NSIS: silent install');
  await run(setup, ['/S', `/D=${installation}`], { timeout: 180000, windowsHide: true, windowsVerbatimArguments: true });
  const installedFiles = await readdir(installation);
  const uninstallName = installedFiles.find(name => /^Uninstall.*\.exe$/i.test(name));
  assert.ok(uninstallName, 'NSIS installed an uninstaller');
  uninstaller = join(installation, uninstallName);
  const executables = installedFiles.filter(name => name.endsWith('.exe') && name !== uninstallName);
  assert.equal(executables.length, 1, 'NSIS installed one application executable');
  const installedExecutable = join(installation, executables[0]);
  report.checks.push('silent NSIS install into isolated directory');
  await launchAndCheck(installedExecutable, 'installed', true);
  await stage('NSIS: silent uninstall');
  await run(uninstaller, ['/S'], { timeout: 180000, windowsHide: true });
  await waitUntil(async () => !(await exists(installedExecutable)) && !(await exists(join(installation, 'resources/app.asar'))), 'NSIS uninstall did not remove application files');
  uninstalled = true;
  report.checks.push('silent NSIS uninstall removes executable and app resources');
  await launchAndCheck(portable, 'portable', false);
  report.ok = true;
  report.limits = ['No real ChatGPT/Bilibili login, quota or live-room message', 'No physical Windows audio device or live capture acceptance', 'No code signature/SmartScreen reputation assertion'];
  await stage('acceptance complete');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack || String(error);
  await stage('acceptance failed');
  throw error;
} finally {
  if (uninstaller && !uninstalled && await exists(uninstaller)) {
    await run(uninstaller, ['/S'], { timeout: 180000, windowsHide: true }).catch(error => { report.cleanupError = error.message; });
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('live-companion-package-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
