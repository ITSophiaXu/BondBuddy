import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tests = Object.freeze({
  'apps/worker/src/codex-file-authoring.test.ts': { profile: 'native-sandbox', run: 'apps/worker/dist/codex-file-authoring.test.js' },
  'apps/worker/src/review-revision-cli-native.test.ts': { profile: 'native-sandbox', run: 'apps/worker/dist/review-revision-cli-native.test.js' },
  'apps/worker/src/integrity-desktop.test.ts': { profile: 'native-desktop', run: 'apps/worker/dist/integrity-desktop.test.js' },
  'python/tests/test_ocr.py': { profile: 'native-ocr', run: 'python/tests/test_ocr.py' },
});
const sha = value => createHash('sha256').update(value).digest('hex');
const sync = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
const requiredFiles = ['package-lock.json', 'python/requirements.txt', 'python/requirements-dev.txt',
  'deploy/m1/scripts/codex-bwrap.sh', 'deploy/m1/security/codex-seccomp.json', 'deploy/m1/security/integrity-browser-seccomp.json',
  ...Object.entries(tests).flatMap(([file, value]) => [file, value.run])];

async function bundle(commit, tree) {
  assert.equal(process.cwd(), '/workspace');
  assert.match(commit, /^[a-f0-9]{40}$/); assert.match(tree, /^[a-f0-9]{40}$/);
  assert.equal(sync('git', ['rev-parse', 'HEAD']), commit); assert.equal(sync('git', ['rev-parse', 'HEAD^{tree}']), tree);
  assert.equal(sync('git', ['status', '--porcelain', '--untracked-files=no']), '');
  const { verifyGitSnapshotSource } = await import('/workspace/scripts/pr-gate/git-snapshot.mjs');
  const rawSource = verifyGitSnapshotSource({ sourceRoot: '/workspace', expectedCommit: commit, expectedTree: tree });
  const files = Object.fromEntries([...new Set(requiredFiles)].map(file => [file, sha(readFileSync(file))]));
  writeFileSync('/evidence/native-manifest.json', JSON.stringify({ commit, tree, raw_source: rawSource, files }, null, 2) + '\n');
  // The worker runtime intentionally carries only production Python packages.
  // Restore the already-verified core ReportLab cache for this synthetic OCR
  // test; no installer, registry, host software or production path is involved.
  sync('/usr/local/bin/python', ['-c', `import hashlib,json,sys,sysconfig,tarfile
from importlib.metadata import distribution
from pathlib import Path
d=distribution('reportlab'); base=Path(d.locate_file('')).resolve(); rows=[]
with tarfile.open('/evidence/native-reportlab.tar','w') as archive:
 for relative in sorted(d.files,key=str):
  name=str(relative)
  if relative.is_absolute() or '..' in relative.parts: raise RuntimeError('Cache member escapes distribution')
  path=Path(d.locate_file(relative))
  if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(base): raise RuntimeError('Unsafe cache member')
  rows.append(dict(path=name,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
  def regular(info):
   info.uid=info.gid=0; info.uname=info.gname=''; info.mode=0o644
   return info
  archive.add(path,arcname=name,recursive=False,filter=regular)
Path('/evidence/native-reportlab.json').write_text(json.dumps(dict(distribution='reportlab',version=d.version,python=sys.version.split()[0],abi=sysconfig.get_config_var('SOABI'),files=rows)))
print('Existing ReportLab cache exported:',d.version,len(rows))`]);
  sync('tar', ['-C', '/workspace', '--mode=a+rX,go-w', '--owner=0', '--group=0', '-cf', '/evidence/native-app.tar',
    'apps', 'packages', 'python', 'node_modules', 'package.json', 'package-lock.json', 'scripts/pr-gate',
    'deploy/m1/scripts/codex-bwrap.sh', 'deploy/m1/security/codex-seccomp.json', 'deploy/m1/security/integrity-browser-seccomp.json'], { timeout: 300_000 });
}

