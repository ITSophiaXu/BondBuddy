import type {PoolClient} from 'pg';
import {AUTOMATIC_PRICE_VERSION,automaticTaskTariff,isAutomaticPriceVersion,type AutomaticPriceVersion,type AutomaticTaskSku,type AutomaticTaskTariff,type ScopeLine} from '@bondbuddy/contracts';
import {classifyFixedPrice} from './billing-classification.js';
import {Problem} from './data.js';

export type AutomaticPrice={version:AutomaticPriceVersion;sku:AutomaticTaskSku|'differential_review'|'review_revision';lines:ScopeLine[];points:number;source_quote_ids:string[]};
const unsupported=(message:string):never=>{throw new Problem(422,'SCOPE_UNSUPPORTED',message);};
/** Only trusted, owned workflow snapshots enter here. It does not interpret prices supplied by a user or a model. */
export function resolveAutomaticTaskPrice(action:string,snapshot:any,version:AutomaticPriceVersion=AUTOMATIC_PRICE_VERSION,tariff:AutomaticTaskTariff=automaticTaskTariff(version)):AutomaticPrice{
  if(!isAutomaticPriceVersion(version))return unsupported('当前任务价格版本不受支持。');
  let sku:AutomaticPrice['sku'],units:{id:string;label?:string}[]=[{id:action}],sources:string[]=[],override:number|undefined;
  if(!snapshot||typeof snapshot!=='object')return unsupported('任务范围缺失，请补充业务目标。');
  if(action==='authoring'){
    const classification=classifyFixedPrice(snapshot);
    if(!classification.task)return unsupported(classification.reason);
    if((classification.annualPeriods??0)>3)return unsupported('超过三个年度的补更暂不属于标准范围，请调整本次目标期间。');
    const mapping:Record<string,AutomaticTaskSku>={interim:'quarter',annual:'annual',two_years:'two_year',three_years:'three_year',migration:'migration',migration_two_years:'migration',migration_three_years:'migration',new_authoring:'new'};
    sku=mapping[classification.task];if(!sku)return unsupported('当前编制类型尚未配置标准范围。');
    if((snapshot.materials?.length??0)>100)return unsupported('本次材料超过100份，请明确与本次成果直接相关的材料。');
  }else if(action==='project_qa_answer'){
    sku='response';const questions=snapshot.questions;
    if(!Array.isArray(questions)||questions.length<1||questions.length>200)return unsupported('请提供1至200个独立问题。');
    if(new Set(questions.map(q=>q.id)).size!==questions.length||questions.some(q=>!q.id||typeof q.question!=='string'||q.question.length>16000))return unsupported('问题清单或独立问题范围无效。');
    units=questions.map(q=>({id:q.id,label:'问题回复'}));
  }else if(action==='m4_qa'){
    sku='response';if(typeof snapshot.content!=='string'||!snapshot.content.trim()||snapshot.content.length>16000)return unsupported('请提供一个明确的问题或使用问题清单批量回复。');
    const numbered=snapshot.content.match(/(?:^|\n)\s*(?:\d+[.、)）]|[（(]\d+[)）]|问题\s*\d+)/g)??[];
    const clauses=snapshot.content.split(/[，,；;\n]|(?=(?:并|另外|同时|另行)(?:请你|请|帮我)?(?:说明|解释|回答|回复|分析|核对|计算|比较|对比))/);
    const separateQuestions=clauses.filter((raw:string)=>{
      const clause=raw.trim(),request=/^(?:(?:并|另外|同时|另行)\s*)?(?:请你|请|帮我)?(?:说明|解释|回答|回复|总结|归纳|概括|列出|写出|分析|核对|计算|比较|对比)(.+)$/.exec(clause);
      if(!request)return /[^\s]{1,40}(?:为什么|为何)[^\s]+/.test(clause);
      // Evidence, citations, methods and arithmetic supporting the same answer
      // remain included. Count only separately requested substantive subjects.
      const subject=request[1].trim();
      return !/^(?:其|该题|上述|本题|相关|所用|具体|详细|相应)?(?:依据|证据|出处|引用|来源|计算方法|计算公式|公式|口径|步骤|差额|数据来源|财务数据|数据|该问题|该问询|问题|问询)(?:[。.!！?？]|$|和|及)/.test(subject)
        && !/^(?:如何|怎么|怎样).*(?:上传|下载|查看积分|查看余额|任务进度|任务状态)/.test(subject);
    });
    if(numbered.length>1||separateQuestions.length>1||(snapshot.content.match(/[?？]/g)??[]).length>1)return unsupported('该输入包含多项提问，请使用问题清单逐题回复，系统会按实际题数处理。');
  }else if(action==='m4_document'){
    if(snapshot.kind!=='document'||!snapshot.input)return unsupported('请选择本次独立生成的文件。');
    sku=snapshot.billing_task==='m4_workpaper'||snapshot.input.workpaper?'workpaper':'related';
  }else if(action==='integrity_round'){
    sku='integrity';const d=snapshot.draft;
    if(!d||!Array.isArray(d.subjects)||!Array.isArray(d.site_ids)||d.subjects.length<1||d.subjects.length>5)return unsupported('每轮诚信核查支持1至5个主体，请核对本轮名单。');
    if(!d.site_ids.length)return unsupported('请至少选择一个核查网站。');
    // The integrity workflow validates the website catalogue; pricing includes the full selected scope in one round.
    if(new Set(d.subjects.map((s:any)=>s.id)).size!==d.subjects.length||new Set(d.site_ids).size!==d.site_ids.length)return unsupported('核查主体或网站重复。');
  }else if(action==='project_file_check'){
    sku='check';const files=snapshot.manifest?.files,charged=snapshot.charged_file_versions;
    if(!Array.isArray(files)||!files.length||files.length>100||!Array.isArray(charged))return unsupported('请明确本次检查的文件清单，单批至多100份。');
    if(new Set(files.map((f:any)=>f.file_version_id)).size!==files.length||charged.some((id:unknown)=>!files.some((f:any)=>f.file_version_id===id)))return unsupported('检查文件清单与版本不一致。');
    units=files.filter((f:any)=>charged.includes(f.file_version_id)).map((f:any)=>({id:f.file_version_id,label:`一致性检查与维护：${f.filename}`.slice(0,200)}));
    sources=(snapshot.paid_checks??[]).map((p:any)=>p.quote_id);
    if(!units.length){if(!sources.length)return unsupported('已付检查凭据缺失。');units=[{id:'included-check',label:'复用已付检查'}];override=0;}
  }else if(action==='project_file_patch'){
    sku='check';if(!snapshot.manifest?.file_version_id)return unsupported('需要锁定修订目标文件版本。');
    units=[{id:snapshot.manifest.file_version_id,label:'同轮一致性修订'}];
    if(snapshot.paid_check){
      sources=[snapshot.paid_check.quote_id];
      // A new maintenance round includes repair. Older paid checks retain their original upgrade price.
      override=isAutomaticPriceVersion(snapshot.paid_check.price_version)?0:1000;
    }
  }else if(action==='review'){
    // Full review is a distinct deliverable; separately commissioned follow-up operations keep their original price.
    if(snapshot.task==='full_review')sku='full_review';
    else if(snapshot.task==='differential_review'||snapshot.task==='review_revision')sku=snapshot.task;
    else return unsupported('请选择独立全面复核、差异复核或复核后原文修订。');
  }else return unsupported('当前业务操作尚未配置自动计费范围。');
  const entry=sku==='differential_review'?{points:14900,label:'差异复核',unit:'次'}:sku==='review_revision'?{points:14900,label:'复核后原文修订',unit:'次'}:tariff[sku];
  const lines=units.map(({id,label})=>({key:id,label:label??entry.label,quantity:1,unit:entry.unit,unit_price_fen:override??entry.points,amount_fen:override??entry.points,evidence:[`服务端已锁定${action}的材料、目标和成果范围；必要修复包含在原任务内。`]}));
  const points=lines.reduce((s,l)=>s+l.amount_fen,0);
  if(!Number.isSafeInteger(points)||points>999999999)return unsupported('本批次超出当前计费执行范围，请缩小本次独立任务范围。');
  return{version,sku,lines,points,source_quote_ids:[...new Set(sources)]};
}

