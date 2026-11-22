import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '@bondbuddy/api/data';
import type { ProjectFileText, WorkpaperEntry } from '@bondbuddy/contracts';
import { workpaperAssessmentWorkspace } from './workpaper-assessment-stage.js';
import { CodexOutputValidationError } from './codex-adapter.js';

test('large-source file output has an explicit schema and rejects missing coverage, IDs and malformed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-assessment-output-'));
  try {
    const source = Buffer.from('synthetic source'),
      path = join(root, 'source.docx'),
      cwd = join(root, 'workspace');
    await mkdir(cwd);
    await writeFile(path, source);
    const entries = [{ id: 'one' }, { id: 'two' }] as WorkpaperEntry[];
    const snapshot = {
      spans: [
        { id: 'p1', text: '已披露事实' },
        { id: 'p2', text: '完整表格明细' },
        { id: 'empty', text: '' },
      ],
    } as ProjectFileText;
    const workspace = workpaperAssessmentWorkspace(
      path,
      'source.docx',
      digest(source),
      snapshot,
      entries,
    );
    await workspace.prepare(cwd);
    const schema = JSON.parse(await readFile(join(cwd, 'assessment-schema.json'), 'utf8'));
    assert.deepEqual(schema.required, ['decisions', 'checked_span_ids']);
    assert.equal(schema.properties.decisions.minItems, 2);
    const valid = {
      decisions: entries.map((e) => ({
        item_id: e.id,
        status: 'generate',
        reason: '已有披露',
        missing_materials: [],
        citations: [{ span_id: 'p1', quote: '已披露事实' }],
      })),
      checked_span_ids: ['p1', 'p2'],
    };
    const collect = () => workspace.collect(cwd, {} as never, { text: '' });
    await assert.rejects(collect(), CodexOutputValidationError);
    for (const invalid of [
      'invalid json',
      JSON.stringify({ ...valid, checked_span_ids: ['p1'] }),
      JSON.stringify({ ...valid, decisions: [valid.decisions[0], valid.decisions[0]] }),
      JSON.stringify({
        ...valid,
        decisions: [{ ...valid.decisions[0], citations: undefined }, valid.decisions[1]],
      }),
    ]) {
      await writeFile(join(cwd, 'output/assessment.json'), invalid);
      await assert.rejects(collect(), CodexOutputValidationError);
    }
    await writeFile(join(cwd, 'output/assessment.json'), JSON.stringify(valid));
    assert.deepEqual(await collect(), { decisions: valid.decisions });
    await chmod(join(cwd, 'source-spans.json'), 0o600);
    await writeFile(join(cwd, 'source-spans.json'), 'changed');
    await assert.rejects(collect(), /INPUT_REVISION_CONFLICT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
