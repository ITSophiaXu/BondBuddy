import assert from 'node:assert/strict';
import {confirmationRequired} from './image-contract.mjs';

export const CONFIRMATION_BUDGET_MS=600000;
export const SMALL_MAX_BYTES=16*1024*1024;
export const CONFIRMATION_MODES=['legacy','size-split'];
export const CONFIRMATION_SQL=`SELECT c.upload_id,c.owner_user_id,c.project_id,c.state,c.sha256,c.byte_size::text,c.inspection_excepted,c.result,
 o.id AS outbox_id,o.delivery_attempts,o.delivered_at,(o.lease_token IS NULL AND o.lease_until IS NULL) AS drained,
 m.id AS material_id,m.version AS material_version,m.sha256 AS material_sha256,m.byte_size::text AS material_bytes,m.filename,
 (SELECT count(*)::int FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id WHERE r.project_id=c.project_id AND r.owner_user_id=c.owner_user_id) AS model_calls
 FROM bb_upload_confirmations c JOIN bb_outbox o ON o.id=c.outbox_id AND o.owner_user_id=c.owner_user_id
 LEFT JOIN bb_material_versions m ON m.owner_user_id=c.owner_user_id AND m.project_id=c.project_id AND m.id=c.result->>'material_id' AND m.version=(c.result->>'material_version')::int AND m.deleted_at IS NULL
 WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.upload_id=$3`;
