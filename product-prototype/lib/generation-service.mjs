import { randomUUID,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,extname } from 'node:path';
import { atomicJson,readJson,python } from './platform.mjs';
import { taskCost } from './billing.mjs';
import { estimateCredits } from './credit-pricing.mjs';
import { generationType,GENERATION_TEMPLATE_VERSION } from '../public/generation-catalog.js';
import { SUPPORT_ROLES } from '../public/project-fields.js';
export function generationService({folder,load,save,owns,billing,templates,settings,enqueue}){
  async function create(req,f,uploads){
    const type=generationType(f.materialType);if(!type)throw new Error('请选择要生成的材料。');
    const prompt=String(f.instructions||'').trim(),broker=String(f.broker||'').trim();
    if(prompt.length>12000||broker.length>200)throw new Error('补充要求或券商名称过长。');
    if(type.id==='summary'&&!['private','public'].includes(f.summaryKind))throw new Error('请选择私募债或公募债摘要。');
    if(type.id==='initiation'&&!broker)throw new Error('请填写立项券商全称。');
    if(uploads.length>60||uploads.some(x=>!['prospectus','generationTemplate','generationRules','other'].includes(x.role)||!['.docx','.pdf','.txt','.xlsx','.csv'].includes(extname(x.filename).toLowerCase())||!x.content.length))throw new Error('材料类型无效，最多提供60份非空文件。');
    const source=uploads.filter(x=>x.role==='prospectus'),custom=uploads.filter(x=>x.role==='generationTemplate');
    if(source.length>1||custom.length>1)throw new Error('最新版募集书和立项模板各提供一份即可。');
    if(Boolean(f.projectId)===Boolean(source.length))throw new Error('请关联一个募集书项目，或上传一份最新版募集书。');
    if(source.some(x=>!['.docx','.pdf'].includes(extname(x.filename).toLowerCase())))throw new Error('最新版募集书请提供 DOCX 或 PDF。');
    if(type.id!=='initiation'&&(custom.length||f.templateId||uploads.some(x=>x.role==='generationRules')))throw new Error('券商模板及立项规则用于立项报告。');
    let project,snapshot=[],sourceName=source[0]?.filename||'';
    if(f.projectId){
      project=await load(f.projectId);owns(req,project);if(!['update','review'].includes(project.kind))throw new Error('请选择更新或复核募集书项目。');
      const latest=project.status==='complete'&&project.kind==='update'?(project.downloads||[]).find(n=>['募集说明书_更新修订版.docx','募集说明书_更新重编版.docx','募集说明书_初稿.docx'].includes(n)):null;
      const main=latest?{filename:latest,path:join(folder(project.id),latest)}:project.files.find(x=>x.role===(project.kind==='review'?'updated':'historical'));
      if(!main)throw new Error('关联项目尚无可用募集书，请先完成更新或上传最新版募集书。');
      sourceName=main.filename;snapshot.push({role:'prospectus',filename:main.filename,content:await readFile(main.path)});
      for(const file of project.files.filter(x=>SUPPORT_ROLES.includes(x.role)))snapshot.push({role:file.role,filename:file.filename,content:await readFile(file.path)});
    }
    if([...snapshot,...uploads].reduce((n,x)=>n+x.content.length,0)>80*1024*1024)throw new Error('本次材料合计超过80 MB，请减少补充材料。');
    let template;
    if(type.id==='initiation'){
      if(custom.length)template=await templates.save(req.user.id,broker,custom[0]);
      else if(f.templateId)template=await templates.get(req.user.id,f.templateId,broker);
      else {const recent=(await templates.list(req.user.id,broker))[0];if(recent)template=await templates.get(req.user.id,recent.id,broker);}
      if(!template)throw new Error('这家券商还没有保存的立项模板，请上传模板或已经写好的立项报告作为参考。');
    }
    const id=randomUUID(),dir=folder(id),incomingCount=uploads.length,files=[...snapshot,...uploads.filter(x=>x.role!=='generationTemplate'),...(template?[template.file]:[])];
    if(files.length>60||files.reduce((n,x)=>n+x.content.length,0)>80*1024*1024)throw new Error('连同关联材料和模板最多60份、合计80 MB。');
    await mkdir(join(dir,'uploads'),{recursive:true});const saved=[];
    for(const [i,file]of files.entries()){const path=join(dir,'uploads',`${i+1}_${file.filename}`);await writeFile(path,file.content);saved.push({role:file.role,filename:file.filename,size:file.content.length,path,sha256:createHash('sha256').update(file.content).digest('hex')});}
    await atomicJson(join(dir,'manifest.json'),{files:saved});await python('extract_materials.py',['manifest.json','evidence.json'],dir);
    const documents=(await readJson(join(dir,'evidence.json'))).documents;
    if(documents.some(d=>!d.records.length))throw new Error('部分材料无法提取文字，请替换扫描件、加密或损坏文件。');
    const config=await settings(),cost=taskCost('generate',incomingCount);
    const job={id,requestId:f.requestId||null,kind:'generate',title:(type.title+' · '+(broker||project?.context?.issuer||sourceName)).slice(0,150),seatId:req.user.id,context:{issuer:project?.context?.issuer||'',scope:project?.context?.scope||'',periods:project?.context?.periods||'',broker},files:saved,projectId:f.projectId||'',generation:{type:type.id,summaryKind:f.summaryKind||'',broker,templateId:template?.id||'',templateFilename:template?.filename||'',templateVersion:GENERATION_TEMPLATE_VERSION,sourceName,sourceBasis:project?.kind==='update'&&project.status!=='complete'?'关联项目当前上传的历史募集书，更新尚未完成':f.projectId?'关联项目的募集书快照':'本次上传的最新版募集书'},prompt,instructions:prompt,status:'queued',progress:'材料已保存，按模板生成中',createdAt:new Date().toISOString(),downloads:[],cost,modelName:config.model,modelLabel:'Codex · DeepSeek',web:false,registry:false,bondQuery:false,queryLimitations:[],connectorIds:[]};
    job.cost=estimateCredits(job,documents,config);job.cost.legacyCost=cost;
    await billing.reserve(id,req.user.id,job.cost);
    try{await save(job);enqueue(id);return job;}catch(error){await billing.settle(id,false);throw error;}
  }
  return {create};
}
