import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TargetFactsSnapshot } from './no-history-model-stage.js';
import {
  renderNoHistoryDraft,
  trustedTargetFactIdsFromSnapshot,
  type TrustedTargetFactIds,
} from './no-history-word-bridge.js';
import type { StageContext } from './run-pipeline.js';

const binding = {
  ownerUserId: 'owner-1',
  projectId: 'project-1',
  runId: 'run-1',
  inputRevision: 2,
  inputHash: 'a'.repeat(64),
};
const snapshot: TargetFactsSnapshot = {
  ...binding,
  facts: [
    {
      factId: 'target-fact-a',
      statement: '目标发行人事实。',
      evidenceRefs: ['evidence-a'],
      status: 'verified',
    },
  ],
};

function context(signal = new AbortController().signal): StageContext {
  return {
    run: {
      id: binding.runId,
      owner_user_id: binding.ownerUserId,
      project_id: binding.projectId,
      input_revision: binding.inputRevision,
      input_hash: binding.inputHash,
      task_kind: 'generation',
    },
    signal,
  } as StageContext;
}

function draft(heading = '第一章 发行人情况', factId = 'target-fact-a') {
  return {
    schema_version: 'no-history-manuscript-draft-v1',
    sections: [{ heading, body: '本句来自目标发行人材料。' }],
    fact_claims: [{ claim: '本句来自目标发行人材料。', target_fact_ids: [factId] }],
    open_questions: ['请人工确认发行期限。'],
  };
}

