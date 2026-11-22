import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runContainedModelCall,
  loadCodexAdapterConfig,
  CodexOutputValidationError,
  type ContainedCallInput,
} from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bb-native-files-test-'));
  let prepared = 0,
    collected = 0;
  const config = {
    ...loadCodexAdapterConfig({ BB_CODEX_PATH: process.env.BB_CODEX_PATH }),
    command: [
      process.execPath,
      fileURLToPath(new URL('../test-fixtures/codex/fake-file-authoring.mjs', import.meta.url)),
    ],
    work_root: root,
    timeout_ms: 20,
    authoring_timeout_ms: 5000,
  };
  const input: ContainedCallInput = {
    owner_user_id: 'synthetic-owner',
    project_id: 'synthetic-project',
    job_id: 'synthetic-job',
    run_id: 'synthetic-run',
    trace_id: 'synthetic-run',
    logical_call_id: 'file-authoring-v1',
    prompt_snapshot_ref: 'synthetic-prompt',
    prompt: 'SCENARIO:file_done',
    output: { kind: 'text' },
    result_schema_version: 'synthetic-file-v1',
    fileWorkspace: {
      prepare: async (cwd) => {
        prepared++;
        for (const dir of ['scratch', 'output']) await mkdir(join(cwd, dir));
        await writeFile(join(cwd, 'input.json'), '{}');
      },
      collect: async (cwd) => {
        collected++;
        return { file: await readFile(join(cwd, 'output/fixture.txt'), 'utf8') };
      },
    },
  };
  return { root, config, input, counts: () => ({ prepared, collected }) };
}
test(
  'continuation capability matches the workspace contract and foreign resource tools remain blocked',
  { skip: process.platform !== 'linux' },
  async () => {
    for (const [completion, scenario, allowed] of [
      [true, 'file_checkpoint', true],
      [false, 'file_checkpoint', false],
      [true, 'file_resource', false],
    ] as const) {
      const s = await setup();
      try {
        const result = await runContainedModelCall(
          {
            ...s.input,
            prompt: `SCENARIO:${scenario}`,
            fileWorkspace: { ...s.input.fileWorkspace!, completionCheck: completion },
          },
          new MemoryCodexJournal(),
          s.config,
        );
        if (allowed) {
          assert.equal(result.status, 'completed');
          assert.equal(s.counts().collected, 1);
        } else {
          assert.equal(result.error_code, 'MODEL_TOOL_ATTEMPT_BLOCKED');
          assert.equal(s.counts().collected, 0);
        }
      } finally {
        await rm(s.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  'file mode accepts prose, stores actual file result and replays without a second CLI',
  { skip: process.platform !== 'linux' },
  async () => {
    const s = await setup();
    try {
      const journal = new MemoryCodexJournal();
      const r = await runContainedModelCall(s.input, journal, s.config);
      assert.equal(r.status, 'completed');
      assert.deepEqual(r.value, { file: 'synthetic file' });
      assert.equal(r.attempts.length, 1);
      assert.equal(r.attempts[0]!.adapter_version, 'codex-file-authoring-1');
      assert.deepEqual(s.counts(), { prepared: 1, collected: 1 });
      journal.prior = {
        call_id: r.attempts[0]!.call_id,
        attempt_no: 1,
        status: 'completed',
        observed: true,
      };
      journal.readCompleted = async () => ({
        value: r.value,
        result_sha256: r.attempts[0]!.result_sha256!,
      });
      assert.equal((await runContainedModelCall(s.input, journal, s.config)).status, 'reused');
      assert.deepEqual(s.counts(), { prepared: 1, collected: 1 });
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  },
);
test(
  'file mode cancellation kills the native command group and never collects or resends',
  { skip: process.platform !== 'linux' },
  async () => {
    const s = await setup();
    try {
      const abort = new AbortController(),
        journal = new MemoryCodexJournal();
      const r = await runContainedModelCall(
        {
          ...s.input,
          prompt: 'SCENARIO:file_hang',
          signal: abort.signal,
          onEvent: (e) => {
            if (e.type === 'item.started') abort.abort();
          },
        },
        journal,
        s.config,
      );
      assert.equal(r.status, 'needs_reconcile');
      assert.equal(r.error_code, 'MODEL_CANCELLED');
      assert.equal(r.attempts.length, 1);
      assert.equal(r.attempts[0]!.usage.status, 'unknown');
      assert.equal(s.counts().collected, 0);
      journal.prior = {
        call_id: r.attempts[0]!.call_id,
        attempt_no: 1,
        status: 'pending_reconcile',
        observed: true,
      };
      assert.equal(
        (await runContainedModelCall(s.input, journal, s.config)).status,
        'needs_reconcile',
      );
      assert.equal(s.counts().prepared, 1);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  },
);
test(
  'file mode validates actual output when a completed CLI has no final prose',
  { skip: process.platform !== 'linux' },
  async () => {
    const s = await setup();
    try {
      const result = await runContainedModelCall(
        { ...s.input, prompt: 'SCENARIO:file_no_prose' },
        new MemoryCodexJournal(),
        s.config,
      );
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.value, { file: 'synthetic file' });
      assert.equal(result.attempts.length, 1);
      assert.deepEqual(s.counts(), { prepared: 1, collected: 1 });
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  },
);

test(
  'known-invalid file output is a measured failure; storage errors still require reconciliation',
  { skip: process.platform !== 'linux' },
  async () => {
    const s = await setup();
    try {
      for (const [error, expected] of [
        [new CodexOutputValidationError('workpaper_source_coverage_incomplete'), 'failed'],
        [new Error('synthetic_storage_error'), 'needs_reconcile'],
      ] as const) {
        const journal = new MemoryCodexJournal();
        const result = await runContainedModelCall(
          {
            ...s.input,
            fileWorkspace: {
              ...s.input.fileWorkspace!,
              collect: async () => {
                throw error;
              },
            },
          },
          journal,
          s.config,
        );
        assert.equal(result.status, expected);
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0].usage.status, 'measured');
        assert.equal(
          result.error_code,
          expected === 'failed' ? 'MODEL_OUTPUT_SCHEMA_INVALID' : 'MODEL_RESULT_STORE_FAILED',
        );
        assert.equal(result.value, null);
      }
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  },
);
