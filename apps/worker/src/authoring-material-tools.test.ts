import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callMaterialTool, type MaterialToolData } from './authoring-material-tools.js';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { loadReviewAuditKnowledge } from './review-knowledge.js';
import { reviewPromptRecordId } from './review-record-context.js';
import { createReviewToolTrace, type ReviewToolData } from './review-tools.js';
const data: MaterialToolData = {
  materials: [
    {
      id: 'm0',
      filename: 'synthetic.xlsx',
      context: { relation: null },
      records: Array.from({ length: 600 }, (_, i) => ({
        id: `m0r${i}`,
        text: i === 499 ? '净资产120万元' : '合成表格 ' + i,
        uncertainty: [],
        locator: { sheet: '财务', cell: `B${i + 1}` },
      })),
    },
  ],
};
test('material search finds facts past the first page; bounded reads retain table source coordinates', () => {
  const found = callMaterialTool(data, 'search_material', {
    material_id: 'm0',
    query: '净资产',
  }) as any;
  assert.equal(found.records[0].index, 499);
  assert.equal(found.records[0].locator.cell, 'B500');
  const first = callMaterialTool(data, 'read_records', {
    material_id: 'm0',
    offset: 480,
    limit: 30,
  }) as any;
  assert.equal(first.records.length, 30);
  assert.equal(first.next_offset, 510);
  const end = callMaterialTool(data, 'read_records', { material_id: 'm0', offset: 590 }) as any;
  assert.equal(end.records.length, 10);
  assert.equal(end.next_offset, null);
});
test('material tools reject arbitrary paths, commands, other-project identifiers and oversized ranges', () => {
  for (const args of [
    { material_id: '../../other-project', offset: 0 },
    { material_id: 'm0', offset: 0, path: '/run/secrets/key' },
    { material_id: 'm0', offset: -1 },
    { material_id: 'm0', offset: 0, limit: 9999 },
  ])
    assert.throws(() => callMaterialTool(data, 'read_records', args));
  assert.throws(() => callMaterialTool(data, 'exec', { command: 'cat /proc/self/environ' }));
  assert.equal(
    (callMaterialTool(data, 'search_material', { material_id: 'm0', query: '.*' }) as any).records
      .length,
    0,
    'literal, not arbitrary regex',
  );
});
test('the stdio MCP transport actually serves run-local material tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-material-mcp-'));
  try {
    const path = join(root, 'materials.json');
    await writeFile(path, JSON.stringify(data));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./authoring-material-tools.js', import.meta.url)), path],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '',
      err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.stdin.end(
      [
        { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { method: 'notifications/initialized' },
        { id: 2, method: 'tools/list' },
        {
          id: 3,
          method: 'tools/call',
          params: { name: 'search_material', arguments: { material_id: 'm0', query: '净资产' } },
        },
      ]
        .map((x) => JSON.stringify({ jsonrpc: '2.0', ...x }))
        .join('\n') + '\n',
    );
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, err);
    const responses = out
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.equal(responses.length, 3);
    assert.equal(responses[1].result.tools.length, 3);
    assert.equal(JSON.parse(responses[2].result.content[0].text).records[0].id, 'm0r499');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'failed host writes cannot later commit unread records, knowledge or unreturned receipts',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-review-mcp-write-failure-'));
    const f = reviewFixture();
    f.addRecord(
      'disclosed',
      '合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入 100.00',
    );
    const record = { ...f.records[0]!, source_kind: 'disclosure' as const };
    const review: ReviewToolData = {
      input: {
        input_hash: 'f'.repeat(64),
        evidence: { ...f.ctx, records: [record] },
        rule_context: null,
        rule_packs: [],
        formatting_requirements: [],
        requirements: [],
        scope: { mode: 'full_review', finding_ids: [] },
        report_version: 1,
        created_at: '2026-10-02T08:00:00Z',
        limitations: [],
      },
      knowledge: await loadReviewAuditKnowledge(),
      allowed_target_ids: [reviewPromptRecordId(record)],
    };
    const tracePath = join(root, 'review-trace.json'),
      initial = JSON.stringify(createReviewToolTrace(review));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const dataPath = join(root, 'review.json');
      await writeFile(dataPath, JSON.stringify(review));
      await writeFile(tracePath, initial);
      child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./authoring-material-tools.js', import.meta.url)),
          dataPath,
          tracePath,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const lines = createInterface({ input: child.stdout! }),
        pending = new Map<
          number,
          { resolve: (value: any) => void; reject: (error: Error) => void }
        >();
      let nextId = 0,
        err = '';
      child.stderr!.on('data', (b) => (err += b));
      lines.on('line', (line) => {
        const response = JSON.parse(line);
        pending.get(response.id)?.resolve(response.result);
        pending.delete(response.id);
      });
      const closed = new Promise<number | null>((resolve) =>
        child!.once('close', (code) => {
          for (const p of pending.values()) p.reject(Error(`MCP exited ${code}: ${err}`));
          pending.clear();
          resolve(code);
        }),
      );
      child.once('error', (error) => {
        for (const p of pending.values()) p.reject(error);
        pending.clear();
      });
      const request = (method: string, params?: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      const call = (name: string, args: Record<string, unknown>) =>
        request('tools/call', { name, arguments: args });
      await request('initialize', { protocolVersion: '2024-11-05' });
      const listed = JSON.parse((await call('list_materials', {})).content[0].text),
        material = listed.materials[0].id;
      // A directory at the trace filename causes a real host write failure on all platforms.
      await rm(tracePath);
      await mkdir(tracePath);
      for (const [name, args] of [
        ['read_records', { material_id: material, offset: 0 }],
        ['read_knowledge', { offset: 0, limit: 30000 }],
        ['check_compliance', { assessments: [], rule_keys: [] }],
      ] as const)
        assert.equal((await call(name, args)).isError, true, name);
      await rm(tracePath, { recursive: true });
      await writeFile(tracePath, initial);
      assert.equal((await call('list_materials', {})).isError, undefined);
      const saved = JSON.parse(await readFile(tracePath, 'utf8'));
      assert.deepEqual(saved.read_record_ids, []);
      assert.deepEqual(saved.knowledge_read_ranges, []);
      assert.equal(saved.knowledge_read_complete, false);
      assert.deepEqual(saved.receipts, []);
      const citation = { record_id: reviewPromptRecordId(record), quote: record.literal_quote };
      const unread = await call('check_financial', {
        observations: [
          {
            observation_id: 'o0',
            source_record_id: citation.record_id,
            entity_id: '合成甲公司',
            metric: '营业收入',
            accounting_scope: '合并',
            basis: '原始报表',
            period: { start: '2025-01-01', end: '2025-12-31', as_of: null },
            currency: 'CNY',
            unit: '万元',
            value: '100.00',
            value_literal: '100.00',
            value_refs: [citation],
            context_refs: {
              entity: [citation],
              period: [citation],
              accounting_scope: [citation],
              currency: [citation],
              unit: [citation],
              basis: [citation],
            },
          },
        ],
        calculations: [],
      });
      assert.equal(unread.isError, true);
      assert.match(unread.content[0].text, /unknown_citation/);
      const returned = await call('read_records', { material_id: material, offset: 0 });
      assert.equal(returned.isError, undefined);
      const after = JSON.parse(await readFile(tracePath, 'utf8'));
      assert.deepEqual(after.read_record_ids, [citation.record_id]);
      assert.deepEqual(after.receipts, []);
      child.stdin!.end();
      assert.equal(await closed, 0, err);
      lines.close();
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);
