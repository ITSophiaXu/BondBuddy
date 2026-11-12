import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_TOOLS_ROOT = '/opt/pr-gate-browser-tools';
export const BROWSER_TOOLS_SCHEMA = 'pr-gate-browser-tools-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
  return (result.stdout + result.stderr).trim();
}

export function lddPaths(output) {
  const paths = [];
  for (const line of output.split(/\r?\n/).filter(row => row.trim())) {
    if (/linux-vdso/.test(line)) continue;
    const path = /^\s*(?:\S+\s+=>\s+)?(\/[^\s]+)\s+\(0x[a-f0-9]+\)\s*$/i.exec(line)?.[1];
    assert.ok(path, 'Unresolved or unrecognized ELF dependency: ' + line);
    paths.push(path);
  }
  assert.ok(paths.length > 0); return [...new Set(paths)].sort();
}

/** Export only existing runtime files from the immutable, offline worker image. */
export function exportBrowserTools(directory, imageId) {
  assert.equal(process.platform, 'linux'); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!existsSync(directory) || readdirSync(directory).length === 0, 'Never reuse a previous tool bundle');
  mkdirSync(directory, { recursive: true });
  const entries = new Map(), copiedNames = new Map();
  const add = (source, relative, executable = false) => {
    assert.match(relative, /^(bin|lib|tessdata|fonts)\/[a-zA-Z0-9_.+-]+$/);
    const original = realpathSync(source), bytes = readFileSync(original), sha256 = hash(bytes);
    assert.ok(lstatSync(original).isFile());
    if (copiedNames.has(relative)) { assert.equal(copiedNames.get(relative), sha256, 'Conflicting ELF library names'); return; }
    copiedNames.set(relative, sha256); mkdirSync(dirname(join(directory, relative)), { recursive: true });
    copyFileSync(original, join(directory, relative)); chmodSync(join(directory, relative), executable ? 0o755 : 0o644);
    entries.set(relative, { path: relative, source: original, sha256, executable });
  };
  const executable = '/usr/bin/tesseract', libraries = lddPaths(command('ldd', [executable]));
  // ldd resolves transitive DT_NEEDED entries; running it for each entry also
  // rejects unresolved dependencies of a library before the bundle is used.
  for (let index = 0; index < libraries.length; index++) {
    const library = libraries[index];
    if (!/\/ld(?:-linux|64)/.test(library)) for (const child of lddPaths(command('ldd', [library]))) if (!libraries.includes(child)) libraries.push(child);
  }
  const loaders = libraries.filter(path => /\/ld(?:-linux|64)/.test(path)); assert.equal(loaders.length, 1);
  for (const path of libraries) add(path, 'lib/' + basename(path), true);
  add(executable, 'bin/tesseract.bin', true);
  for (const language of ['eng', 'chi_sim', 'osd']) add(`/usr/share/tesseract-ocr/5/tessdata/${language}.traineddata`, `tessdata/${language}.traineddata`);
  add('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'fonts/NotoSansCJK-Regular.ttc');
  const wrapper = `#!/bin/sh\nexec '${BROWSER_TOOLS_ROOT}/lib/${basename(loaders[0])}' --library-path '${BROWSER_TOOLS_ROOT}/lib' '${BROWSER_TOOLS_ROOT}/bin/tesseract.bin' "$@"\n`;
  writeFileSync(join(directory, 'bin/tesseract'), wrapper, { mode: 0o755 });
  entries.set('bin/tesseract', { path: 'bin/tesseract', source: 'generated-explicit-loader-wrapper', sha256: hash(wrapper), executable: true });
  const manifest = { schema: BROWSER_TOOLS_SCHEMA, image_id: imageId, platform: process.platform, arch: process.arch,
    source_version: command(executable, ['--version']).split('\n')[0], loader: basename(loaders[0]), files: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}

export function verifyBrowserTools(directory, expectedHash, restoreModes = false) {
  const bytes = readFileSync(join(directory, 'manifest.json')); assert.equal(hash(bytes), expectedHash, 'Browser native tool manifest changed');
  const manifest = JSON.parse(bytes); assert.equal(manifest.schema, BROWSER_TOOLS_SCHEMA);
  assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch, 'Native tool CPU ABI differs');
  assert.match(manifest.image_id, /^sha256:[a-f0-9]{64}$/); assert.ok(Array.isArray(manifest.files) && manifest.files.length > 6);
  const actual = [];
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name); assert.ok(!entry.isSymbolicLink(), 'Tool bundle must contain regular files');
    if (entry.isDirectory()) walk(absolute); else { assert.ok(entry.isFile()); actual.push(absolute.slice(directory.length + 1).replaceAll('\\', '/')); }
  } };
  walk(directory); assert.deepEqual(actual.filter(path => path !== 'manifest.json').sort(), manifest.files.map(row => row.path).sort(), 'Tool bundle file table differs');
  for (const row of manifest.files) {
    assert.match(row.path, /^(bin|lib|tessdata|fonts)\/[a-zA-Z0-9_.+-]+$/);
    const path = join(directory, row.path); assert.equal(hash(readFileSync(path)), row.sha256, 'Browser native tool bytes changed');
    // Windows bind/copy transport does not retain POSIX executable mode. Apply
    // only the hash-verified manifest modes to this owned disposable directory.
    if (restoreModes) chmodSync(path, row.executable ? 0o755 : 0o644);
    assert.equal(Boolean(lstatSync(path).mode & 0o111), row.executable);
  }
  return { schema: BROWSER_TOOLS_SCHEMA, image_id: manifest.image_id, manifest_sha256: expectedHash, arch: manifest.arch,
    files: manifest.files.length, source_version: manifest.source_version };
}

