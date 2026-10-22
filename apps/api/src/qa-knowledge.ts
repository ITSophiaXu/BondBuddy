import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {qaSchemas,qaSearchTerms,type QaCase} from '@bondbuddy/contracts';
import {Problem,transaction,uid,conflict,date} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
const dto=(r:any):QaCase=>({id:r.id,revision:r.revision,content:r.content,sha256:r.sha256.trim(),status:r.status,review_note:r.review_note,created_at:date(r.created_at)});
export async function qaCaseSearch(db:Pool|PoolClient,query:string,limit=8):Promise<QaCase[]>{
 const terms=qaSearchTerms(query);if(!terms.length)return [];
 return (await db.query(`SELECT * FROM bb_qa_cases WHERE status='approved' AND search_terms && $1::text[]
 ORDER BY (SELECT count(*) FROM unnest(search_terms) t WHERE t=ANY($1::text[])) DESC,created_at DESC,id LIMIT $2`,[terms,limit])).rows.map(dto);
}
async function reviewer(db:Pool|PoolClient,user:string){return !!(await db.query('SELECT 1 FROM bb_qa_case_reviewers WHERE user_id=$1',[user])).rowCount;}
async function list(db:Pool,user:string,q=''){
 const can_review=await reviewer(db,user),terms=qaSearchTerms(q);
 const rows=(await db.query(`SELECT * FROM bb_qa_cases WHERE (status='approved' OR owner_user_id=$1 OR $2::boolean)
 AND (cardinality($3::text[])=0 OR search_terms && $3::text[]) ORDER BY created_at DESC,id LIMIT 100`,[user,can_review,terms])).rows;
 return {cases:rows.map(dto),can_review};
}
export function registerQaKnowledge(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
 app.get('/api/v1/qa/cases',{schema:{querystring:qaSchemas.QaCaseQuery,response:{200:qaSchemas.QaCasesResponse}}},async r=>list(db(),await owner(r),(r.query as {q?:string}).q));
 app.post('/api/v1/qa/cases',{schema:{body:qaSchemas.QaCaseCreateRequest,response:{200:qaSchemas.QaCasesResponse}}},async r=>{
  const user=await owner(r),b=r.body as Static<typeof qaSchemas.QaCaseCreateRequest>;
  let url:URL;try{url=new URL(b.content.url);}catch{throw new Problem(422,'VALIDATION_FAILED','请提供公开来源网址。');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!url.hostname||/^(localhost|127\.|10\.|192\.168\.|\[)/i.test(url.hostname))throw new Problem(422,'VALIDATION_FAILED','请使用公开来源的 HTTP / HTTPS 网址。');
  if(Object.entries(b.content).some(([k,v])=>k!=='evidence_requirements'&&!v.trim()))throw new Problem(422,'VALIDATION_FAILED','请填写来源、问题、公开回复和回答思路。');
  await transaction(db(),async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':qa-case:'+b.request_id]);
   const hash=inputManifestHash(b.content),old=(await c.query('SELECT sha256 FROM bb_qa_cases WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
   if(old){if(old.sha256.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','请求已用于其他案例。');return;}
   const id=uid();
   await c.query('INSERT INTO bb_qa_cases(id,owner_user_id,request_id,content,sha256,search_terms) VALUES($1,$2,$3,$4,$5,$6)',[id,user,b.request_id,b.content,hash,qaSearchTerms(Object.values(b.content).join(' '))]);
   await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'qa_case',$3,'qa_case.submitted',$4)",[uid(),user,id,{revision:1,sha256:hash}]);
  });return list(db(),user);
 });
 app.post('/api/v1/qa/cases/:case_id/review',{schema:{body:qaSchemas.QaCaseReviewRequest,response:{200:qaSchemas.QaCasesResponse}}},async r=>{
  const user=await owner(r),id=(r.params as {case_id:string}).case_id,b=r.body as Static<typeof qaSchemas.QaCaseReviewRequest>;
  await transaction(db(),async c=>{if(!await reviewer(c,user))throw new Problem(403,'DATA_NOT_ENTITLED','需要知识库审核权限。');
   const old=(await c.query('SELECT * FROM bb_qa_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw new Problem(404,'NOT_FOUND','案例不存在。');
   if(old.revision!==b.expected_revision)throw conflict('INPUT_REVISION_CONFLICT','审核状态已变化，请刷新。');
   if(!b.review_note.trim())throw new Problem(422,'VALIDATION_FAILED','请记录来源核对及适用范围。');
   await c.query('UPDATE bb_qa_cases SET status=$2,revision=revision+1,review_note=$3 WHERE id=$1',[id,b.status,b.review_note]);
   await c.query('INSERT INTO bb_qa_case_reviews(id,case_id,reviewer_user_id,revision,status,note) VALUES($1,$2,$3,$4,$5,$6)',[uid(),id,user,old.revision+1,b.status,b.review_note]);
   await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'qa_case',$3,'qa_case.reviewed',$4)",[uid(),old.owner_user_id,id,{revision:old.revision+1,status:b.status,reviewer:user}]);
  });return list(db(),user);
 });
}
