import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import { runContainedModelCall, loadCodexAdapterConfig, type CodexAdapterConfig } from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';
import { revisionCliFixture } from './review-revision-cli-test-fixture.js';
import { reviewRevisionCliStage, reviewRevisionCliDeliveryStage, type ReviewRevisionCliResult } from './review-revision-cli-stage.js';

test('M3 revision uses real native Codex sandbox + Python tool, saves actual files, and replays without another CLI',
  { skip: process.platform !== 'linux', timeout: 90000 }, async () => {
    const f = await revisionCliFixture();
    let prepared = 0, collected = 0;
    const journal = new MemoryCodexJournal();
    const config = { ...loadCodexAdapterConfig({}), work_root: join(f.root, 'attempts'), timeout_ms: 5000, authoring_timeout_ms: 60000,
      command: [process.execPath, fileURLToPath(new URL('../test-fixtures/codex/fake-review-revision-cli.mjs', import.meta.url))] };
    try {
      const stage = reviewRevisionCliStage({ load: async () => f.input, config, checkpoint: async () => {}, model: options => ({
        name: options.name, run: async ctx => {
          const result = await runContainedModelCall({ owner_user_id: ctx.run.owner_user_id, project_id: ctx.run.project_id,
            job_id: 'synthetic-job', run_id: ctx.run.id, trace_id: ctx.run.id, logical_call_id: options.logicalCallId,
            prompt_snapshot_ref: 'synthetic-prompt', prompt: await options.buildPrompt(ctx), output: { kind: 'text' },
            result_schema_version: options.resultSchemaVersion!, signal: ctx.signal,
            fileWorkspace: {
              prepare: async cwd => { prepared++; await options.fileWorkspace!.prepare(cwd); },
              collect: async (cwd, intent) => { collected++; return options.fileWorkspace!.collect(cwd, intent); },
            },
          }, journal, options.config as CodexAdapterConfig);
          assert.ok(['completed', 'reused'].includes(result.status), JSON.stringify({ status: result.status, error: result.error_code, attempts: result.attempts }));
          assert.ok(options.validate(result.value));
          return { kind: 'done', value: result.value };
        },
      }) });
      const first = await stage.run(f.ctx);
      assert.equal(first.kind, 'done'); if (first.kind !== 'done') throw Error('expected actual native result');
      const value = first.value as ReviewRevisionCliResult;
      assert.equal(value.error, undefined); assert.equal(value.handling?.items[0]?.status, 'modified');
      assert.deepEqual({ prepared, collected, calls: journal.intents.length }, { prepared: 1, collected: 1, calls: 1 });
      assert.equal(journal.observations[0]?.observation.usage.status, 'measured');
      assert.equal(journal.runtimes[0]?.tool_attempts, 1);
      const intent = journal.intents[0]!;
      journal.prior = { call_id: intent.call_id, attempt_no: 1, status: 'completed', observed: true };
      journal.readCompleted = async () => ({ value, result_sha256: digest(journal.results.get(intent.call_id)!) });
      const replay = await stage.run(f.ctx);
      assert.equal(replay.kind, 'done'); if (replay.kind !== 'done') throw Error('expected replay');
      assert.deepEqual(replay.value, value);
      assert.deepEqual({ prepared, collected, calls: journal.intents.length }, { prepared: 1, collected: 1, calls: 1 });
      f.ctx.values.set('model_generation', replay.value);
      const delivery = await reviewRevisionCliDeliveryStage().run(f.ctx);
      assert.equal(delivery.kind, 'deliver'); if (delivery.kind !== 'deliver') throw Error('expected delivery');
      assert.ok(delivery.bytes.length && delivery.cleanBytes?.length && delivery.baselineBytes?.length);
      assert.equal(delivery.wordSummary?.review_passed, false);
      assert.equal(journal.intents.length, 1, 'delivery and replay cannot regenerate the document');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
