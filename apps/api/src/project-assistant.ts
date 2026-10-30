import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AssistantCardRequestSchema, isUnifiedInput, type AssistantCardRequest, type AssistantCard, type AssistantResult } from '@bondbuddy/contracts';
import { project,projectDto,materialDto,runDto,transaction,date,executionKeyStorage,Problem,missing,conflict,uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { creditBalanceExact,quoteDto } from './billing.js';
import { m4QuoteDto } from './m4-billing.js';
import { draft as reviewDraft } from './review-workspace.js';

type Db=Pool|PoolClient;
const param=(r:FastifyRequest,k:string)=>(r.params as Record<string,string>)[k];
async function topic(db:Db,user:string,id:string){
  const t=(await db.query("SELECT * FROM bb_m4_topics WHERE owner_user_id=$1 AND id=$2 AND surface='assistant'",[user,id])).rows[0];
  if(!t)throw missing();await project(db,user,t.project_id);return t;
}
async function cardDto(db:Db,user:string,row:any):Promise<AssistantCard>{
  await project(db,user,row.project_id);
  const run=(await db.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND execution_request_id=$3',
    [user,row.project_id,executionKeyStorage(row.execution_request_id)])).rows[0];
  // The immutable request key is reused by the existing executor. A lost HTTP
  // response is recovered here, without a second execution or linking mutation.
  return {...row.request,...row.summary,created_at:date(row.created_at),balance:await creditBalanceExact(db,user),run:run && (!row.request.input_hash || run.input_hash.trim()===row.request.input_hash)?runDto(run):null};
}
export async function assistantCardSummary(db:Db,user:string,t:any,b:AssistantCardRequest){
  const p=await project(db,user,b.project_id);
  const view=(await db.query('SELECT view FROM bb_m4_views WHERE owner_user_id=$1 AND topic_id=$2',[user,t.id])).rows[0]?.view;
  if(b.operation==='generation'?p.id!==t.project_id:view?.assistant?.project_id!==p.id)
    throw conflict('INPUT_REVISION_CONFLICT','请先在本会话明确选择本次任务的项目。');
  let input:any,quote:any=null,requirements='',baseline:any=null,selected:any[]=[];
  if(b.operation==='update'){
    input=(await db.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [user,p.id,b.input_revision])).rows[0];
    if(p.kind!=='update'||!input||input.input_hash.trim()!==b.input_hash||!isUnifiedInput(input.manifest))throw missing();
    const m=input.manifest; selected=m.materials;
    requirements=[m.update_details?.supplementary_notes,...m.authoring.requirements.map((r:any)=>r.content)].filter(Boolean).join('\n');
    const base=m.authoring.previous_output;baseline=base?{source_project_id:p.id,artifact_id:base.artifact_id,artifact_version:base.version,sha256:base.sha256}:null;
  }else if(b.operation==='review'){
    input=(await db.query('SELECT * FROM bb_review_drafts WHERE owner_user_id=$1 AND project_id=$2',[user,p.id])).rows[0];
    if(p.kind!=='review'||input?.version!==b.expected_input_version)throw conflict('INPUT_REVISION_CONFLICT','复核输入已变化。');
    selected=input.input.material_versions;requirements=input.input.requirements.join('\n');
  }else{
    input=(await db.query('SELECT * FROM bb_m4_drafts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3',[user,t.id,b.document_type])).rows[0];
    if(input?.version!==b.expected_draft_version)throw conflict('INPUT_REVISION_CONFLICT','材料输入已变化。');
    selected=[...input.input.materials,...(input.input.source_material?[input.input.source_material]:[])];
    requirements=[input.input.supplemental_requirements,...input.input.requirements.map((r:any)=>r.text)].filter(Boolean).join('\n');baseline=input.input.edit_base;
  }
  if(b.quote_id){
    if(b.operation==='generation'){
      const q=(await db.query('SELECT * FROM bb_m4_quotes WHERE owner_user_id=$1 AND topic_id=$2 AND id=$3',[user,t.id,b.quote_id])).rows[0];
      if(!q||q.snapshot?.draft_version!==b.expected_draft_version||q.snapshot?.input?.document_type!==b.document_type)throw missing();quote=m4QuoteDto(q);
    }else{
      const q=(await db.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[user,p.id,b.quote_id])).rows[0];
      if(!q||b.operation==='update'&&(q.input_hash.trim()!==b.input_hash||q.input_revision!==b.input_revision))throw missing();quote=quoteDto(q);
      if(b.operation==='review'){
        const intent={execution_request_id:b.execution_request_id,operation:'full_review',expected_input_version:b.expected_input_version,
          source_report_id:null,expected_plan_version:null,finding_ids:[]};
        const hash=inputManifestHash({project_id:p.id,draft_revision:p.draft_revision,intent,review_draft:await reviewDraft(db,user,p.id)});
        if(q.task_type!=='full_review'||q.input_hash.trim()!==hash)throw conflict('QUOTE_CHANGED','复核输入与报价不一致，请重新核对。');
      }
    }
  }
  if(b.operation==='generation'&&!quote)throw conflict('QUOTE_REQUIRED','请先查看本次材料生成的报价。');
  const material_names:string[]=[];
  for(const pin of selected){
    const m=(await db.query('SELECT filename FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL AND NOT internal_template',
      [user,pin.source_project_id??p.id,pin.material_id,pin.material_version])).rows[0];
    if(!m)throw missing();if(!material_names.includes(m.filename))material_names.push(m.filename);
  }
  const fields=b.operation==='generation'?input.input.fields:p;
  return {draft_token:view?.assistant?.draft_token??null,target:{issuer_name:fields.issuer_name??'',market:fields.market??'',offering:fields.offering??'',reporting_cutoff:p.update_details?.reporting_cutoff??''},project_name:p.name,requirements,material_names,baseline,quote};
}
export function registerProjectAssistant(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
  app.get('/api/v1/assistant/projects/:project_id',async request=>{
    const user=await owner(request),id=param(request,'project_id'),p=await project(db(),user,id);
    const materials=(await db().query('SELECT DISTINCT ON(id) * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND deleted_at IS NULL AND NOT internal_template ORDER BY id,version DESC',[user,id])).rows.map(materialDto);
    const rows=(await db().query(`SELECT a.id,a.version,a.sha256,r.id AS run_id,r.created_at,r.input_revision,
      COALESCE(m.filename,'清洁版募集说明书.docx') AS filename
      FROM bb_artifact_versions a JOIN bb_runs r ON r.id=a.run_id AND r.owner_user_id=a.owner_user_id
      JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
      LEFT JOIN bb_m4_artifacts m ON m.artifact_id=a.id AND m.artifact_version=a.version AND m.owner_user_id=a.owner_user_id
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.state='succeeded' AND a.delivery_status='available' AND a.quality_status='passed'
      AND (a.id=j.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}' OR m.kind='document') ORDER BY r.created_at DESC`,[user,id])).rows;
    const results:AssistantResult[]=rows.map(a=>({pin:{source_project_id:id,artifact_id:a.id,artifact_version:a.version,sha256:a.sha256.trim()},
      run_id:a.run_id,filename:a.filename,label:`${a.filename} · ${date(a.created_at).slice(0,16).replace('T',' ')}`,created_at:date(a.created_at)}));
    return {project:projectDto(p),materials,results};
  });
  const path='/api/v1/assistant/topics/:topic_id/cards';
  app.get(path,async request=>{const user=await owner(request),id=param(request,'topic_id');await topic(db(),user,id);
    const rows=(await db().query('SELECT c.* FROM bb_assistant_cards c JOIN bb_projects p ON p.id=c.project_id AND p.owner_user_id=c.owner_user_id WHERE c.owner_user_id=$1 AND c.topic_id=$2 AND p.deleted_at IS NULL ORDER BY c.created_at,c.id',[user,id])).rows;
    return {cards:await Promise.all(rows.map(r=>cardDto(db(),user,r)))};
  });
  app.post(path,{schema:{body:AssistantCardRequestSchema}},async request=>{
    const user=await owner(request),id=param(request,'topic_id'),b=request.body as AssistantCardRequest;
    return transaction(db(),async c=>{
      const t=await topic(c,user,id),hash=inputManifestHash(b);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`assistant-card:${user}:${b.card_id}`]);
      const old=(await c.query('SELECT * FROM bb_assistant_cards WHERE owner_user_id=$1 AND id=$2',[user,b.card_id])).rows[0];
      if(old){if(old.topic_id!==id||old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','确认卡请求已使用。');return {card:await cardDto(c,user,old)};}
      const summary=await assistantCardSummary(c,user,t,b);
      const row=(await c.query(`INSERT INTO bb_assistant_cards(id,owner_user_id,topic_id,project_id,execution_request_id,request,request_hash,summary)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[b.card_id,user,id,b.project_id,b.execution_request_id,b,hash,summary])).rows[0];
      await c.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'m4_topic',$3,'assistant.card_prepared',$4)`,[uid(),user,id,{card_id:b.card_id}]);
      return {card:await cardDto(c,user,row)};
    });
  });
}
