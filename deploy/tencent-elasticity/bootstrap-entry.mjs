import {readFile, mkdir, lstat, readdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readPrivateJson} from './private-files.mjs';
import {bootstrapNode, writePrivateEnvelope} from './bootstrap.mjs';
import {requireThat, sha256} from './policy.mjs';
import {acquireControlTick} from './control-tick-bound.mjs';
import {createBootstrapFailureRecorder} from './bootstrap-failure.mjs';

const exec = promisify(execFile);

// This directory is on the captured system disk, never /run. Preserve its
// high-water mark after first deployment, including across failed boots.
export async function acquireBootstrapAdmission(directory = '/etc/bondbuddy/bootstrap-rate', {
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), waitForCooldown = true,
} = {}) {
  requireThat(process.getuid() === 0, 'BOOTSTRAP_RATE_ROOT');
  const parent = await lstat(dirname(directory));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 &&
    (parent.mode & 0o022) === 0, 'BOOTSTRAP_RATE_PARENT');
  await mkdir(directory, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
  const stat = await lstat(directory);
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 &&
    (stat.mode & 0o777) === 0o700, 'BOOTSTRAP_RATE_DIRECTORY');
  requireThat((await readdir(directory)).every(name => ['control-tick.lock', 'control-tick.json'].includes(name)),
    'BOOTSTRAP_RATE_CONTENT');
  try {
    const previous = await readPrivateJson(`${directory}/control-tick.json`);
    requireThat(Object.keys(previous).length === 1 && Number.isSafeInteger(previous.last_started_at) &&
      previous.last_started_at >= 0, 'BOOTSTRAP_RATE_STATE');
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const release = await acquireControlTick(directory, {now});
  if (release || !waitForCooldown) return release;
  const previous = await readPrivateJson(`${directory}/control-tick.json`);
  const at = now();
  requireThat(Number.isSafeInteger(at) && at >= 0, 'BOOTSTRAP_RATE_CLOCK');
  // A rapid legitimate reboot can finish this one cooldown inside the existing
  // entry. Never extend the saved deadline, wait through rollback, or loop on a
  // lock held by another initialization process.
  if (at < previous.last_started_at) return null;
  const remaining = previous.last_started_at + 60000 - at;
  if (remaining <= 0 || remaining > 60000) return null;
  await wait(remaining);
  return acquireControlTick(directory, {now});
}

// Image preparation leaves the unit disabled and omits the public manifest.
// A valid first-instance binding persists the boot entry, even if enrollment
// must wait for issuance. Enabling never starts transport or task containers.
export async function runBootstrapEntry({
  readConfig = () => readPrivateJson('/etc/bondbuddy/elastic-bootstrap.json'),
  readManifest = () => readPrivateJson('/etc/bondbuddy/elastic-public.json'),
  readAdapter = readFile,
  importAdapter = path => import(pathToFileURL(path).href),
  enableBootstrap = () => exec('/usr/bin/systemctl', ['enable', 'bondbuddy-execution-bootstrap.service'],
    {timeout: 5000, maxBuffer: 4096}),
  acquireAdmission = () => acquireBootstrapAdmission(),
  writeEnvelope = (service, data) => writePrivateEnvelope('/run/bondbuddy/enrollment', service, data),
  diagnostics = createBootstrapFailureRecorder(),
} = {}) {
  try {
  diagnostics.stage('config_read');
  const config = await readConfig();
  diagnostics.stage('manifest_read');
  const publicManifest = await readManifest();
  diagnostics.stage('adapter_verify');
  requireThat(config.enabled === true && config.adapter_path.startsWith('/opt/bondbuddy/') &&
    /^[a-f0-9]{64}$/.test(config.adapter_sha256), 'BOOTSTRAP_ADAPTER_REQUIRED');
  requireThat(sha256(await readAdapter(config.adapter_path)) === config.adapter_sha256, 'BOOTSTRAP_ADAPTER_CHANGED');
  diagnostics.stage('adapter_import');
  const module = await importAdapter(config.adapter_path);
  diagnostics.stage('adapter_configure');
  const adapter = await module.createConfiguredNodeAdapter({publicManifest}, {diagnostics});
  diagnostics.stage('bootstrap_enable');
  await enableBootstrap();
  diagnostics.stage('admission');
  const release = await acquireAdmission();
  requireThat(typeof release === 'function', 'BOOTSTRAP_RATE_LIMITED');
  try {
    diagnostics.stage('metadata');
    return await bootstrapNode({publicManifest, metadata: await adapter.metadata(), broker: adapter.broker, runtime: adapter.runtime,
      writeEnvelope, diagnostics});
  } catch (error) {
    await diagnostics.capture(error,adapter.runtime.failureContainers);
    throw error;
  } finally {diagnostics.stage('admission_release');await release();}
  } catch (error) {
    await diagnostics.capture(error);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runBootstrapEntry(); }
  catch {
    process.stderr.write('Execution bootstrap failed closed; node is not ready.\n');
    process.exitCode = 1;
  }
}
