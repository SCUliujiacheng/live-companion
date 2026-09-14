import { lstat, readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// New release assets require an explicit entry; no caches, backups or key files.
const REQUIRED_FILES = [
  'manifest.json', 'background.js', 'content.js', 'offscreen.js', 'offscreen.html',
  'sidepanel.js', 'sidepanel.html', 'sidepanel.css', 'core/settings.js',
  'core/provider.js', 'core/policy.js', 'core/engine.js', 'audio/capture.js',
  'audio/pcm-worklet.js', 'audio/wav.js',
];
const ICON_FILES = [16, 32, 48, 128].map(size => `icons/icon-${size}.png`);
const APPROVED_FILES = new Set([...REQUIRED_FILES, ...ICON_FILES, 'LICENSE']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DOS_DATE = 0x21; // ZIP's earliest valid date: 1980-01-01, 00:00:00.
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safePath(name) {
  if (typeof name !== 'string' || !name || /[\\:\u0000-\u001f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`Unsafe package path: ${String(name)}`);
  }
  return name;
}

export function buildZip(entries, { prefix = '' } = {}) {
  if (prefix) safePath(prefix.replace(/\/$/, ''));
  if (prefix && !prefix.endsWith('/')) throw new Error('ZIP prefix path must end with /');
  const sorted = [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (sorted.length > 0xffff) throw new Error('ZIP entry limit exceeded');
  const names = new Set();
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of sorted) {
    safePath(entry.name);
    if (names.has(entry.name)) throw new Error(`Duplicate ZIP path: ${entry.name}`);
    names.add(entry.name);
    const bytes = Buffer.from(entry.bytes);
    const name = Buffer.from(prefix + entry.name, 'utf8');
    if (name.length > 0xffff || bytes.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP32 size limit exceeded');
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8; store method and no data descriptor.
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const size = central.reduce((sum, bytes) => sum + bytes.length, 0);
  if (offset > 0xffffffff || size > 0xffffffff) throw new Error('ZIP32 size limit exceeded');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function manifestPaths(manifest) {
  const paths = [
    manifest.background?.service_worker, manifest.side_panel?.default_path,
    manifest.action?.default_popup, manifest.options_page, manifest.options_ui?.page,
    manifest.devtools_page,
  ].filter(Boolean);
  for (const icons of [manifest.icons, manifest.action?.default_icon]) {
    if (typeof icons === 'string') paths.push(icons);
    else if (icons && typeof icons === 'object') paths.push(...Object.values(icons));
  }
  for (const content of manifest.content_scripts ?? []) paths.push(...(content.js ?? []), ...(content.css ?? []));
  paths.push(...Object.values(manifest.chrome_url_overrides ?? {}));
  return paths;
}

async function loadApprovedFile(sourceDir, realSourceDir, name, { optional = false } = {}) {
  safePath(name);
  if (!APPROVED_FILES.has(name)) throw new Error(`Manifest path is not approved for packaging: ${name}`);
  const path = join(sourceDir, name);
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`Required package file is missing: ${name}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Package file must be a regular file: ${name}`);
  const actualPath = await realpath(path);
  const inside = relative(realSourceDir, actualPath);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`Package path escapes the extension source: ${name}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Package file is unexpectedly large: ${name}`);
  const bytes = await readFile(path);
  if (/\.(?:js|json|css|html)$/.test(name)) {
    const text = bytes.toString('utf8');
    if (/\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{24,}\b/.test(text) || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`Possible embedded secret in approved source file: ${name}`);
    }
  }
  return { name, bytes };
}

export async function buildPackages({ sourceDir = join(root, 'extension'), outputDir = join(root, 'dist') } = {}) {
  sourceDir = resolve(sourceDir);
  outputDir = resolve(outputDir);
  const realSourceDir = await realpath(sourceDir);
  const manifestEntry = await loadApprovedFile(sourceDir, realSourceDir, 'manifest.json');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  if (manifest.manifest_version !== 3) throw new Error('Only Manifest V3 packages are supported');
  const required = new Set([...REQUIRED_FILES, ...manifestPaths(manifest)]);
  for (const name of required) {
    safePath(name);
    if (!APPROVED_FILES.has(name)) throw new Error(`Manifest path is not approved for packaging: ${name}`);
  }
  const entries = [manifestEntry];
  for (const name of [...APPROVED_FILES].sort()) {
    if (name === 'manifest.json') continue;
    const entry = await loadApprovedFile(sourceDir, realSourceDir, name, { optional: !required.has(name) });
    if (entry) entries.push(entry);
  }
  if (entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > MAX_TOTAL_BYTES) throw new Error('Extension package is unexpectedly large');
  // Validate and assemble both archives before either output is written.
  const manualBytes = buildZip(entries, { prefix: 'live-companion/' });
  const storeBytes = buildZip(entries);
  const manualPath = join(outputDir, 'live-companion.zip');
  const storePath = join(outputDir, 'live-companion-chrome-web-store.zip');
  await mkdir(outputDir, { recursive: true });
  await writeFile(manualPath, manualBytes);
  await writeFile(storePath, storeBytes);
  return { manualPath, storePath, entryCount: entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPackages();
  console.log(`Packaged ${result.entryCount} approved extension files in each archive:`);
  console.log(`  ${relative(root, result.manualPath)}`);
  console.log(`  ${relative(root, result.storePath)}`);
}
