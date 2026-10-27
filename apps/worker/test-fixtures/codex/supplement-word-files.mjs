// Synthetic provider, with the real pinned Codex binary handling the sandbox
// preflight. Never use a substitute implementation of that containment check.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const marker = option('marker'), python = option('python'), repo = option('repo');
const forwarded = args.filter(value => !['marker', 'python', 'repo'].some(name => value.startsWith(`--${name}=`)));
if (forwarded.includes('sandbox')) {
  const result = spawnSync('/usr/local/bin/codex', forwarded, { stdio: 'inherit' }); process.exit(result.status ?? 1);
}
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (!forwarded.includes('exec') || forwarded.includes('--output-schema')) throw Error('plain file CLI required');
const cwd = forwarded[forwarded.indexOf('--cd') + 1], input = JSON.parse(readFileSync(`${cwd}/input.json`, 'utf8'));
if (input.version !== 'm4-file-workspace-v1' && !prompt.includes(input.input_hash)) throw Error('exact input lock missing');
for (const material of input.materials) readFileSync(`${cwd}/${material.path}`);
for (const file of input.continuation?.previous_work.files ?? []) readFileSync(`${cwd}/${file.path}`);
if (input.continuation && JSON.parse(readFileSync(`${cwd}/continuation.json`, 'utf8')).basis_hash !== input.continuation.basis_hash)
  throw Error('continuation basis mismatch');
if (marker) appendFileSync(marker, JSON.stringify({ input_hash: input.input_hash,
  continuation: input.continuation?.basis_hash ?? null, materials: input.materials.map(value => value.material_id),
  baseline_kind: input.baseline_kind, scope: input.scope, task: input.task }) + '\n');
if (input.version === 'codex-file-input-v1') {
  // Same actual OOXML bytes in V1/V2 deliberately exercise immutable artifact
  // identity across execution versions, independently of changing input locks.
  const { makeWorkerDocxFixture } = await import(pathToFileURL(`${repo}/apps/worker/dist/docx-test-fixture.js`).href);
  const bytes = makeWorkerDocxFixture({ externalLink: false });
  writeFileSync(`${cwd}/output/clean.docx`, bytes);
  const tracked = spawnSync(python, ['-c', `from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED\nfrom pathlib import Path\nr=Path.cwd()/'output'\nwith ZipFile(r/'clean.docx') as source, ZipFile(r/'tracked.docx','w',ZIP_DEFLATED) as target:\n for name in source.namelist():\n  b=source.read(name)\n  if name=='word/document.xml': b=b.replace(b'Synthetic worker upload fixture',b'Synthetic tracked worker fixture')\n  info=ZipInfo(name,(2026,1,1,0,0,0)); info.compress_type=ZIP_DEFLATED; target.writestr(info,b)`],
  { cwd, encoding: 'utf8' });
  if (tracked.status !== 0) throw Error(tracked.stderr);
  if (input.baseline_path) copyFileSync(`${cwd}/${input.baseline_path}`, `${cwd}/output/baseline.docx`);
  writeFileSync(`${cwd}/output/delivery.md`, 'Synthetic full-document recheck.');
} else if (input.version === 'review-file-input-v1') {
  const source = input.materials.find(value => value.review_source);
  if (!source) throw Error('pinned source missing');
  const program = `from docx import Document\nimport sys\nd=Document(sys.argv[1]); print('\\n'.join(p.text for p in d.paragraphs))`;
  const result = spawnSync(python, ['-c', program, `${cwd}/${source.path}`], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr);
  const quote = result.stdout.trim().split('\n')[0];
  const report = `# Synthetic review ${input.input_hash}\n\n## 财务核对\n### Synthetic source check\n**复核类别：** 财务数据一致性\n**原文位置：** 第一段\n**原文披露：** ${quote}\n**核对依据：** Synthetic candidate materials\n**问题说明：** Synthetic review of the exact candidate source\n**处理方式：** 仅批注\n**替换文本：** 无\n**缺少材料：** 无\n\n## 公开信息核验\n公开检索未执行。\n`;
  writeFileSync(`${cwd}/output/report.md`, report);
  const resultWord = spawnSync(python, ['-c', 'from docx import Document; import sys; d=Document(); d.add_paragraph(sys.argv[1]); d.save(sys.argv[2])',
    report, `${cwd}/output/report.docx`], { encoding: 'utf8' });
  if (resultWord.status !== 0) throw Error(resultWord.stderr);
} else if (input.version === 'm4-file-workspace-v1') {
  const result = spawnSync(python, ['-c', `import json,sys\nfrom pathlib import Path\nfrom docx import Document\nr=Path.cwd(); i=json.loads((r/'input.json').read_text(encoding='utf-8')); d=Document(); d.add_paragraph('Synthetic M4 '+i['input_hash']); d.save(r/'output/document.docx'); n=Document(); n.add_paragraph('Synthetic preparation note '+i['input_hash']); n.save(r/'output/preparation-note.docx')`],
  { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr);
} else throw Error('unsupported synthetic workspace');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-supplement-files' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Synthetic Word files saved.' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }));
