import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {QaInputSchema,QaAnswerSchema,type QaInput,type QaAnswer} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';

export const QA_ANSWER_TEMPLATE='project-qa-direct-answer-v7';
// v7 changes reference transport only. Older writing policies are not reusable.
const compatibleTemplates=['project-qa-direct-answer-v6',QA_ANSWER_TEMPLATE];

export function qaRecoveryScope(input:QaInput){
 const {version,operation,project_name,source,prospectus,preparation_id,questions,materials,requirements,cases}=input;
 // A new quote/reservation does not change the answer. All semantic inputs do.
 return inputManifestHash({version,operation,project_name,source,prospectus:prospectus??null,preparation_id,questions,materials,requirements,cases});
}

type Candidate={run_id:string;manifest:unknown;input_hash:string;run_hash:string;answer:unknown;sha256:string;template_version:string};
export function validQaRecovery(candidate:Candidate,input:QaInput,questionId:string,validate:(answer:QaAnswer)=>boolean){
 if(!compatibleTemplates.includes(candidate.template_version)||!Value.Check(QaInputSchema,candidate.manifest)||!Value.Check(QaAnswerSchema,candidate.answer))return false;
 return candidate.manifest.operation==='answer'&&inputManifestHash(candidate.manifest)===candidate.input_hash.trim()
  &&candidate.run_hash.trim()===candidate.input_hash.trim()&&qaRecoveryScope(candidate.manifest)===qaRecoveryScope(input)
  &&candidate.answer.question_id===questionId&&inputManifestHash(candidate.answer)===candidate.sha256.trim()&&validate(candidate.answer);
}

/** Copy only completed answers from an earlier failed attempt on exactly the same
 * input. No failed provider output, terminal state or billing ledger is rewritten.
 */
export async function reusableQaAnswer(pool:Pool,run:{id:string;owner_user_id:string;project_id:string},input:QaInput,questionId:string,validate:(answer:QaAnswer)=>boolean){
 const rows=(await pool.query<Candidate>(`SELECT q.run_id,q.manifest,q.input_hash,r.input_hash AS run_hash,a.answer,a.sha256,p.template_version
  FROM bb_project_qa_runs q
  JOIN bb_runs r ON r.id=q.run_id AND r.owner_user_id=q.owner_user_id AND r.project_id=q.project_id
  JOIN bb_project_qa_answers a ON a.run_id=q.run_id AND a.owner_user_id=q.owner_user_id AND a.question_id=$4
  JOIN bb_runs current_run ON current_run.id=$3 AND current_run.owner_user_id=q.owner_user_id AND current_run.project_id=q.project_id
  JOIN LATERAL (
   SELECT s.template_version FROM bb_model_call_attempts m
   JOIN bb_jobs j ON j.id=m.job_id AND j.run_id=q.run_id AND j.owner_user_id=q.owner_user_id AND j.subtype='project_qa_v1'
   JOIN bb_snapshot_refs s ON s.id=m.prompt_snapshot_id AND s.owner_user_id=q.owner_user_id AND s.project_id=q.project_id AND s.run_id=q.run_id
   WHERE m.owner_user_id=q.owner_user_id AND m.logical_call_id='qa-'||a.question_id AND m.status='completed'
    AND s.input_revision=r.input_revision AND s.input_hash=r.input_hash AND s.template_version=ANY($5::text[])
   ORDER BY m.attempt_no DESC LIMIT 1
  ) p ON true
  WHERE q.owner_user_id=$1 AND q.project_id=$2 AND q.run_id<>$3 AND q.operation='answer' AND r.state='failed'
   AND q.created_at<current_run.created_at AND r.channel=current_run.channel
   AND EXISTS(SELECT 1 FROM bb_run_events e WHERE e.run_id=q.run_id AND e.state='failed' AND e.payload->>'error_code'='MODEL_OUTPUT_SCHEMA_INVALID')
  ORDER BY q.created_at DESC LIMIT 10`,[run.owner_user_id,run.project_id,run.id,questionId,compatibleTemplates])).rows;
 for(const candidate of rows){
  if(validQaRecovery(candidate,input,questionId,validate))return {answer:candidate.answer as QaAnswer,source_run_id:candidate.run_id,
   answer_sha256:candidate.sha256.trim(),source_template:candidate.template_version,scope_hash:qaRecoveryScope(input)};
 }
 return null;
}
