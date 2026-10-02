#!/usr/bin/env node
// SYNTHETIC only. This local stand-in never contacts a model supplier or network.
import { appendFileSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const marker = process.argv.find(value => value.startsWith('--m3-marker='))?.slice('--m3-marker='.length);
const assistant = prompt.includes('ref=review-context\n');
const data = JSON.parse(assistant ? prompt.match(/<<BB-DATA-[a-f0-9]+ ref=review-context\n([\s\S]+)\nBB-DATA-[a-f0-9]+>>/)[1] : prompt.split('输入数据：\n')[1]);
let value;
if (assistant) {
  value = { content: '合成材料解释：' + data.material_evidence.map(item => item.status === 'unparsed' ? '该固定版本发送时待解析。' :
    item.records.map(record => record.literal_quote).join('\n')).join('\n'), cited_finding_ids: data.context.finding_ids, proposal: null };
} else if (data.editable_records) {
  value = {
    reviewed: data.editable_records.map(record => record.id),
    edits: data.editable_records.map(record => {
      const finding = data.findings.find(finding => finding.allowed_record_ids.includes(record.id));
      return { record_id: record.id, after: record.text.replace('营业收入100.00', '营业收入120.00'),
        finding_ids: [finding.finding_id], evidence: finding.evidence, pending: [] };
    }),
    additions: [],
    handling: data.findings.map(finding => ({ finding_id: finding.finding_id, status: 'modified',
      reason: '仅根据合成同主体同期间审计证据修改选中金额；未作复核通过判断。', evidence: finding.evidence })),
    summary: ['合成修订：只改选定的营业收入。'],
  };
} else {
  value = {
    reviewed_record_ids: data.records.map(record => record.id),
    observations: data.records.flatMap(record => {
      const match = /(营业收入|净利润)(\d+\.\d+)/.exec(record.literal_quote);
      if (!match) return [];
      const refs = [{ record_id: record.id, quote: record.literal_quote }];
      return [{ observation_id: `obs-${record.id}`, source_record_id: record.id,
        entity_id: '合成甲公司', metric: match[1], accounting_scope: '合并', basis: '原始报表',
        period: { start: '2025-01-01', end: '2025-12-31', as_of: null }, currency: 'CNY', unit: '万元',
        value: match[2], value_literal: match[2], value_refs: refs,
        context_refs: { entity: refs, period: refs, accounting_scope: refs, currency: refs, unit: refs, basis: refs } }];
    }),
    calculations: [], compliance_assessments: [], concerns: [], limitations: ['合成模型回复，仅验证工程链路。'],
  };
}
if (marker) appendFileSync(marker, JSON.stringify({ synthetic: true, operation: assistant ? 'assistant' : data.editable_records ? 'revision' : 'review',
  requirements: data.requirements, source_report: data.source_report ?? null, accepted_plan: data.accepted_plan ?? null,
  ...(assistant ? { material_evidence: data.material_evidence, context: data.context } : {}) }) + '\n');
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
out({ type: 'thread.started', thread_id: 'synthetic-m3-pipeline' });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'synthetic-reply', type: 'agent_message', text: JSON.stringify(value) } });
out({ type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 70, output_tokens: 50, reasoning_output_tokens: 5 } });
