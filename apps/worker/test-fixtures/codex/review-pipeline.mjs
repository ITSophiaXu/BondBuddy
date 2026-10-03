#!/usr/bin/env node
// SYNTHETIC only. This local stand-in never contacts a model supplier or network.
import { appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
// File-mode tests still execute the real native permission probe. The local
// marker is only a synthetic-fixture option, never a Codex CLI argument.
if (args.includes('sandbox')) {
  const result = spawnSync('/usr/local/bin/codex', args.filter(arg => !arg.startsWith('--m3-marker=')), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const marker = process.argv.find(value => value.startsWith('--m3-marker='))?.slice('--m3-marker='.length);
const assistant = prompt.includes('ref=review-context\n');
const fileRevision = args.includes('exec') && !args.includes('--output-schema') && prompt.includes('accepted revision');
let data = fileRevision ? null : JSON.parse(assistant ? prompt.match(/<<BB-DATA-[a-f0-9]+ ref=review-context\n([\s\S]+)\nBB-DATA-[a-f0-9]+>>/)[1] : prompt.split('输入数据：\n')[1]);
let value;
let toolEvidence;
const out = event => process.stdout.write(JSON.stringify(event) + '\n');
out({ type: 'thread.started', thread_id: 'synthetic-m3-pipeline' });
out({ type: 'turn.started' });
function explicitRevisionTool() {
  const cwd = args[args.indexOf('--cd') + 1], permissions = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && /^(default_permissions|permissions)=/.test(args[i + 1])) permissions.push(args[i], args[++i]);
  }
  if (permissions.length !== 4) throw Error('Synthetic revision requires the real scoped native permissions');
  // Source reads, the scoped proposal and the bounded writer all run in the same
  // actual Codex sandbox. No host-created revision replaces this tool action.
  const program = `import json,subprocess,sys
from pathlib import Path
r=Path.cwd();d=json.loads((r/'input.json').read_text(encoding='utf-8'))
assert d['version']=='review-revision-cli-v1'
assert all((r/m['path']).is_file() for m in d['materials'])
selected=d['revision']['selected_findings'];executable=set(d['executable_finding_ids'])
records={item['record_id']:item for item in d['records']}
allowed=sorted({rid for f in selected if f['finding_id'] in executable for rid in f['repairability']['allowed_record_ids']})
edits=[];handling=[]
for finding in selected:
 fid=finding['finding_id'];evidence=list(dict.fromkeys(ref['material_id']+'/'+ref['record_id'] for ref in finding['evidence_refs']))
 modified=False
 if fid in executable:
  for rid in finding['repairability']['allowed_record_ids']:
   before=records[rid]['literal_quote'];after=before.replace('营业收入100.00','营业收入120.00')
   if before!=after:
    edits.append({'record_id':rid,'after':after,'evidence':evidence,'finding_ids':[fid]});modified=True
 handling.append({'finding_id':fid,'status':'modified' if modified else 'needs_evidence','reason':'Synthetic selected revenue only; no review-pass claim.','evidence':evidence})
assert len(edits)==1 and len(selected)==1
p={'version':d['version'],'input_hash':d['input_hash'],'reviewed':allowed,'edits':edits,'additions':[],'handling':handling,'summary':['Synthetic native sandbox revision of selected revenue only.']}
(r/'scratch/proposal.json').write_text(json.dumps(p,ensure_ascii=False),encoding='utf-8')
subprocess.run([sys.executable,'-B',str(r/'tools/revision_cli.py'),'scratch/proposal.json'],check=True,stdout=subprocess.PIPE)
assert all((r/'output'/name).is_file() for name in ['tracked.docx','clean.docx','baseline.docx','handling.json','summary.json','proposal.json'])
print(json.dumps({'requirements':d['requirements'],'source_report':d['revision']['source_report'],'accepted_plan':d['revision']['accepted_plan'],'method':d['version'],'workspace_input_hash':d['input_hash'],'native_writer':True},ensure_ascii=True))
`;
  out({ type: 'item.started', item: { id: 'synthetic-revision-tool', type: 'command_execution' } });
  const result = spawnSync('/usr/local/bin/codex', [...permissions, 'sandbox', '--', '/opt/venv/bin/python', '-B', '-c', program],
    { cwd, env: { ...process.env, TMPDIR: `${cwd}/scratch`, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? 'Synthetic native revision tool failed');
    throw Error('Synthetic native revision tool failed');
  }
  const context = JSON.parse(result.stdout);
  out({ type: 'item.completed', item: { id: 'synthetic-revision-tool', type: 'command_execution', exit_code: 0 } });
  return context;
}
async function explicitReviewTools() {
  // Start the exact trusted MCP configured by the real contained adapter. The synthetic
  // CLI cannot manufacture receipts: the host tool server writes its own trace file.
  const settings = new Map();
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '-c') {
    const setting = process.argv[++i], equal = setting.indexOf('=');
    settings.set(setting.slice(0, equal), setting.slice(equal + 1));
  }
  const command = JSON.parse(settings.get('mcp_servers.bb_review.command'));
  const args = JSON.parse(settings.get('mcp_servers.bb_review.args'));
  const child = spawn(command, args, { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let requestId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const reply = JSON.parse(line), waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error('Synthetic review tool rejected request'));
    else waiter.resolve(reply.result);
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      for (const waiter of pending.values()) waiter.reject(new Error('Synthetic review tool server closed'));
      pending.clear();
      if (code === 0) resolve(); else reject(new Error('Synthetic review tool server failed'));
    });
  });
  child.stderr.resume();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  let toolId = 0;
  const tool = async (name, args) => {
    const id = `synthetic-review-tool-${++toolId}`;
    out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'bb_review', tool: name, arguments: args } });
    const result = await request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error('Synthetic review tool returned an error');
    out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'bb_review', tool: name, arguments: args, result } });
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  };
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-m3-cli', version: '2' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const materials = (await tool('list_materials', {})).materials, records = [];
    for (const material of materials) {
      let offset = 0;
      while (offset !== null) {
        const page = await tool('read_records', { material_id: material.id, offset, limit: 300 });
        records.push(...page.records); offset = page.next_offset;
      }
    }
    let offset = 0;
    while (offset !== null) offset = (await tool('read_knowledge', { offset, limit: 30000 })).next_offset;
    const key = ref => JSON.stringify([ref.material_id, ref.material_version, ref.parse_snapshot_id, ref.record_id]);
    const selected = new Set(data.anchor_mappings.flatMap(mapping => mapping.current_target_refs).map(key));
    const observations = records.flatMap(record => {
      if (record.source_kind === 'disclosure' && data.scope.mode === 'differential_review' && !selected.has(key(record.evidence_ref))) return [];
      const match = /(营业收入|净利润)(\d+\.\d+)/.exec(record.literal_quote);
      if (!match) return [];
      const refs = [{ record_id: record.id, quote: record.literal_quote }];
      return [{ observation_id: `obs-${record.id}`, source_record_id: record.id,
        entity_id: '合成甲公司', metric: match[1], accounting_scope: '合并', basis: '原始报表',
        period: { start: '2025-01-01', end: '2025-12-31', as_of: null }, currency: 'CNY', unit: '万元',
        value: match[2], value_literal: match[2], value_refs: refs,
        context_refs: { entity: refs, period: refs, accounting_scope: refs, currency: refs, unit: refs, basis: refs } }];
    });
    const receipt = await tool('check_financial', { observations, calculations: [], audit_rule_ids: [] });
    toolEvidence = { tool_receipts: 1, knowledge_read_complete: true };
    return { summary: 'Synthetic CLI selected evidence comparison through the real run-local tools.',
      reviewed_record_count: new Set(records.map(record => record.id)).size, receipt_ids: [receipt.receipt_id], concerns: [], checks: [],
      limitations: ['合成 CLI 回复，仅验证工具、持久化与交付工程链路。'] };
  } finally {
    child.stdin.end();
    await closed;
  }
}
if (fileRevision) {
  data = explicitRevisionTool();
  toolEvidence = { method: data.method, workspace_input_hash: data.workspace_input_hash, native_writer: data.native_writer };
  value = { summary: 'Synthetic accepted revision artifacts generated by the native scoped Word tool.' };
} else if (assistant) {
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
  value = await explicitReviewTools();
}
if (marker) appendFileSync(marker, JSON.stringify({ synthetic: true, operation: assistant ? 'assistant' : fileRevision || data.editable_records ? 'revision' : 'review',
  requirements: data.requirements, source_report: data.source_report ?? null, accepted_plan: data.accepted_plan ?? null,
  ...(assistant ? { material_evidence: data.material_evidence, context: data.context } : toolEvidence ?? {}) }) + '\n');
out({ type: 'item.completed', item: { id: 'synthetic-reply', type: 'agent_message', text: JSON.stringify(value) } });
out({ type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 70, output_tokens: 50, reasoning_output_tokens: 5 } });
