import test from 'node:test';
import assert from 'node:assert/strict';
import { reportDocument, reportBlocks, reportBlockHtml, reportInline } from './review-report-document.js';

test('tolerant report view retains all prose and numbered findings without a business schema', () => {
  const doc = reportDocument('# 复核报告\r\n\r\n说明\r\n## 总体结论\n存在待核事项。\n## 复核发现\n先核对口径。\n### 1. 金额不一致\n**位置：** 第八章\n\n- 依据：100 与 120\n- 建议：核对\n### 2. 待补充\n未找到依据\n## 未覆盖事项\n公开检索未执行');
  assert.equal(doc.itemCount, 2); assert.equal(doc.sections.length, 4);
  assert.match(JSON.stringify(doc), /公开检索未执行/); assert.match(JSON.stringify(doc), /100 与 120/);
  assert.equal(doc.sections[2].items[0].title, '1. 金额不一致');
  assert.equal(reportDocument('没有标题也应展示\n\n没有问题不等于全部通过').sections[0].blocks.length, 2);
});
test('rendered report cannot execute HTML, links or remote images; retains literal source', () => {
  const html = reportBlocks('<script>alert(1)</script>\n\n[坏链接](javascript:alert) ![追踪图](https://example.test/x)\n\n**重点** [官网](https://example.test/?a=1&b=2)').map(reportBlockHtml).join('');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /noopener noreferrer/); assert.match(html, /no-referrer/); assert.match(html, /<strong>重点/);
  assert.ok(!reportInline('[账号](https://user:password@example.test)').includes('<a '));
});
test('tables, lists, unknown text and unclosed fences stay readable', () => {
  const blocks = reportBlocks('列一 | 列二\n--- | ---\n100 | 120\n\n1. 第一项\n2. 第二项\n\n> 尚待确认\n\n```\n## not a heading');
  assert.deepEqual(blocks.map(b => b.kind), ['table','list','quote','code']);
  assert.match(blocks.map(reportBlockHtml).join(''), /scope="col"/);
  assert.match(blocks.map(reportBlockHtml).join(''), /尚待确认/);
  assert.equal(reportDocument('## 问题\n### 一般说明\n不是编号问题').itemCount, 0);
});
