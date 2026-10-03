// Synthetic provider output; both preflight and native tool execution use real Codex sandboxing.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('sandbox')) {
  const result = spawnSync('/usr/local/bin/codex', args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (!args.includes('exec') || args.includes('--output-schema') || !prompt.includes('accepted revision'))
  throw Error('expected one CLI accepted revision');
const cwd = args[args.indexOf('--cd') + 1];
const permissions = [];
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '-c' && /^(default_permissions|permissions)=/.test(args[i + 1])) permissions.push(args[i], args[++i]);
}
if (permissions.length !== 4) throw Error('native scoped permissions required');
const program = `import json,subprocess,sys
from pathlib import Path
r=Path.cwd();d=json.loads((r/'input.json').read_text())
assert d['version']=='review-revision-cli-v1'
assert len(d['materials'])==2 and all((r/m['path']).is_file() for m in d['materials'])
p={'version':d['version'],'input_hash':d['input_hash'],'reviewed':['r0'],'edits':[{'record_id':'r0','after':'Net assets 120.','evidence':['audit/r0'],'finding_ids':['F-1']}],'additions':[],'handling':[{'finding_id':'F-1','status':'modified','reason':'Synthetic corrected accepted evidence.','evidence':['audit/r0']}],'summary':['Synthetic native sandbox revision.']}
(r/'scratch/proposal.json').write_text(json.dumps(p),encoding='utf-8')
subprocess.run([sys.executable,'-B',str(r/'tools/revision_cli.py'),'scratch/proposal.json'],check=True,stdout=subprocess.PIPE)
assert all((r/'output'/n).is_file() for n in ['tracked.docx','clean.docx','baseline.docx','handling.json'])
`;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-revision-thread' }));
console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'synthetic-revision-tool' } }));
const result = spawnSync('/usr/local/bin/codex', [...permissions, 'sandbox', '--', '/opt/venv/bin/python', '-B', '-c', program],
  { cwd, env: { ...process.env, TMPDIR: `${cwd}/scratch`, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? 'native tool execution failed');
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'synthetic-revision-tool', exit_code: 0 } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Synthetic accepted revision artifacts actually generated.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 } }));
