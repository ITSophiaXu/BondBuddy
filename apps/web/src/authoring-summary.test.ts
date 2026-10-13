import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authoringSummary } from './authoring-summary.js';

test('legacy single-item delivery Markdown becomes readable sections without losing limits', () => {
  const html=authoringSummary(['# 募集说明书 Word 交付说明\n\n**交付文件：** `tracked.docx`、`clean.docx`。\n\n**基线与范围。**报告期为2024年、2025年及2026年中期。\n\n**已经更新。**已更新财务表格。\n\n**缺材料未更新或尚待核实。**缺少附注，未补造数据。\n\n**知识、核对与局限。**未进行页面视觉检查；不得直接作为签署发行文件。']);
  for(const title of ['生成的文件','本次更新范围','已更新的内容','需要补充或确认的事项','使用依据与核对范围']) assert.ok(html.includes(`<h3>${title}</h3>`));
  for(const text of ['缺少附注，未补造数据','未进行页面视觉检查','不得直接作为签署发行文件','2026年中期']) assert.ok(html.includes(text));
  assert.doesNotMatch(html,/tracked\.docx|clean\.docx|\*\*|# 募集/);
});

test('plain legacy arrays, unknown headings, emphasis and tables retain their content', () => {
  const html=authoringSummary(['已更新公司介绍。','未更新担保条款。','## 自定义说明\n- **并非已发布合规意见**\n- 数字仍待确认\n\n| 项目 | 状态 |\n| --- | --- |\n| 财务 | 待核对 |']);
  assert.match(html,/<p>已更新公司介绍。<\/p>/);assert.match(html,/<p>未更新担保条款。<\/p>/);
  assert.match(html,/<h3>自定义说明<\/h3>/);assert.match(html,/<strong>并非已发布合规意见<\/strong>/);
  assert.match(html,/<table>/);assert.match(html,/待核对/);
});

test('generated text never executes HTML, scripts or embedded image requests', () => {
  const html=authoringSummary(['<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[打开](javascript:alert)\n![图](https://example.com/private.png)']);
  assert.doesNotMatch(html,/<script|<img|href="javascript:/);assert.match(html,/&lt;script&gt;/);
});

test('long prose is split on sentence boundaries with every fact preserved', () => {
  const sentences=Array.from({length:16},(_,i)=>`第${i}项材料仍未核实，请补充对应的原始资料。`);
  const html=authoringSummary([sentences.join('')]);
  assert.ok((html.match(/<p>/g)??[]).length>1);
  assert.equal(html.replace(/<\/?p>/g,''),sentences.join(''));
});
