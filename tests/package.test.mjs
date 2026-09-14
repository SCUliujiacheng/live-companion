import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPackages, buildZip, crc32 } from '../scripts/package.mjs';

const coreFiles = [
  'manifest.json', 'background.js', 'content.js', 'offscreen.js', 'offscreen.html',
  'sidepanel.js', 'sidepanel.html', 'sidepanel.css', 'core/settings.js',
  'core/provider.js', 'core/policy.js', 'core/engine.js', 'audio/capture.js',
  'audio/pcm-worklet.js', 'audio/wav.js',
];
const iconFiles = [16, 32, 48, 128].map(size => `icons/icon-${size}.png`);

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'live-companion-package-'));
  t.after(async () => {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith('live-companion-package-'));
    await rm(temp, { recursive: true, force: true });
  });
  const sourceDir = join(temp, 'extension');
  const manifest = {
    manifest_version: 3, version: '0.1.0',
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'sidepanel.html' },
    icons: Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/icon-${size}.png`])),
    action: { default_icon: { 16: 'icons/icon-16.png' } },
  };
  for (const name of [...coreFiles, ...iconFiles].reverse()) {
    const path = join(sourceDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name === 'manifest.json' ? JSON.stringify(manifest) : `fixture:${name}\n`);
  }
  return { temp, sourceDir, outputDir: join(temp, 'dist'), manifest };
}

// Independent bit-by-bit reference; archive tests do not reuse the writer's CRC.
function referenceCrc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function inspectZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  let offset = bytes.readUInt32LE(end + 16);
  const centralStart = offset;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 8), 0x800);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    assert.equal(bytes.readUInt16LE(offset + 12), 0);
    assert.equal(bytes.readUInt16LE(offset + 14), 0x21); // 1980-01-01.
    const nameSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), 0x800);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt16LE(local + 10), 0);
    assert.equal(bytes.readUInt16LE(local + 12), 0x21);
    assert.equal(bytes.readUInt16LE(local + 26), nameSize);
    assert.equal(bytes.subarray(local + 30, local + 30 + nameSize).toString('utf8'), name);
    const size = bytes.readUInt32LE(local + 22);
    assert.equal(bytes.readUInt32LE(local + 18), size);
    assert.equal(bytes.readUInt32LE(offset + 20), size);
    assert.equal(bytes.readUInt32LE(offset + 24), size);
    const payload = bytes.subarray(local + 30 + nameSize, local + 30 + nameSize + size);
    assert.equal(payload.length, size);
    assert.equal(bytes.readUInt32LE(local + 14), referenceCrc(payload));
    assert.equal(bytes.readUInt32LE(offset + 16), referenceCrc(payload));
    assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'));
    entries.push({ name, payload });
    offset += 46 + nameSize + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  assert.equal(offset - centralStart, bytes.readUInt32LE(end + 12));
  return entries;
}

test('manual and Chrome Web Store ZIPs have correct roots, sorted entries, valid records, and deterministic bytes', async t => {
  const sample = await fixture(t);
  await buildPackages(sample);
  const manual = await readFile(join(sample.outputDir, 'live-companion.zip'));
  const store = await readFile(join(sample.outputDir, 'live-companion-chrome-web-store.zip'));
  const expected = [...coreFiles, ...iconFiles].sort();
  assert.deepEqual(inspectZip(manual).map(entry => entry.name), expected.map(name => `live-companion/${name}`));
  const storeEntries = inspectZip(store);
  assert.deepEqual(storeEntries.map(entry => entry.name), expected);
  assert.equal(JSON.parse(storeEntries.find(entry => entry.name === 'manifest.json').payload.toString()).manifest_version, 3);
  await utimes(join(sample.sourceDir, 'manifest.json'), new Date('2030-10-20'), new Date('2030-10-20'));
  await buildPackages({ ...sample, outputDir: join(sample.temp, 'another-dist') });
  assert.deepEqual(await readFile(join(sample.temp, 'another-dist', 'live-companion.zip')), manual);
  assert.deepEqual(await readFile(join(sample.temp, 'another-dist', 'live-companion-chrome-web-store.zip')), store);
});

test('packaging includes only approved extension files and excludes hidden, temporary, and key files', async t => {
  const sample = await fixture(t);
  const excluded = ['.env', 'secrets.json', 'api-keys.js', 'core/private-key.js', 'audio/private.wav', 'sidepanel.js.bak', 'icons/.DS_Store', 'icons/secret.png'];
  for (const name of excluded) await writeFile(join(sample.sourceDir, name), 'fixture-private-secret-do-not-package');
  await buildPackages(sample);
  for (const zip of ['live-companion.zip', 'live-companion-chrome-web-store.zip']) {
    const bytes = await readFile(join(sample.outputDir, zip));
    assert.equal(bytes.includes(Buffer.from('fixture-private-secret-do-not-package')), false);
    assert.equal(inspectZip(bytes).length, 19);
  }
});

test('manifest icons must exist and remain inside the approved package paths', async t => {
  const sample = await fixture(t);
  await rm(join(sample.sourceDir, 'icons/icon-16.png'));
  await assert.rejects(buildPackages(sample), /icon-16\.png/);
  sample.manifest.icons[16] = '../secret.png';
  await writeFile(join(sample.sourceDir, 'manifest.json'), JSON.stringify(sample.manifest));
  await assert.rejects(buildPackages(sample), /unsafe|approved|不安全|允许/i);
});

test('ZIP writer rejects ambiguous paths and CRC agrees with the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const name of ['../secret', '/absolute', 'C:/secret', 'a\\b', 'a/../b', './file', 'a//b']) {
    assert.throws(() => buildZip([{ name, bytes: Buffer.from('x') }]), /path|路径/i);
  }
  assert.throws(() => buildZip([{ name: 'x', bytes: Buffer.from('1') }, { name: 'x', bytes: Buffer.from('2') }]), /duplicate|重复/i);
});

test('obvious embedded provider keys are rejected even inside approved JavaScript files', async t => {
  const sample = await fixture(t);
  const fakeKey = `sk-proj-${'testfixture'.repeat(5)}`;
  await writeFile(join(sample.sourceDir, 'core/provider.js'), `const fixture = '${fakeKey}';`);
  await assert.rejects(buildPackages(sample), error => {
    assert.match(error.message, /Possible embedded secret/);
    assert.equal(error.message.includes(fakeKey), false);
    return true;
  });
});

test('approved filenames cannot escape through a linked source directory', async t => {
  const sample = await fixture(t);
  const audioDir = resolve(sample.sourceDir, 'audio');
  assert.ok(audioDir.startsWith(`${resolve(sample.sourceDir)}${sep}`));
  await rm(audioDir, { recursive: true });
  const outsideAudio = join(sample.temp, 'outside-audio');
  await mkdir(outsideAudio);
  for (const name of ['capture.js', 'pcm-worklet.js', 'wav.js']) await writeFile(join(outsideAudio, name), 'outside source content');
  await symlink(outsideAudio, audioDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPackages(sample), /escapes the extension source/);
});
