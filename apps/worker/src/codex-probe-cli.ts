// Operator probe for the authorized host: runs ONE contained Codex attempt with the server
// config from BB_CODEX_* env and prints the redacted, normalized #79 attempt record.
// Journal is in-memory (nothing persisted). Use synthetic prompts only.
//   npm run -w apps/worker probe:codex -- --prompt-file x.txt [--schema-file s.json] [--material-file m.txt] [--timeout-ms 60000]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  composeContainedPrompt,
  loadCodexAdapterConfig,
  runContainedModelCall,
} from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';

// This synthetic-only CLI has no durable lease or PG permit. Managed and
// production execution must use the existing leased probe entry instead.
if (process.env.BB_EXECUTION_ENROLLMENT_FILE || process.env.NODE_ENV === 'production') {
  process.stderr.write('CODEX_PROBE_REQUIRES_DURABLE_LEASE\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    'prompt-file': { type: 'string' },
    'schema-file': { type: 'string' },
    'material-file': { type: 'string' },
    'timeout-ms': { type: 'string' },
  },
});
if (!values['prompt-file']) {
  process.stderr.write(
    'usage: probe:codex -- --prompt-file <file> [--schema-file <json>] [--material-file <txt>] [--timeout-ms N]\n',
  );
  process.exit(2);
}
const config = loadCodexAdapterConfig({
  ...process.env,
  ...(values['timeout-ms'] ? { BB_CODEX_TIMEOUT_MS: values['timeout-ms'] } : {}),
});
const instructions = readFileSync(values['prompt-file'], 'utf8');
const prompt = values['material-file']
  ? composeContainedPrompt({
      instructions,
      materials: [{ ref: 'probe-material-1', text: readFileSync(values['material-file'], 'utf8') }],
    })
  : instructions;
const schema = values['schema-file']
  ? (JSON.parse(readFileSync(values['schema-file'], 'utf8')) as Record<string, unknown>)
  : null;
const validateSchema = schema
  ? (schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
      ? new Ajv2020({ strict: false })
      : new Ajv({ strict: false })
    ).compile(schema)
  : null;
const journal = new MemoryCodexJournal();
const id = `probe-${Date.now().toString(36)}`;
const result = await runContainedModelCall(
  {
    owner_user_id: 'probe-owner',
    project_id: 'probe-project',
    job_id: `${id}-job`,
    run_id: `${id}-run`,
    trace_id: `${id}-run`,
    logical_call_id: `${id}-call`,
    prompt_snapshot_ref: `${id}-prompt`,
    prompt,
    result_schema_version: 'probe-v1',
    // Provider dialect normalization may omit constraints; validate the original schema locally.
    output: schema
      ? {
          kind: 'json',
          schema,
          validate: (v) =>
            typeof v === 'object' && v !== null && !Array.isArray(v) && !!validateSchema?.(v),
        }
      : { kind: 'text' },
  },
  journal,
  config,
);
process.stdout.write(
  JSON.stringify(
    {
      label: 'bb-codex-probe (in-memory journal, not durable)',
      status: result.status,
      error_code: result.error_code,
      config: {
        command: config.command[0].split('/').pop(),
        model_id: config.model_id,
        model_provider: config.model_provider,
        base_url: config.base_url,
        wire_api: config.wire_api,
        model_config_version: config.model_config_version,
        credential:
          config.credential.kind === 'env'
            ? { kind: 'env', name: config.credential.name }
            : { kind: config.credential.kind },
        disabled_features: config.disabled_features,
      },
      attempts: result.attempts,
      event_order: journal.events,
    },
    null,
    2,
  ) + '\n',
);
process.exit(result.status === 'completed' ? 0 : 1);
