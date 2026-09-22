import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { ROOT,PYTHON,processRun,python,readJson } from '../lib/platform.mjs';
import { runTask } from '../lib/worker.mjs';
import { GenerationTemplates } from '../lib/generation-templates.mjs';
import { GENERATION_TYPES,GENERATION_TEMPLATE_VERSION } from '../public/generation-catalog.js';
const root=join(ROOT,'qa','artifacts','material-generation-'+randomUUID());await mkdir(root,{recursive:true});
await processRun(PYTHON,['-c',`from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from pathlib import Path
p=Path(r'${root.replaceAll('\\','/')}')
d=Document(); d.add_paragraph('测试发行人'); para=d.add_paragraph('发行人总资产')
old=OxmlElement('w:del'); r=OxmlElement('w:r'); t=OxmlElement('w:delText'); t.text='100'; r.append(t); old.append(r); para._p.append(old)
new=OxmlElement('w:ins'); r=OxmlElement('w:r'); t=OxmlElement('w:t'); t.text='120'; r.append(t); new.append(r); para._p.append(new); para.add_run('万元')
d.save(p/'latest.docx')
d=Document(); d.styles['Normal'].font.name='SimSun'; d.styles['Normal'].font.size=Pt(12)
d.add_heading('一、项目概况',1); d.add_paragraph('旧发行人999亿元，已批准立项。'); d.add_heading('二、偿债能力',1); d.add_paragraph('原报告表格字段：资产、负债、现金流。')
d.sections[0].header.paragraphs[0].text='旧发行人秘密签章'; d.save(p/'broker-template.docx')
`]);
test('broker templates in deep workspaces are readable, versioned, deduplicated and isolated by account and broker',async()=>{
  // Exercise Windows paths longer than 260 characters even in a short checkout.
  const store=new GenerationTemplates(join(root,'templates','nested-'+ 'x'.repeat(180))),file={filename:'券商模板.docx',content:await readFile(join(root,'broker-template.docx'))};
  const first=await store.save('owner','测试证券股份有限公司',file),duplicate=await store.save('owner','测试证券股份有限公司',file);assert.equal(first.id,duplicate.id);
  const own=await store.list('owner','测试证券股份有限公司');assert.equal(own.length,1);assert(!JSON.stringify(own).includes(root));assert.equal((await store.list('other','测试证券股份有限公司')).length,0);
  await assert.rejects(store.get('other',first.id,'测试证券股份有限公司'),/未找到/);await assert.rejects(store.get('owner',first.id,'其他证券'),/未找到/);
  const changed=await store.save('owner','测试证券股份有限公司',{filename:'新版.txt',content:Buffer.from('一、项目概况\n二、风控审查')});assert.notEqual(changed.id,first.id);assert.equal((await store.list('owner','测试证券股份有限公司')).length,2);
  await assert.rejects(store.save('owner','测试证券',{filename:'bad.docx',content:Buffer.from('not-a-docx')}),/未提取到文字/);
});
test('latest-prospectus extraction accepts revisions and exposes actual Word font evidence',async()=>{
  const dir=join(root,'extract');await mkdir(dir);await writeFile(join(dir,'manifest.json'),JSON.stringify({files:[{role:'prospectus',filename:'latest.docx',path:join(root,'latest.docx')},{role:'updated',filename:'template.docx',path:join(root,'broker-template.docx')}]}));
  await python('extract_materials.py',['manifest.json','evidence.json'],dir);const {documents}=await readJson(join(dir,'evidence.json'));
  assert.equal(documents[0].records[1].text,'发行人总资产120万元');assert(!documents[0].records[1].text.includes('100'));
  assert(documents[1].records.some(r=>r.formatting.runs.some(f=>f.latinFont==='SimSun'&&f.halfPoints==='24')));
});
test('all five material templates and both summary variants export Word; reference facts and signatures stay out',async()=>{
  for(const entry of [...GENERATION_TYPES.map(type=>({type:type.id,summaryKind:'private'})),{type:'summary',summaryKind:'public'}]){
    const id=randomUUID(),dir=join(root,entry.type+'-'+entry.summaryKind);await mkdir(dir);
    const files=[{role:'prospectus',filename:'latest.docx',path:join(root,'latest.docx'),size:100},...(entry.type==='initiation'?[{role:'generationTemplate',filename:'券商模板.docx',path:join(root,'broker-template.docx'),size:100}]:[])];
    await writeFile(join(dir,'manifest.json'),JSON.stringify({files}));
    const job={id,kind:'generate',title:'材料生成测试',context:{issuer:'测试发行人'},files,modelName:'mock',modelLabel:'测试',generation:{...entry,broker:'测试证券',templateFilename:entry.type==='initiation'?'券商模板.docx':'',templateVersion:GENERATION_TEMPLATE_VERSION,sourceName:'latest.docx',sourceBasis:'本次上传的最新版募集书'},instructions:'按提供的最新版起草',web:false,registry:false,bondQuery:false};
    let calls=0;const sourceId='C'+id.slice(0,8)+'-D01',templateId='C'+id.slice(0,8)+'-D02';
    await runTask({job,folder:dir,save:async()=>{},settings:{apiKey:'test-only'},signal:new AbortController().signal,ask:async({prompt,schema})=>{
      calls++;if(schema.properties.issuerEvidence)return {value:{issuer:'测试发行人',issuerEvidence:[{documentId:sourceId,locator:'P0001',quote:'测试发行人'}],sections:entry.type==='initiation'?[{title:'一、项目概况',guide:'基本情况',evidence:[{documentId:templateId,locator:'P0001',quote:'一、项目概况'}]},{title:'二、偿债能力',guide:'财务及偿债',evidence:[{documentId:templateId,locator:'P0003',quote:'二、偿债能力'}]}]:[]},usage:{}};
      assert(!prompt.includes('旧发行人999亿元'));assert(prompt.includes('发行人总资产120万元'));assert(!prompt.includes('总资产100万元'));
      return {value:{paragraphs:[{text:'发行人总资产120万元。',evidence:[{documentId:sourceId,locator:'P0002',quote:'发行人总资产120万元'}]}],tables:[],gaps:['测试模拟稿，需项目组审阅']},usage:{}};
    }});
    assert.equal(job.status,'complete',job.progress);assert(calls>2);assert(job.downloads.some(name=>name.endsWith('.docx')));assert.equal(job.result.sections.length,entry.type==='initiation'?2:GENERATION_TYPES.find(t=>t.id===entry.type).sections.length);
    const output=join(dir,job.downloads.find(n=>n.endsWith('.docx')));
    await processRun(PYTHON,['-c',`import sys,zipfile; from docx import Document; p=sys.argv[1]; d=Document(p); text=chr(10).join(x.text for x in d.paragraphs); assert '总资产120万元' in text; assert '【待补充】' in text; z=zipfile.ZipFile(p); xml=' '.join(z.read(n).decode('utf-8','ignore') for n in z.namelist() if n.endswith('.xml')); assert '旧发行人' not in xml; assert '999亿元' not in xml; ${entry.type==='initiation'?"assert d.styles['Normal'].font.name=='SimSun'; assert '一、项目概况' in text; assert '二、偿债能力' in text":"assert '募集说明书初稿' not in text"}`,output]);
  }
});
