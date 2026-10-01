import { Value } from '@sinclair/typebox/value';
import { M1_MATERIAL_PARTITIONS, OcrEngineResponseSchema, OcrCorrectionRequestSchema, type OcrEngineResponse, type OcrReview, type OcrCorrectionRequest, type OcrCorrection } from '@bondbuddy/contracts';
import type { Pool, PoolClient } from 'pg';
import { canonical, digest, material, project, missing, Problem, transaction, uid, type PrivateBlobs } from './data.js';

export type OcrContext = { owner: string; projectId: string; materialId: string; version: number; requestId: string; purpose: 'source_preflight'|'full_ocr'; runId?: string };
type Stored = { response: OcrEngineResponse; page_objects: Record<string,{key:string;sha256:string}> };
const bad = () => new Problem(422,'VALIDATION_FAILED','Invalid OCR evidence');
const changed = () => new Problem(409,'INPUT_REVISION_CONFLICT','OCR evidence or confirmation changed');

export function validateOcrResponse(value: unknown, expected: { materialId:string;version:number;sha256:string;mediaType:string;requestId:string;purpose:string }, checkImages=true): OcrEngineResponse {
  if(!Value.Check(OcrEngineResponseSchema,value)) throw bad();
  const result=value as OcrEngineResponse;
  if(result.request_id!==expected.requestId || result.material.material_id!==expected.materialId || result.material.material_version!==expected.version || result.material.sha256!==expected.sha256 || result.material.media_type!==expected.mediaType || result.purpose!==expected.purpose) throw bad();
  if(result.status==='failed') {
    if(!result.error || result.records.length || result.pages.length || result.coverage!=='none') throw bad();
    return result;
  }
  if((result.purpose==='source_preflight' && result.pages.length>5) || result.error!==null || result.page_count<1 || result.pages.length<1 || result.coverage==='none' || (result.coverage==='complete')!==(result.pages.length===result.page_count) || (result.purpose==='full_ocr' && result.coverage!=='complete')) throw bad();
  const pages=new Map(result.pages.map(page=>[page.page,page]));
  if(pages.size!==result.pages.length || result.pages.some((page,index)=>page.page!==index+1 || page.page>result.page_count || page.width*page.height>20_000_000)) throw bad();
  if(checkImages) for(const page of result.pages) {
    const image=Buffer.from(page.image_base64,'base64');
    if(image.length<24 || image.toString('base64')!==page.image_base64 || image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || image.readUInt32BE(16)!==page.width || image.readUInt32BE(20)!==page.height || digest(image)!==page.image_sha256) throw bad();
  }
  const ids=new Set<string>();
  for(const record of result.records) {
    const page=pages.get(record.page),[left,top,right,bottom]=record.bbox;
    if(!page || ids.has(record.record_id) || right<=left || bottom<=top || right>page.width || bottom>page.height || !record.uncertainty.length || (record.numeric.kind==='number' && (record.numeric.decimal===null || !/^-?\d+(?:\.\d+)?$/.test(record.numeric.decimal))) || (['blank','dash'].includes(record.numeric.kind) && record.numeric.decimal!==null)) throw bad();
    ids.add(record.record_id);
  }
  return result;
}

async function activeMaterial(pool: Pool|PoolClient, context: OcrContext, lock=false) {
  await project(pool,context.owner,context.projectId,lock);
  const result=await pool.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[context.owner,context.projectId,context.materialId,context.version]);
  if(!result.rows[0]) throw missing();
  if(context.purpose==='full_ocr') {
    const run=await pool.query(`SELECT r.id FROM bb_runs r JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
      WHERE r.owner_user_id=$1 AND r.project_id=$2 AND r.id=$3 AND r.state IN ('queued','running')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.material_versions) m WHERE m->>'material_id'=$4 AND (m->>'material_version')::integer=$5)`,[context.owner,context.projectId,context.runId??'',context.materialId,context.version]);
    if(!run.rowCount) throw new Problem(409,'CAPABILITY_NOT_READY','Full OCR requires an active authorized execution with this material version');
  } else if(context.runId) throw bad();
  return result.rows[0];
}
export { activeMaterial as authorizeOcrMaterial };

