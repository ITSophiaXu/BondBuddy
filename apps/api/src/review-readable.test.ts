import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { digest } from './data.js';
import { readReviewMarkdown } from './review-readable.js';

function fixture(options: { foreign?: boolean; input?: string; invalidUtf8?: boolean; noMarkdown?: boolean; correction?: boolean } = {}) {
  const markdown = options.invalidUtf8 ? Buffer.from([0xff, 0xfe]) : Buffer.from('# 合成报告\n原文位置、发现、建议。'), sha = digest(markdown), input = 'a'.repeat(64);
  const reportKey = `owners/owner/projects/project/runs/run/review-files/${options.correction ? 'correction' : 'call'}/${sha}/report.md`;
  const result = Buffer.from(JSON.stringify({ version:'codex-review-file-v1', input_hash: options.input ?? input,
    files: options.noMarkdown ? { 'final-response.md': { key:reportKey,sha256:sha,byte_size:markdown.length } } : {
      'report.md': { key: options.foreign ? reportKey.replace('/run/', '/other-run/') : reportKey, sha256:sha,byte_size:markdown.length },
      ...(options.correction ? { 'editor.json': {}, 'revision.docx': {} } : {}) } }));
  const ref = `users/owner/projects/project/provider-results/call-${digest(result)}.json`;
  const data = new Map([[ref,result],[reportKey,markdown]]), reads: string[] = [];
  const blobs = { getIfExistsBounded: async (key:string) => { reads.push(key); return data.get(key) ?? null; } };
  const row = { id:'result',prompt_snapshot_ref:'prompt',owner_user_id:'owner',project_id:'project',run_id:'run',call_id:'call',input_hash:input,result_ref:ref,result_sha256:digest(result),byte_size:result.length };
  const operations: string[] = [];
  let visible = true, registered: Record<string, unknown> | undefined;
  let onLock: ((kind: string) => void | Promise<void>) | undefined;
  const client = {
    query: async (sql: string) => {
      operations.push(sql);
      const kind = /pg_advisory_xact_lock\(hashtext\('([^']+)'\)/.exec(sql)?.[1];
      if (kind) await onLock?.(kind);
      if (sql.includes('SELECT p.id FROM bb_provider_result_refs')) return { rows: visible ? [{ id: row.id }] : [], rowCount: visible ? 1 : 0 };
      if (sql.includes('FROM bb_run_working_objects')) return { rows: registered ? [registered] : [], rowCount: registered ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    }, release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const registry = (changes: Record<string, unknown> = {}) => ({
    object_key: reportKey,owner_user_id:'owner',project_id:'project',run_id:'run',filename:'report.md',sha256:sha,
    byte_size:markdown.length,media_type:'text/markdown',stored_at:new Date(),purge_started_at:null,purged_at:null,...changes,
  });
  return { blobs,row,data,reads,reportKey,pool,operations,registry,
    setVisible: (value: boolean) => { visible = value; },
    setRegistry: (value: Record<string, unknown>) => { registered = value; },
    onLock: (callback: (kind: string) => void | Promise<void>) => { onLock = callback; } };
}
test('readable view loads the exact private Markdown, no prompts or final chatter', async () => {
  const f = fixture(), report = await readReviewMarkdown(f.pool, f.blobs, f.row);
  assert.equal(report?.markdown, '# 合成报告\n原文位置、发现、建议。'); assert.equal(f.reads.length,2);
  assert.deepEqual(f.operations.flatMap(sql => /pg_advisory_xact_lock\(hashtext\('([^']+)'\)/.exec(sql)?.[1] ?? []),
    ['prompt_snapshot','provider_result','run_file_object']);
  assert.equal(f.operations.some(sql => /FOR (?:UPDATE|SHARE|KEY SHARE)/.test(sql)),false);
  assert.equal(f.operations.at(-1),'COMMIT');
  const missing = fixture({ noMarkdown:true }); assert.equal(await readReviewMarkdown(missing.pool, missing.blobs, missing.row),null);
  const correction = fixture({ correction:true });
  correction.setRegistry(correction.registry());
  assert.equal((await readReviewMarkdown(correction.pool,correction.blobs,correction.row))?.content_sha256,digest(correction.data.get(correction.reportKey)!));
});
test('cross-run references, mismatched input/hash, unavailable or invalid UTF8 safely disable only the optional view', async () => {
  for (const options of [{foreign:true},{input:'b'.repeat(64)},{invalidUtf8:true}]) {
    const f = fixture(options); assert.equal(await readReviewMarkdown(f.pool,f.blobs,f.row),null);
  }
  const f=fixture(); f.data.set(f.reportKey,Buffer.from('tampered'));
  assert.equal(await readReviewMarkdown(f.pool,f.blobs,f.row),null);
  const g=fixture();g.row.result_ref='users/other/secret.json';
  assert.equal(await readReviewMarkdown(g.pool,g.blobs,g.row),null);assert.equal(g.reads.length,0);
});

test('purged parents and visibility lost while waiting for the file deny further private reads', async () => {
  const parent = fixture(); parent.setVisible(false);
  assert.equal(await readReviewMarkdown(parent.pool,parent.blobs,parent.row),null);
  assert.deepEqual(parent.reads,[]);
  const file = fixture(); file.onLock(kind => { if (kind === 'run_file_object') file.setVisible(false); });
  assert.equal(await readReviewMarkdown(file.pool,file.blobs,file.row),null);
  assert.deepEqual(file.reads,[file.row.result_ref]);
});

test('registered unavailable, purging, purged or mismatched files deny reads even while their bytes remain', async () => {
  for (const change of [{stored_at:null},{purge_started_at:new Date()},{purged_at:new Date()},
    {owner_user_id:'other'},{project_id:'other'},{run_id:'other'},{filename:'other.md'},
    {sha256:'b'.repeat(64)},{byte_size:1},{media_type:'text/plain'}]) {
    const f=fixture(); f.onLock(kind => { if (kind === 'run_file_object') f.setRegistry(f.registry(change)); });
    assert.equal(await readReviewMarkdown(f.pool,f.blobs,f.row),null,JSON.stringify(change));
    assert.deepEqual(f.reads,[f.row.result_ref]);
    assert.equal(f.data.has(f.reportKey),true);
  }
});
