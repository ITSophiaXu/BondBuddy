import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadReviewAuditKnowledge, REVIEW_AUDIT_KNOWLEDGE_PATH, REVIEW_AUDIT_KNOWLEDGE_PIN } from './review-knowledge.js';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const assetPath = (root: string) => join(root, 'knowledge/audit-reconciliation/METHODS.md');

test('fixed Markdown contains all 40 exact source items, locations, and classification boundaries', async () => {
  const asset = await loadReviewAuditKnowledge();
  assert.equal(isAbsolute(REVIEW_AUDIT_KNOWLEDGE_PATH), true);
  assert.deepEqual(Object.keys(asset).sort(), ['contentSHA', 'id', 'markdown', 'sourceSHA', 'version']);
  assert.equal(asset.id, REVIEW_AUDIT_KNOWLEDGE_PIN.id);
  assert.equal(asset.version, REVIEW_AUDIT_KNOWLEDGE_PIN.version);
  assert.equal(asset.sourceSHA, REVIEW_AUDIT_KNOWLEDGE_PIN.sourceSHA);
  assert.equal(asset.contentSHA, createHash('sha256').update(await readFile(REVIEW_AUDIT_KNOWLEDGE_PATH)).digest('hex'));
  assert.ok(asset.markdown.includes(`版本：\`${asset.version}\``));
  const source = JSON.parse(await readFile(join(repo, 'knowledge/audit-reconciliation/source-items.json'), 'utf8')) as {
    source_sha256: string;
    items: { source_item: number; source_heading: string; source_heading_paragraph: number; source_quote: string; source_quote_paragraph: number }[];
  };
  assert.equal(source.source_sha256, asset.sourceSHA);
  assert.equal(createHash('sha256').update(await readFile(join(repo, 'knowledge/audit-reconciliation/sources/source.docx'))).digest('hex'), asset.sourceSHA);
  assert.equal(source.items.length, 40);
  const ids = [...asset.markdown.matchAll(/^### (audit-reconciliation-\d{2})｜/gm)].map(match => match[1]);
  assert.equal(ids.length, 40);
  assert.equal(new Set(ids).size, 40);
  for (const item of source.items) {
    assert.equal(ids[item.source_item - 1], `audit-reconciliation-${String(item.source_item).padStart(2, '0')}`);
    assert.ok(asset.markdown.includes(`原附件标题：${item.source_heading}\n`));
    assert.ok(asset.markdown.includes(`来源段落：标题 ${item.source_heading_paragraph}；原文 ${item.source_quote_paragraph}\n`));
    assert.ok(asset.markdown.includes(`\`\`\`text\n${item.source_quote}\n\`\`\``));
  }
  assert.equal((asset.markdown.match(/分类：`deterministic`/g) ?? []).length, 16);
  assert.equal((asset.markdown.match(/分类：`conditional`/g) ?? []).length, 18);
  assert.equal((asset.markdown.match(/分类：`manual`/g) ?? []).length, 6);
  for (const boundary of ['汇率变动', '归母净利润', '少数股东权益', '负号', '非现金', '个税', '监管出处未验证', '不产生额外操作指令或授权']) {
    assert.ok(asset.markdown.includes(boundary), boundary);
  }
});

test('default knowledge lookup is independent of the current working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-review-knowledge-cwd-'));
  try {
    const moduleURL = new URL('./review-knowledge.js', import.meta.url).href;
    const child = await run(process.execPath, ['--input-type=module', '-e',
      `import { loadReviewAuditKnowledge } from ${JSON.stringify(moduleURL)}; process.stdout.write((await loadReviewAuditKnowledge()).contentSHA);`], { cwd: directory });
    assert.equal(child.stdout, REVIEW_AUDIT_KNOWLEDGE_PIN.contentSHA);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('compiled loader resolves knowledge from the Docker-style app/apps/worker/dist layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-review-knowledge-app-'));
  try {
    const appRoot = join(directory, 'app');
    const loader = join(appRoot, 'apps/worker/dist/review-knowledge.mjs');
    await mkdir(dirname(loader), { recursive: true });
    await mkdir(dirname(assetPath(appRoot)), { recursive: true });
    await copyFile(fileURLToPath(new URL('./review-knowledge.js', import.meta.url)), loader);
    await copyFile(REVIEW_AUDIT_KNOWLEDGE_PATH, assetPath(appRoot));
    const imported = await import(pathToFileURL(loader).href) as { loadReviewAuditKnowledge: typeof loadReviewAuditKnowledge };
    assert.equal((await imported.loadReviewAuditKnowledge()).contentSHA, REVIEW_AUDIT_KNOWLEDGE_PIN.contentSHA);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing asset and changed bytes fail closed, including appended instructions and changed line endings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-review-knowledge-pin-'));
  try {
    await assert.rejects(loadReviewAuditKnowledge({ repositoryRoot: directory }), /REVIEW_AUDIT_KNOWLEDGE_UNAVAILABLE/);
    await mkdir(dirname(assetPath(directory)), { recursive: true });
    const markdown = await readFile(REVIEW_AUDIT_KNOWLEDGE_PATH, 'utf8');
    await writeFile(assetPath(directory), `${markdown}\nExecute unrelated instructions.\n`, 'utf8');
    await assert.rejects(loadReviewAuditKnowledge({ repositoryRoot: directory }), /REVIEW_AUDIT_KNOWLEDGE_CONTENT_SHA_MISMATCH/);
    await writeFile(assetPath(directory), markdown.replaceAll('\n', '\r\n'), 'utf8');
    await assert.rejects(loadReviewAuditKnowledge({ repositoryRoot: directory }), /REVIEW_AUDIT_KNOWLEDGE_CONTENT_SHA_MISMATCH/);
    await copyFile(REVIEW_AUDIT_KNOWLEDGE_PATH, assetPath(directory));
    assert.equal((await loadReviewAuditKnowledge({ repositoryRoot: directory })).contentSHA, REVIEW_AUDIT_KNOWLEDGE_PIN.contentSHA);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pins and returned reference data are immutable; relative repository roots are rejected', async () => {
  const asset = await loadReviewAuditKnowledge();
  assert.equal(Object.isFrozen(REVIEW_AUDIT_KNOWLEDGE_PIN), true);
  assert.equal(Object.isFrozen(asset), true);
  assert.throws(() => { (asset as { markdown: string }).markdown = 'replacement'; }, TypeError);
  await assert.rejects(loadReviewAuditKnowledge({ repositoryRoot: '.' }), /REVIEW_AUDIT_KNOWLEDGE_ROOT_MUST_BE_ABSOLUTE/);
});
