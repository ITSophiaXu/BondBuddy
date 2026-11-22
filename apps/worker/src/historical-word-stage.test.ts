import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateContentHash } from '@bondbuddy/domain/historical-update';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import type { StageContext } from './run-pipeline.js';
import { workerRuntimeOptionsFromEnv } from './runtime.js';
import { splitHistoricalReviewNotes } from './historical-review-notes.js';

function productionWordStage() {
  const options = workerRuntimeOptionsFromEnv(
    {} as Parameters<typeof workerRuntimeOptionsFromEnv>[0],
    {} as Parameters<typeof workerRuntimeOptionsFromEnv>[1],
    { BB_WORKER_JOB_KINDS: 'run' },
  );
  const stage = options.runStages?.find((candidate) => candidate.name === 'word_delivery');
  assert.ok(stage);
  return stage;
}

function context(plan: Record<string, unknown>): StageContext {
  return {
    run: {
      id: 'run-1',
      owner_user_id: 'owner-1',
      project_id: 'project-1',
      input_revision: 2,
      input_hash: 'a'.repeat(64),
      task_kind: 'update',
    },
    values: new Map([['model_generation', plan]]),
    signal: new AbortController().signal,
  } as StageContext;
}

function plan(): Record<string, unknown> {
  const content = {
    schemaVersion: 'historical-update-plan-v1',
    deliverable: false,
    baselineHash: 'b'.repeat(64),
    context: {
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      inputRevision: 2,
      inputHash: 'a'.repeat(64),
    },
    source: { format: 'docx_effective', contentHash: 'c'.repeat(64) },
    generation: { version: 'historical-sse-private-v1' },
    reviewNotes: [],
    findings: [],
    replacements: [{ changeId: 'supported' }],
    columns: [],
  };
  return { ...content, planHash: updateContentHash(content) };
}

test('Word delivery consumes a complete hashed plan and emits three document bytes', async () => {
  let called = 0;
  const writer = async () => {
    called++;
    return {
      revision: Buffer.from('revision'),
      clean: Buffer.from('clean'),
      baseline: Buffer.from('baseline'),
      summary: {
        writer_version: 'bondbuddy-word-delivery-1.0.0',
        source_sha256: 'c'.repeat(64),
        baseline_hash: 'b'.repeat(64),
        plan_hash: 'd'.repeat(64),
        replacements: 1,
        columns: 0,
        pending: 0,
        revision_sha256: 'e'.repeat(64),
        clean_sha256: 'f'.repeat(64),
        effective_baseline_sha256: '0'.repeat(64),
      },
    };
  };
  const stage = historicalWordDeliveryStage({ writer });
  const result = await stage.run(context(plan()));
  assert.equal(result.kind, 'deliver');
  if (result.kind === 'deliver') {
    assert.deepEqual(result.bytes, Buffer.from('revision'));
    assert.deepEqual(result.cleanBytes, Buffer.from('clean'));
    assert.deepEqual(result.baselineBytes, Buffer.from('baseline'));
  }
  assert.equal(called, 1);
  assert.equal(stage.replay, true);
});

test('Word delivery fails closed on tampered plan, scope, or missing pending note', async () => {
  let called = 0;
  const stage = historicalWordDeliveryStage({
    writer: async () => {
      called++;
      throw new Error('unexpected');
    },
  });
  const tampered = plan();
  tampered.replacements = [];
  assert.deepEqual(await stage.run(context(tampered)), { kind: 'fail', code: 'VALIDATION_FAILED' });
  const wrongScope = plan();
  wrongScope.context = { ...(wrongScope.context as object), ownerUserId: 'other' };
  assert.deepEqual(await stage.run(context(wrongScope)), {
    kind: 'fail',
    code: 'VALIDATION_FAILED',
  });
  const pending = plan();
  pending.findings = [{ recordIds: ['record-1'] }];
  pending.planHash = updateContentHash(
    Object.fromEntries(Object.entries(pending).filter(([key]) => key !== 'planHash')),
  );
  assert.deepEqual(await stage.run(context(pending)), { kind: 'fail', code: 'VALIDATION_FAILED' });
  assert.equal(called, 0);
});

test('production runtime binds the real Word stage and rejects missing locked source', async () => {
  const stage = productionWordStage();
  assert.equal(stage.replay, true, 'the real writer stage must replay after a worker restart');
  const noHistory = context(plan());
  noHistory.run.task_kind = 'generation';
  assert.deepEqual(await stage.run(noHistory), {
    kind: 'pause',
    stage: 'capability_not_ready',
    reason: 'historical_word_task_kind_required',
  });

  const locked = context(plan());
  locked.run.task_kind = 'update';
  locked.pool = { query: async () => ({ rows: [] }) } as unknown as StageContext['pool'];
  assert.deepEqual(
    await stage.run(locked),
    { kind: 'fail', code: 'WORD_QUALITY_REJECTED' },
    'a valid synthetic plan must reach the writer and fail on absent server-side source',
  );
});