/** Internal worker only. Source authorization is rechecked after extraction, before publishing. */
export async function storeOcr(pool: Pool, blobs: PrivateBlobs, context: OcrContext, raw: unknown): Promise<string> {
  return transaction(pool,async client=>{
    const source=await activeMaterial(client,context,true);
    const response=validateOcrResponse(raw,{materialId:context.materialId,version:context.version,requestId:context.requestId,purpose:context.purpose,sha256:source.sha256.trim(),mediaType:source.media_type});
    if(response.status==='failed') throw new Problem(422,'MATERIAL_UNREADABLE',response.error!);
    const requestHash=digest(canonical({...context,source_hash:source.sha256.trim()}));
    const old=await client.query('SELECT * FROM bb_ocr_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3',[context.owner,context.projectId,context.requestId]);
    const value:Stored={response:structuredClone(response),page_objects:{}};
    for(const page of value.response.pages) {
      const bytes=Buffer.from(page.image_base64,'base64');
      const key=`users/${context.owner}/projects/${context.projectId}/ocr/${context.materialId}/${context.version}/${page.image_sha256}.png`;
      await blobs.put(key,bytes,'image/png');
      const readback=await blobs.getIfExistsBounded(key,bytes.length);
      if(!readback || digest(readback)!==page.image_sha256) throw new Problem(503,'DATA_UNAVAILABLE','OCR page could not be verified');
      value.page_objects[String(page.page)]={key,sha256:page.image_sha256}; page.image_base64='';
    }
    const bytes=Buffer.from(canonical(value));
    const hash=digest(bytes);
    if(old.rows[0]) {
      if(old.rows[0].request_hash.trim()!==requestHash || old.rows[0].result_hash.trim()!==hash) throw changed();
      return old.rows[0].id;
    }
    const id=uid(), key=`users/${context.owner}/projects/${context.projectId}/ocr/results/${hash}.json`;
    await blobs.put(key,bytes,'application/json');
    const verified=await blobs.getIfExistsBounded(key,bytes.length);
    if(!verified || digest(verified)!==hash) throw new Problem(503,'DATA_UNAVAILABLE','OCR result could not be verified');
    await client.query('INSERT INTO bb_ocr_snapshots(id,owner_user_id,project_id,material_id,material_version,request_id,request_hash,result_hash,result_key,purpose,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,context.owner,context.projectId,context.materialId,context.version,context.requestId,requestHash,hash,key,context.purpose,context.runId??null]);
    await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),context.owner,'material',context.materialId,'ocr.snapshot_saved',{snapshot_id:id,project_id:context.projectId,purpose:context.purpose,billable:false,cost_payer:'platform',coverage:response.coverage}]);
    return id;
  });
}

async function load(pool: Pool|PoolClient, blobs: PrivateBlobs, owner:string, projectId:string, materialId:string, snapshotId?:string) {
  const source=await material(pool,owner,projectId,materialId);
  await project(pool,owner,projectId);
  const found=await pool.query(`SELECT * FROM bb_ocr_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND ($5::text IS NULL OR id=$5) ORDER BY created_at DESC,id DESC LIMIT 1`,[owner,projectId,materialId,source.version,snapshotId??null]);
  const row=found.rows[0];if(!row)throw missing();
  const bytes=await blobs.getIfExistsBounded(row.result_key,32*1024*1024);
  if(!bytes || digest(bytes)!==row.result_hash.trim())throw new Problem(503,'DATA_UNAVAILABLE','OCR result integrity failed');
  let stored:Stored;
  try { stored=JSON.parse(bytes.toString());validateOcrResponse(stored.response,{materialId,version:source.version,sha256:source.sha256.trim(),mediaType:source.media_type,requestId:row.request_id,purpose:row.purpose},false); }
  catch { throw new Problem(503,'DATA_UNAVAILABLE','OCR result integrity failed'); }
  return {row,stored,source};
}

/** A worker-only reader for OCR fact extraction. Caller-provided record text and
 * coordinates are never accepted: each value is resolved from the hash-checked
 * immutable result object and an active, owner-scoped material version. */
