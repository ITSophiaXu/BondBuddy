import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, PYTHON, processRun, readJson } from '../lib/platform.mjs';
import { startBridge, toMessages } from '../lib/bridge.mjs';
import { askCodex, object, string, REVIEW_SCHEMA, UPDATE_SCHEMA, CHAT_SCHEMA } from '../lib/codex.mjs';
import { loadKnowledge, manifest } from '../lib/knowledge.mjs';
import { validateEdits, runTask } from '../lib/worker.mjs';
import { randomUUID } from 'node:crypto';

const artifacts=join(ROOT,'qa','artifacts',randomUUID());await mkdir(artifacts,{recursive:true});
await processRun(PYTHON,[join(ROOT,'qa','make_fixtures.py'),artifacts]);
const source=join(artifacts,'source.docx');
test('all eight knowledge routes have different scope-specific markdown and traceable sources',async()=>{
  const packs=await manifest();assert.equal(packs.length,8);
  for(const p of packs){const k=await loadKnowledge(p.scope,p.kind);assert.equal(k.id,p.id);assert(k.handbook.includes(p.title));assert(k.rules.length>=26);assert(k.sourceChunks.length>0);}
  const sse=await loadKnowledge('sse-private','review'),szse=await loadKnowledge('szse-public','review');
  assert(sse.handbook.includes('最近两年'));assert(szse.handbook.includes('最近三年'));assert(!szse.sources.includes('S005'));
});
test('bridge translates instructions and JSON schema without leaking provider keys',async()=>{
  const schema=object({message:string});const messages=toMessages({instructions:'rules',input:[{role:'developer',content:[{type:'input_text',text:'dev'}]},{role:'user',content:'question'}],text:{format:{schema}}});
  assert.deepEqual(messages.map(m=>m.role),['system','system','user','system']);assert(messages[3].content.includes('JSON Schema'));
  let seen;
  const bridge=await startBridge({apiKey:'private-provider-key',fetcher:async(url,request)=>{seen={url,request};return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"message":"ok"}'}}],usage:{prompt_tokens:7,completion_tokens:4}}));}});
  try{
    let r=await fetch(bridge.url+'/responses',{method:'POST',body:'{}'});assert.equal(r.status,401);
    r=await fetch(bridge.url+'/responses',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`},body:JSON.stringify({input:'hi',stream:true,text:{format:{schema}}})});
    const body=await r.text();assert.equal(r.status,200);assert(body.includes('response.completed'));assert(body.includes('response.output_text.delta'));assert(!body.includes('private-provider-key'));assert.equal(seen.request.headers.Authorization,'Bearer private-provider-key');assert.equal(JSON.parse(seen.request.body).response_format.type,'json_object');
  }finally{bridge.close();}
});
test('Codex worker uses custom Responses provider and validates output',async()=>{
  let args;
  const r=await askCodex({prompt:'hi',schema:object({message:string}),folder:artifacts,key:'adapter',settings:{apiKey:'secret',model:'deepseek-chat'},bridgeFactory:async()=>({url:'http://127.0.0.1:9999/v1',token:'test-token',close(){}}),runner:async(a,o)=>{args=a;assert.equal(o.env.DEEPSEEK_API_KEY,'');assert.equal(o.env.BOND_BUDDY_BRIDGE_TOKEN,'test-token');await writeFile(a[a.indexOf('--output-last-message')+1],'{"message":"ok"}');return{code:0,stdout:'{"type":"turn.completed","usage":{"input_tokens":5}}',stderr:''};}});
  assert(args.includes('model_provider="bondbuddy"'));assert(args.includes('read-only'));assert.equal(r.value.message,'ok');assert.equal(r.usage.inputTokens,5);
});
test('unverified evidence and ambiguous quotes never become applied edits',()=>{
  const d={id:'D01',records:[{locator:'P1',text:'100 and 100'},{locator:'P2',text:'assets100'}]};
  const batches=[{gaps:[],edits:[{locator:'P1',quote:'100',replacement:'200',reason:'ambiguous',evidence:[{documentId:'D01',locator:'P1',quote:'100'}]},{locator:'P2',quote:'100',replacement:'200',reason:'fabricated',evidence:[{documentId:'D99',locator:'P1',quote:'200'}]}]}];
  const result=validateEdits(batches,d,[d]);assert.equal(result.edits.length,0);assert.equal(result.gaps.length,2);
});
async function fixtureJob(kind){
  const folder=join(artifacts,kind);await mkdir(folder,{recursive:true});
  const files=kind==='generate'?[]:[{role:kind==='review'?'updated':'historical',filename:'source.docx',path:source,size:100},{role:'financial',filename:'财务材料.txt',path:join(artifacts,'财务材料.txt'),size:100}];
  await writeFile(join(folder,'manifest.json'),JSON.stringify({files}));
  return{folder,job:{id:randomUUID(),kind,title:'结构验证测试',context:{scope:'sse-private',periods:'2026-06-30',issuer:'测试发行人'},files,modelName:'deepseek-chat',modelLabel:'test',prompt:'生成项目说明书',web:false,registry:false}};
}
test('update pipeline writes real Word revisions and an update report',async()=>{
  const {job,folder}=await fixtureJob('update');
  job.context.updateMode='full';job.context.projectMessages=[{text:'截至2026年6月末，银行授信总额50亿元，已使用30亿元，未使用20亿元。'}];
  const prompts=[];
  await runTask({job,folder,save:async()=>{},settings:{apiKey:'mock-key'},signal:new AbortController().signal,ask:async({prompt})=>{prompts.push(prompt);return ({value:{summary:'测试模拟',edits:[{locator:'P0002',quote:'100',replacement:'120',reason:'按财务报表更新',evidence:[{documentId:'D02',locator:'L00001',quote:'发行人总资产120万元'}]},{locator:'T001R002C002P0001',quote:'100',replacement:'120',reason:'表格同口径更新',evidence:[{documentId:'D02',locator:'L00001',quote:'发行人总资产120万元'}]}],gaps:['模型响应为测试模拟，不代表业务结果']},usage:{}});}});
  assert(prompts.length);for(const prompt of prompts){assert(prompt.includes('本项目为全文更新'));assert(prompt.includes('银行授信总额50亿元'));assert(prompt.includes('重大资产重组由系统根据审计报告'));assert(prompt.includes('由发行人提供'));}
  assert.equal(job.status,'complete',job.progress);assert.equal(job.editCount,2);assert(job.downloads.includes('募集说明书_更新修订版.docx'));
  await processRun(PYTHON,['-c',`import zipfile,sys; from lxml import etree; z=zipfile.ZipFile(sys.argv[1]); r=etree.fromstring(z.read('word/document.xml')); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}; assert len(r.xpath('//w:ins',namespaces=ns))==2; assert len(r.xpath('//w:del',namespaces=ns))==2; assert r.xpath('//w:ins//w:t/text()',namespaces=ns)==['120','120']; assert r.xpath('//w:del//w:delText/text()',namespaces=ns)==['100','100']; assert len(r.xpath('//w:tbl',namespaces=ns))==1`,join(folder,'募集说明书_更新修订版.docx')]);
});
test('review pipeline writes native comments and a downloadable Word findings report',async()=>{
  const {job,folder}=await fixtureJob('review');
  await runTask({job,folder,save:async()=>{},settings:{apiKey:'mock-key'},signal:new AbortController().signal,ask:async()=>({value:{summary:'测试模拟',findings:[{status:'明确错误',priority:'P1',category:'财务',title:'资产金额不一致',locator:'P0002',quote:'100',issue:'材料记载120万元',evidence:[{documentId:'D02',locator:'L00001',quote:'发行人总资产120万元'}],suggestion:'核实并更正为120万元',rule_ids:['SSE-PRIVATE-01'],calculation:''}],checks:[],limitations:['测试模拟']},usage:{}})});
  assert.equal(job.status,'complete',job.progress);assert.equal(job.findingCount,1);assert.equal(job.annotationCount,1);assert(job.downloads.includes('复核结果报告.docx'));
  await processRun(PYTHON,['-c',`import zipfile,sys; from lxml import etree; z=zipfile.ZipFile(sys.argv[1]); assert 'word/comments.xml' in z.namelist(); r=etree.fromstring(z.read('word/document.xml')); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}; assert len(r.xpath('//w:commentRangeStart',namespaces=ns))==1; from docx import Document; a=Document(sys.argv[1]); b=Document(sys.argv[2]); assert [p.text for p in a.paragraphs]==[p.text for p in b.paragraphs]`,join(folder,'募集说明书_复核批注.docx'),source]);
});
test('chat generates Word without claiming unconfigured external queries',async()=>{
  const {job,folder}=await fixtureJob('generate');job.web=true;job.registry=true;
  await runTask({job,folder,save:async()=>{},settings:{apiKey:'mock-key'},signal:new AbortController().signal,ask:async()=>({value:{title:'项目说明书',answer:'已生成说明书。',document:'## 项目背景\n测试材料。',sources:['https://invented.example/'],limitations:[]},usage:{}})});
  assert.equal(job.status,'complete',job.progress);assert(job.downloads.includes('生成材料.docx'));assert.equal(job.result.sources.length,0);assert(job.result.limitations.some(s=>s.includes('工商查询尚未连接')));
});
test('missing provider credentials preserve a resumable job',async()=>{
  const {job,folder}=await fixtureJob('generate');await runTask({job,folder,save:async()=>{},settings:{apiKey:''},signal:new AbortController().signal,ask:async()=>{throw new Error('must not call');}});assert.equal(job.status,'needs_setup');assert.deepEqual(job.downloads,[]);
});

test('reference authoring exports new draft tables and gap markers, never copies the peer original',async()=>{
  const {job,folder}=await fixtureJob('update');job.context.authoringMode='reference';job.files[0].role='reference';job.context.blueprint={issuer:'PEER_PROVENANCE_ONLY',version:'测试版',publishedAt:'2026-06-30',sourceUrl:'https://bond.sse.com.cn/fixture',documentUrl:'https://static.sse.com.cn/fixture.pdf',verification:'测试来源',confirmedAt:'2026-07-01',sha256:'test-hash'};
  await writeFile(join(folder,'manifest.json'),JSON.stringify({files:job.files}));
  let calls=0;
  await runTask({job,folder,save:async()=>{},settings:{apiKey:'mock-key'},signal:new AbortController().signal,ask:async({prompt})=>{
    calls++;assert(!prompt.includes('PEER_PROVENANCE_ONLY'));assert(prompt.includes('referenceBlueprint只能说明结构'));assert(prompt.includes('projectEvidence'));assert(prompt.includes('本项目为全文更新'));assert(prompt.includes('重大资产重组由系统根据审计报告'));
    const financial=prompt.includes('起草“财务会计信息”');
    const evidence=[{documentId:'D02',locator:'L00001',quote:'发行人总资产120万元'}];
    return {value:{paragraphs:financial?[{text:'测试发行人总资产120万元。',evidence}]:[],tables:financial?[{title:'资产情况',columns:['项目','金额（万元）'],rows:[['总资产','120']],evidence}]:[],gaps:financial?[]:['请补充本节项目资料（模拟结果）']},usage:{}};
  }});
  assert.equal(job.status,'complete',job.progress);assert.equal(calls,15);assert(!(await readFile(join(folder,'编制说明.md'),'utf8')).includes('PEER_PROVENANCE_ONLY'));assert.equal(job.context.blueprint.issuer,'PEER_PROVENANCE_ONLY');assert(job.downloads.includes('募集说明书_初稿.docx'));assert(!job.downloads.includes('募集说明书_更新修订版.docx'));assert.equal(job.result.sections.find(s=>s.title==='财务会计信息').tableCount,1);
  await processRun(PYTHON,['-c',`from docx import Document; import sys; d=Document(sys.argv[1]); text=chr(10).join(p.text for p in d.paragraphs); assert '总资产120万元' in text; assert '【待补充】' in text; assert len(d.tables)==1; assert d.tables[0].cell(1,1).text=='120'; assert '100' not in text`,join(folder,'募集说明书_初稿.docx')]);
});
