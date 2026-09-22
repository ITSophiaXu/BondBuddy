import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export const CREDIT_RULES=JSON.parse(readFileSync(new URL('./credit-rules.json',import.meta.url),'utf8'));
export const CREDIT_VERSION='2026-09-22-v1.1';
const number=(n)=>Number.isFinite(Number(n))?Number(n):0;
const fault=message=>Object.assign(new Error(message),{status:409,code:'METERING_PENDING'});
const productMap={'sse-private':'SH-P','sse-public':'SH-Q','sse-public_all':'SH-R','szse-private':'SZ-P','szse-public':'SZ-Q','szse-public_all':'SZ-R'};
export const productFor=scope=>productMap[scope]||(scope?.startsWith('nafmii-')?scope.slice(7).toUpperCase():scope);
export function updateCoefficient({history='own_complete',periods=1,source,target,scope='financial',special=1}){
  if(!Number.isInteger(periods)||periods<1)throw new Error('实际更新期间数量无效。');
  const base=periods<=4?CREDIT_RULES.history_bases_1_to_4[history]?.[periods-1]:({own_complete:5*periods,own_partial:Math.max(8,Math.ceil(6.25*periods)),peer:Math.max(25,15*periods),none:Math.max(35,15*periods+10)})[history];
  const migration=['peer','none'].includes(history)?1:CREDIT_RULES.migration_matrix[source]?.[target];
  const structure=CREDIT_RULES.products.find(p=>p.id===target)?.target_factor;
  if(!base||!migration||!structure||!CREDIT_RULES.update_scope[scope])throw new Error('无法识别本次募集书品种或范围，请补充项目材料。');
  return Math.min(200,Number((base*migration*structure*CREDIT_RULES.update_scope[scope]*Math.min(1.75,Math.max(1,special))).toFixed(6)));
}
export function parseCoefficient(format='F01',quality='normal'){
  const f=CREDIT_RULES.format_factors.find(x=>x.id===format),q=CREDIT_RULES.parse_quality_factors[quality];
  if(!f||!q)throw new Error('解析计价分类无效。');return Math.min(6,2*f.factor*q);
}
export function reviewCoefficient({type='R05',periods=1,target='SH-P',migration=1,special=1}){
  const base=CREDIT_RULES.review_types.find(x=>x.id===type)?.base;
  if(!base||!Number.isInteger(periods)||periods<1)throw new Error('复核计价分类无效。');
  const p=['R03','R05','R06','R08'].includes(type)?Math.min(1.75,1+(periods-1)*.15):1;
  const j=CREDIT_RULES.products.find(x=>x.id===target)?.target_factor||1,d=type==='R06'?1+.5*(migration-1):1;
  return Math.min(80,Number((base*p*j*d*Math.min(1.75,special)).toFixed(6)));
}
export function generationCoefficient({type,template='standard',evidence='source_materials',target='SH-P',special=1}){
  const base=CREDIT_RULES.generation_types.find(x=>x.id===type)?.base,t=CREDIT_RULES.template_factors[template],e=CREDIT_RULES.generation_evidence_factors[evidence];
  if(!base||!t||!e)throw new Error('材料生成计价分类无效。');
  return Math.min(60,Number((base*t*e*(CREDIT_RULES.products.find(x=>x.id===target)?.target_factor||1)*Math.min(1.75,special)).toFixed(6)));
}
export function materialRequest(prompt=''){
  if(/如何|怎么|怎样|是什么|什么是/.test(prompt)||!/(?:起草|编写|生成|制作|出具|撰写)/.test(prompt))return null;
  return /立项报告/.test(prompt)?'initiation':/主承销商核查意见/.test(prompt)?'underwriter':/法律意见书/.test(prompt)?'legal':/推荐函/.test(prompt)?'recommendation':/募集(?:说明)?书摘要|募集说明书摘要/.test(prompt)?'summary':null;
}
function textOf(documents){return documents.flatMap(d=>(d.records||[]).map(r=>r.text||'')).join('\n');}
export function financialPeriods(text){
  const periods=new Set();
  for(const m of text.matchAll(/(20\d{2})\s*(?:年度|年末|年\s*12\s*月\s*31\s*日)/g))periods.add(m[1]+'-12-31');
  for(const m of text.matchAll(/(20\d{2})\s*(?:年|[-/.])\s*(03|3|06|6|09|9|12)\s*(?:月|[-/.])\s*(31|30)(?:日)?/g))periods.add(`${m[1]}-${m[2].padStart(2,'0')}-${m[3]}`);
  for(const m of text.matchAll(/(20\d{2})\s*年\s*(?:1\s*[-—至]\s*)?(3|6|9)\s*月(?:末)?/g))periods.add(`${m[1]}-0${m[2]}-${m[2]==='3'?'31':'30'}`);
  return [...periods].sort();
}
export function changedPeriods(context,documents){
  const target=(context.reportingWindow?.periods||[]).map(p=>p.end);
  const historic=documents.filter(d=>d.role==='historical');
  const old=new Set(financialPeriods(textOf(historic)));
  const notes=(context.projectMessages||[]).map(m=>m.text).join('\n')+'\n'+(context.reviewNotes||'');
  // Count target financial periods missing from the historical version, never all years in attachments.
  const affected=new Set(target.filter(p=>!old.has(p)));
  if(/重述|更正|重新核对|重新更新/.test(notes))for(const p of financialPeriods(notes))if(target.includes(p))affected.add(p);
  return {count:Math.max(1,affected.size),periods:[...affected],historicalPeriods:[...old],basis:old.size?'历史稿与目标窗口差集':'未识别到历史财务期间，按目标待更新窗口计量'};
}
export function classifyQA(prompt,{projectId,files=[],web,registry,connectorIds=[]}={}){
  if(/^(?:查询|查看|我的|剩余|还有|显示|请问)*\s*(?:积分余额|剩余积分|积分规则|充值规则|如何充值|怎么充值|如何上传|怎么上传)[？?。！!\s]*$/.test(prompt))return 'Q00';
  if(/深度研究|跨市场|跨品种|多步骤/.test(prompt))return 'Q07';
  if(web||registry||connectorIds.length)return 'Q06';
  if(/会计|发行条件|合规|财务分析|偿债能力|风险分析/.test(prompt))return 'Q05';
  if(files.length>1||/交叉|多文档|对照|比对/.test(prompt))return 'Q04';
  if(/计算|比率|指标|增长率/.test(prompt))return 'Q03';
  return projectId||files.length?'Q02':'Q01';
}
export function classifyTask(job,documents=[]){
  const c=job.context||{},target=productFor(c.scope)||'SH-P';
  const structure=CREDIT_RULES.products.find(p=>p.id===target)?.target_factor||1;
  const notes=[c.reviewNotes,...(c.projectMessages||[]).map(m=>m.text),job.prompt].filter(Boolean).join('\n');
  // Only explicit work instructions trigger special handling, never a subsidiary inventory or a negated field.
  const specials=[];
  if(/(?:分析|核对|更新|补充).{0,12}(?:绿色|科创)/.test(notes))specials.push('green');
  if(/(?:分析|核对|更新|补充).{0,12}可持续发展挂钩/.test(notes))specials.push('sll');
  if(/(?:分析|核对|更新|补充).{0,12}(?:追溯重述|口径桥接)/.test(notes))specials.push('restatement');
  if(/(?:分析|核对|更新|补充).{0,12}(?:重组|备考)/.test(notes))specials.push('reorg');
  if(specials.includes('sll'))specials.splice(specials.indexOf('green'),specials.includes('green')?1:0);
  const special=Math.min(1.75,1+specials.reduce((n,id)=>n+CREDIT_RULES.special_additions.find(x=>x.id===id).addition,0));
  if(job.kind==='update'){
    const own=documents.some(d=>d.role==='historical');
    const history=own?'own_complete':job.files?.some(f=>f.role==='userReference')?'peer':'none';
    const period=changedPeriods(c,documents),source=productFor(c.sourceScope)||target;
    const scope=own&&source===target?'full_facts':'restructure';
    return {type:'update',history,source,target,...period,scope,special,specials,coefficient:updateCoefficient({history,periods:period.count,source,target,scope,special})};
  }
  if(job.kind==='review'){
    const count=Math.max(1,c.reportingWindow?.periods?.length||financialPeriods(textOf(documents)).length||1);
    const periodFactor=Math.min(1.75,1+(count-1)*.15);
    // Current review workflow is a single combined package; its contained checks are not added again.
    return {type:'review',reviewType:'R05',count,target,coverage:'文内、财务证据及规则；外部查询覆盖见成果',coefficient:reviewCoefficient({periods:count,target,special})};
  }
  if(job.generation){
    const map={initiation:'G01',underwriter:'G02',legal:'G03',recommendation:'G04',summary:job.generation.summaryKind==='public'?'G06':'G05'};
    const id=map[job.generation.type];
    const template=job.generation.templateId?'matching':'standard';
    const evidence=job.projectId?'verified_project':'source_materials';
    return {type:'generation',generationType:id,template,evidence,target,coefficient:generationCoefficient({type:id,template,evidence,target,special})};
  }
  if(/起草|编写|生成|制作|撰写/.test(job.prompt||'')&&!/如何|怎么|怎样/.test(job.prompt||'')){
    const text=job.prompt||'',id=/问询回复/.test(text)?'G13':/尽调|风险专题/.test(text)?'G12':/行业研究/.test(text)?'G11':/财务分析/.test(text)?'G10':/指标说明|财务数据表/.test(text)?'G09':/项目介绍|项目说明书|会议材料/.test(text)?'G08':/资料清单|信息整理|函件/.test(text)?'G07':null;
    if(id)return {type:'generation',generationType:id,template:'build_new',evidence:'source_materials',coefficient:generationCoefficient({type:id,template:'build_new',evidence:'source_materials',target,special})};
  }
  const id=classifyQA(job.prompt||'',job);return {type:'qa',qaType:id,coefficient:CREDIT_RULES.qa_types.find(x=>x.id===id).base};
}
export function priceSnapshot(settings={}){
  // Reference rates for the local demo, not a claim about today's provider tariff.
  const configured=settings.modelPrices?.[settings.model],rates=configured||{input:10,cached:1,output:30};
  if(['input','cached','output'].some(k=>!Number.isFinite(rates[k])||rates[k]<0)||rates.cached>rates.input)throw new Error('模型计量单价配置无效。');
  return {model:settings.model||'deepseek-chat',currency:'CNY',perMillion:{...rates},source:configured?'operator_configured':'demo_reference',version:settings.modelPriceVersion||'reference-10-1-30-v1'};
}
export function actualCredits(snapshot,events=[]){
  let numerator=0n,modelNumerator=0n;const ids=new Set();
  const micro=value=>BigInt(Math.round(number(value)*1e6));
  for(const e of events){
    if(!e.id||ids.has(e.id))continue;ids.add(e.id);
    if(e.billable===false||e.reused)continue;
    if(e.verified!==true)throw fault('模型用量待核对，本次暂未结算。');
    let term;
    if(e.type==='external'){
      if(!Number.isFinite(e.costCny)||e.costCny<0)throw fault('外部查询费用待核对。');
      term=micro(e.costCny)*micro(1.2)*1000000n;
    }else{
      const u=e.usage,r=snapshot.prices.perMillion;
      if(!u||['inputTokens','cachedInputTokens','outputTokens'].some(k=>!Number.isSafeInteger(u[k])||u[k]<0)||u.cachedInputTokens>u.inputTokens)throw fault('模型用量待核对，本次暂未结算。');
      const k=e.type==='parse'?parseCoefficient(e.format,e.quality):snapshot.classification.coefficient;
      term=(BigInt(u.inputTokens-u.cachedInputTokens)*micro(r.input)+BigInt(u.cachedInputTokens)*micro(r.cached)+BigInt(u.outputTokens)*micro(r.output))*micro(k);
      modelNumerator+=term;
    }
    numerator+=term;
  }
  const denominator=10000000000000000n;
  return {credits:Number((numerator+denominator-1n)/denominator),modelCredits:Number(modelNumerator/denominator),numerator:numerator.toString()};
}
export function estimateCredits(job,documents=[],settings={}){
  const classification=classifyTask(job,documents),prices=priceSnapshot(settings);
  const characters=textOf(documents).length||job.files?.reduce((n,f)=>n+Math.min(500000,f.size||f.content?.length||0),0)||0;
  const steps=job.generation?7:job.kind==='review'?Math.max(3,Math.ceil(characters/6500)*2):job.kind==='update'?Math.max(1,Math.ceil(characters/9000)):1;
  const usage={inputTokens:Math.ceil((characters/1.5+12000*steps+(job.prompt?.length||0)+number(job.historyCharacters))*1.2),cachedInputTokens:0,outputTokens:steps*(job.kind==='generate'?2500:1600)};
  const snapshot={version:CREDIT_VERSION,classification,prices,createdAt:new Date().toISOString(),estimateId:randomUUID()};
  const estimated=actualCredits(snapshot,[{id:'estimate',verified:true,type:'model',usage}]).credits;
  const externalEstimate=(job.web?4*number(settings.externalPrices?.web):0)+(job.registry?number(settings.externalPrices?.registry):0)+(job.connectorIds||[]).reduce((n,id)=>n+50*number(settings.externalPrices?.[id]),0);
  snapshot.externalPrices={...(settings.externalPrices||{})};
  snapshot.estimatedCredits=estimated+Math.ceil(externalEstimate*120);
  snapshot.riskFactor=classification.coefficient>=20||job.files?.some(f=>/\.pdf$/i.test(f.filename))?1.5:1.2;
  snapshot.reservation=classification.coefficient===0?0:Math.ceil(snapshot.estimatedCredits*snapshot.riskFactor);
  return {credits:snapshot.reservation,snapshot};
}