function initialize() {
  assert.equal(process.getuid(), 0); assert.deepEqual(readdirSync('/app'), [], 'Candidate volume must start empty');
  sync('tar', ['-xf', '/transfer/native-app.tar', '-C', '/app', '--no-same-owner'], { timeout: 300_000 });
  mkdirSync('/app/.pr-gate-python');
  sync('tar', ['-xf', '/transfer/native-reportlab.tar', '-C', '/app/.pr-gate-python', '--no-same-owner']);
  for (const row of JSON.parse(readFileSync('/transfer/native-reportlab.json')).files) assert.equal(sha(readFileSync(join('/app/.pr-gate-python', row.path))), row.sha256, 'Cached ReportLab member changed');
  for (const [file, expected] of Object.entries(JSON.parse(readFileSync('/transfer/native-manifest.json')).files)) assert.equal(sha(readFileSync(join('/app', file))), expected, 'Candidate volume file differs: ' + file);
  console.log('Fresh candidate app volume restored');
}

function verifyRuntime() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000);
  const status = readFileSync('/proc/self/status', 'utf8');
  const security = Object.fromEntries(['CapEff', 'NoNewPrivs', 'Seccomp'].map(key => [key, status.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))?.[1]]));
  assert.equal(security.CapEff, '0000000000000000'); assert.equal(security.NoNewPrivs, '1'); assert.equal(security.Seccomp, '2');
  const manifest = JSON.parse(readFileSync('/transfer/native-manifest.json', 'utf8'));
  for (const [file, expected] of Object.entries(manifest.files)) assert.equal(sha(readFileSync(join('/app', file))), expected, 'Native candidate changed: ' + file);
  assert.equal(sha(readFileSync('/usr/local/bin/bwrap')), manifest.files['deploy/m1/scripts/codex-bwrap.sh'], 'Cached sandbox wrapper differs from candidate');
  assert.ok(Object.keys(process.env).every(key => !/(TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(key)), 'Credential-like environment in native test');
  for (const row of JSON.parse(readFileSync('/transfer/native-reportlab.json')).files) assert.equal(sha(readFileSync(join('/app/.pr-gate-python', row.path))), row.sha256, 'Native ReportLab cache changed');
  return { ...manifest, security, node: process.version, uid: process.getuid(), models: 0, network: 'none' };
}

async function probe(profile) {
  assert.ok(Object.values(tests).some(test => test.profile === profile));
  const report = { ...verifyRuntime(), profile, started_at: new Date().toISOString(), checks: {}, status: 'failed' };
  try {
    report.checks.python = sync('/opt/venv/bin/python', ['--version']);
    report.checks.cache_abi = JSON.parse(sync('/opt/venv/bin/python', ['-c', `import json,sys,sysconfig
from pathlib import Path
cached=json.loads(Path('/transfer/native-reportlab.json').read_text())
assert tuple(map(int,cached['python'].split('.')[:2]))==sys.version_info[:2]
assert cached['abi']==sysconfig.get_config_var('SOABI')
print(json.dumps(dict(cached_python=cached['python'],runtime_python=sys.version.split()[0],abi=cached['abi'],compatible=True)))`]));
    report.checks.pip = sync('/opt/venv/bin/python', ['-m', 'pip', 'check']);
    // Validate the actual installed versions; no installer or download runs.
    report.checks.requirements = JSON.parse(sync('/opt/venv/bin/python', ['-c', `import json
from pathlib import Path
from importlib.metadata import version
from pip._vendor.packaging.requirements import Requirement
rows=[]
for name in ['requirements.txt','requirements-dev.txt']:
 for raw in Path('/app/python',name).read_text().splitlines():
  if not raw.strip() or raw.startswith('#') or raw=='-r requirements.txt': continue
  r=Requirement(raw); v=version(r.name)
  if r.url or r.marker or r.extras or v not in r.specifier: raise RuntimeError(raw+' vs '+v)
  rows.append(dict(requirement=raw,installed=v))
print(json.dumps(rows))`]));
    if (profile === 'native-sandbox') {
      report.checks.codex = sync('/usr/local/bin/codex', ['--version']); report.checks.bwrap = sync('/usr/local/bin/bwrap', ['--version']);
      assert.equal(readFileSync('/run/secrets/bb-copilot-oauth', 'utf8'), 'BB_SYNTHETIC_SANDBOX_CANARY_NOT_A_CREDENTIAL\n');
      assert.ok(readFileSync('/proc/1/environ').length > 0);
      const { verifyFilePermissions } = await import(pathToFileURL('/app/apps/worker/dist/codex-file-permissions.js').href);
      const area = mkdtempSync('/tmp/bb-host-probe-'), cwd = join(area, 'job'), home = join(area, 'home');
      try {
        for (const dir of [cwd, home, join(cwd, 'scratch'), join(cwd, 'output')]) mkdirSync(dir, { mode: 0o700 });
        writeFileSync(join(cwd, 'input.json'), '{}');
        await verifyFilePermissions({ command: ['/usr/local/bin/codex'], path_env: '/usr/local/bin:/usr/bin:/bin' }, cwd, home);
        assert.equal(readFileSync(join(cwd, 'input.json'), 'utf8'), '{}'); report.checks.original_permission_probe = true;
      } finally { assert.ok(resolve(area).startsWith('/tmp/bb-host-probe-')); rmSync(area, { recursive: true, force: true }); }
    }
    if (profile === 'native-ocr' || profile === 'native-desktop') {
      report.checks.tesseract = sync('tesseract', ['--version']);
      const languages = sync('tesseract', ['--list-langs']).split('\n').map(line => line.trim());
      for (const language of ['eng', 'chi_sim', 'osd']) assert.ok(languages.includes(language)); report.checks.languages = languages;
    }
    if (profile === 'native-ocr') {
      const font = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'; assert.ok(existsSync(font)); report.checks.font_sha256 = sha(readFileSync(font));
      report.checks.reportlab = sync('/opt/venv/bin/python', ['-c', "import reportlab; from PIL import ImageFont; ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',36); print(reportlab.Version)"]);
    }
    if (profile === 'native-desktop') {
      report.checks.desktop_commands = Object.fromEntries(['Xvfb', 'xauth', 'xdpyinfo', 'openbox', 'dbus-daemon', 'xfdesktop', 'xfce4-panel', 'wmctrl', 'scrot'].map(command => [command, sync('which', [command])]));
      const { chromium } = await import('/app/node_modules/playwright/index.mjs');
      assert.ok(existsSync(chromium.executablePath())); report.checks.chromium_executable = chromium.executablePath();
    }
    report.status = 'passed';
  } finally { report.finished_at = new Date().toISOString(); writeFileSync('/evidence/probe.json', JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report));
}

