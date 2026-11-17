// Synthetic CLI output. Actual pinned Codex executes only the sandbox permission preflight.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), marker = args.find(a => a.startsWith('--marker='))?.slice(9);
const forwarded = args.filter(a => !a.startsWith('--marker='));
if (forwarded.includes('sandbox')) { const r = spawnSync('/usr/local/bin/codex', forwarded, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (!forwarded.includes('exec') || forwarded.includes('--output-schema')) throw Error('file-only CLI required');
const cwd = forwarded[forwarded.indexOf('--cd') + 1], input = JSON.parse(readFileSync(cwd + '/input.json', 'utf8'));
if (input.version !== 'review-file-input-v1' || !input.knowledge.length || (input.scope.operation==='full_review'&&!input.requirements.includes('original requirement'))) throw Error('incorrect immutable input');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-review-file' }));
const progress=(id,code,state)=>console.log(JSON.stringify({type:'item.completed',item:{id,type:'agent_message',text:`BB_REVIEW_PROGRESS:${code}:${state}`}}));
progress('read-start','read_materials','started');
for (const m of input.materials) readFileSync(cwd + '/' + m.path);
progress('read-done','read_materials','completed');
progress('report-start','prepare_report','started');
if (marker) appendFileSync(marker, JSON.stringify({ input_hash: input.input_hash, material_count: input.materials.length }) + '\n');
// Exercise host conversion from complete Markdown, without an agent-generated DOCX or JSON.
writeFileSync(cwd + '/output/report.md', '# 合成复核报告\n\n## 财务核对\n### 合成金额100与120不一致\n**复核类别：** 财务数据一致性\n**原文位置：** 第一段\n**原文披露：** Synthetic worker upload fixture\n**核对依据：** 合成报表120\n**问题说明：** 合成修改用于验证原生修订交付\n**处理方式：** 直接修改\n**替换文本：** Synthetic reviewed fixture\n**缺少材料：** 无\n\n## 公开信息核验\n缺失事项：公开检索未执行。\n');
progress('report-done','prepare_report','completed');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '复核结果已保存为 report.md。非JSON返回。' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }));
