import test from 'node:test';
import assert from 'node:assert/strict';
import { businessReport, businessText, dimensionStatus } from './review-business-report.js';
import { businessContent, businessControls } from './review-business-view.js';

test('business results have three independent dimensions without exposing execution bookkeeping', () => {
  const md = `# 合成项目\n## 复核范围与依据\n本轮按 input.json 的 full_review 执行；主体为合成公司；输入锁 ${'a'.repeat(64)} 与 input_hash 一致。\n材料位于 materials/m0.docx，SHA-256 ${'b'.repeat(64)}。\n## 财务核对\n**本次结论：** 两处金额口径待核对。\n### 1. 现金流与报表不一致\n**原文位置：** 第八章，现金流表。\n**核对依据：** 2025年审计报告。\n**差异及影响：** 原文100万元，对照120万元。\n**修改建议：** 确认口径后统一金额。\n## 合规与披露\n**本次结论：** 需补充条款。\n### 2. 募集资金用途披露不完整\n**修改建议：** 补充具体用途。\n## 公开信息核验\n**本次结论：** 公开信息检索未执行，不能确认是否存在遗漏。`;
  const doc = businessReport(md);
  assert.deepEqual(doc.dimensions.map(s => s.items.length), [1,1,0]);
  assert.equal(dimensionStatus(doc.dimensions[2]), '有待核实事项');
  const html = businessControls(doc,'financial','') + ['financial','compliance','public'].map(id=>businessContent(doc,id,'',new Set())).join('');
  assert.doesNotMatch(html,/input\.json|full_review|input_hash|SHA-256|materials\/|a{64}|b{64}/);
  for (const text of ['100万元','120万元','第八章','2025年审计报告','补充具体用途','公开信息检索未执行']) assert.ok(html.includes(text));
});

test('legacy mixed findings retain uncertainty and unclassified business findings', () => {
  const doc = businessReport('## 复核发现\n### 1. 金额口径不一致\n**建议：** 核对100与120。\n### 2. 募集资金用途缺项\n**建议：** 补充。\n### 3. 公开信息未核实\n**原因：** 未查到实际来源。\n### 4. 名称需要确认\n无足够分类依据。');
  assert.deepEqual(doc.dimensions.map(s=>s.items.length),[1,1,1]); assert.equal(doc.other.items.length,1);
  assert.match(businessContent(doc,'other','',new Set()),/名称需要确认/);
  assert.match(businessContent(doc,'financial','未查到',new Set()),/未查到实际来源/);
  const empty = businessReport('## 执行记录\ninput_hash 已校验通过。');
  for (const s of empty.dimensions) assert.equal(dimensionStatus(s),'暂无明确核验结论');
});

test('business filtering preserves material business facts and safe source links', () => {
  assert.equal(businessText('本轮按 input.json 执行；发行人已发生名称变更；输入锁abc与input_hash一致。'), '发行人已发生名称变更；');
  const doc=businessReport('## 公开信息核验\n### 1. 工商变更待核实\n**依据：** [官方来源](https://example.test)\n\n<script>alert(1)</script>\n\n**建议：** 核对变更日期。');
  const html=businessContent(doc,'public','',new Set());
  assert.ok(!html.includes('<script>'));assert.match(html,/noopener noreferrer/);assert.match(html,/核对变更日期/);
});

test('legacy internal material aliases use business names, and public limitations remain visible', () => {
  const doc=businessReport('## 范围\n**A，审阅对象：** materials/m0.docx，上传名《合成募集书.docx》。\n**B，财务比对：** materials/m1.xlsx。\n本轮未执行公开信息检索，诉讼情况尚未核实。\n## 发现\n### 1. 现金流差异\n**位置和比较：** A `docx/p/27`写100万元，B写120万元。');
  const html=businessContent(doc,'financial','',new Set());
  assert.match(html,/合成募集书\.docx/);assert.match(html,/财务报表写120万元/);assert.doesNotMatch(html,/docx\/p\/27|materials\//);
  assert.match(businessContent(doc,'public','',new Set()),/未执行公开信息检索/);
  assert.equal(dimensionStatus(doc.dimensions[2]),'有待核实事项');
});
