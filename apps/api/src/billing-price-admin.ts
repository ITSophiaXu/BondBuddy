import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {AUTOMATIC_TASK_TARIFF,AUTOMATIC_TASK_SKUS,billingPriceAdminSchemas,standardCostBaseFen,standardCostPoints,safeBillingNumber,
  type BillingCostVersion,type BillingCostVersionCreate,type BillingPriceVersion,type BillingPriceDraftCreate,type BillingPriceValidate,type BillingPricePublish} from '@bondbuddy/contracts';
import {billingPermissions,requireBillingPermission} from './billing-permissions.js';
import {currentAutomaticPriceVersion,loadAutomaticTaskTariff} from './automatic-tariff-repository.js';
import {date,digest,missing,Problem,transaction,uid} from './data.js';

const invalid=(message:string)=>new Problem(422,'VALIDATION_FAILED',message);
const conflict=(message:string)=>new Problem(409,'QUOTE_CHANGED',message);
const validReason=(v:string)=>typeof v==='string'&&v.trim().length>0&&v.length<=2000;
const costDto=(r:any):BillingCostVersion=>({id:r.id,checksum:r.checksum.trim(),complete:r.complete,created_at:date(r.created_at),created_by:r.created_by,change_reason:r.change_reason,rows:r.rows});
const priceDto=(r:any):BillingPriceVersion=>({id:r.id,base_cost_version:r.base_cost_version,base_cost_checksum:r.base_cost_checksum.trim(),multiplier_bps:r.multiplier_bps,
  comparison_version:r.comparison_version,change_reason:r.change_reason,state:r.state,checksum:r.checksum.trim(),validated_checksum:r.validated_checksum?.trim()??null,
  validation_checks:r.validation_checks,effective_at:r.effective_at?date(r.effective_at):null,created_at:date(r.created_at),created_by:r.created_by,
  published_at:r.published_at?date(r.published_at):null,published_by:r.published_by,rollback_of:r.rollback_of,rows:r.rows});
const contentChecksum=(r:Pick<BillingPriceVersion,'id'|'base_cost_version'|'base_cost_checksum'|'multiplier_bps'|'comparison_version'|'change_reason'|'rollback_of'|'rows'>)=>
  digest(JSON.stringify([r.id,r.base_cost_version,r.base_cost_checksum,r.multiplier_bps,r.comparison_version,r.change_reason,r.rollback_of,
    r.rows.map(x=>[x.sku,x.label,x.unit,x.planned_cost_cny,x.base_price_fen,x.previous_points,x.points,x.delta_points])]));
