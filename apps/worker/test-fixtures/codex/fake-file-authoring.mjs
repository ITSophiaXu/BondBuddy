// Synthetic provider only. Sandbox preflight is delegated to the real pinned Codex binary.
import {spawnSync,spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.includes('sandbox')){
  const result=spawnSync('/usr/local/bin/codex',args,{stdio:'inherit'});process.exit(result.status??1);
}
let input='';for await(const chunk of process.stdin)input+=chunk;
if(!args.includes('exec')||args.includes('--output-schema'))throw Error('one plain-text CLI execution required');
const cwd=args[args.indexOf('--cd')+1];
if(input.includes('SCENARIO:file_hang')){
  const child=spawn('sleep',['120'],{stdio:'ignore'});
  console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',id:'synthetic-sleep'}}));
  await new Promise(resolve=>child.on('exit',resolve));process.exit(0);
}
if(input.includes('SCENARIO:file_done')||input.includes('SCENARIO:file_no_prose')){
  writeFileSync(cwd+'/output/fixture.txt','synthetic file');
  if(!input.includes('SCENARIO:file_no_prose'))console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'普通文字；文件保存在 output。'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));process.exit(0);
}
const program=`import json,sys,shutil
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from docx import Document
from bondbuddy_file_authoring.check import package,clean,parse_xml
from bondbuddy_file_authoring.word_patch import Patcher,q,paragraph_text,serialized
r=Path.cwd();d=json.loads((r/'input.json').read_text());o=r/'output'
assert d['target']['issuer_name']=='合成目标发行人'
assert d['requirements'] and d['knowledge']
for m in d['materials']:assert (r/m['path']).is_file()
source=d['baseline_path']
if d.get('format_tools'):
 from bondbuddy_file_authoring.fixed_edit import load_editor,write_json
 data,base,raw,log,editor=load_editor(r/'input.json')
 node=next(n for n in editor.nodes if editor.nodes[n][1].tag==q('p'))
 log['operations']=[{'id':'synthetic-update','kind':'replace_text','node_id':node,'before':paragraph_text(editor.nodes[node][1]),'after':'合成目标发行人2025年净资产120万元。'+d['input_hash'][:8]}]
 write_json(o/'operations.json',log)
elif source:
 shutil.copyfile(r/source,o/'baseline.docx');parts=package(r/source);root=parse_xml(parts['word/document.xml']);p=root.find(q('body')).find(q('p'))
 Patcher(root,True,d['revision_author']).patch(p,paragraph_text(p),'合成目标发行人2025年净资产120万元。'+d['input_hash'][:8])
 parts['word/document.xml']=serialized(root)
 with ZipFile(o/'tracked.docx','w',ZIP_DEFLATED) as z:
  for n,b in parts.items():z.writestr(n,b)
 clean(o/'tracked.docx',o/'clean.docx')
else:
 doc=Document();doc.add_paragraph('合成目标发行人2025年净资产120万元。'+d['input_hash'][:8]);doc.save(o/'clean.docx')
 shutil.copyfile(o/'clean.docx',o/'tracked.docx');shutil.copyfile(o/'clean.docx',o/'baseline.docx')
(o/'delivery.md').write_text('合成测试编制。未进行页面视觉检查。',encoding='utf-8')
if not source:
 (o/'baseline.docx').unlink();(o/'delivery.md').unlink()
`;
const result=spawnSync('/opt/venv/bin/python',['-c',program],{cwd,env:{PATH:process.env.PATH,PYTHONPATH:fileURLToPath(new URL('../../../../python',import.meta.url)),LANG:'C.UTF-8'},encoding:'utf8'});
if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);}
console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-file-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'合成测试：文件已实际生成。'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:50,cached_input_tokens:0}}));
