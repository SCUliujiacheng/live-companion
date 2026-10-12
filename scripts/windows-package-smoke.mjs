// Run only on a disposable Windows CI runner after `npm run desktop:dist`.
// Installs/uninstalls the actual NSIS artifact, then launches the portable EXE.
// No login, real room, microphone, API key, or external messages are involved.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { execFile } from 'node:child_process';
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
let application, uninstaller, uninstalled = false;
await mkdir(output, { recursive: true });

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
  const logs = [];
  try {
    application = await _electron.launch({ executablePath, args: ['--package-smoke'], cwd: temporary, env, timeout: 180000 });
    application.process().stderr?.on('data', bytes => logs.push(bytes.toString()));
    const ui = await application.firstWindow();
    const errors = [];
    ui.on('pageerror', error => errors.push(error.message));
    await ui.waitForFunction(() => document.body.dataset.ready === 'true', undefined, { timeout: 60000 });
    assert.equal(ui.url(), 'companion://app/desktop/ui/index.html');
    assert.equal(await ui.evaluate(() => typeof window.require), 'undefined', 'privileged UI is sandboxed');
    const version = await ui.evaluate(() => window.desktopAPI.getVersion());
    assert.match(version, /^\d+\.\d+\.\d+/);
    await ui.locator('#open-settings').click();
    await ui.waitForFunction(() => document.body.dataset.aiReady === 'true');
    const state = await ui.evaluate(() => window.desktopAPI.command('ai-get-state'));
    assert.equal(state.ok, true, 'real preload and allowlisted IPC work from packaged UI');
    const info = await application.evaluate(({ app, BrowserWindow, webContents }) => ({
      isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
      executable: process.execPath, resources: process.resourcesPath,
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
    const worker = join(info.resources, 'app.asar.unpacked/desktop/local-speech-worker.js');
    assert.equal(await exists(worker), true, 'actual worker is unpacked outside ASAR');
    const nativeDirectory = join(info.resources, 'app.asar.unpacked/node_modules/onnxruntime-node/bin');
    assert.equal(await exists(nativeDirectory), true, 'ONNX runtime shipped with application');
    const speech = await application.evaluate(packagedSpeech, { directory, fixture, allowDownload });
    await ui.screenshot({ path: join(output, `${label}.png`) });
    assert.deepEqual(errors, [], 'packaged UI has no uncaught page errors');
    // Exercise the application's own close handler, not a forced process kill.
    const closed = application.waitForEvent('close', { timeout: 30000 });
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await closed;
    application = null;
    report.applications.push({ label, version, executable: basename(executablePath), speech,
      checks: ['fresh userData', 'packaged privileged UI and IPC', 'sandbox and context isolation',
        'unpacked worker and ONNX', 'real Chinese CPU ASR', 'offline service restart', 'graceful window close'] });
    report.checks.push(`${label}: launch, UI, worker, real ASR, offline restart, close`);
  } finally {
    if (application) { await application.close().catch(() => {}); application = null; }
    await writeFile(join(output, `${label}-stderr.log`), logs.join(''));
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
  await run(uninstaller, ['/S'], { timeout: 180000, windowsHide: true });
  await waitUntil(async () => !(await exists(installedExecutable)) && !(await exists(join(installation, 'resources/app.asar'))), 'NSIS uninstall did not remove application files');
  uninstalled = true;
  report.checks.push('silent NSIS uninstall removes executable and app resources');
  await launchAndCheck(portable, 'portable', false);
  report.ok = true;
  report.limits = ['No real ChatGPT/Bilibili login, quota or live-room message', 'No physical Windows audio device or live capture acceptance', 'No code signature/SmartScreen reputation assertion'];
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack || String(error);
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
