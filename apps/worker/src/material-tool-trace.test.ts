import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMaterialToolTrace,
  isMaterialModelEnvelope,
  validateMaterialToolTrace,
} from './material-tool-trace.js';
import type { MaterialToolData } from './authoring-material-tools.js';
import {
  buildCodexArgs,
  composeContainedPrompt,
  DEFAULT_DISABLED_FEATURES,
  runContainedModelCall,
  type CodexAdapterConfig,
  type ContainedCallInput,
} from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';

const data: MaterialToolData = {
  materials: [
    {
      id: 'm0',
      filename: 'synthetic.txt',
      context: { version: 1 },
      records: [
        { id: 'r0', text: 'Unrelated record', uncertainty: [] },
        { id: 'r1', text: 'Synthetic issuer disclosure', uncertainty: [] },
      ],
    },
  ],
};
test('material receipts reject ambiguous identities, other snapshots and invented records', () => {
  const trace = createMaterialToolTrace(data);
  assert(validateMaterialToolTrace(data, trace));
  assert(!validateMaterialToolTrace(data, { ...trace, read_record_ids: ['other-project'] }));
  assert(!validateMaterialToolTrace(data, { ...trace, read_record_ids: ['r1', 'r1'] }));
  const changed = structuredClone(data);
  changed.materials[0]!.context = { version: 2 };
  assert(!validateMaterialToolTrace(changed, trace));
  changed.materials[0]!.records.push({ ...changed.materials[0]!.records[0]! });
  assert.throws(() => createMaterialToolTrace(changed), /AMBIGUOUS/);
});
test(
  'real MCP read trace is durable and replay does not send a new CLI request',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-material-trace-'));
    const config: CodexAdapterConfig = {
      command: [
        process.execPath,
        fileURLToPath(new URL('../test-fixtures/codex/fake-material-trace.mjs', import.meta.url)),
      ],
      model_id: 'deepseek-flash',
      model_provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      wire_api: 'responses',
      model_config_version: 'synthetic-trace',
      reasoning_effort: null,
      credential: { kind: 'env', name: 'BB_SYNTHETIC_TRACE_KEY' },
      work_root: root,
      timeout_ms: 10000,
      kill_grace_ms: 100,
      max_output_bytes: 1024 * 1024,
      max_schema_reasks: 0,
      disabled_features: DEFAULT_DISABLED_FEATURES,
      path_env: process.env.PATH ?? '',
    };
    const input: ContainedCallInput = {
      owner_user_id: 'owner',
      project_id: 'project',
      job_id: 'job',
      run_id: 'run',
      trace_id: 'run',
      logical_call_id: 'read',
      prompt_snapshot_ref: 'prompt',
      prompt: 'read',
      output: {
        kind: 'json',
        schema: { type: 'object' },
        validate: (v) => !!v && typeof v === 'object',
      },
      result_schema_version: 'synthetic-trace-v1',
      materialTools: data,
      materialToolsTrace: true,
    };
    try {
      const journal = new MemoryCodexJournal(),
        first = await runContainedModelCall(input, journal, config);
      assert.equal(first.status, 'completed', first.error_code ?? undefined);
      assert(isMaterialModelEnvelope(first.value, data));
      assert.deepEqual(first.value.tool_trace.read_record_ids, ['r1']);
      const saved = JSON.parse(journal.results.get(first.attempts[0]!.call_id)!.toString('utf8'));
      assert.deepEqual(saved, first.value);
      journal.prior = {
        call_id: first.attempts[0]!.call_id,
        attempt_no: 1,
        status: 'completed',
        observed: true,
      };
      journal.readCompleted = async () => ({
        value: saved,
        result_sha256: first.attempts[0]!.result_sha256!,
      });
      const before = [...journal.events];
      assert.equal((await runContainedModelCall(input, journal, config)).status, 'reused');
      assert.deepEqual(journal.events, before);
      const changed = structuredClone(data);
      changed.materials[0]!.records[1]!.text = 'Changed disclosure';
      assert.equal(
        (await runContainedModelCall({ ...input, materialTools: changed }, journal, config)).status,
        'needs_reconcile',
      );
      const forged = await runContainedModelCall(
        { ...input, prompt: 'stdout-only' },
        new MemoryCodexJournal(),
        config,
      );
      assert(isMaterialModelEnvelope(forged.value, data));
      assert.deepEqual(
        forged.value.tool_trace.read_record_ids,
        [],
        'stdout claim is not a host read',
      );
      await assert.rejects(
        runContainedModelCall(input, new MemoryCodexJournal(), { ...config, web_search: 'live' }),
        /MODEL_ADAPTER_CONFIG_INVALID/,
      );
      await assert.rejects(
        runContainedModelCall(
          { ...input, materialToolsTrace: undefined },
          new MemoryCodexJournal(),
          { ...config, web_search: 'live' },
        ),
        /MODEL_ADAPTER_CONFIG_INVALID/,
      );
      assert.throws(
        () =>
          buildCodexArgs(
            { ...config, web_search: 'live' },
            {
              cwd: root,
              schemaFile: null,
              ephemeral: true,
              resumeThreadId: null,
              materialDataFile: join(root, 'materials.json'),
            },
          ),
        /MODEL_ADAPTER_CONFIG_INVALID/,
      );
      assert.throws(
        () =>
          composeContainedPrompt({
            instructions: 'read',
            materials: [],
            materialTools: true,
            webSearch: true,
          }),
        /MODEL_ADAPTER_CONFIG_INVALID/,
      );
    } finally {
      assert(root.startsWith(join(tmpdir(), 'bb-material-trace-')));
      await rm(root, { recursive: true, force: true });
    }
  },
);