export async function readOcrFactSource(pool: Pool|PoolClient, blobs: PrivateBlobs, input: {
  owner: string; projectId: string; materialId: string; version: number;
  snapshotId: string; resultSha256: string; recordId: string; correctionId?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.resultSha256)) throw changed();
  const {row,stored,source} = await load(pool,blobs,input.owner,input.projectId,input.materialId,input.snapshotId);
  if (row.material_version !== input.version || row.result_hash.trim() !== input.resultSha256) throw changed();
  const record = stored.response.records.find(item => item.record_id === input.recordId);
  if (!record) throw missing();
  const page = stored.response.pages.find(item => item.page === record.page);
  if (!page) throw new Problem(503,'DATA_UNAVAILABLE','OCR record page is missing');
  const pageObject = stored.page_objects[String(page.page)];
  if (!pageObject || pageObject.sha256 !== page.image_sha256) throw new Problem(503,'DATA_UNAVAILABLE','OCR page reference integrity failed');
  const pageBytes = await blobs.getIfExistsBounded(pageObject.key,32*1024*1024);
  if (!pageBytes || digest(pageBytes) !== pageObject.sha256) throw new Problem(503,'DATA_UNAVAILABLE','OCR page integrity failed');
  let correction: OcrCorrection|undefined;
  if (input.correctionId !== undefined) {
    const latest = await pool.query(`SELECT id,revision,correction FROM bb_ocr_corrections
      WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_id=$3 AND record_id=$4
      ORDER BY revision DESC LIMIT 1`, [input.owner,input.projectId,row.id,record.record_id]);
    const stored = latest.rows[0];
    if (!stored || stored.id !== input.correctionId) throw changed();
    const value = stored.correction as OcrCorrection;
    if (value?.correction_id !== stored.id || value.record_id !== record.record_id || value.original_text !== record.text ||
      value.actor_user_id !== input.owner || value.status !== 'user_asserted' || value.eligible_for_manuscript !== false ||
      !Number.isSafeInteger(value.revision) || value.revision !== stored.revision || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.corrected_text !== 'string' || typeof value.reason !== 'string' || !value.reason.trim() ||
      ![value.period,value.scope,value.unit].every(item => item === null || typeof item === 'string')) {
      throw new Problem(503,'DATA_UNAVAILABLE','OCR correction integrity failed');
    }
    correction = value;
  }
  return {snapshotId:row.id,resultSha256:row.result_hash.trim(),materialId:input.materialId,
    materialVersion:row.material_version,materialSha256:stored.response.material.sha256,materialRole:source.role,
    snapshotCreatedAt:new Date(row.created_at).toISOString(),processorVersion:stored.response.processor_version,
    record,page,correction};
}

/** Resolve a period-review anchor from the current immutable OCR response and
 * its page image. OCR uncertainty is deliberately not promoted here: the
 * reviewer must inspect this exact page before recording a confirmed outcome. */
