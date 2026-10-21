import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {IntegrityInputSchema,INTEGRITY_PRICE,type IntegrityInput} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {readProjectFileAsset} from '@bondbuddy/api/project-file-storage';
import type {InputRevisionRow,RunRow,StageOutcome,StageContext} from './run-pipeline.js';

export const isIntegrityInput=(v:unknown):v is IntegrityInput=>Value.Check(IntegrityInputSchema,v);
export async function integrityInputGate(pool:Pool,run:RunRow,input:InputRevisionRow):Promise<Extract<StageOutcome,{kind:'fail'}>|null>{
 const fail={kind:'fail',code:'INPUT_REVISION_CONFLICT'} as const,m=input.manifest;
 if(!isIntegrityInput(m)||run.task_kind!=='generation'||inputManifestHash(m)!==run.input_hash.trim()||input.input_hash.trim()!==run.input_hash.trim())return fail;
 const stored=(await pool.query(`SELECT i.*,j.subtype FROM bb_integrity_runs i JOIN bb_jobs j ON j.owner_user_id=i.owner_user_id AND j.run_id=i.run_id
 WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.run_id=$3`,[run.owner_user_id,run.project_id,run.id])).rows[0];
 if(!stored||stored.input_hash.trim()!==run.input_hash.trim()||inputManifestHash(stored.manifest)!==run.input_hash.trim()||stored.subtype!=='integrity_v1'||stored.round_id!==m.round_id||stored.operation!==m.operation)return fail;
 if(m.operation==='check'){
  if(m.round_id!==run.id||m.points!==INTEGRITY_PRICE.points||m.records.length||m.evidence_ids.length)return fail;
  const quote=(await pool.query(`SELECT 1 FROM bb_integrity_quotes q JOIN bb_credit_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id AND c.run_id=q.run_id
   WHERE q.owner_user_id=$1 AND q.run_id=$2 AND q.input_hash=$3 AND q.points=$4 AND q.price_version=$5 AND c.points=q.points AND c.billing_policy='on_delivery'`,[run.owner_user_id,run.id,run.input_hash,INTEGRITY_PRICE.points,INTEGRITY_PRICE.version])).rowCount;
  if(!quote)return fail;
 }else{
  if(m.points!==0||new Set(m.evidence_ids).size!==m.evidence_ids.length)return fail;
  const parent=(await pool.query(`SELECT * FROM bb_integrity_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3 AND operation='check'`,[run.owner_user_id,run.project_id,m.round_id])).rows[0];
  if(!parent?.result||inputManifestHash(parent.result)!==parent.result_hash.trim()||inputManifestHash(parent.result.records)!==inputManifestHash(m.records)||inputManifestHash(parent.manifest.draft)!==inputManifestHash(m.draft)||parent.manifest.project_name!==m.project_name)return fail;
  const evidence=(await pool.query('SELECT * FROM bb_integrity_evidence WHERE owner_user_id=$1 AND project_id=$2 AND round_id=$3 AND id=ANY($4::text[])',[run.owner_user_id,run.project_id,m.round_id,m.evidence_ids])).rows;
  if(evidence.length!==m.evidence_ids.length)return fail;
  try{for(const e of evidence){if(inputManifestHash({id:run.project_id,run_id:m.round_id,...e.record})!==e.request_hash.trim()||e.record.material.source_project_id!==run.project_id)return fail;
   await readProjectFileAsset(pool,run.owner_user_id,{kind:'material',pin:e.record.material});}}
  catch{return fail;}
 }
 return null;
}
export async function loadIntegrityInput(ctx:StageContext){
 const input=(await ctx.pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.input_revision])).rows[0];
 if(!input||await integrityInputGate(ctx.pool,ctx.run,input))throw Error('INPUT_REVISION_CONFLICT');return input.manifest as IntegrityInput;
}
