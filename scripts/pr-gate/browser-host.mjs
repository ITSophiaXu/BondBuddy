import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_DATABASE, browserHash, createBrowserPlan } from './browser-profiles.mjs';
import { BROWSER_TOOLS_ROOT } from './browser-tools.mjs';

export function browserFilesForShard(expected, row) {
  assert.equal(row.groups, 'browser');
  const [index, total] = row.shard.split('/').map(Number);
  assert.ok(index >= 1 && index <= total);
  return Object.keys(expected.browser_source_sha256).sort().filter((_, offset) => offset % total === index - 1);
}

export function verifyBrowserDatabaseContainer(value, { name, runner, imageId, runId }) {
  assert.match(value.Id, /^[a-f0-9]{64}$/); assert.equal(value.Name, '/' + name); assert.equal(value.Image, imageId);
  assert.equal(value.Config.Labels['bondbuddy.pr-gate.run'], runId);
  assert.equal(value.HostConfig.NetworkMode, 'container:' + runner);
  assert.equal(value.HostConfig.Privileged, false); assert.ok(!Object.keys(value.HostConfig.PortBindings ?? {}).length);
  assert.deepEqual(value.Config.Cmd, ['postgres', '-p', '55433']);
  for (const item of ['POSTGRES_USER=bondbuddy', 'POSTGRES_PASSWORD=synthetic-ci-only', 'POSTGRES_DB=bondbuddy_local']) assert.ok(value.Config.Env.includes(item));
  return { id: value.Id, name, image_id: imageId, run_id: runId, network: value.HostConfig.NetworkMode, published_ports: 0, privileged: false, port: 55433, database: 'bondbuddy_local' };
}

/** Host owns sidecars; the existing runBrowser still executes the whole batch. */
export async function prepareBrowserServices({ candidate, runId, row, sourceBlob, core, images, evidenceRoot, sourceRoot }) {
  const files = browserFilesForShard(candidate, row);
  const plan = createBrowserPlan({ candidate, runId, shard: row.name, files, sourceBlob });
  const directory = join(evidenceRoot, 'shards', row.name); mkdirSync(directory, { recursive: true });
  const planPath = join(directory, 'browser-plan.json'); writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  const proof = { commit: candidate.commit, tree: candidate.tree, run_id: runId, shard: row.name,
    plan, plan_sha256: browserHash(readFileSync(planPath)), started_at: new Date().toISOString(), status: 'failed', cleanup: { status: 'pending' } };
  const names = [], save = () => writeFileSync(join(directory, 'browser-services.json'), JSON.stringify(proof, null, 2) + '\n');
  const environment = { PR_GATE_BROWSER_PLAN: `/evidence/shards/${row.name}/browser-plan.json`, PR_GATE_BROWSER_PLAN_SHA256: proof.plan_sha256, PR_GATE_RUN_ID: runId, PR_GATE_BROWSER_SHARD: row.name };
  const cleanup = async () => { try { await core.removeOwned(names); proof.cleanup = { status: 'passed', finished_at: new Date().toISOString() }; }
    catch (error) { proof.cleanup = { status: 'failed', error: error.message }; throw error; } finally { save(); } };
  try {
    if (plan.needs.api) {
      const name = `${core.runner}-${row.name}-pg`; names.push(name);
      await core.start(`${row.name}-database-create`, name, ['--label', 'bondbuddy.pr-gate.run=' + runId, '--network', 'container:' + core.runner,
        '--cpus', '0.5', '--memory', '512m', '--memory-swap', '512m', '--env', 'POSTGRES_USER=bondbuddy', '--env', 'POSTGRES_PASSWORD=synthetic-ci-only',
        '--env', 'POSTGRES_DB=bondbuddy_local', images.postgres, 'postgres', '-p', '55433']);
      const inspected = JSON.parse((await core.docker(`${row.name}-database-isolation`, ['inspect', name], { capture: true, privateCapture: true })).text)[0];
      // Docker resolves container:<name> into container:<id> in some versions.
      const runnerId = (await core.docker(`${row.name}-runner-id`, ['inspect', '--format', '{{.Id}}', core.runner], { capture: true })).text;
      proof.database = verifyBrowserDatabaseContainer(inspected, { name, runner: inspected.HostConfig.NetworkMode === 'container:' + runnerId ? runnerId : core.runner, imageId: images.postgres, runId });
      for (let attempt = 0; ; attempt++) {
        const ready = await core.docker(`${row.name}-database-ready`, ['exec', name, 'pg_isready', '-p', '55433', '-U', 'bondbuddy', '-d', 'bondbuddy_local'], { capture: true, allowFailure: true });
        if (ready.code === 0) break; assert.ok(attempt < 29, 'Browser database did not become ready'); await new Promise(done => setTimeout(done, 1000));
      }
      await core.exec(`${row.name}-browser-migrate`, ['node', 'db/migrate.mjs'], { DATABASE_URL: BROWSER_DATABASE });
      proof.database.migrated = true;
    }
    if (plan.needs.ocr) {
      assert.match(images.native, /^sha256:[a-f0-9]{64}$/);
      const name = `${core.runner}-${row.name}-ocr-export`, exportDirectory = join(directory, 'native-tools'); mkdirSync(exportDirectory);
      names.push(name);
      const id = await core.start(`${row.name}-ocr-export-create`, name, ['--label', 'bondbuddy.pr-gate.run=' + runId, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128',
        '--mount', `type=bind,source=${join(sourceRoot, 'scripts/pr-gate/browser-tools.mjs')},target=/browser-tools.mjs,readonly`,
        '--mount', `type=bind,source=${exportDirectory},target=/export`, '--entrypoint', '/usr/bin/env', images.native,
        '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'node', '/browser-tools.mjs', 'export', '/export', images.native]);
      const completed = await core.docker(`${row.name}-ocr-export-wait`, ['wait', id], { capture: true }); assert.equal(completed.text, '0');
      const bytes = readFileSync(join(exportDirectory, 'manifest.json')); proof.tools = { image_id: images.native, manifest_sha256: browserHash(bytes), manifest: JSON.parse(bytes) };
      await core.exec(`${row.name}-ocr-tools-must-be-new`, ['node', '-e', `if(require('fs').existsSync(${JSON.stringify(BROWSER_TOOLS_ROOT)}))throw Error('Browser tools directory already exists')`]);
      await core.docker(`${row.name}-ocr-copy-existing-tools`, ['cp', exportDirectory, `${core.runner}:${BROWSER_TOOLS_ROOT}`]);
      await core.exec(`${row.name}-ocr-restore-file-modes`, ['node', 'scripts/pr-gate/browser-tools.mjs', 'restore', BROWSER_TOOLS_ROOT, proof.tools.manifest_sha256]);
      environment.PR_GATE_BROWSER_TOOLS_SHA256 = proof.tools.manifest_sha256;
      await core.removeOwned([name]); names.splice(names.indexOf(name), 1);
    }
    proof.status = 'prepared'; proof.prepared_at = new Date().toISOString(); save();
    return { env: environment, evidence: proof, cleanup };
  } catch (error) { proof.error = error.message; await cleanup(); throw error; }
}
