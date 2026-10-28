import type {Pool,PoolClient} from 'pg';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Value} from '@sinclair/typebox/value';
import {OUTCOME_PRICE_VERSION,ScopeLineSchema,type ScopeLine,type CommercePriceMetadata} from '@bondbuddy/contracts';
import {digest,missing,Problem,project,transaction,uid} from './data.js';

export type ScopePrice={scope_quote_id:string;quote_status:'pending_scope'|'ready';amount_fen:number;scope_lines:ScopeLine[];price_version:typeof OUTCOME_PRICE_VERSION};
const dto=(r:any):ScopePrice=>({scope_quote_id:r.id,quote_status:r.status==='quoted'?'ready':'pending_scope',amount_fen:Number(r.amount_fen??0),scope_lines:r.lines??[],price_version:OUTCOME_PRICE_VERSION});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function scopePriceMetadata(price:ScopePrice):CommercePriceMetadata{return{pricing_mode:'outcome_cny_v1',currency:'CNY',amount_fen:price.amount_fen,scope_quote_id:price.scope_quote_id,quote_status:price.quote_status,scope_lines:price.scope_lines};}
/** Hash only work scope. Never include a price, quotation id, timestamps or model retry count. */
export const workScopeHash=(snapshot:unknown)=>digest(canonical(snapshot));
export async function resolveApprovedScope(c:PoolClient,owner:string,projectId:string,action:string,inputHash:string):Promise<ScopePrice|null>{
  const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND project_id=$2 AND action=$3 AND input_hash=$4',[owner,projectId,action,inputHash])).rows[0];return row?dto(row):null;
}
/** Called only by trusted workflow quote preparation with its exact immutable scope snapshot. */
export async function requestScope(c:PoolClient,owner:string,projectId:string,action:string,inputHash:string,snapshot:unknown):Promise<ScopePrice>{
  if(!/^[a-f0-9]{64}$/.test(inputHash)||!/^[a-z][a-z0-9_]{0,63}$/.test(action))throw new Problem(422,'VALIDATION_FAILED','Invalid work scope');
  await project(c,owner,projectId);
  const inserted=(await c.query(`INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_user_id,project_id,action,input_hash) DO NOTHING RETURNING *`,[uid(),owner,projectId,action,inputHash,snapshot])).rows[0];
  const row=inserted??(await c.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 AND project_id=$2 AND action=$3 AND input_hash=$4',[owner,projectId,action,inputHash])).rows[0];
  if(inserted)await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'commerce.scope_requested',$4)",[uid(),owner,projectId,{scope_quote_id:row.id,action,input_hash:inputHash}]);
  return dto(row);
}
export async function assertScopeQuote(c:PoolClient,id:string|undefined,owner:string,projectId:string,action:string,inputHash:string,amountFen:number):Promise<ScopePrice>{
  if(!id)throw new Problem(409,'QUOTE_REQUIRED','请先获取本次实际处理范围的报价。');
  const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 AND action=$4 AND input_hash=$5',[id,owner,projectId,action,inputHash])).rows[0];
  if(!row||row.status!=='quoted'||Number(row.amount_fen)!==amountFen)throw new Problem(409,'QUOTE_CHANGED','本次范围报价尚未确认或材料与范围已经变化，请重新获取报价。');return dto(row);
}
export function validateScopeLines(lines:unknown):{lines:ScopeLine[];total:number}{
  if(!Array.isArray(lines)||!lines.length||lines.length>200||lines.some(l=>!Value.Check(ScopeLineSchema,l)))throw new Problem(422,'VALIDATION_FAILED','Work items with scope evidence are required');
  const keys=new Set<string>();let total=0;
  for(const l of lines as ScopeLine[]){if(keys.has(l.key)||!l.label.trim()||!l.unit.trim()||l.evidence.some(x=>!x.trim())||!Number.isSafeInteger(l.quantity*l.unit_price_fen)||l.amount_fen!==l.quantity*l.unit_price_fen)throw new Problem(422,'VALIDATION_FAILED','Work items must be unique and amounts must match quantity × unit price');keys.add(l.key);total+=l.amount_fen;}
  if(!Number.isSafeInteger(total)||total<1||total>100000000)throw new Problem(422,'VALIDATION_FAILED','Scope total is outside the supported range');return{lines:lines as ScopeLine[],total};
}
/** Trusted operations command. No browser endpoint can approve or change a price. */
export async function publishScopeQuote(pool:Pool,input:{id:string;expected_input_hash:string;lines:unknown;actor:string;reason:string}){
  const {lines,total}=validateScopeLines(input.lines);
  if(!input.actor?.trim()||!input.reason?.trim()||input.actor.length>200||input.reason.length>2000)throw new Problem(422,'VALIDATION_FAILED','Reviewer and scope pricing explanation required');
  return transaction(pool,async c=>{
    const row=(await c.query('SELECT * FROM bb_scope_quotations WHERE id=$1 FOR UPDATE',[input.id])).rows[0];if(!row)throw missing();
    if(row.input_hash.trim()!==input.expected_input_hash)throw new Problem(409,'INPUT_REVISION_CONFLICT','Review the exact requested input snapshot before quoting');
    if(row.status==='quoted'){
      if(canonical(row.lines)!==canonical(lines)||Number(row.amount_fen)!==total||row.reason!==input.reason||row.approved_by!==input.actor)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Published scope price is immutable');return dto(row);
    }
    const saved=(await c.query("UPDATE bb_scope_quotations SET status='quoted',lines=$2,amount_fen=$3,approved_by=$4,reason=$5,published_at=now() WHERE id=$1 RETURNING *",[input.id,JSON.stringify(lines),total,input.actor,input.reason])).rows[0];
    await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'commerce.scope_quoted',$4)",[uid(),row.owner_user_id,row.project_id,{scope_quote_id:row.id,input_hash:row.input_hash.trim(),amount_fen:total}]);
    return dto(saved);
  });
}
export async function readScopeQuotations(db:Pool,owner:string){
  const rows=(await db.query('SELECT * FROM bb_scope_quotations WHERE owner_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[owner])).rows;
  return{items:rows.map(r=>({id:r.id,project_id:r.project_id,action:r.action,input_hash:r.input_hash.trim(),quote_status:dto(r).quote_status,amount_fen:Number(r.amount_fen??0),scope_lines:r.lines??[],reason:r.reason,created_at:new Date(r.created_at).toISOString(),published_at:r.published_at?new Date(r.published_at).toISOString():null}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
  const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    const [command,file]=process.argv.slice(2);
    if(command==='publish'&&file)process.stdout.write(JSON.stringify(await publishScopeQuote(pool,JSON.parse(readFileSync(file,'utf8'))))+'\n');
    else if(command==='inspect'&&file){const row=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[file])).rows[0];if(!row)throw missing();process.stdout.write(JSON.stringify(row,null,2)+'\n');}
    else throw Error('Use inspect QUOTATION_ID or publish FILE. Inspect outputs private task scope; keep it in the authorised operational environment.');
  }finally{await pool.end();}
}