async function audit(c:PoolClient,actor:string,id:string,operation:string,payload:object){
  await c.query('INSERT INTO bb_billing_price_audit(id,actor,aggregate_id,operation,payload) VALUES($1,$2,$3,$4,$5)',[uid(),actor,id,operation,JSON.stringify(payload)]);
  await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'billing_price',$3,$4,$5)`,
    [uid(),actor,id,`billing_price.${operation}`,JSON.stringify(payload)]);
}
async function readable(db:Pool|PoolClient,actor:string){const permissions=await billingPermissions(db,actor);if(!permissions.has('price_draft')&&!permissions.has('price_publish'))throw missing();}
export async function listBillingCostVersions(pool:Pool,actor:string){await readable(pool,actor);return{items:(await pool.query('SELECT * FROM bb_billing_cost_versions ORDER BY created_at DESC,id DESC LIMIT 100')).rows.map(costDto)};}
export async function createBillingCostVersion(pool:Pool,actor:string,input:BillingCostVersionCreate):Promise<{cost_version:BillingCostVersion}>{
  if(typeof input.request_id!=='string'||!input.request_id.trim()||input.request_id.length>128||!validReason(input.change_reason)||!Array.isArray(input.rows)||input.rows.length!==12||new Set(input.rows.map(r=>r.sku)).size!==12)throw invalid('需要请求键、全部12项标准成本及可追溯来源。');
  let rows:BillingCostVersion['rows'];
  try{rows=AUTOMATIC_TASK_SKUS.map(sku=>{const r=input.rows.find(r=>r.sku===sku);if(!r||!validReason(r.source))throw Error('missing');
    return{sku,planned_cost_cny:r.planned_cost_cny,base_price_fen:standardCostBaseFen(r.planned_cost_cny),source:r.source.trim()};});}
  catch{throw invalid('每个标准成本必须是大于0、至多12位小数的人民币金额；来源不能为空。');}
  return transaction(pool,async c=>{
    const grant=await requireBillingPermission(c,actor,'price_draft'),id=`bb-standard-cost-${uid().replaceAll('-','')}`;
    const hash=digest(JSON.stringify([rows,input.change_reason.trim()]));
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cost-create:${actor}:${input.request_id}`]);
    const previous=(await c.query('SELECT * FROM bb_billing_cost_versions WHERE created_by=$1 AND request_id=$2',[actor,input.request_id])).rows[0];
    if(previous){if(previous.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','成本请求键已用于另一份内容。');return{cost_version:costDto(previous)};}
    const row=(await c.query(`INSERT INTO bb_billing_cost_versions(id,checksum,complete,created_by,change_reason,rows,request_id,request_hash)
      VALUES($1,encode(sha256(convert_to($2::jsonb::text,'UTF8')),'hex'),true,$3,$4,$2,$5,$6) RETURNING *`,[id,JSON.stringify(rows),actor,input.change_reason.trim(),input.request_id,hash])).rows[0];
    await audit(c,actor,id,'cost_frozen',{checksum:row.checksum,grant_id:grant});return{cost_version:costDto(row)};
  });
}
export async function createBillingPriceDraft(pool:Pool,actor:string,input:BillingPriceDraftCreate):Promise<{version:BillingPriceVersion}>{
  if(typeof input.request_id!=='string'||!input.request_id.trim()||input.request_id.length>128||!validReason(input.change_reason))throw invalid('需要请求键和价格变更原因。');
  try{standardCostPoints('1',input.multiplier_bps);}catch{throw invalid('multiplier_bps 必须是1至1000000的十进制整数字符串。');}
  return transaction(pool,async c=>{
    const grant=await requireBillingPermission(c,actor,'price_draft');
    const hash=digest(JSON.stringify([input.base_cost_version,input.multiplier_bps,input.change_reason.trim(),input.rollback_of??null]));
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`price-create:${actor}:${input.request_id}`]);
    const previous=(await c.query('SELECT * FROM bb_billing_price_drafts WHERE created_by=$1 AND request_id=$2',[actor,input.request_id])).rows[0];
    if(previous){if(previous.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','价格请求键已用于另一份内容。');return{version:priceDto(previous)};}
    const cost=(await c.query('SELECT * FROM bb_billing_cost_versions WHERE id=$1',[input.base_cost_version])).rows[0];if(!cost)throw missing();
    if(input.rollback_of){
      const previous=(await c.query("SELECT * FROM bb_billing_price_drafts WHERE id=$1 AND state='PUBLISHED'",[input.rollback_of])).rows[0];
      if(!previous||previous.base_cost_version!==cost.id||previous.multiplier_bps!==input.multiplier_bps)throw invalid('回滚必须复用目标已发布版本的成本版本和倍数，并创建新的未来版本。');
    }
    const comparison=await currentAutomaticPriceVersion(c),old=await loadAutomaticTaskTariff(c,comparison);
    const rows:BillingPriceVersion['rows']=cost.rows.map((r:BillingCostVersion['rows'][number])=>{
      const points=standardCostPoints(r.base_price_fen,input.multiplier_bps),item=AUTOMATIC_TASK_TARIFF[r.sku];
      return{sku:r.sku,label:item.label,unit:item.unit,planned_cost_cny:r.planned_cost_cny,base_price_fen:r.base_price_fen,previous_points:String(old[r.sku].points),points,delta_points:(BigInt(points)-BigInt(old[r.sku].points)).toString()};
    });
    const content={id:`bb-task-price-managed-${uid().replaceAll('-','')}`,base_cost_version:cost.id,base_cost_checksum:cost.checksum.trim(),multiplier_bps:input.multiplier_bps,
      comparison_version:comparison,change_reason:input.change_reason.trim(),rollback_of:input.rollback_of??null,rows};
    const row=(await c.query(`INSERT INTO bb_billing_price_drafts(id,base_cost_version,base_cost_checksum,multiplier_bps,comparison_version,change_reason,rollback_of,rows,checksum,created_by,request_id,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[content.id,content.base_cost_version,content.base_cost_checksum,content.multiplier_bps,content.comparison_version,content.change_reason,content.rollback_of,JSON.stringify(rows),contentChecksum(content),actor,input.request_id,hash])).rows[0];
    await audit(c,actor,row.id,'draft_created',{checksum:row.checksum,grant_id:grant});return{version:priceDto(row)};
  });
}
async function checkDraft(c:PoolClient,row:BillingPriceVersion){
  const cost=(await c.query('SELECT * FROM bb_billing_cost_versions WHERE id=$1',[row.base_cost_version])).rows[0];
  const checks:BillingPriceVersion['validation_checks']=[];
  const check=(code:string,passed:boolean,message:string)=>checks.push({code,passed,message});
  check('complete_cost_source',!!cost?.complete&&cost.rows.every((r:any)=>r.planned_cost_cny!==null),'发布需要12项完整精度标准成本及冻结来源；旧11项缺源基准只可比价。');
  check('frozen_cost_checksum',cost?.checksum.trim()===row.base_cost_checksum,'成本版本及来源不可覆写。');
  check('twelve_skus',row.rows.length===12&&new Set(row.rows.map(r=>r.sku)).size===12&&AUTOMATIC_TASK_SKUS.every(s=>row.rows.some(r=>r.sku===s)),'需覆盖全部12项SKU，无缺项、重复项。');
  let arithmetic=true;
  try{arithmetic=row.rows.every(r=>{const source=cost.rows.find((x:any)=>x.sku===r.sku);return source&&source.planned_cost_cny===r.planned_cost_cny&&source.base_price_fen===r.base_price_fen&&
    r.planned_cost_cny!==null&&standardCostBaseFen(r.planned_cost_cny)===r.base_price_fen&&standardCostPoints(r.base_price_fen,row.multiplier_bps)===r.points;});}catch{arithmetic=false;}
  check('two_independent_ceil',arithmetic,'从C_plan向上取整得到1倍基准，再独立按multiplier_bps向上取整，禁止沿上版售价连续乘倍数。');
  check('runtime_amount_bounds',row.rows.every(r=>BigInt(r.points)>0n&&BigInt(r.points)<=100000000n&&BigInt(r.points)*(r.sku==='response'?200n:r.sku==='check'?100n:1n)<=999999999n),'单价及最大标准批次必须在现有任务协议范围：单价最高100000000、批次总额最高999999999积分。');
  check('units_and_checksum',contentChecksum(row)===row.checksum&&row.rows.every(r=>r.label===AUTOMATIC_TASK_TARIFF[r.sku]?.label&&r.unit===AUTOMATIC_TASK_TARIFF[r.sku]?.unit),'价格单位和完整差异内容必须与冻结checksum一致。');
  check('old_contracts_immutable',true,'新版本只用于生效后的新合同；未过期旧报价、已付周期与批次持续锁定旧版。');
  return checks;
}
export async function validateBillingPriceDraft(pool:Pool,actor:string,id:string,input:BillingPriceValidate):Promise<{version:BillingPriceVersion}>{
  return transaction(pool,async c=>{
    const grant=await requireBillingPermission(c,actor,'price_draft'),raw=(await c.query('SELECT * FROM bb_billing_price_drafts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!raw)throw missing();
    const row=priceDto(raw);if(row.state!=='DRAFT'||row.checksum!==input.expected_checksum)throw conflict('草稿状态或校验和已变化，请重新读取。');
    const checks=await checkDraft(c,row),passed=checks.every(c=>c.passed);
    const updated=(await c.query('UPDATE bb_billing_price_drafts SET validation_checks=$2,validated_checksum=$3 WHERE id=$1 RETURNING *',[id,JSON.stringify(checks),passed?row.checksum:null])).rows[0];
    await audit(c,actor,id,'validated',{checksum:row.checksum,passed,checks,grant_id:grant});return{version:priceDto(updated)};
  });
}
export async function publishBillingPriceVersion(pool:Pool,actor:string,id:string,input:BillingPricePublish):Promise<{version:BillingPriceVersion}>{
  if(!Number.isFinite(Date.parse(input.effective_at)))throw invalid('需要明确的未来生效时间。');
  return transaction(pool,async c=>{
    const grant=await requireBillingPermission(c,actor,'price_publish');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bb-managed-task-prices',0))");
    const raw=(await c.query('SELECT * FROM bb_billing_price_drafts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!raw)throw missing();const row=priceDto(raw);
    if(row.checksum!==input.expected_checksum)throw conflict('价格内容已变化，不能发布。');
    if(row.state==='PUBLISHED'){
      if(row.effective_at!==date(input.effective_at))throw conflict('已发布版本不可修改；回滚或改期需新建未来版本。');return{version:row};
    }
    const checks=await checkDraft(c,row);
    if(row.validated_checksum!==row.checksum||!checks.every(c=>c.passed))throw conflict('价格必须完成全部校验，且校验后内容保持不变。');
    if(!(await c.query('SELECT $1::timestamptz>clock_timestamp() valid',[input.effective_at])).rows[0].valid)throw invalid('生效时间必须在未来，不能追溯改价。');
    if((await c.query('SELECT 1 FROM bb_credit_price_versions WHERE effective_at=$1',[input.effective_at])).rowCount)throw conflict('该生效时间已有价格版本，请选择其他时间。');
    const p=Object.fromEntries(row.rows.map(r=>[r.sku,safeBillingNumber(r.points,100000000)]));
    const prices={interim:p.quarter,annual:p.annual,two_years:p.two_year,three_years:p.three_year,migration:p.migration,migration_two_years:p.migration,migration_three_years:p.migration,
      new_authoring:p.new,full_review:p.full_review,differential_review:14900,review_revision:14900};
    await c.query(`INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode) VALUES($1,$2,$3,$4,$5,'outcome_cny_v1')`,[id,JSON.stringify(prices),input.effective_at,actor,row.change_reason]);
    const result=(await c.query(`UPDATE bb_billing_price_drafts SET state='PUBLISHED',effective_at=$2,published_at=clock_timestamp(),published_by=$3,publish_grant_id=$4 WHERE id=$1 RETURNING *`,[id,input.effective_at,actor,grant])).rows[0];
    await audit(c,actor,id,'published',{checksum:row.checksum,effective_at:date(input.effective_at),grant_id:grant,rollback_of:row.rollback_of});return{version:priceDto(result)};
  });
}
export async function readBillingPriceVersion(pool:Pool,actor:string,id:string){await readable(pool,actor);const row=(await pool.query('SELECT * FROM bb_billing_price_drafts WHERE id=$1',[id])).rows[0];if(!row)throw missing();return{version:priceDto(row)};}
export async function listBillingPriceVersions(pool:Pool,actor:string){await readable(pool,actor);return{current_version:await currentAutomaticPriceVersion(pool),items:(await pool.query('SELECT * FROM bb_billing_price_drafts ORDER BY created_at DESC,id DESC LIMIT 100')).rows.map(priceDto)};}
export function installBillingPriceAdmin(app:FastifyInstance,pool:()=>Pool,owner:(request:FastifyRequest)=>Promise<string>){
  const s=billingPriceAdminSchemas,base='/api/v1/admin/price-versions',cost='/api/v1/admin/cost-versions',id=(r:FastifyRequest)=>(r.params as {id:string}).id;
  const exactWire=async(r:FastifyRequest)=>{const b=r.body as any;if(b&&('multiplier_bps' in b&&typeof b.multiplier_bps!=='string'||Array.isArray(b.rows)&&b.rows.some((x:any)=>typeof x?.planned_cost_cny!=='string')))throw invalid('金额、成本和倍数必须使用十进制字符串，不能使用JSON数值。');};
  app.get(cost,{schema:{response:{200:s.BillingCostVersionsResponse}}},async(r,reply)=>{const user=await owner(r);reply.header('cache-control','private, no-store');return listBillingCostVersions(pool(),user);});
  app.post(cost,{preValidation:exactWire,schema:{body:s.BillingCostVersionCreateRequest,response:{201:s.BillingCostVersionResponse}}},async(r,reply)=>{const user=await owner(r);return reply.code(201).send(await createBillingCostVersion(pool(),user,r.body as BillingCostVersionCreate));});
  app.get(base,{schema:{response:{200:s.BillingPriceVersionsResponse}}},async(r,reply)=>{const user=await owner(r);reply.header('cache-control','private, no-store');return listBillingPriceVersions(pool(),user);});
  app.get(base+'/:id',{schema:{response:{200:s.BillingPriceVersionResponse}}},async(r,reply)=>{const user=await owner(r);reply.header('cache-control','private, no-store');return readBillingPriceVersion(pool(),user,id(r));});
  app.post(base,{preValidation:exactWire,schema:{body:s.BillingPriceDraftCreateRequest,response:{201:s.BillingPriceVersionResponse}}},async(r,reply)=>{const user=await owner(r);return reply.code(201).send(await createBillingPriceDraft(pool(),user,r.body as BillingPriceDraftCreate));});
  app.post(base+'/:id/validate',{schema:{body:s.BillingPriceValidateRequest,response:{200:s.BillingPriceVersionResponse}}},async r=>{const user=await owner(r);return validateBillingPriceDraft(pool(),user,id(r),r.body as BillingPriceValidate);});
  app.post(base+'/:id/publish',{schema:{body:s.BillingPricePublishRequest,response:{200:s.BillingPriceVersionResponse}}},async r=>{const user=await owner(r);return publishBillingPriceVersion(pool(),user,id(r),r.body as BillingPricePublish);});
}
