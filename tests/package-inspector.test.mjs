import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connectInspector } from '../scripts/lib/package-inspector.mjs';

const delay = ms => new Promise(done => setTimeout(done, ms));
test('real inspector detaches before waiting for graceful process exit', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ['--input-type=module', '--inspect=127.0.0.1:0', '-e', 'globalThis.keepAlive=setInterval(()=>{},1000); console.log("READY")']);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '', ready = false;
  child.stdout.on('data', bytes => { if (String(bytes).includes('READY')) ready = true; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  for (let count = 0; count < 200 && (!ready || !stderr.includes('ws://')); count++) await delay(20);
  assert.equal(ready, true);
  const endpoint = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/)?.[0];
  assert.ok(endpoint);
  const inspector = await connectInspector(endpoint);
  t.after(() => inspector.close());
  assert.equal(await inspector.evaluate('21*2'), 42);
  assert.equal(await inspector.evaluate("process.getBuiltinModule('node:module').createRequire(process.cwd()+'/package.json')('node:path').basename('/check/success')"), 'success', 'explicit require works in an ESM application inspector');
  await assert.rejects(inspector.evaluate('Promise.reject(new Error("expected failure"))'), /expected failure/);
  await assert.rejects(inspector.evaluate('new Promise(() => {})', { timeout: 40 }), /timed out/);
  assert.equal(await inspector.evaluate('setTimeout(()=>clearInterval(globalThis.keepAlive),0); true'), true, 'close request responds before the scheduled shutdown');
  for (let count = 0; count < 100 && !stderr.includes('Waiting for the debugger to disconnect'); count++) await delay(20);
  assert.equal(child.exitCode, null, 'attached inspector reproduces original acceptance deadlock');
  assert.match(stderr, /Waiting for the debugger to disconnect/);
  await inspector.close();
  assert.deepEqual(await ended, { code: 0, signal: null });
});

test('inspector rejects remote endpoints before attempting connection', async () => {
  await assert.rejects(connectInspector('ws://example.com/inspector'), /must be local/);
});
