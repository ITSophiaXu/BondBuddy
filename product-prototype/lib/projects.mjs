import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join,extname } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { atomicJson,readJson,python } from './platform.mjs';
import { validScope } from '../public/markets.js';
import { reportingPeriods } from '../public/reporting-periods.js';
import { normaliseOptional,SUPPORT_ROLES } from '../public/project-fields.js';
import { estimateWork,assessmentDigest,normaliseWork } from './work-estimate.mjs';
import { businessProfile } from './business-profile.mjs';
import { REVIEW_DIMENSIONS,FINANCIAL_ROLES } from '../public/review-scope.js';
import { estimateCredits } from './credit-pricing.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const editable=new Set(['draft','awaiting_confirmation','needs_materials']);
export function projectService({folder,load,save,owns,billing,library,settings,enqueue,queryPlan}){
  const locks=new Map(),executions=new Map();
  function exclusive(id,fn){const run=(locks.get(id)||Promise.resolve()).then(fn);const tail=run.catch(()=>{});locks.set(id,tail);return run.finally(()=>{if(locks.get(id)===tail)locks.delete(id);});}
  function contextFor(f){
    if(!validScope(f.scope))throw fault('请选择有效的发行市场与发行方式。');
    if(!String(f.issuer||'').trim()||!String(f.title||'').trim())throw fault('请填写项目名称与发行人。');
    if(String(f.issuer).length>300||String(f.title).length>150)throw fault('发行人或项目名称过长。');
    if(!['update','review'].includes(f.kind))throw fault('项目类型无效。');
    if(f.kind==='update'&&!['historical','reference'].includes(f.authoringMode))throw fault('请选择是否有历史募集书。');
    const context={issuer:f.issuer.trim(),scope:f.scope,periods:f.periods,...normaliseOptional(f),...normaliseWork(f)};
    if(context.registrationMode==='dfi'&&!f.scope.startsWith('nafmii-'))throw fault('DFI统一注册模式仅用于交易商协会项目，具体适用性须核对注册通知。');
    context.authoringMode=f.kind==='update'?f.authoringMode:'historical';
    context.investorBasis='以所选发行方式及适用规则核验投资者范围；不把用户选择当作资格已核验的证据。';
    context.reportingWindow=reportingPeriods(f.periods,f.scope.split('-')[1]);
    context.optionalInputBasis='未填写不等于否。对话说明和字段包含用户的拟定安排与补充资料。授信等补充数据按发行人提供注明来源，尚无证明材料的列为待核实，不替代审计或其他外部证据；冲突列明差异，不擅自覆盖。';
    if(f.kind==='review')context.reviewDimensions=REVIEW_DIMENSIONS.map(d=>d.id);
    return context;
  }
  async function create(req,f){
    const context=contextFor(f),id=randomUUID();
    const job={id,requestId:f.requestId||null,kind:f.kind,title:f.title.trim(),context,seatId:req.user.id,files:[],status:'draft',progress:'项目已创建，请提供材料并开始任务',downloads:[],createdAt:new Date().toISOString(),revision:0};
    await mkdir(folder(id),{recursive:true});await save(job);return job;
  }
  const rolesFor=(kind,context)=>kind==='review'?['updated','historical',...SUPPORT_ROLES]:context.authoringMode==='historical'?['historical',...SUPPORT_ROLES]:['userReference',...SUPPORT_ROLES];
  function invalidate(job){job.quote=null;job.cost=null;job.revision++;job.status='needs_materials';job.progress='材料已保存，补充完成后点击开始';}
  async function upload(req,id,f,uploads){return exclusive(id,async()=>{
    const job=await load(id);owns(req,job);if(!editable.has(job.status))throw fault('项目已开始，不能更换本次材料。',409);
    if(f.kind!==job.kind||uploads.length!==1)throw fault('请逐份上传本项目材料。');
    const context=contextFor(f),file=uploads[0],roles=rolesFor(job.kind,context),extension=extname(file.filename).toLowerCase();
    if(!roles.includes(file.role)||!['.docx','.pdf','.xlsx','.csv','.txt'].includes(extension)||!file.content.length)throw fault('文件类型或材料分区无效。');
    if(['updated','historical'].includes(file.role)&&extension!=='.docx')throw fault('募集书请提供 DOCX 文件。');
    if(file.role==='userReference'&&!['.docx','.pdf'].includes(extension))throw fault('相似募集书请提供 DOCX 或 PDF 文件。');
    const singleton=['updated','historical','userReference'].includes(file.role);
    const kept=job.files.filter(x=>x.role!=='reference'&&(!singleton||x.role!==file.role));
    if(kept.length>=60||kept.reduce((n,x)=>n+x.size,0)+file.content.length>80*1024*1024)throw fault('最多60份材料，合计不超过80 MB。');
    const key=randomUUID(),dir=join(folder(id),'materials');await mkdir(dir,{recursive:true});
    const path=join(dir,key+'_'+file.filename);await writeFile(path,file.content);
    const saved={key,role:file.role,filename:file.filename,size:file.content.length,sha256:sha(file.content),path};
    job.files=[...kept,saved];job.context=context;job.title=f.title.trim();invalidate(job);await save(job);
    const {path:privatePath,...publicFile}=saved;return publicFile;
  });}
  async function removeMaterial(req,id,key){return exclusive(id,async()=>{
    const job=await load(id);owns(req,job);if(!editable.has(job.status))throw fault('项目已开始，不能移除本次材料。',409);
    if(!job.files.some(f=>f.key===key&&f.role!=='reference'))throw fault('文件不存在。',404);
    job.files=job.files.filter(f=>f.key!==key&&f.role!=='reference');invalidate(job);await save(job);return {ok:true};
  });}
  async function assess(req,id,f,uploads){return exclusive(id,async()=>{
    const job=await load(id);owns(req,job);if(!editable.has(job.status))throw fault('该项目已开始处理，不能覆盖本次材料。',409);
    if(f.kind!==job.kind)throw fault('不能改变已创建项目的任务类型。');
    if(f.blueprintId||uploads.some(x=>x.role==='reference'))throw fault('请提供本发行人的项目资料。');
    const context=contextFor(f);let retained=[];
    try{retained=JSON.parse(f.retainedFiles||'[]');}catch{throw fault('保留材料清单无效。');}
    if(!Array.isArray(retained)||retained.length>60||retained.some(key=>typeof key!=='string'))throw fault('保留材料清单无效。');
    const files=[...uploads];
    for(const key of new Set(retained)){
      const old=job.files.find(x=>x.key===key&&x.role!=='reference');if(!old)throw fault('材料已变更，请重新打开项目。',409);
      const content=await readFile(old.path);if(sha(content)!==old.sha256)throw fault('已保存的材料发生变化，请重新上传。',409);
      files.push({role:old.role,filename:old.filename,content});
    }
    const roles=rolesFor(job.kind,context);
    if(!files.length||files.length>60||files.some(x=>!roles.includes(x.role)||!['.pdf','.docx','.xlsx','.csv','.txt'].includes(extname(x.filename).toLowerCase())||!x.content.length)||files.reduce((n,x)=>n+x.content.length,0)>80*1024*1024)throw fault('请提供1至60份有效项目材料，合计不超过80 MB。');
    const primary=job.kind==='review'?'updated':'historical';
    if((job.kind==='review'||context.authoringMode==='historical')&&(files.filter(x=>x.role===primary).length!==1||!files.find(x=>x.role===primary).filename.toLowerCase().endsWith('.docx')))throw fault('请提供一份本发行人的募集书 DOCX。');
    if(!files.some(x=>FINANCIAL_ROLES.includes(x.role)))throw fault('请提供审计报告，或财务报表及附注，用于核对财务数据。');
    if(files.filter(x=>x.role==='userReference').length>1||files.some(x=>x.role==='userReference'&&!/\.(docx|pdf)$/i.test(x.filename)))throw fault('可选的相似募集书限一份 DOCX 或 PDF。');
    if(job.kind==='update'&&context.authoringMode==='reference'&&!files.some(x=>x.role==='audit'))throw fault('没有历史募集书时，请先提供本发行人的年度审计报告（含营业收入分业务披露）。');
    // Invalidate the previous quote before writing any revised material.
    job.quote=null;job.cost=null;job.context=context;job.title=f.title.trim();job.revision++;job.progress='正在准备项目材料';job.status='needs_materials';await save(job);
    const dir=join(folder(id),'assessment-'+job.revision);await mkdir(dir,{recursive:true});
    const saved=[];for(const [i,file] of files.entries()){const path=join(dir,`${i+1}_${file.filename}`);await writeFile(path,file.content);saved.push({role:file.role,filename:file.filename,size:file.content.length,path,sha256:sha(file.content),key:randomUUID()});}
    job.files=saved;await save(job);await atomicJson(join(dir,'manifest.json'),{files:saved});
    try{
      await python('extract_materials.py',['manifest.json','evidence.json'],dir);
      const documents=(await readJson(join(dir,'evidence.json'))).documents;
      if(documents.some(d=>!d.records.length))throw fault('部分文件未提取到文字。请替换扫描件、加密文件或损坏文件后重新提交。');
      const config=await settings();
      if(job.kind==='update'&&context.authoringMode==='reference'&&files.some(f=>f.role==='userReference')){
        const source=files.find(f=>f.role==='userReference'),path=join(dir,'reference'+extname(source.filename));await writeFile(path,source.content);
        saved.push({role:'reference',filename:source.filename,path,size:source.content.length,sha256:sha(source.content),key:randomUUID()});context.blueprint={kind:'user-provided',sha256:sha(source.content),basis:'只参考结构，不作为发行人事实依据'};
      }else if(job.kind==='update'&&context.authoringMode==='reference'){
        const year=Number(context.periods.slice(0,4))-(context.periods.endsWith('12-31')?0:1);
        const audit=documents.filter(d=>d.role==='audit');
        const profile=await businessProfile(audit,{year,issuer:context.issuer,folder:dir,settings:config});
        if(!profile.ready)throw fault('审计报告中的合并业务收入口径尚不能完整确认。请补充最近完整年度、带分业务收入及单位的审计附注。');
        const selected=await library.automaticBlueprint(req.user.id,profile,{scope:context.scope,folder:dir,settings:config});
        if(!selected)throw fault('自动编制准备尚未完成，项目与材料已保存。请联系项目支持补充编制资料，本次不扣点。');
        const path=join(dir,'reference'+extname(selected.file.filename));await writeFile(path,selected.file.content);
        saved.push({role:'reference',filename:selected.file.filename,path,size:selected.file.content.length,sha256:sha(selected.file.content),key:randomUUID()});context.blueprint=selected.snapshot;
      }
      if(job.kind==='update'&&context.authoringMode==='historical'&&!context.sourceScope){
        const text=documents.find(d=>d.role==='historical').records.slice(0,30).map(r=>r.text).join('\n');
        const market=/上海证券交易所|上交所/.test(text)?'sse':/深圳证券交易所|深交所/.test(text)?'szse':/交易商协会|银行间市场/.test(text)?'nafmii':'';
        const offering=market==='nafmii'?(/超短期融资券/.test(text)?'scp':/短期融资券/.test(text)?'cp':/中期票据/.test(text)?'mtn':/定向债务融资工具/.test(text)?'ppn':''):/非公开|私募/.test(text)?'private':/普通投资者/.test(text)?'public_all':/专业投资者/.test(text)?'public':'';
        if(market&&offering)context.sourceScope=market+'-'+offering;
      }
      job.context=context;job.files=saved;job.quote=estimateWork(context,documents,job.kind);job.quote.digest=assessmentDigest(context,saved);job.quote.revision=job.revision;
      job.quote.warnings=documents.flatMap(d=>(d.warnings||[]).map(w=>`${d.filename}：${w}`));
      if(job.kind==='review'){const plan=queryPlan(job,config,(await billing.view(req.user.id)).seat.quota);job.quote.warnings.push(...plan.queryLimitations);}
      job.cost=estimateCredits(job,documents,config);job.cost.legacyCost={qa:0,documents:0,points:job.quote.points};
      job.status='awaiting_confirmation';job.progress='材料准备完成';job.modelName=config.model;
      await atomicJson(join(folder(id),'manifest.json'),{files:saved});await save(job);return job;
    }catch(error){job.status='needs_materials';job.progress=error.message;job.quote=null;await save(job);throw error;}
  });}
  async function start(req,id,quoteId){return exclusive(id,async()=>{
    const job=await load(id);owns(req,job);
    quoteId=quoteId||job.quote?.id;
    if(quoteId&&job.acceptedQuoteId===quoteId&&job.status!=='awaiting_confirmation')return job;
    if(job.status!=='awaiting_confirmation'||!quoteId||quoteId!==job.quote?.id||job.quote.expiresAt<new Date().toISOString())throw fault('评估结果已失效，请重新点击开始。',409);
    if(assessmentDigest(job.context,job.files)!==job.quote.digest)throw fault('项目内容已变化，请重新提交。',409);
    for(const f of job.files)if(sha(await readFile(f.path))!==f.sha256)throw fault('材料已发生变化，请重新提交。',409);
    const config=await settings(),quota=(await billing.view(req.user.id)).seat.quota;
    const documents=(await readJson(join(folder(id),'assessment-'+job.revision,'evidence.json'))).documents;
    const plan=queryPlan(job,config,quota);Object.assign(job,plan);
    const cost=estimateCredits(job,documents,config);cost.legacyCost={qa:0,documents:0,points:job.quote.points};
    await billing.reserve(id,req.user.id,cost);
    try{job.cost=cost;job.acceptedQuoteId=quoteId;job.acceptedAt=new Date().toISOString();job.status='queued';job.progress='任务等待开始';job.modelName=config.model;Object.assign(job,plan);await save(job);enqueue(id);return job;}catch(error){await billing.settle(id,false);throw error;}
  });}
  async function execute(req,id,f,uploads){
    const current=await load(id);owns(req,current);
    if(executions.has(id))return executions.get(id);
    if(!editable.has(current.status))return current;
    const promise=(async()=>{await assess(req,id,f,uploads);return start(req,id);})();executions.set(id,promise);
    try{return await promise;}finally{executions.delete(id);}
  }
  return {create,assess,start,execute,upload,removeMaterial};
}