async function executeTest(testId) {
  const entry = tests[testId]; assert.ok(entry, 'Only the four exact native test files may execute'); verifyRuntime();
  const environment = { ...process.env };
  if (entry.profile === 'native-desktop') environment.BB_TEST_INTEGRITY_DESKTOP = '1';
  if (entry.profile === 'native-ocr') Object.assign(environment, { BB_OCR_CHINESE_TEST: '1', BB_OCR_TEST_FONT: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc' });
  const command = entry.profile === 'native-ocr' ? '/opt/venv/bin/python' : process.execPath;
  const args = entry.profile === 'native-ocr' ? ['-m', 'unittest', '-v', 'test_ocr'] : ['--test', '--test-reporter=tap', join('/app', entry.run)];
  const started = Date.now(); let child, timedOut = false, stdout = '', stderr = '', outputFailure = false;
  const result = await new Promise(done => {
    child = spawn(command, args, { cwd: '/app', env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 300_000);
    child.stdout.on('data', data => { stdout += data; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { outputFailure = true; kill(); } });
    child.stderr.on('data', data => { stderr += data; if (Buffer.byteLength(stderr) > 8 * 1024 * 1024) { outputFailure = true; kill(); } });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code, signal, timedOut, stdout, stderr, durationMs: Date.now() - started }); });
  });
  writeFileSync('/evidence/execution.json', JSON.stringify(result) + '\n');
  writeFileSync('/evidence/execution-command.json', JSON.stringify({ command, args, cwd: '/app', started_at: new Date(started).toISOString(), output_limit_failed: outputFailure }) + '\n');
  process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = outputFailure ? 1 : result.code ?? 1;
}

const [mode, first, second] = process.argv.slice(2);
try {
  if (mode === 'bundle') await bundle(first, second);
  else if (mode === 'initialize') initialize();
  else if (mode === 'probe') await probe(first);
  else if (mode === 'test') await executeTest(first);
  else throw new Error('Invalid fixed native capability operation');
} catch (error) { console.error(error.stack); process.exitCode = 1; }