const id=v=>typeof v==='string'&&v.length>0,hash=v=>/^[a-f0-9]{64}$/.test(v??'');
export function confirmationDeadline(mode,now=Date.now()){
 assert.equal(mode.budgetMs,CONFIRMATION_BUDGET_MS,'Upload preflight budget changed');
 const start=Date.parse(mode.startedAt),end=Date.parse(mode.deadlineAt);
 assert.ok(Number.isFinite(start)&&end-start===CONFIRMATION_BUDGET_MS,'Upload preflight deadline changed');
 assert.ok(now<end,'Upload preflight budget expired; preserve accepted uploads');return end-now;
}
export function assertConfirmationReceipt(upload,row,owner,project){
 assert.ok(row&&row.state==='completed'&&row.drained===true&&row.inspection_excepted===false,'Upload has no completed, drained, fully inspected outbox receipt');
 assert.equal(row.owner_user_id,owner);assert.equal(row.project_id,project);assert.equal(row.upload_id,upload.uploadId);
 assert.ok(id(row.outbox_id)&&Number.isInteger(row.delivery_attempts)&&row.delivery_attempts>=1);
 assert.ok(Number.isFinite(Date.parse(row.delivered_at)));
 for(const field of ['sha256','material_sha256'])assert.equal(row[field]?.trim(),upload.sha256);
 for(const field of ['byte_size','material_bytes'])assert.equal(Number(row[field]),upload.bytes);
 assert.equal(row.filename,upload.filename);assert.equal(row.material_id,row.result?.material_id);assert.equal(row.material_version,row.result?.material_version);
 assert.equal(row.result?.upload_id,upload.uploadId);assert.equal(row.result.sha256,upload.sha256);assert.equal(row.result.byte_size,upload.bytes);assert.equal(row.result.filename,upload.filename);
 assert.equal(row.model_calls,0,'Upload-only preflight executed a model');
}
export function verifyConfirmationRuntime(runtime,mode,images){
 const names=mode==='legacy'?['api','worker']:['api','worker','upload-confirmation'];
 assert.deepEqual(Object.keys(runtime).sort(),[...names].sort(),'Unexpected active upload consumers');
 for(const name of names){
  const r=runtime[name];assert.match(r.containerId??'',/^[a-f0-9]{64}$/);assert.equal(r.imageId,images[name].id);assert.equal(r.platform,images[name].platform);
  assert.equal(r.running,true);assert.ok(Number.isFinite(Date.parse(r.startedAt)));
 }
 const w=runtime.worker;assert.equal(w.enabled,'1');assert.equal(w.smallSlot,'0');assert.equal(w.lane,mode==='legacy'?'general':'small');assert.equal(w.spoolBytes,'134217728');
 assert.deepEqual(w.command,['sh','-c','/usr/local/bin/bb-verify-ocr-runtime && exec node apps/worker/dist/runtime.js'],'Worker preflight must use the real runtime entry');
 if(mode==='size-split'){
  const c=runtime['upload-confirmation'];assert.equal(c.enabled,'1');assert.equal(c.lane,'large');assert.equal(c.smallSlot,'0');assert.equal(c.spoolBytes,'134217728');
  assert.equal(c.readOnly,true);assert.equal(c.modelConfiguration,false);assert.equal(c.credentialMounts,false);assert.equal(c.memoryBytes,512*1024*1024);
  assert.equal(c.spoolType,'volume');assert.equal(c.spoolDestination,'/var/lib/bondbuddy/upload-confirmation');
  assert.deepEqual(c.command,['node','apps/worker/dist/upload-confirmation-runtime.js']);
 }
}
export function verifyConfirmationEvidence(report,expected){
 if(!confirmationRequired(expected))return;
 const p=report.uploadConfirmation;
 assert.equal(p?.schema,'release-upload-confirmation-v1');assert.equal(p.status,'passed');assert.equal(p.commit,expected.commit);assert.equal(p.tree,expected.tree);
 assert.ok(hash(expected.confirmationInspectorSha256)&&p.controllerSha256===expected.confirmationInspectorSha256,'Upload preflight controller is not from the candidate');
 assert.ok(id(p.ownerId));assert.equal(p.modes.length,2);assert.deepEqual(p.modes.map(m=>m.name),CONFIRMATION_MODES);
 const allIds=new Set();let prior=Date.parse(report.startedAt);
 for(const mode of p.modes){
  assert.equal(mode.status,'passed');assert.equal(mode.budgetMs,CONFIRMATION_BUDGET_MS);
  const start=Date.parse(mode.startedAt),end=Date.parse(mode.finishedAt),deadline=Date.parse(mode.deadlineAt);
  assert.ok(start>=prior&&end>=start&&end<=deadline&&deadline-start===CONFIRMATION_BUDGET_MS,'Invalid or refreshed upload preflight budget');prior=end;
  verifyConfirmationRuntime(mode.runtime,mode.name,report.images);
  for(const r of Object.values(mode.runtime)){assert.equal(r.revision,expected.commit);assert.ok(Date.parse(r.startedAt)<=end,'Runtime started after its upload evidence');}
  assert.ok(id(mode.projectId));assert.equal(mode.uploads.length,2);assert.deepEqual(mode.uploads.map(u=>u.sizeClass),['small','large']);
  for(const upload of mode.uploads){
   assert.ok(id(upload.uploadId)&&!allIds.has(upload.uploadId));allIds.add(upload.uploadId);
   assert.ok(hash(upload.sha256)&&Number.isSafeInteger(upload.bytes)&&upload.bytes>0);
   assert.equal(upload.bytes<=SMALL_MAX_BYTES,upload.sizeClass==='small');
   assert.ok(report.fixtureHashes.some(f=>f.sha256===upload.sha256),'Upload preflight bytes are not an original fixed fixture');
   assert.ok(Date.parse(upload.acceptedAt)>=start&&Date.parse(upload.finishedAt)<=end&&Date.parse(upload.finishedAt)>=Date.parse(upload.acceptedAt));
   assertConfirmationReceipt(upload,upload.database,p.ownerId,mode.projectId);
   assert.deepEqual(upload.httpReceipt,upload.database.result,'HTTP receipt does not match persisted material');
   const target=mode.name==='size-split'&&upload.sizeClass==='large'?'upload-confirmation':'worker';
   const lane=mode.name==='legacy'?'general':upload.sizeClass;
   assert.ok(Array.isArray(upload.phases)&&upload.phases.length>=3);
   for(const phase of ['read','inspection','commit'])assert.ok(upload.phases.some(e=>e.phase===phase));
   for(const e of upload.phases){
    assert.equal(e.service,target);assert.equal(e.containerId,mode.runtime[target].containerId);assert.equal(e.upload_id,upload.uploadId);assert.equal(e.kind,'upload_confirmation_phase');assert.equal(e.lane,lane);
    assert.ok(Date.parse(e.at)>=start&&Date.parse(e.at)<=end&&Number.isFinite(e.elapsed_ms)&&e.elapsed_ms>=0);
   }
  }
 }
 assert.ok(prior<=Date.parse(report.completedAt),'Five-flow report predates upload preflight');
}