/** Paid coverage is rechecked at execution, including quality reversals; snapshot IDs are never proof by themselves. */
export async function assertAutomaticPriceSources(c:PoolClient,owner:string,price:AutomaticPrice,snapshot?:any){
  if(price.source_quote_ids.length&&snapshot?.manifest?.source){
    const {paidFileCheckEvidence}=await import('./project-file-billing.js');
    const current=await paidFileCheckEvidence(c,owner,snapshot.manifest.source),allowed=new Set(price.source_quote_ids);
    const required:string[]=snapshot.manifest.file_version_id?[snapshot.manifest.file_version_id]:
      (snapshot.manifest.files??[]).filter((f:any)=>!(snapshot.charged_file_versions??[]).includes(f.file_version_id)).map((f:any)=>f.file_version_id);
    if(required.some(file=>!current.some(p=>allowed.has(p.quote_id)&&p.charged_file_versions.includes(file))))throw new Problem(409,'QUOTE_CHANGED','本次复用的检查项目已退回，请刷新当前任务。');
    return;
  }
  for(const id of price.source_quote_ids){
    const paid=(await c.query(`SELECT 1 FROM bb_project_file_check_quotes q
      JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id
      JOIN bb_credit_reservations h ON h.run_id=r.id AND h.owner_user_id=r.owner_user_id AND h.quote_id=q.id
      WHERE q.owner_user_id=$1 AND q.id=$2 AND r.state='succeeded' AND h.state='settled' AND h.charged_points=q.points
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(q.charged_file_versions) f(value) WHERE bb_task_item_was_refunded(q.owner_user_id,q.run_id,f.value))`,[owner,id])).rowCount;
    if(!paid)throw new Problem(409,'QUOTE_CHANGED','原检查权益已退回或不可用，请刷新当前任务。');
  }
}