test(
  'actual Python writer accepts a locked synthetic source through the worker stage',
  {
    skip:
      !process.env.BONDBUDDY_TEST_PYTHON &&
      'Set BONDBUDDY_TEST_PYTHON to run the real Python writer bridge.',
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bb-word-stage-test-'));
    try {
      const repo = fileURLToPath(new URL('../../../', import.meta.url));
      const sourcePath = join(directory, 'source.docx');
      const code = `import json,sys,io,base64\nfrom pathlib import Path\nfrom docx import Document\nfrom bondbuddy_document_parser.parser import _parse_docx\np=Path(sys.argv[1]); d=Document(); d.add_paragraph('截至2024年末净资产100万元。'); d.add_paragraph('风险说明保持原文。'); d.sections[0].header.paragraphs[0].text='合成页眉待核'; d.sections[0].footer.paragraphs[0].text='合成页脚待核'; d.add_picture(io.BytesIO(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII='))); d.save(p); print(json.dumps(_parse_docx(p,{})[0],ensure_ascii=False))`;
      const generated = spawnSync(process.env.BONDBUDDY_TEST_PYTHON!, ['-c', code, sourcePath], {
        cwd: repo,
        env: { ...process.env, PYTHONPATH: join(repo, 'python') },
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(generated.status, 0, generated.stderr);
      const rows = JSON.parse(generated.stdout) as {
        record_id: string;
        literal_quote: string;
        locator: Record<string, unknown>;
        formatting: Record<string, unknown>;
      }[];
      const source = await readFile(sourcePath);
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const first = rows[0]!,
        second = rows[1]!;
      const before = first.literal_quote;
      const start = before.indexOf('100');
      const completeNote = `待人工确认：原稿辅助对象word/header1.xml、word/footer1.xml和图片保留待核；${'缺少材料😀'.repeat(200)}；未作为审计来源核验`;
      const reviewNotes = splitHistoricalReviewNotes([
        { recordId: second.record_id, message: completeNote },
      ]);
      const content = {
        schemaVersion: 'historical-update-plan-v1',
        deliverable: false,
        baselineHash: 'b'.repeat(64),
        context: {
          ownerUserId: 'owner-1',
          projectId: 'project-1',
          inputRevision: 2,
          inputHash: 'a'.repeat(64),
        },
        source: {
          materialId: 'historical-1',
          materialVersion: 1,
          format: 'docx_effective',
          contentHash: sourceHash,
        },
        generation: { version: 'historical-sse-private-v1' },
        reviewNotes,
        findings: [],
        textPreview: rows.map((row, index) => ({
          recordId: row.record_id,
          before: row.literal_quote,
          after: index === 0 ? row.literal_quote.replace('100', '120') : row.literal_quote,
          locator: row.locator,
          formatting: row.formatting,
        })),
        replacements: [
          {
            changeId: 'change-1',
            recordId: first.record_id,
            locator: first.locator,
            start,
            end: start + 3,
            before: '100',
            after: '120',
          },
        ],
        columns: [],
      };
      const locked = { ...content, planHash: updateContentHash(content) };
      const ctx = context(locked);
      ctx.pool = {
        query: async (sql: string) => {
          if (sql.includes('bb_input_revisions'))
            return {
              rows: [
                {
                  input_hash: ctx.run.input_hash,
                  material_versions: [{ material_id: 'historical-1', material_version: 1 }],
                },
              ],
            };
          if (sql.includes('bb_material_versions'))
            return {
              rows: [
                {
                  role: 'historical',
                  media_type:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  sha256: sourceHash,
                  byte_size: source.length,
                  object_key: 'source-private-key',
                },
              ],
            };
          if (sql.includes('bb_runs')) return { rows: [{ created_at: '2026-09-25T13:00:00Z' }] };
          throw new Error('Unexpected query');
        },
      } as StageContext['pool'];
      ctx.blobs = { getIfExistsBounded: async () => source } as unknown as StageContext['blobs'];
      ctx.run.task_kind = 'update';
      const outcome = await productionWordStage().run(ctx);
      assert.equal(outcome.kind, 'deliver');
      if (outcome.kind === 'deliver') {
        assert.equal(outcome.wordSummary?.pending, reviewNotes.length);
        assert.ok(outcome.bytes.subarray(0, 2).equals(Buffer.from('PK')));
        assert.ok(outcome.cleanBytes?.subarray(0, 2).equals(Buffer.from('PK')));
        assert.ok(outcome.baselineBytes?.subarray(0, 2).equals(Buffer.from('PK')));
        const comments = spawnSync(
          process.env.BONDBUDDY_TEST_PYTHON!,
          [
            '-c',
            "import io,json,sys,zipfile;from lxml import etree;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));root=etree.fromstring(z.read('word/comments.xml'));print(json.dumps([''.join(c.itertext()) for c in root],ensure_ascii=False))",
          ],
          {
            input: outcome.bytes,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            encoding: 'utf8',
            timeout: 30_000,
          },
        );
        assert.equal(comments.status, 0, comments.stderr);
        assert.deepEqual(
          JSON.parse(comments.stdout),
          reviewNotes.map((note) => note.message),
        );
        for (const bytes of [outcome.bytes, outcome.cleanBytes!]) {
          const parts = spawnSync(
            process.env.BONDBUDDY_TEST_PYTHON!,
            [
              '-c',
              "import io,sys,zipfile;from lxml import etree;s=zipfile.ZipFile(sys.argv[1]);z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));names=[n for n in s.namelist() if n.startswith(('word/header','word/footer','word/media/'))];assert len(names)>=3,'missing source parts';normalize=lambda n,b:etree.tostring(etree.fromstring(b),method='c14n') if n.endswith('.xml') else b;assert all(normalize(n,s.read(n))==normalize(n,z.read(n)) for n in names),'changed auxiliary content';ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};root=etree.fromstring(z.read('word/document.xml'));assert root.findall('.//w:drawing',ns),'missing drawing';assert b'word/header1.xml' in z.read('word/comments.xml'),'missing auxiliary note';print(len(names))",
              sourcePath,
            ],
            {
              input: bytes,
              env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
              encoding: 'utf8',
              timeout: 30_000,
            },
          );
          assert.equal(parts.status, 0, parts.stderr);
        }
        assert.equal(
          reviewNotes.map((note) => note.message.replace(/^待人工确认（\d+\/\d+）：/, '')).join(''),
          completeNote,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
