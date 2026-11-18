import {inputManifestHash as digest} from '@bondbuddy/api/production-rule-pin';
import type {ProviderCallIntent,ProviderCallObservation,ModelAttemptRuntime} from '@bondbuddy/api/provider-results';
import type {StageContext} from './run-pipeline.js';
import {saveFileAuthoringRecovery,type FileAuthoringRecovery} from './file-authoring-recovery.js';

export type WorkspaceExit = {observation:ProviderCallObservation;runtime:ModelAttemptRuntime;completed:boolean};
export type WorkspaceEvidence = {version:'model-workspace-evidence-v1';snapshot:FileAuthoringRecovery;exit:WorkspaceExit};
export type CollectionDiagnostic = {code:string;file?:string;field?:string;rule?:string};

// Only host-defined identifiers leave the collector; never JSON values, exception
// text, client filenames or customer content. The private snapshot holds bytes.
export function collectionDiagnostic(error:unknown):CollectionDiagnostic {
 const d=(error as {collectionDiagnostic?:CollectionDiagnostic})?.collectionDiagnostic;
 if(d&&/^[a-zA-Z0-9_]{1,80}$/.test(d.code)&&[d.file,d.field,d.rule].every(v=>v===undefined||/^[a-zA-Z0-9_./-]{1,160}$/.test(v)))return {...d};
 return {code:'collection_failed'};
}
export async function writeWorkspaceEvidence(ctx:StageContext,intent:ProviderCallIntent,event:'exit'|'collection_failure'|'capture_failure',payload:unknown) {
 const hash=digest(payload);
 const result=await ctx.pool.query(`INSERT INTO bb_model_workspace_evidence(attempt_id,event,owner_user_id,run_id,input_hash,payload,payload_sha256)
 SELECT a.id,$2,r.owner_user_id,r.id,r.input_hash,$3::jsonb,$4 FROM bb_model_call_attempts a
 JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
 JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
 WHERE a.id=$1 AND a.owner_user_id=$5 AND j.id=$6 AND r.id=$7 AND r.project_id=$8
 AND r.input_hash=$9 AND a.logical_call_id=$10 AND a.attempt_no=$11 AND a.prompt_snapshot_id=$12
 ON CONFLICT(attempt_id,event) DO NOTHING RETURNING attempt_id`,
 [intent.call_id,event,JSON.stringify(payload),hash,ctx.run.owner_user_id,ctx.lease.jobId,ctx.run.id,ctx.run.project_id,
 ctx.run.input_hash.trim(),intent.logical_call_id,intent.attempt_no,intent.prompt_snapshot_ref]);
 if(!result.rowCount){
  const saved=(await ctx.pool.query('SELECT payload_sha256 FROM bb_model_workspace_evidence WHERE attempt_id=$1 AND event=$2 AND owner_user_id=$3 AND run_id=$4',
    [intent.call_id,event,ctx.run.owner_user_id,ctx.run.id])).rows[0];
  if(saved?.payload_sha256.trim()!==hash)throw Error('WORKSPACE_EVIDENCE_CONFLICT');
 }
}
/** Caller must have observed contained process exit. Independent cleanup
 * signal preserves bytes after cancellation without reviving the cancelled task. */
export async function captureExitedWorkspace(ctx:StageContext,cwd:string,intent:ProviderCallIntent,exit:WorkspaceExit) {
 if(exit.runtime.exit_code===null&&!['SIGTERM','SIGKILL'].includes(exit.runtime.exit_signal??''))return;
 const captureCtx={...ctx,signal:AbortSignal.timeout(30000)};
 try {
  await saveFileAuthoringRecovery(captureCtx,cwd,intent,{persist:async snapshot=>{
    const payload={version:'model-workspace-evidence-v1' as const,snapshot,exit},bytes=Buffer.from(JSON.stringify(payload));
    // Deterministic private manifest remains discoverable even if PG is down
    // after the files have reached object storage. Never a public download.
    const key=`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/workspace-evidence/${intent.call_id}/exit.json`;
    const prior=await ctx.blobs.getIfExistsBounded(key,4*1024*1024);
    if(prior&&digest(JSON.parse(prior.toString('utf8')))!==digest(payload))throw Error('WORKSPACE_EVIDENCE_CONFLICT');
    if(!prior)await ctx.blobs.put(key,bytes,'application/json');
    const stored=await ctx.blobs.getIfExistsBounded(key,4*1024*1024);
    if(!stored||digest(JSON.parse(stored.toString('utf8')))!==digest(payload))throw Error('WORKSPACE_EVIDENCE_STORE_FAILED');
    await writeWorkspaceEvidence(captureCtx,intent,'exit',payload);
  }});
 }catch{
  await writeWorkspaceEvidence(captureCtx,intent,'capture_failure',{code:'workspace_capture_failed'});
  throw Error('WORKSPACE_CAPTURE_FAILED');
 }
}
export async function readWorkspaceEvidence(ctx:StageContext,attemptId:string,logicalCallId='m4-document-v1'):Promise<WorkspaceEvidence|null> {
 const row=(await ctx.pool.query(`SELECT e.payload,e.input_hash,e.payload_sha256 FROM bb_model_workspace_evidence e
 JOIN bb_model_call_attempts a ON a.id=e.attempt_id JOIN bb_jobs j ON j.id=a.job_id
 WHERE e.attempt_id=$1 AND e.event='exit' AND e.owner_user_id=$2 AND e.run_id=$3
 AND j.id=$4 AND j.owner_user_id=$2 AND j.run_id=$3 AND a.logical_call_id=$5`,
 [attemptId,ctx.run.owner_user_id,ctx.run.id,ctx.lease.jobId,logicalCallId])).rows[0];
 if(!row)return null;
 const p=row.payload as WorkspaceEvidence;
 if(digest(p)!==row.payload_sha256.trim()||row.input_hash.trim()!==ctx.run.input_hash.trim()||p.version!=='model-workspace-evidence-v1'
   ||p.snapshot.attempt_id!==attemptId||p.snapshot.logical_call_id!==logicalCallId||p.exit.observation.logical_call_id!==logicalCallId
   ||p.exit.observation.call_id!==attemptId||p.exit.observation.owner_user_id!==ctx.run.owner_user_id
   ||p.exit.observation.run_id!==ctx.run.id||p.exit.observation.job_id!==ctx.lease.jobId
   ||p.exit.observation.project_id!==ctx.run.project_id)throw Error('INPUT_REVISION_CONFLICT');
 return p;
}
