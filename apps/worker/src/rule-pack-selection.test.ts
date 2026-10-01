import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputLockStage, type StageContext } from './run-pipeline.js';

const hash = 'a'.repeat(64);

function stageContext(manifest: unknown, version: string | null): StageContext {
  const pool = {
    query: async () => ({ rows: [{ input_hash: hash, material_versions: [], rule_pack_version: version, manifest,
      template_version: null, reference_release: null }] }),
  };
  return {
    pool: pool as never,
    blobs: {} as never,
    lease: {} as never,
    run: { id: 'synthetic-run', owner_user_id: 'synthetic-owner', project_id: 'synthetic-project', input_revision: 1,
      input_hash: hash, task_kind: 'review' },
    signal: new AbortController().signal,
    checkpoint: {},
    values: new Map(),
  };
}

test('production input lock parks an unpinned revision without checkpointing it', async () => {
  assert.equal(inputLockStage.replay, true, 'recovery must repeat the release check');
  const result = await inputLockStage.run(stageContext({ rule_pack_version: null }, null));
  assert.deepEqual(result, { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_pack_pin_missing' });
});

test('self-asserted test or production metadata cannot satisfy the missing authenticated selector', async () => {
  for (const channel of ['test', 'production']) {
    const manifest = { rule_pack_pin: { pack_id: 'synthetic-pack', version: 'synthetic.1', content_hash: hash, channel } };
    const result = await inputLockStage.run(stageContext(manifest, 'synthetic.1'));
    assert.deepEqual(result, { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_pack_pin_missing' });
  }
});