export function browserToolsEnvironment(base) {
  return { ...base, PATH: `${BROWSER_TOOLS_ROOT}/bin:${base.PATH}`, TESSDATA_PREFIX: `${BROWSER_TOOLS_ROOT}/tessdata`,
    BB_OCR_TEST_FONT: `${BROWSER_TOOLS_ROOT}/fonts/NotoSansCJK-Regular.ttc` };
}

export function probeBrowserTools(manifestHash, env, output) {
  const proof = verifyBrowserTools(BROWSER_TOOLS_ROOT, manifestHash);
  const version = command(`${BROWSER_TOOLS_ROOT}/bin/tesseract`, ['--version'], env).split('\n')[0]; assert.equal(version, proof.source_version);
  const languages = command(`${BROWSER_TOOLS_ROOT}/bin/tesseract`, ['--list-langs'], env);
  for (const language of ['eng', 'chi_sim', 'osd']) assert.ok(languages.split('\n').includes(language));
  const image = join(output, 'ocr-probe.png');
  command(env.BB_PYTHON, ['-c', 'import sys;from PIL import Image,ImageDraw,ImageFont;im=Image.new("RGB",(1000,140),"white");ImageDraw.Draw(im).text((20,20),"财务报表 1,234.50",font=ImageFont.truetype(sys.argv[2],48),fill="black");im.save(sys.argv[1])', image, env.BB_OCR_TEST_FONT], env);
  const text = command(`${BROWSER_TOOLS_ROOT}/bin/tesseract`, [image, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], env);
  assert.match(text, /1,234\.50/); assert.match(text.replaceAll(' ', ''), /财务报表/);
  writeFileSync(join(output, 'ocr-probe.txt'), text + '\n');
  return { ...proof, status: 'passed', version, languages: ['eng', 'chi_sim', 'osd'], synthetic_image_sha256: hash(readFileSync(image)), output_sha256: hash(text), model_calls: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, imageId] = process.argv.slice(2);
  if (mode === 'export') exportBrowserTools(directory, imageId);
  else { assert.equal(mode, 'restore'); assert.equal(directory, BROWSER_TOOLS_ROOT); verifyBrowserTools(directory, imageId, true); }
}