export async function assertAutomaticScopeAvailable(c:PoolClient,owner:string,scopeId:string,runId?:string){
  const busy=(await c.query(`SELECT a.run_id FROM bb_automatic_scope_runs a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
    LEFT JOIN bb_credit_reservations h ON h.id=r.reservation_id AND h.owner_user_id=r.owner_user_id
    WHERE a.owner_user_id=$1 AND a.scope_quote_id=$2 AND ($3::text IS NULL OR a.run_id<>$3)
    AND (r.state NOT IN ('failed','cancelled','rejected') OR (r.reservation_id IS NOT NULL AND h.state IS DISTINCT FROM 'released')) LIMIT 1`,[owner,scopeId,runId??null])).rows[0];
  if(busy)throw new Problem(409,'IDEMPOTENCY_CONFLICT',`相同范围已有任务 ${busy.run_id}，请查看原任务及成果；不会重复扣费。`);
}
export async function bindAutomaticScopeRun(c:PoolClient,owner:string,scope:any,runId:string){
  if((await c.query('SELECT 1 FROM bb_automatic_scope_runs WHERE owner_user_id=$1 AND scope_quote_id=$2 AND run_id=$3',[owner,scope.id,runId])).rowCount)return;
  await assertAutomaticScopeAvailable(c,owner,scope.id,runId);
  await assertAutomaticPriceSources(c,owner,scope.automatic_price,scope.snapshot);
  await c.query('INSERT INTO bb_automatic_scope_runs(owner_user_id,scope_quote_id,run_id) VALUES($1,$2,$3)',[owner,scope.id,runId]);
}
