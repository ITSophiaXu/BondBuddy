// Synthetic CLI output. Actual pinned Codex executes only the sandbox permission preflight.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), marker = args.find(a => a.startsWith('--marker='))?.slice(9);
const forwarded = args.filter(a => !a.startsWith('--marker='));
if (forwarded.includes('sandbox')) { const r = spawnSync('/usr/local/bin/codex', forwarded, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (!forwarded.includes('exec') || forwarded.includes('--output-schema')) throw Error('file-only CLI required');
const cwd = forwarded[forwarded.indexOf('--cd') + 1], input = JSON.parse(readFileSync(cwd + '/input.json', 'utf8'));
if (input.version !== 'review-file-input-v1' || !input.knowledge.length || input.requirements.includes('late draft')) throw Error('incorrect immutable input');
for (const m of input.materials) readFileSync(cwd + '/' + m.path);
if (marker) appendFileSync(marker, JSON.stringify({ input_hash: input.input_hash, material_count: input.materials.length }) + '\n');
// Exercise host conversion from complete Markdown, without an agent-generated DOCX or JSON.
writeFileSync(cwd + '/output/report.md', '# 合成复核报告\n\n合成金额100与120不一致。来源：synthetic-source.docx，第一段。\n\n缺失事项：公开检索未执行。\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-review-file' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '复核结果已保存为 report.md。非JSON返回。' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }));
