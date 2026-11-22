import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeUsage,
  runDeepSeekProbe,
  type ProbeInput,
  type ProbeJournal,
  type ProbeObservation,
} from './deepseek-probe.js';

const seed: ProbeInput = {
  owner_user_id: 'user-synthetic',
  project_id: 'project-synthetic',
  job_id: 'job-synthetic',
  run_id: 'run-synthetic',
  trace_id: 'run-synthetic',
  logical_call_id: 'logical-synthetic',
  call_id: 'call-synthetic',
  attempt_no: 1,
  model_id: 'deepseek-flash',
  model_config_version: 'docs-20260924',
  prompt_snapshot_ref: 'private-blob-ref-synthetic',
  result_schema_version: 'update-result-v1',
  apiKey: 'synthetic-only',
  messages: [{ role: 'user', content: 'Return JSON' }],
  stream: false,
  validate: (v) => typeof v === 'object' && v !== null && (v as { ok?: boolean }).ok === true,
};
const syntheticStoreResult: ProbeJournal['storeResult'] = async (intent, bytes, schemaVersion) => {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return {
    result_ref: `users/${intent.owner_user_id}/projects/${intent.project_id}/provider-results/${intent.call_id}-${hash}.json`,
    result_sha256: hash,
    result_schema_version: schemaVersion,
    result_byte_size: bytes.length,
  };
};
function journal() {
  const events: string[] = [];
  const j: ProbeJournal = {
    recordIntent: async (i) => {
      assert.equal(i.prompt_snapshot_ref, seed.prompt_snapshot_ref);
      events.push('intent');
    },
    storeResult: async (i, b, s) => {
      events.push('store_result');
      return syntheticStoreResult(i, b, s);
    },
    recordObservation: async (o) => {
      assert.equal(o.call_id, seed.call_id);
      events.push('observation');
    },
  };
  return { j, events };
}
const okBody = {
  id: 'chatcmpl-synthetic',
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 12,
    prompt_cache_hit_tokens: 3,
    completion_tokens: 7,
    completion_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 19,
  },
};
function fake(body: unknown, status = 200): typeof fetch {
  return (async (_url: unknown, options: RequestInit) => {
    assert.equal(options.method, 'POST');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'x-request-id': 'request-synthetic' },
    });
  }) as typeof fetch;
}

test('intent commits before network, usage subsets are not double counted', async () => {
  const { j, events } = journal();
  const fetcher = (async (url: unknown, options: RequestInit) => {
    events.push('fetch');
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(options.body));
    assert.equal(body.tools, undefined);
    return new Response(JSON.stringify(okBody), {
      headers: { 'x-request-id': 'request-synthetic' },
    });
  }) as typeof fetch;
  const result = await runDeepSeekProbe(seed, j, fetcher);
  assert.deepEqual(events, ['intent', 'fetch', 'store_result', 'observation']);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.provider_request_id, 'request-synthetic');
  assert.ok(result.result_ref);
  assert.match(result.result_sha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.usage, {
    status: 'measured',
    input_tokens: 12,
    cached_input_tokens: 3,
    output_tokens: 7,
    reasoning_tokens: 2,
    total_tokens: 19,
  });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 22 }), {
    status: 'pending',
    input_tokens: 12,
    cached_input_tokens: null,
    output_tokens: 7,
    reasoning_tokens: null,
    total_tokens: 22,
  });
});

test('invalid model JSON is held for reconciliation with observed usage', async () => {
  const { j } = journal();
  const body = { ...okBody, choices: [{ message: { content: '{bad' }, finish_reason: 'stop' }] };
  const result = await runDeepSeekProbe(seed, j, fake(body));
  assert.equal(result.outcome, 'pending_reconcile');
  assert.equal(result.error_code, 'INVALID_MODEL_JSON');
  assert.equal(result.usage.status, 'measured');
});

test('timeout and cancellation leave attempts pending', async () => {
  for (const cancelled of [false, true]) {
    const { j } = journal();
    const controller = new AbortController();
    const fetcher = (async (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        if (cancelled) controller.abort();
        if (options.signal?.aborted) reject(new Error('aborted'));
      })) as typeof fetch;
    const result = await runDeepSeekProbe(
      { ...seed, signal: controller.signal, timeoutMs: cancelled ? 200 : 2 },
      j,
      fetcher,
    );
    assert.equal(result.outcome, 'pending_reconcile');
    assert.equal(result.error_code, cancelled ? 'CANCELLED' : 'TIMEOUT');
    assert.equal(result.usage.status, 'pending');
  }
});

