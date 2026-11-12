import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfirmationSources } from './confirmation-source-policy.mjs';

const target = '/var/lib/bondbuddy/upload-confirmation';
const sha = text => createHash('sha256').update(text).digest('hex');
const volume = bind => `- type: bind\n  source: /synthetic/spool\n  target: ${target}\n${bind}`;
const source = (entry = volume('  bind: {create_host_path: false}\n'), tag = '') =>
  `services:\n  upload-confirmation:\n    volumes:${tag ? ` ${tag}` : ''}\n${entry.split('\n').filter(Boolean).map(line => `      ${line}`).join('\n')}\n`;

function fixture(t, override = 'services: {}\n') {
  const directory = mkdtempSync(join(tmpdir(), 'bb-confirmation-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = join(directory, 'compose.execution.yaml'), overrideFile = join(directory, 'private.yaml');
  writeFileSync(base, source()); writeFileSync(overrideFile, override);
  for (const name of ['compose.integrity-beijing.yaml', 'compose.integrity-browser.yaml']) writeFileSync(join(directory, name), 'services: {}\n');
  const options = { directory, integrityMode: 'disabled', overrideFile, overrideSha256: sha(override) };
  return { directory, base, overrideFile, options, validate: changes => validateConfirmationSources({ ...options, ...changes }) };
}

test('untouched override inherits the checked fixed base in every fixed integrity mode', t => {
  const f = fixture(t);
  for (const integrityMode of ['disabled', 'beijing', 'direct']) f.validate({ integrityMode })();
  f.validate({ overrideFile: '', overrideSha256: '' })();
});

test('long-form explicit false survives known Compose replacement tags unchanged', t => {
  const text = source(undefined, '!override'), f = fixture(t, text);
  f.validate()();
  assert.equal(readFileSync(f.overrideFile, 'utf8'), text);
  assert.throws(() => f.validate({ integrityMode: 'unknown' }));
});

test('a false bind inherited through a YAML anchor and merge remains explicit source evidence', t => {
  const text = `x-volume: &volume\n  type: bind\n  source: /synthetic/spool\n  target: ${target}\n  bind: &bind {create_host_path: false}\nservices:\n  upload-confirmation:\n    volumes: !override\n      - <<: *volume\n        bind: *bind\n`;
  fixture(t, text).validate()();
});

test('every authored confirmation volume must carry its own boolean false', t => {
  for (const bind of ['', '  bind: {}\n', '  bind: {create_host_path: true}\n', '  bind: {create_host_path: null}\n', '  bind: {create_host_path: "false"}\n', '  bind: {create_host_path: ${SYNTHETIC_FALSE}}\n']) {
    const f = fixture(t, 'x-decoy: {create_host_path: false}\n' + source(volume(bind), '!override'));
    assert.throws(() => f.validate(), bind || 'missing bind');
  }
  for (const entry of [`- /synthetic/spool:${target}\n`, volume('  bind: {create_host_path: false}\n').replace(target, '/synthetic/other'), volume('  bind: {create_host_path: false}\n').replace('type: bind', 'type: volume')])
    assert.throws(() => fixture(t, source(entry, '!override')).validate());
  assert.throws(() => fixture(t, 'services:\n  upload-confirmation:\n    volumes: !override []\n').validate());
});

test('all inspected sources must preserve policy, including the fixed base and selected overlay', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'compose.integrity-beijing.yaml'), source(volume('  bind: {}\n')));
  assert.throws(() => f.validate({ integrityMode: 'beijing' }));
  f.validate({ integrityMode: 'direct' })();
  writeFileSync(f.base, source(volume('  bind: {}\n')));
  assert.throws(() => f.validate());
});

test('multiple documents, duplicate keys and custom coercion tags fail closed', t => {
  const invalid = [
    'services: {}\n---\nservices: {}\n', 'services: {}\nservices: {}\n',
    'services: {}\nx-unknown: !untrusted value\n', 'services: {}\nx-unknown: !override scalar\n',
    source(volume('  bind: {create_host_path: false, create_host_path: true}\n')),
    '%YAML 1.1\n---\nservices: {}\n', 'services: {}\nx-complex: {[nested, key]: value}\n',
    'services: {}\nx-value: !!timestamp 2026-11-13\n',
  ];
  for (const text of invalid) assert.throws(() => fixture(t, text).validate(), text);
});

