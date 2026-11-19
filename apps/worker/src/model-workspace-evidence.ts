import {inputManifestHash as digest} from '@bondbuddy/api/production-rule-pin';
import type {CodexCollectionDiagnostic,CodexCollectionDiagnosticDetails} from './codex-adapter.js';
import type {ProviderCallIntent,ProviderCallObservation,ModelAttemptRuntime} from '@bondbuddy/api/provider-results';
import type {StageContext} from './run-pipeline.js';
import {saveFileAuthoringRecovery,type FileAuthoringRecovery} from './file-authoring-recovery.js';

export type WorkspaceExit = {observation:ProviderCallObservation;runtime:ModelAttemptRuntime;completed:boolean};
export type WorkspaceEvidence = {version:'model-workspace-evidence-v1';snapshot:FileAuthoringRecovery;exit:WorkspaceExit};
export type CollectionDiagnostic = CodexCollectionDiagnostic;

// Only host-defined identifiers leave the collector; never JSON values, exception
// text, client filenames or customer content. The private snapshot holds bytes.
function safeDiagnosticDetails(value:unknown):CodexCollectionDiagnosticDetails|null {
 const d=value as CodexCollectionDiagnosticDetails|null;
 if(!d||!/^[a-zA-Z0-9_]{1,80}$/.test(d.code)||![d.file,d.field,d.rule].every(v=>v===undefined||typeof v==='string'&&/^[a-zA-Z0-9_./-]{1,160}$/.test(v)))return null;
 const ids=d.source_span_ids,count=d.source_span_count;
 if(ids!==undefined&&(!Array.isArray(ids)||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||id.length>128||!/^(?:p[0-9]+|(?:footnotes|endnotes|header[0-9]*|footer[0-9]*)-p[0-9]+)$/.test(id))))return null;
 if(count!==undefined&&(!Number.isSafeInteger(count)||count<(ids?.length??0)||count>1000000))return null;
 return {code:d.code,...(d.file?{file:d.file}:{}),...(d.field?{field:d.field}:{}),...(d.rule?{rule:d.rule}:{}),
  ...(ids?{source_span_ids:[...ids]}:{}),...(count!==undefined?{source_span_count:count}:{})};
}
export function collectionDiagnostic(error:unknown):CollectionDiagnostic {
 const raw=(error as {collectionDiagnostic?:CollectionDiagnostic}|null)?.collectionDiagnostic,first=safeDiagnosticDetails(raw);
 if(!first)return {code:'collection_failed'};
 const issues=raw?.issues,count=raw?.issue_count;
 if(issues!==undefined&&(!Array.isArray(issues)||issues.length>8))return {code:'collection_failed'};
 const safe=issues?.map(safeDiagnosticDetails);
 if(safe?.some(d=>!d)||count!==undefined&&(!Number.isSafeInteger(count)||count<(safe?.length??0)||count>1000000))return {code:'collection_failed'};
 return {...first,...(safe?{issues:safe as CodexCollectionDiagnosticDetails[]}:{}),...(count!==undefined?{issue_count:count}:{})};
}
// Older collectors persisted only a generic code/file/rule. Preserve that
// immutable first receipt when a newer collector adds precise diagnostics for
// the same rejection; it does not authorize execution or change the exit proof.
function legacyDiagnosticUpgrade(previous:unknown,next:unknown){
 const p=previous as Record<string,unknown>|null,n=collectionDiagnostic({collectionDiagnostic:next});
 const rules:Record<string,[string,string,string]>={
  WORKPAPER_SOURCE_COVERAGE_INCOMPLETE:['workpaper-coverage.json','/reviewed_span_ids','full_nonempty_source_partition'],
  WORKPAPER_CONTENT_LINKS_MISSING:['file-links.json','/links','each_used_source_requires_verified_link'],
  WORKPAPER_TABLE_INCOMPLETE:['workpaper-coverage.json','/used_span_ids','all_nonempty_cells_of_each_used_table'],
  WORKPAPER_TABLE_OUTPUT_INCOMPLETE:['file-links.json','/links','complete_source_table_to_distinct_target_cells'],
  WORKPAPER_EMPTY_OR_INTERNAL_CONTENT:['document.docx','/body','business_content_only']
 };
 if(!p||Object.keys(p).sort().join(',')!=='code,file,rule'||p.file!=='workpaper-coverage.json'||p.rule!=='validateWorkpaperCoverage'||p.code!==n.code)return false;
 const expected=rules[n.code];return !!expected&&n.file===expected[0]&&n.field===expected[1]&&n.rule===expected[2]&&digest(n)===digest(next);
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
  const saved=(await ctx.pool.query(`SELECT e.payload_sha256,e.payload,e.input_hash FROM bb_model_workspace_evidence e
    JOIN bb_model_call_attempts a ON a.id=e.attempt_id AND a.owner_user_id=e.owner_user_id
    JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id AND j.run_id=e.run_id
    JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
    WHERE e.attempt_id=$1 AND e.event=$2 AND e.owner_user_id=$3 AND e.run_id=$4
      AND a.job_id=$5 AND a.logical_call_id=$6 AND a.attempt_no=$7 AND a.prompt_snapshot_id=$8
      AND r.project_id=$9 AND r.input_hash=$10 AND e.input_hash=$10`,
    [intent.call_id,event,ctx.run.owner_user_id,ctx.run.id,ctx.lease.jobId,intent.logical_call_id,intent.attempt_no,intent.prompt_snapshot_ref,ctx.run.project_id,ctx.run.input_hash.trim()])).rows[0];
   if(saved?.payload_sha256.trim()!==hash&&!(event==='collection_failure'&&saved?.input_hash?.trim()===ctx.run.input_hash.trim()
      &&digest(saved.payload)===saved.payload_sha256.trim()&&legacyDiagnosticUpgrade(saved.payload,payload)))throw Error('WORKSPACE_EVIDENCE_CONFLICT');
 }
}
/** Caller must have observed contained process exit. Independent cleanup
 * signal preserves bytes after cancellation without reviving the cancelled task. */
export async function captureExitedWorkspace(ctx:StageContext,cwd:string,intent:ProviderCallIntent,exit:WorkspaceExit) {
 if(exit.runtime.exit_code===null&&!['SIGTERM','SIGKILL'].includes(exit.runtime.exit_signal??''))return;
 // Real OCR/Word workspaces contain hundreds of files. Keep cleanup bounded,
 // but allow the full metadata pass and verified object-store round trips.
 const captureCtx={...ctx,signal:AbortSignal.timeout(5*60*1000)};
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
 }catch(error){
  const failure=(error as {captureFailure?:unknown})?.captureFailure;
  const reason=captureCtx.signal.aborted?'capture_timeout':
   ['unsafe_workspace','capacity_exceeded','storage_failed'].includes(String(failure))?failure:'capture_failed';
  await writeWorkspaceEvidence(captureCtx,intent,'capture_failure',{code:'workspace_capture_failed',reason});
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
