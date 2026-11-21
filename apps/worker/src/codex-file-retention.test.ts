import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodexAdapterConfig, runContainedModelCall, type ContainedCallInput } from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';
import { createFileWorkspaceRetention, fileAuthoringWorkRoot, markFileWorkspaceActive } from './codex-file-retention.js';

// The fake CLI substitutes only the permission-probe protocol, never claims to
// validate Linux isolation. The real adapter, process exit, classification,
// checkpoint callback, provider journal and workspace cleanup all execute.
async function fixture(scenario: 'timeout' | 'payload-failure' | 'completed' | 'native-nonzero' | 'stream-broken', persist: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'bb-file-retention-'));
  const journal = new MemoryCodexJournal();
  let workspace = '', captured = 0;
  const config = {
    ...loadCodexAdapterConfig({}), credential: { kind: 'env' as const, name: 'SYNTHETIC_RETENTION_TOKEN' },
    command: [process.execPath, fileURLToPath(new URL('../test-fixtures/codex/fake-file-retention.mjs', import.meta.url))],
    work_root: root, authoring_timeout_ms: 750, kill_grace_ms: 20,
  };
  const input: ContainedCallInput = {
    owner_user_id: 'synthetic-owner', project_id: 'synthetic-project', job_id: 'synthetic-job', run_id: 'synthetic-run',
    trace_id: 'synthetic-run', logical_call_id: 'file-authoring-v1', prompt_snapshot_ref: 'synthetic-prompt',
    prompt: scenario, output: { kind: 'text' }, result_schema_version: 'synthetic-file-v1',
    fileWorkspace: {
      prepare: async cwd => {
        workspace = cwd;
        await mkdir(join(cwd, 'scratch')); await mkdir(join(cwd, 'output'));
        await writeFile(join(cwd, 'input.json'), '{"synthetic":true}');
      },
      collect: async () => { throw Error('interrupted candidates must never become completed provider results'); },
      onFailure: async cwd => {
        captured++;
        assert.equal(await readFile(join(cwd, 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
        if (!persist) throw Error('synthetic_blob_unavailable');
      },
    },
  };
  return { root, journal, config, input, workspace: () => workspace, captures: () => captured };
}

for (const scenario of ['timeout', 'payload-failure'] as const) {
  test(`failed ${scenario} recovery capture retains local work without changing provider outcome`, async () => {
    const f = await fixture(scenario, false);
    try {
      const result = await runContainedModelCall(f.input, f.journal, f.config);
      assert.equal(result.status, scenario === 'timeout' ? 'needs_reconcile' : 'failed');
      assert.equal(result.error_code, scenario === 'timeout' ? 'MODEL_TIMEOUT' : 'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0]!.usage.status, 'unknown');
      assert.equal(f.captures(), 1);
      assert.equal(f.journal.results.size, 0, 'private work is not an accepted provider result');
      assert.equal(await readFile(join(f.workspace(), 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
      assert.equal(await createFileWorkspaceRetention(f.root).pendingCount(),1);
      const marker=JSON.parse(await readFile(join(f.workspace(),'../retention.json'),'utf8'));
      assert.equal(marker.state,'operator_action_required');assert.equal(marker.call_id,result.attempts[0]!.call_id);
      assert.equal(marker.reason,result.error_code);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('durably captured timeout work permits cleanup and still cannot be delivered as a provider result', async () => {
  const f = await fixture('timeout', true);
  try {
    const result = await runContainedModelCall(f.input, f.journal, f.config);
    assert.equal(result.status, 'needs_reconcile'); assert.equal(result.error_code, 'MODEL_TIMEOUT');
    assert.equal(f.captures(), 1); assert.equal(f.journal.results.size, 0);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('cancellation after native work keeps a local candidate without calling a stale capture context', async () => {
  const f = await fixture('timeout', false), controller = new AbortController();
  try {
    const result = await runContainedModelCall({ ...f.input, signal: controller.signal,
      onEvent: event => { if (event.type === 'item.started') controller.abort(new Error('synthetic lease no longer valid')); }
    }, f.journal, { ...f.config, authoring_timeout_ms: 10_000 });
    assert.equal(result.error_code, 'MODEL_CANCELLED');
    assert.equal(result.status, 'needs_reconcile');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.usage.status, 'unknown');
    assert.equal(f.captures(), 0, 'an aborted lease cannot be used to upload a checkpoint');
    assert.equal(f.journal.results.size, 0);
    assert.equal(await readFile(join(f.workspace(), 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
    assert.equal(await createFileWorkspaceRetention(f.root).pendingCount(), 1);
    const marker = JSON.parse(await readFile(join(f.workspace(), '../retention.json'), 'utf8'));
    assert.equal(marker.reason, 'MODEL_CANCELLED');
    assert.equal(marker.capture_failure, 'context_aborted');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const stage of ['runtime', 'observation'] as const) test(`a failed ${stage} journal commit keeps the completed candidate`, async () => {
  const f = await fixture('completed', false);
  try {
    f.input.fileWorkspace!.collect = async () => ({ private_candidate: true });
    if (stage === 'runtime') f.journal.recordRuntime = async () => { throw Error('synthetic_runtime_commit_failed'); };
    else f.journal.recordObservation = async () => { throw Error('synthetic_observation_commit_failed'); };
    await assert.rejects(runContainedModelCall(f.input, f.journal, f.config), new RegExp(`synthetic_${stage}_commit_failed`));
    assert.equal(f.journal.intents.length, 1, 'journal failures must never cause another provider execution');
    assert.equal(f.captures(), 1);
    assert.equal(await readFile(join(f.workspace(), 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
    assert.equal(await createFileWorkspaceRetention(f.root).pendingCount(), 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const scenario of ['native-nonzero', 'stream-broken'] as const) test(`an uncaptured ${scenario} outcome retains the last local candidate`, async () => {
  const f = await fixture(scenario, false);
  try {
    const result = await runContainedModelCall(f.input, f.journal, f.config);
    assert.equal(result.error_code, scenario === 'native-nonzero' ? 'MODEL_PROCESS_EXIT_NONZERO' : 'MODEL_STREAM_BROKEN');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.usage.status, 'unknown');
    assert.equal(f.captures(), 0, 'terminal outcomes preserve locally without inventing recovery authorization');
    assert.equal(f.journal.results.size, 0);
    assert.equal(await readFile(join(f.workspace(), 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
    assert.equal(await createFileWorkspaceRetention(f.root).pendingCount(), 1);
    const marker = JSON.parse(await readFile(join(f.workspace(), '../retention.json'), 'utf8'));
    assert.equal(marker.reason, result.error_code);
    assert.equal(marker.capture_failure, 'outcome_not_checkpointed');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('stage and restart inventory use the same explicit and legacy workspace roots', () => {
  const names=['BB_FILE_AUTHORING_WORK_ROOT','BB_PARSE_STAGING_DIR','BB_CODEX_WORK_ROOT'] as const;
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try{
    process.env.BB_CODEX_WORK_ROOT=join(tmpdir(),'configured-codex');process.env.BB_PARSE_STAGING_DIR=join(tmpdir(),'parse-staging');
    process.env.BB_FILE_AUTHORING_WORK_ROOT=join(tmpdir(),'durable-authoring');
    assert.equal(fileAuthoringWorkRoot('/ignored'),process.env.BB_FILE_AUTHORING_WORK_ROOT);
    delete process.env.BB_FILE_AUTHORING_WORK_ROOT;
    assert.equal(fileAuthoringWorkRoot('/ignored'),join(process.env.BB_PARSE_STAGING_DIR,'file-authoring'));
    delete process.env.BB_PARSE_STAGING_DIR;
    assert.equal(fileAuthoringWorkRoot('/config-root'),join('/config-root','file-authoring'));
    assert.equal(fileAuthoringWorkRoot(),join(process.env.BB_CODEX_WORK_ROOT,'file-authoring'));
    delete process.env.BB_CODEX_WORK_ROOT;
    assert.equal(fileAuthoringWorkRoot(),join(tmpdir(),'bb-codex','file-authoring'));
  }finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});

test('bounded inventory distinguishes active attempts from retained directories without trusting a marker', async () => {
  const root=await mkdtemp(join(tmpdir(),'bb-retention-inventory-'));
  let release:(()=>void)|undefined;
  try{
    const inventory=createFileWorkspaceRetention(root);
    assert.equal(await inventory.pendingCount(),0);
    await mkdir(join(root,'attempt-running'));release=markFileWorkspaceActive(join(root,'attempt-running'));
    await mkdir(join(root,'attempt-stale'));
    assert.equal(await inventory.pendingCount(),1);
    release();assert.equal(await inventory.pendingCount(),2);
    await rm(join(root,'attempt-stale'),{recursive:true});assert.equal(await inventory.pendingCount(),1);
    assert.equal(await createFileWorkspaceRetention(join(root,'absent')).pendingCount(),0);
  }finally{release?.();await rm(root,{recursive:true,force:true});}
});

test('a process restart exposes an interrupted active directory even when no retention marker was written', async () => {
  const root=await mkdtemp(join(tmpdir(),'bb-retention-restart-'));
  try{
    await promisify(execFile)(process.execPath,['--input-type=module','-e',
      'const {mkdir}=await import("node:fs/promises");const {join}=await import("node:path");const {markFileWorkspaceActive}=await import(process.argv[2]);const path=join(process.argv[1],"attempt-interrupted");await mkdir(path);markFileWorkspaceActive(path);',
      root,new URL('./codex-file-retention.js',import.meta.url).href]);
    assert.equal(await createFileWorkspaceRetention(root).pendingCount(),1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('inventory fails closed for non-directories, links, unexpected entries and excessive entries', async () => {
  const root=await mkdtemp(join(tmpdir(),'bb-retention-untrusted-'));
  try{
    for(const mode of ['file','link','unexpected'] as const){
      const path=join(root,mode==='unexpected'?'unknown-directory':'attempt-unsafe');
      if(mode==='file')await writeFile(path,'x');
      else if(mode==='link')await symlink(tmpdir(),path,process.platform==='win32'?'junction':'dir');
      else await mkdir(path);
      await assert.rejects(createFileWorkspaceRetention(root).pendingCount(),/AUTHORING_RETENTION_INVENTORY_UNSAFE/);
      await rm(path,{recursive:mode==='unexpected',force:true});
    }
    const link=join(root,'root-link');await symlink(tmpdir(),link,process.platform==='win32'?'junction':'dir');
    await assert.rejects(createFileWorkspaceRetention(link).pendingCount(),/AUTHORING_RETENTION_INVENTORY_UNSAFE/);await rm(link);
    for(let start=0;start<1025;start+=64)await Promise.all(Array.from({length:Math.min(64,1025-start)},(_,i)=>mkdir(join(root,`attempt-${start+i}`))));
    await assert.rejects(createFileWorkspaceRetention(root).pendingCount(),/AUTHORING_RETENTION_INVENTORY_LIMIT/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('completed file work survives result-store and recovery-store failure with measured usage intact', async () => {
  const f = await fixture('completed', false);
  try {
    f.input.fileWorkspace!.collect = async () => ({ private_candidate: true });
    f.journal.storeResult = async () => { throw Error('synthetic_result_store_unavailable'); };
    const result = await runContainedModelCall(f.input, f.journal, f.config);
    assert.equal(result.status, 'needs_reconcile'); assert.equal(result.error_code, 'MODEL_RESULT_STORE_FAILED');
    assert.equal(result.attempts[0]!.usage.status, 'measured');
    assert.equal(f.captures(), 1); assert.equal(f.journal.results.size, 0);
    assert.equal(await readFile(join(f.workspace(), 'output', 'operations.json'), 'utf8'), '{"saved":"synthetic substantive work"}');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