test('merge and alias mapping keys cannot hide duplicate fields during resolution', t => {
  const duplicateMerge = 'x-safe: &safe {create_host_path: false}\nx-unsafe: &unsafe {create_host_path: true}\n' +
    source(volume('  bind:\n    <<: *safe\n    <<: *unsafe\n'));
  const aliasKey = 'x-key: &key create_host_path\n' +
    source(volume('  bind:\n    create_host_path: true\n    ? *key\n    : false\n'));
  for (const text of [duplicateMerge, aliasKey]) assert.throws(() => fixture(t, text).validate());
});

test('alias cycles, unresolved aliases and expansion/depth limits are rejected', t => {
  const invalid = [
    'services: {}\nx-cycle: &cycle [*cycle]\n',
    'services: {}\nx-cycle: &cycle {child: *cycle}\n',
    'services: {}\nx-unknown: *unknown\n',
    'services: {}\nx-deep: ' + '['.repeat(110) + 'value' + ']'.repeat(110) + '\n',
    'services: {}\nx-a: &a [1,2,3,4,5,6,7,8,9,10]\nx-b: &b [' + Array(10).fill('*a').join(',') + ']\nx-c: &c [' + Array(10).fill('*b').join(',') + ']\nx-d: [' + Array(10).fill('*c').join(',') + ']\n',
  ];
  for (const text of invalid) assert.throws(() => fixture(t, text).validate());
});

test('source includes and confirmation inheritance from uninspected files are rejected', t => {
  for (const text of ['include: [uninspected.yaml]\nservices: {}\n', 'services:\n  upload-confirmation:\n    extends: {file: uninspected.yaml, service: other}\n', 'services:\n  upload-confirmation:\n    volumes_from: [other]\n', source(undefined, '!reset')])
    assert.throws(() => fixture(t, text).validate());
});

test('a harmless unrelated service does not override the confirmation declaration', t => {
  fixture(t, 'services:\n  other:\n    extends: {file: compose.yaml, service: other}\n    volumes: [unrelated:/data]\n').validate()();
});

test('private override hash is checked before parsing and all source identities after rendering', t => {
  const f = fixture(t);
  assert.throws(() => f.validate({ overrideSha256: 'f'.repeat(64) }));
  assert.throws(() => f.validate({ overrideSha256: '' }));
  const verify = f.validate(); writeFileSync(f.overrideFile, 'services: {}\n# changed\n');
  assert.throws(verify);
  const baseChanged = fixture(t), verifyBase = baseChanged.validate(); writeFileSync(baseChanged.base, source() + '# changed\n');
  assert.throws(verifyBase);
  const overlayChanged = fixture(t), verifyOverlay = overlayChanged.validate({ integrityMode: 'direct' });
  writeFileSync(join(overlayChanged.directory, 'compose.integrity-browser.yaml'), 'services: {}\n# changed\n');
  assert.throws(verifyOverlay);
});

test('invalid UTF-8 and oversized source fail without using replacement characters or truncation', t => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0xff]), Buffer.alloc(1024 * 1024 + 1, 0x20)]) {
    const f = fixture(t); writeFileSync(f.overrideFile, bytes);
    assert.throws(() => f.validate({ overrideSha256: sha(bytes) }));
  }
});

test('vendored parser bytes and licenses retain the verified source identity', () => {
  const directory = join(import.meta.dirname, 'vendor'), provenance = JSON.parse(readFileSync(join(directory, 'yaml-2.9.0.provenance.json')));
  assert.equal(sha(readFileSync(join(directory, 'yaml-2.9.0.cjs'))), provenance.assembly.outputSha256);
  assert.equal(sha(readFileSync(join(directory, 'yaml-2.9.0.LICENSE'))), provenance.assembly.noticeSha256);
  assert.equal(sha(readFileSync(join(directory, 'PLAYWRIGHT-LICENSE'))), provenance.source.parentLicense.sha256);
  assert.equal(sha(readFileSync(join(directory, 'PLAYWRIGHT-NOTICE'))), provenance.source.parentNotice.sha256);
});
