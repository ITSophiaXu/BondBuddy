import { randomUUID, createHash } from 'node:crypto';

export const ESTIMATE_POLICY='2026-09-workload-v2';
export function estimateWork(context,documents,kind='update'){
  const main=documents.find(d=>d.role===(kind==='review'?'updated':'historical'));
  const own=documents.filter(d=>!['reference','userReference'].includes(d.role));
  const chars=own.reduce((n,d)=>n+d.records.reduce((sum,r)=>sum+r.text.length,0),0);
  const types=new Set(own.map(d=>d.role)).size;
  const reasons=[];
  const add=(label,points,detail)=>reasons.push({label,points,detail});
  add(kind==='review'?'全文复核':'项目整理与全文更新',kind==='review'?1:2,`${own.length} 份材料，约 ${Math.ceil(chars/1000)} 千字可解析内容`);
  if(kind==='update'){
    if(context.authoringMode==='reference')add('无历史稿的完整编制',3,'建立章节、组织披露内容并核对项目事实');
    const source=context.sourceScope;
    if(main&&source&&source!==context.scope)add('跨发行品种与披露结构调整',2,'发行条款、章节结构、投资者保护及披露口径联动调整');
    else if(main&&!source)add('原稿品种待确认',1,'按需核对原稿市场与发行条款，覆盖可能的结构调整');
    const financial=own.filter(d=>['audit','financial','interimFinancial','notes','accountDetails'].includes(d.role)&&d.records.length);
    if(financial.length){
      const years=new Set(financial.flatMap(d=>d.records.flatMap(r=>[...r.text.matchAll(/\b(20\d{2})(?=\s*年|[-/.]\d{1,2})/g)].map(m=>m[1]))));
      const count=Math.min(10,Math.max(1,years.size));
      add('财务资料与报告期核对',count,years.size?`已解析财务材料涉及 ${years.size} 个年度，结合本次财务截止日核对更新`:'已提供财务材料，暂按 1 个年度口径核对；具体期间结合正文确认');
    }else add('财务资料待补充',0,'未提供独立财务材料；全文仍会核对原稿日期与口径，缺少的更新依据列为待补充');
    if(/品种[二三四五六七八九]|第二|第三|两个品种|多品种|分档|分期/.test(context.trancheTerms||''))add('多品种条款联动',1,'核对各品种规模、期限、含权安排与相关章节');
  }
  if(chars>60000)add('材料阅读量',Math.ceil((chars-60000)/60000),`按已解析全文长度计算，约 ${Math.ceil(chars/1000)} 千字`);
  if(types>4)add('跨材料核对',Math.ceil((types-4)/3),`${types} 类材料需要交叉核对`);
  return {id:randomUUID(),policy:ESTIMATE_POLICY,points:reasons.reduce((n,r)=>n+r.points,0),reasons,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+24*3600000).toISOString(),materialCount:own.length,characterCount:chars};
}
export function assessmentDigest(context,files){return createHash('sha256').update(JSON.stringify({context,files:files.map(f=>({role:f.role,filename:f.filename,sha256:f.sha256}))})).digest('hex');}
export function normaliseWork(fields){
  const registrationMode=fields.registrationMode||'';if(!['','standard','dfi'].includes(registrationMode))throw new Error('注册模式无效。');
  let messages=[];try{messages=typeof fields.projectMessages==='string'?JSON.parse(fields.projectMessages):fields.projectMessages||[];}catch{throw new Error('项目补充说明格式无效。');}
  if(!Array.isArray(messages)||messages.length>50||messages.some(m=>typeof m.text!=='string'||m.text.length>3000))throw new Error('项目补充说明最多50条，每条不超过3000字。');
  // Legacy form controls must not constrain a newly created or reassessed project.
  // Source instrument and financial workload are inferred from uploaded materials.
  return {updateMode:'full',registrationMode,projectMessages:messages.map(m=>({text:m.text.trim()})).filter(m=>m.text)};
}