async function installFakePython(directory: string, body: string): Promise<string> {
  const executable = join(directory, 'fake-python');
  await writeFile(executable, `#!/usr/bin/env python3\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test('trusted target IDs are scoped to the same owner, run, revision, and input hash', () => {
  assert.deepEqual([...trustedTargetFactIdsFromSnapshot(snapshot, binding)], ['target-fact-a']);
  assert.throws(
    () => trustedTargetFactIdsFromSnapshot({ ...snapshot, inputHash: 'b'.repeat(64) }, binding),
    /SCOPE_MISMATCH/,
  );
  assert.throws(
    () =>
      trustedTargetFactIdsFromSnapshot(
        {
          ...snapshot,
          facts: [{ ...snapshot.facts[0]!, status: 'needs_confirmation' as 'verified' }],
        },
        binding,
      ),
    /FACTS_INVALID/,
  );
});

test('a run-scoped allowlist cannot be reused by another run or forged with a plain Set', async () => {
  const trustedA = trustedTargetFactIdsFromSnapshot(snapshot, binding);
  const bindingB = { ...binding, runId: 'run-2' };
  const snapshotB: TargetFactsSnapshot = {
    ...bindingB,
    facts: [
      {
        factId: 'target-fact-b',
        statement: '另一 run 的事实。',
        evidenceRefs: ['evidence-b'],
        status: 'verified',
      },
    ],
  };
  const runB = context();
  runB.run.id = bindingB.runId;
  const trustedB = trustedTargetFactIdsFromSnapshot(snapshotB, bindingB);
  assert.deepEqual([...trustedB], ['target-fact-b']);
  await assert.rejects(
    renderNoHistoryDraft(runB, draft('第一章 发行人情况', 'target-fact-b'), trustedA),
    /SCOPE_MISMATCH/,
  );
  await assert.rejects(
    renderNoHistoryDraft(
      context(),
      draft(),
      new Set(['target-fact-a']) as unknown as TrustedTargetFactIds,
    ),
    /SCOPE_MISMATCH/,
  );
});

test(
  'actual Python renderer returns deterministic DOCX bytes and explicitly non-deliverable metadata',
  {
    skip: (() => {
      const python =
        process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON ??
        process.env.BONDBUDDY_TEST_PYTHON ??
        'python3';
      const probe = spawnSync(python, ['-c', 'import docx'], { encoding: 'utf8', timeout: 10_000 });
      return probe.status === 0
        ? false
        : 'Python python-docx is unavailable; set BONDBUDDY_TEST_PYTHON to the repository test environment.';
    })(),
  },
  async () => {
    const trustedIds = trustedTargetFactIdsFromSnapshot(snapshot, binding);
    const first = await renderNoHistoryDraft(context(), draft(), trustedIds);
    const second = await renderNoHistoryDraft(context(), draft(), trustedIds);
    assert.ok(first.bytes.subarray(0, 2).equals(Buffer.from('PK')));
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.metadata.sha256, second.metadata.sha256);
    assert.equal(first.metadata.writerVersion, 'bondbuddy-no-history-draft-writer-1.1.0');
    assert.equal(first.metadata.runBinding.inputHash, binding.inputHash);
    assert.equal(first.metadata.factsVerified, false);
    assert.equal(first.metadata.deliveryChecked, false);
    assert.equal(first.metadata.factIdsAllowlisted, true);
    const python =
      process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON ??
      process.env.BONDBUDDY_TEST_PYTHON ??
      'python3';
    const readback = spawnSync(
      python,
      [
        '-c',
        "import io,sys; from docx import Document; d=Document(io.BytesIO(sys.stdin.buffer.read())); print('\\n'.join(p.text for p in d.paragraphs))",
      ],
      { input: first.bytes, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(readback.status, 0, readback.stderr);
    assert.match(readback.stdout, /第一章 发行人情况/);
    assert.match(readback.stdout, /待人工确认：请人工确认发行期限/);
  },
);

test('model-provided foreign fact IDs are not added to the trusted allowlist', async () => {
  const trustedIds = trustedTargetFactIdsFromSnapshot(snapshot, binding);
  assert.deepEqual([...trustedIds], ['target-fact-a']);
  await assert.rejects(
    renderNoHistoryDraft(
      context(),
      draft('第一章 发行人情况', 'library-fact-from-model'),
      trustedIds,
    ),
    /RENDER_FAILED/,
  );
});

test('renderer summary hash tampering fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-no-history-bridge-test-'));
  const previous = process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON;
  try {
    const fake = await installFakePython(
      directory,
      `import json, os, pathlib, sys
request = json.loads(sys.stdin.buffer.read())
output = pathlib.Path(os.environ['BONDBUDDY_WORD_OUTPUT_DIR'], 'no-history-manuscript-draft.docx')
output.write_bytes(b'PK\\x03\\x04')
os.chmod(output, 0o600)
print(json.dumps({'schema_version':'no-history-manuscript-draft-render-response-v1','status':'rendered','writer_version':'bondbuddy-no-history-draft-writer-1.1.0','output_sha256':'${'0'.repeat(64)}','output_size_bytes':4,'section_count':1,'fact_claim_count':1,'pending_question_count':1}))`,
    );
    process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON = fake;
    await assert.rejects(
      renderNoHistoryDraft(context(), draft(), trustedTargetFactIdsFromSnapshot(snapshot, binding)),
      /OUTPUT_HASH_MISMATCH/,
    );
  } finally {
    if (previous === undefined) delete process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON;
    else process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('subprocess buffer overflow and interruption are bounded and fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-no-history-bridge-test-'));
  const previous = process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON;
  try {
    const fake = await installFakePython(
      directory,
      `import json, sys, time
request = json.loads(sys.stdin.buffer.read())
if request['draft']['sections'][0]['heading'] == 'interrupt':
    time.sleep(10)
    raise SystemExit(0)
sys.stdout.write('x' * (1024 * 1024 + 1))
sys.stdout.flush()
time.sleep(10)`,
    );
    process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON = fake;
    await assert.rejects(
      renderNoHistoryDraft(context(), draft(), trustedTargetFactIdsFromSnapshot(snapshot, binding)),
      /OUTPUT_LIMIT_EXCEEDED/,
    );

    await assert.rejects(
      renderNoHistoryDraft(
        context(),
        draft('interrupt'),
        trustedTargetFactIdsFromSnapshot(snapshot, binding),
        { timeoutMs: 250 },
      ),
      /TIMEOUT/,
    );

    const abortController = new AbortController();
    const pending = renderNoHistoryDraft(
      context(abortController.signal),
      draft('interrupt'),
      trustedTargetFactIdsFromSnapshot(snapshot, binding),
    );
    setTimeout(() => abortController.abort(), 50).unref();
    await assert.rejects(pending, /INTERRUPTED/);
  } finally {
    if (previous === undefined) delete process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON;
    else process.env.BONDBUDDY_NO_HISTORY_WORD_PYTHON = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('only versioned no-history draft inputs and generation runs are accepted', async () => {
  const trustedIds = trustedTargetFactIdsFromSnapshot(snapshot, binding);
  await assert.rejects(
    renderNoHistoryDraft(context(), { ...draft(), schema_version: 'unknown-v1' }, trustedIds),
    /VERSION_UNSUPPORTED/,
  );
  const update = context();
  (update.run as { task_kind: string }).task_kind = 'update';
  await assert.rejects(renderNoHistoryDraft(update, draft(), trustedIds), /TASK_KIND_REQUIRED/);
});
