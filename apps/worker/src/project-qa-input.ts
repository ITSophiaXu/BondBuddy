import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {QaInputSchema,type QaInput} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {readProjectFileAsset} from '@bondbuddy/api/project-file-storage';
import {validateQaQuestions} from '@bondbuddy/api/project-qa';
import type {RunRow,InputRevisionRow,StageContext,StageOutcome} from './run-pipeline.js';
export const isProjectQaInput=(v:unknown):v is QaInput=>Value.Check(QaInputSchema,v);
export async function projectQaInputGate(pool:Pool,run:RunRow,input:InputRevisionRow):Promise<Extract<StageOutcome,{kind:'fail'}>|null>{
 const fail={kind:'fail',code:'INPUT_REVISION_CONFLICT'} as const,m=input.manifest;
 if(!isProjectQaInput(m)||run.task_kind!=='generation'||inputManifestHash(m)!==run.input_hash.trim()||input.input_hash.trim()!==run.input_hash.trim())return fail;
 const row=(await pool.query('SELECT q.*,j.subtype FROM bb_project_qa_runs q JOIN bb_jobs j ON j.owner_user_id=q.owner_user_id AND j.run_id=q.run_id WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3',[run.owner_user_id,run.project_id,run.id])).rows[0];
 if(!row||row.subtype!=='project_qa_v1'||row.input_hash.trim()!==run.input_hash.trim()||inputManifestHash(row.manifest)!==run.input_hash.trim())return fail;
 try{
  await readProjectFileAsset(pool,run.owner_user_id,m.source.asset);
  for(const material of m.materials)await readProjectFileAsset(pool,run.owner_user_id,material.asset);
  if(m.operation==='prepare'){if(m.points!==0||m.questions.length||m.materials.length||m.cases.length||m.preparation_id)return fail;}
  else{
   if(m.points!==m.questions.length*60||!m.questions.length)return fail;
   const parent=(await pool.query("SELECT q.* FROM bb_project_qa_runs q JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id=$3 AND q.operation='prepare' AND r.state='succeeded'",[run.owner_user_id,run.project_id,m.preparation_id])).rows[0];
   if(!parent?.result||inputManifestHash(parent.result)!==parent.result_hash.trim()||inputManifestHash(parent.manifest.source)!==inputManifestHash(m.source))return fail;
   validateQaQuestions(m.questions,parent.result);
   const quote=(await pool.query("SELECT 1 FROM bb_project_qa_quotes q JOIN bb_credit_reservations c ON c.owner_user_id=q.owner_user_id AND c.run_id=q.run_id AND c.quote_id=q.id WHERE q.owner_user_id=$1 AND q.run_id=$2 AND q.input_hash=$3 AND q.points=$4 AND c.points=q.points AND c.billing_policy='on_delivery'",[run.owner_user_id,run.id,run.input_hash,m.points])).rowCount;if(!quote)return fail;
   if(m.cases.some(c=>c.status!=='approved'||inputManifestHash(c.content)!==c.sha256))return fail;
  }
 }catch{return fail;}return null;
}
export async function loadProjectQaInput(ctx:StageContext){const input=(await ctx.pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.input_revision])).rows[0];if(!input||await projectQaInputGate(ctx.pool,ctx.run,input))throw Error('INPUT_REVISION_CONFLICT');return input.manifest as QaInput;}