test('interrupted stream cannot become completed or zero usage', async () => {
  const { j } = journal();
  const frame =
    'data: ' +
    JSON.stringify({
      id: 'chunk-synthetic',
      choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }) +
    '\n\n';
  const result = await runDeepSeekProbe({ ...seed, stream: true }, j, fake(frame));
  assert.equal(result.outcome, 'pending_reconcile');
  assert.equal(result.error_code, 'INTERRUPTED_STREAM');
  assert.equal(result.usage.status, 'pending');
});

test('stream uses final cumulative usage exactly once', async () => {
  const { j } = journal();
  const frames =
    [
      { id: 'chunk-synthetic', choices: [{ delta: { content: '{"ok":' }, finish_reason: null }] },
      { id: 'chunk-synthetic', choices: [{ delta: { content: 'true}' }, finish_reason: 'stop' }] },
      { id: 'chunk-synthetic', choices: [], usage: okBody.usage },
    ]
      .map((c) => 'data: ' + JSON.stringify(c) + '\n\n')
      .join('') + 'data: [DONE]\n\n';
  const result = await runDeepSeekProbe({ ...seed, stream: true }, j, fake(frames));
  assert.equal(result.outcome, 'completed');
  assert.equal(result.usage.total_tokens, 19);
  assert.equal(result.provider_request_id, 'request-synthetic');
});

test('DONE and valid JSON without measured final usage remain pending', async () => {
  for (const finalUsage of [undefined, { ...okBody.usage, total_tokens: 20 }]) {
    const { j, events } = journal();
    const chunks = [
      {
        id: 'chunk-synthetic',
        choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: okBody.usage,
      },
      { id: 'chunk-synthetic', choices: [], ...(finalUsage ? { usage: finalUsage } : {}) },
    ];
    const frames =
      chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
    const result = await runDeepSeekProbe({ ...seed, stream: true }, j, fake(frames));
    assert.equal(result.outcome, 'pending_reconcile');
    assert.equal(result.error_code, 'USAGE_PENDING');
    assert.equal(result.finish_reason, 'stop');
    assert.equal(result.usage.status, 'pending');
    assert.equal(result.usage.total_tokens, finalUsage?.total_tokens ?? 19);
    assert.deepEqual(events, ['intent', 'store_result', 'observation']);
  }
});

test('non-stream success with missing usage remains pending while preserving the validated result reference', async () => {
  const { j } = journal();
  const { usage: _usage, ...body } = okBody;
  const result = await runDeepSeekProbe(seed, j, fake(body));
  assert.equal(result.outcome, 'pending_reconcile');
  assert.equal(result.error_code, 'USAGE_PENDING');
  assert.equal(result.usage.total_tokens, null);
  assert.ok(result.result_ref);
  assert.equal(result.result_sha256?.length, 64);
});

test('pre-aborted input creates no intent or provider request', async () => {
  const controller = new AbortController();
  controller.abort();
  const { j, events } = journal();
  let fetched = false;
  await assert.rejects(
    runDeepSeekProbe({ ...seed, signal: controller.signal }, j, (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch),
    /PROBE_CANCELLED_BEFORE_INTENT/,
  );
  assert.deepEqual(events, []);
  assert.equal(fetched, false);
});

test('cancellation during durable intent is recorded as confirmed not sent', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let fetched = false;
  const j: ProbeJournal = {
    recordIntent: async () => {
      events.push('intent');
      controller.abort();
    },
    storeResult: syntheticStoreResult,
    recordObservation: async (o) => {
      events.push('observation');
      assert.equal(o.outcome, 'confirmed_not_sent');
    },
  };
  const result = await runDeepSeekProbe({ ...seed, signal: controller.signal }, j, (async () => {
    fetched = true;
    return new Response('{}');
  }) as typeof fetch);
  assert.equal(result.outcome, 'confirmed_not_sent');
  assert.equal(result.error_code, 'CANCELLED');
  assert.equal(result.usage.status, 'unknown');
  assert.deepEqual(events, ['intent', 'observation']);
  assert.equal(fetched, false);
});

test('tool output, including cross-project material access, is denied', async () => {
  const { j } = journal();
  const body = {
    ...okBody,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { function: { name: 'read_material', arguments: '{"project_id":"other-project"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
  const result = await runDeepSeekProbe(seed, j, fake(body));
  assert.equal(result.outcome, 'pending_reconcile');
  assert.equal(result.error_code, 'TOOL_DENIED');
});

test('journal failure prevents external request', async () => {
  let fetched = false;
  const j: ProbeJournal = {
    recordIntent: async () => {
      throw new Error('database unavailable');
    },
    storeResult: syntheticStoreResult,
    recordObservation: async (_o: ProbeObservation) => {},
  };
  await assert.rejects(
    runDeepSeekProbe(seed, j, (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch),
    /database unavailable/,
  );
  assert.equal(fetched, false);
});
