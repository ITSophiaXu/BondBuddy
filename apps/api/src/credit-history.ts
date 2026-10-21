import type { Pool } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Static } from '@sinclair/typebox';
import { BILLING_TASKS, M4_BILLING_TASKS, schemas } from '@bondbuddy/contracts';
import { date, digest, Problem } from './data.js';

type Query=Static<typeof schemas.CreditHistoryQuery>;
type Position={time:string;id:string};
type Kind='consumption'|'recharge';
const invalid=()=>new Problem(422,'VALIDATION_FAILED','历史记录游标无效，请刷新记录。');
const scope=(owner:string,kind:Kind)=>digest(JSON.stringify([owner,kind]));
export function historyPosition(cursor:string|undefined,owner:string,kind:Kind):Position|null{
  if(!cursor)return null;
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(cursor)||cursor.length>1024||Buffer.from(cursor,'base64url').toString('base64url')!==cursor)throw invalid();
    const v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(!Array.isArray(v)||v.length!==4||v[0]!==1||v[1]!==scope(owner,kind)||
      typeof v[2]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v[2])||!Number.isFinite(Date.parse(v[2]))||new Date(v[2]).toISOString().slice(0,19)!==v[2].slice(0,19)||
      typeof v[3]!=='string'||!v[3]||v[3].length>128)throw invalid();
    return {time:v[2],id:v[3]};
  }catch{throw invalid();}
}
function page(rows:any[],limit:number,owner:string,kind:Kind){
  const items=rows.slice(0,limit),last=items.at(-1),more=rows.length>limit;
  return {items,page:{has_more:more,next_cursor:more?Buffer.from(JSON.stringify([1,scope(owner,kind),last.cursor_time,last.id])).toString('base64url'):null}};
}
export async function consumptionHistory(db:Pool,owner:string,query:Query){
  const limit=Number(query.limit??20),after=historyPosition(query.cursor,owner,'consumption');
  // Paginate stable creation keys before joining events. Finalization cannot move a row across pages.
  const rows=(await db.query(`WITH selected AS (
    SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1
    AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text))
    ORDER BY created_at DESC,id DESC LIMIT $4)
    SELECT c.*,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
      r.project_id,p.deleted_at,p.kind AS project_kind,
      COALESCE(i.manifest->>'name',i.manifest->>'project_name',i.manifest#>>'{assistant_context,project_name}',p.name,'项目任务') AS project_name,
      COALESCE(CASE WHEN i.manifest->>'version'='integrity-round-v1' THEN 'integrity_check' END,q.task_type,mq.task_type,CASE WHEN fq.id IS NOT NULL THEN 'project_file_update' ELSE r.task_kind END) AS task_type,
      COALESCE(e.charged,0)::text AS charged,COALESCE(e.released,0)::text AS released,COALESCE(e.corrected,0)::text AS corrected
    FROM selected c JOIN bb_runs r ON r.id=c.run_id AND r.owner_user_id=c.owner_user_id
    JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=c.owner_user_id
    LEFT JOIN bb_input_revisions i ON i.project_id=r.project_id AND i.owner_user_id=c.owner_user_id AND i.revision=r.input_revision
    LEFT JOIN bb_credit_quotes q ON q.id=c.quote_id AND q.owner_user_id=c.owner_user_id
    LEFT JOIN bb_m4_quotes mq ON mq.id=c.quote_id AND mq.owner_user_id=c.owner_user_id
    LEFT JOIN bb_project_file_update_quotes fq ON fq.id=c.quote_id AND fq.owner_user_id=c.owner_user_id
    LEFT JOIN LATERAL (SELECT sum(points) FILTER(WHERE kind='settle') AS charged,
      sum(points) FILTER(WHERE kind='release') AS released,sum(points) FILTER(WHERE kind='correction') AS corrected
      FROM bb_credit_events WHERE owner_user_id=c.owner_user_id AND reservation_id=c.id) e ON true
    ORDER BY c.created_at DESC,c.id DESC`,[owner,after?.time??null,after?.id??null,limit+1])).rows;
  const result=page(rows,limit,owner,'consumption');
  const labels:Record<string,string>={...BILLING_TASKS,...M4_BILLING_TASKS,update:'更新募集书',review:'复核募集书',generation:'文件生成',project_file_update:'更新关联文件',integrity_check:'诚信核查',qa:'项目问答'};
  return {page:result.page,items:result.items.map(r=>({reservation_id:r.id,run_id:r.run_id,
    project_id:r.deleted_at||r.project_kind==='qa'?null:r.project_id,project_name:r.deleted_at?'已删除项目':r.project_name,
    task_name:labels[r.task_type]??'项目任务',created_at:date(r.created_at),finalized_at:r.finalized_at?date(r.finalized_at):null,
    state:r.state,billing_policy:r.billing_policy,reserved_points:r.billing_policy==='authoring_balance_v2'?0:Number(r.points),charged_points:Number(r.charged),released_points:Number(r.released),corrected_points:Number(r.corrected)}))};
}
export async function rechargeHistory(db:Pool,owner:string,query:Query){
  const limit=Number(query.limit??20),after=historyPosition(query.cursor,owner,'recharge');
  const rows=(await db.query(`SELECT id,provider,state,amount_fen,points,created_at,credited_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM bb_recharge_orders WHERE owner_user_id=$1
    AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text))
    ORDER BY created_at DESC,id DESC LIMIT $4`,[owner,after?.time??null,after?.id??null,limit+1])).rows;
  const result=page(rows,limit,owner,'recharge');
  return {page:result.page,items:result.items.map(r=>({order_id:r.id,provider:r.provider,state:r.state,amount_fen:Number(r.amount_fen),points:Number(r.points),created_at:date(r.created_at),credited_at:r.credited_at?date(r.credited_at):null}))};
}
export function installCreditHistory(app:FastifyInstance,db:()=>Pool,owner:(request:FastifyRequest)=>Promise<string>){
  app.get('/api/v1/credits/consumption-history',{schema:{querystring:schemas.CreditHistoryQuery,response:{200:schemas.CreditConsumptionHistoryResponse}}},async(request,reply)=>{
    reply.header('cache-control','private, no-store');return consumptionHistory(db(),await owner(request),request.query as Query);
  });
  app.get('/api/v1/credits/recharge-history',{schema:{querystring:schemas.CreditHistoryQuery,response:{200:schemas.RechargeHistoryResponse}}},async(request,reply)=>{
    reply.header('cache-control','private, no-store');return rechargeHistory(db(),await owner(request),request.query as Query);
  });
}