export async function readOcrPeriodEvidence(pool: Pool|PoolClient, blobs: PrivateBlobs, input: {
  owner:string; projectId:string; materialId:string; version:number; snapshotId:string;
  resultSha256:string; recordId:string; page:number; pageImageSha256:string;
}) {
  if(!/^[a-f0-9]{64}$/.test(input.resultSha256)||!/^[a-f0-9]{64}$/.test(input.pageImageSha256))throw changed();
  const {row,stored,source}=await load(pool,blobs,input.owner,input.projectId,input.materialId,input.snapshotId);
  const financialRoles=new Set<string>(M1_MATERIAL_PARTITIONS.find(partition=>partition.label==='财务与审计')?.roles.map(role=>role.code)??[]);
  if(row.material_version!==input.version||row.result_hash.trim()!==input.resultSha256||!financialRoles.has(String(source.role)))throw changed();
  const latest=await pool.query(`SELECT id FROM bb_ocr_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3
    AND material_version=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,[input.owner,input.projectId,input.materialId,input.version]);
  if(latest.rows[0]?.id!==row.id)throw changed();
  const record=stored.response.records.find(item=>item.record_id===input.recordId);
  const page=stored.response.pages.find(item=>item.page===input.page);
  const object=stored.page_objects[String(input.page)];
  if(!record||record.page!==input.page||!page||page.image_sha256!==input.pageImageSha256||!object||object.sha256!==input.pageImageSha256)throw changed();
  const bytes=await blobs.getIfExistsBounded(object.key,32*1024*1024);
  if(!bytes||digest(bytes)!==input.pageImageSha256)throw new Problem(503,'DATA_UNAVAILABLE','OCR page integrity failed');
  return {snapshotId:row.id,resultSha256:row.result_hash.trim(),processorVersion:stored.response.processor_version,
    recordSha256:digest(canonical(record)),page:record.page,pageImageSha256:page.image_sha256,
    materialSha256:stored.response.material.sha256,role:String(source.role),uncertainty:[...record.uncertainty]};
}

export async function readOcr(pool: Pool, blobs: PrivateBlobs, owner:string, projectId:string, materialId:string):Promise<OcrReview> {
  const {row,stored}=await load(pool,blobs,owner,projectId,materialId);
  const corrections=await pool.query('SELECT correction FROM bb_ocr_corrections WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_id=$3 ORDER BY created_at,id',[owner,projectId,row.id]);
  return {snapshot_id:row.id,result_sha256:row.result_hash.trim(),material_id:materialId,material_version:row.material_version,purpose:row.purpose,
    coverage:stored.response.coverage as 'complete'|'partial',page_count:stored.response.page_count,
    pages:stored.response.pages.map(({image_base64:_omit,...page})=>({...page,image_url:`/api/v1/projects/${encodeURIComponent(projectId)}/materials/${encodeURIComponent(materialId)}/ocr/pages/${encodeURIComponent(row.id)}/${page.page}`})),
    records:stored.response.records,corrections:corrections.rows.map(row=>row.correction),warnings:stored.response.warnings,eligible_for_manuscript:false};
}
export async function readOcrPage(pool: Pool, blobs:PrivateBlobs, owner:string, projectId:string, materialId:string, snapshotId:string, page:string) {
  if(!/^[1-9]\d{0,3}$/.test(page))throw missing();
  const {stored}=await load(pool,blobs,owner,projectId,materialId,snapshotId);
  const object=stored.page_objects[page]; if(!object)throw missing();
  const bytes=await blobs.getIfExistsBounded(object.key,32*1024*1024);
  if(!bytes || digest(bytes)!==object.sha256)throw new Problem(503,'DATA_UNAVAILABLE','OCR image integrity failed');
  return bytes;
}
export async function correctOcr(pool: Pool, blobs:PrivateBlobs, owner:string, projectId:string, materialId:string, input:OcrCorrectionRequest):Promise<OcrCorrection> {
  if(!Value.Check(OcrCorrectionRequestSchema,input))throw bad();
  return transaction(pool,async client=>{
    await project(client,owner,projectId,true);
    const {row,stored}=await load(client,blobs,owner,projectId,materialId);
    if(row.id!==input.snapshot_id || row.result_hash.trim()!==input.result_sha256)throw changed();
    const record=stored.response.records.find(record=>record.record_id===input.record_id);
    if(!record)throw missing();
    if(!input.reason.trim())throw bad();
    const hash=digest(canonical(input));
    const prior=await client.query('SELECT request_hash,correction FROM bb_ocr_corrections WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3',[owner,projectId,input.request_id]);
    if(prior.rows[0]){if(prior.rows[0].request_hash.trim()!==hash)throw changed();return prior.rows[0].correction;}
    const last=await client.query('SELECT COALESCE(max(revision),0) revision FROM bb_ocr_corrections WHERE snapshot_id=$1 AND record_id=$2',[row.id,record.record_id]);
    if(last.rows[0].revision!==input.expected_revision)throw changed();
    const correction:OcrCorrection={correction_id:uid(),record_id:record.record_id,revision:input.expected_revision+1,
      original_text:record.text,corrected_text:input.corrected_text,reason:input.reason,period:input.period,scope:input.scope,unit:input.unit,
      actor_user_id:owner,created_at:new Date().toISOString(),status:'user_asserted',eligible_for_manuscript:false};
    await client.query('INSERT INTO bb_ocr_corrections(id,owner_user_id,project_id,snapshot_id,record_id,revision,request_id,request_hash,correction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[correction.correction_id,owner,projectId,row.id,record.record_id,correction.revision,input.request_id,hash,correction]);
    await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),owner,'material',materialId,'ocr.user_corrected',{project_id:projectId,snapshot_id:row.id,record_id:record.record_id,revision:correction.revision}]);
    return correction;
  });
}
