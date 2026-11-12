import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export const WORD_QUALITY_EVIDENCE_VERSION='release-word-quality-evidence-v1';
export const WORD_QUALITY_EVIDENCE_SQL=`
SELECT r.id AS run_id,r.owner_user_id,r.project_id,trim(r.input_hash) AS input_hash,r.state,r.channel,
 j.id AS job_id,j.checkpoint#>'{stages,word_delivery_pair}' AS pair,
 current_setting('transaction_read_only') AS transaction_read_only,
 current_setting('transaction_isolation') AS transaction_isolation,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'id',a.id,'version',a.version,'owner_user_id',a.owner_user_id,'run_id',a.run_id,
  'sha256',trim(a.sha256),'media_type',a.media_type,'quality_status',a.quality_status,'delivery_status',a.delivery_status,
  'evidence_id',e.id,'candidate_sha256',trim(e.candidate_sha256),'readback_sha256',trim(e.readback_sha256),
  'byte_size',e.byte_size::text,'readback_byte_size',e.readback_byte_size::text,
  'evidence_quality_status',e.quality_status,'evidence_delivery_status',e.delivery_status,'delivery_code',e.delivery_code
 ) ORDER BY a.id,a.version),'[]') FROM bb_artifact_versions a
 LEFT JOIN bb_word_delivery_evidence e ON e.id=a.word_delivery_evidence_id AND e.owner_user_id=a.owner_user_id
  AND e.run_id=a.run_id AND e.artifact_id=a.id AND e.artifact_version=a.version
 WHERE a.owner_user_id=r.owner_user_id AND a.run_id=r.id AND a.id IN (
  j.checkpoint#>>'{stages,word_delivery_pair,revision_artifact_id}',j.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}'
 )) AS artifacts
FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
WHERE r.owner_user_id=$1 AND r.id=$2`;

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=value=>assert.match(value,/^[a-f0-9]{64}$/);
const identity=value=>{assert.equal(typeof value,'string');assert.ok(value.trim()&&value.length<=128);return value;};
const size=value=>{assert.ok(typeof value==='string'&&/^[1-9]\d*$/.test(value));const n=Number(value);assert.ok(Number.isSafeInteger(n)&&n<=100*1024*1024);return n;};

export function assertQualityIsolation(env,project){
 assert.match(project,/^bb-release-[a-f0-9]{10}$/);const database=new URL(env.DATABASE_URL);
 const endpoints=[...(env.AZURE_STORAGE_CONNECTION_STRING??'').matchAll(/(?:^|;)BlobEndpoint=([^;]+)/g)];assert.equal(endpoints.length,1,'One explicit local BlobEndpoint required');const blob=new URL(endpoints[0][1]);
 assert.equal(database.hostname,'postgres');assert.equal(database.pathname,'/bb_release_smoke');assert.ok(['postgres:','postgresql:'].includes(database.protocol));
 assert.equal(blob.hostname,'azurite');assert.ok(['http:','https:'].includes(blob.protocol));assert.equal(env.BB_DEPLOYMENT_TIER,'local');assert.equal(env.BB_RELEASE_TEST_INSTANCE,project);
}
export function validateQualityRow(row,{ownerId,runId,inputHash}){
 assert.equal(row?.owner_user_id,ownerId);assert.equal(row.run_id,runId);assert.equal(row.input_hash,inputHash);sha(inputHash);
 assert.equal(row.transaction_read_only,'on');assert.equal(row.transaction_isolation,'repeatable read');assert.ok(['succeeded','test_completed'].includes(row.state));
 const pair=row.pair,gate=pair?.quality_gate,ref=gate?.report;assert.equal(gate?.version,'word-quality-v1');assert.equal(gate.status,'passed');
 identity(pair.revision_artifact_id);identity(pair.clean_artifact_id);assert.notEqual(pair.revision_artifact_id,pair.clean_artifact_id);sha(ref?.sha256);
 assert.ok(Number.isSafeInteger(ref.byte_size)&&ref.byte_size>0&&ref.byte_size<=32*1024*1024);
 const prefix='owners/'+identity(ownerId)+'/projects/'+identity(row.project_id)+'/runs/'+identity(runId)+'/file-authoring/quality/';
 assert.equal(ref.key,prefix+ref.sha256+'/quality-report.json','Unexpected original report key');
 assert.ok(Array.isArray(row.artifacts)&&row.artifacts.length===2,'Exact tracked/clean registry pair required');
 return ref;
}

/** Mechanical evidence only. This never renders a new report or adds approval. */
export function verifyWordQualityEvidence({row,reportBytes,ownerId,runId,inputHash,downloads,requireRenderedPages=true}){
 const ref=validateQualityRow(row,{ownerId,runId,inputHash});assert.ok(Buffer.isBuffer(reportBytes));assert.equal(reportBytes.length,ref.byte_size);assert.equal(hash(reportBytes),ref.sha256,'Original quality JSON hash mismatch');
 const report=JSON.parse(reportBytes.toString('utf8'));assert.equal(report.version,row.pair.quality_gate.version);assert.equal(report.status,row.pair.quality_gate.status);assert.deepEqual(report.issues,[]);assert.equal(report.input_hash,row.input_hash);assert.ok(Array.isArray(report.limitations));
 assert.equal(report.visual_review,'not_run','Unexpected visual-review claim');assert.ok(['not_verified','provided_anchors_checked_only'].includes(report.factual_accuracy),'Unexpected factual acceptance claim');
 assert.ok(Array.isArray(downloads)&&downloads.length>=2,'Actual tracked and clean downloads required');
 const artifacts={};
 for(const [role,id] of [['tracked',row.pair.revision_artifact_id],['clean',row.pair.clean_artifact_id]]){
  const rows=row.artifacts.filter(a=>a.id===id);assert.equal(rows.length,1,'Missing or ambiguous '+role+' artifact');const a=rows[0];
  assert.equal(a.owner_user_id,ownerId);assert.equal(a.run_id,runId);sha(a.sha256);assert.equal(a.sha256,report[role+'_sha256']);
  assert.equal(a.media_type,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert.equal(a.quality_status,'passed');assert.equal(a.delivery_status,row.channel==='non_production_test'?'test_only':'available');
  identity(a.evidence_id);assert.equal(a.candidate_sha256,a.sha256);assert.equal(a.readback_sha256,a.sha256);assert.equal(a.readback_byte_size,a.byte_size);assert.equal(a.evidence_quality_status,'passed');assert.equal(a.evidence_delivery_status,'available');assert.equal(a.delivery_code,'readback_verified');
  const bytes=size(a.byte_size),copies=downloads.filter(d=>d.role===role);assert.ok(copies.length,'Missing '+role+' download');for(const d of copies){assert.equal(d.sha256,a.sha256,'Downloaded '+role+' hash mismatch');assert.equal(d.bytes,bytes,'Downloaded '+role+' size mismatch');}
  artifacts[role]={artifactId:a.id,version:a.version,sha256:a.sha256,bytes,downloadCopies:copies.length};
 }
 assert.ok(downloads.every(d=>['tracked','clean'].includes(d.role)),'Unexpected download role');
 const extent=report.document_size_check,page=extent?.page_check;
 assert.equal(extent?.version,'whole-document-size-v1');assert.equal(extent.visual_acceptance,'not_performed');assert.ok(['passed','not_applicable'].includes(extent.status));assert.deepEqual(extent.issues,[]);
 if(requireRenderedPages)assert.equal(page?.status,'passed','Actual rendered page counts unavailable');
 if(page?.status==='passed'){
  assert.equal(extent.status,'passed');assert.equal(page.renderer,'LibreOffice');for(const v of [page.baseline?.pages,page.clean?.pages])assert.ok(Number.isSafeInteger(v)&&v>0&&v<=2000,'Invalid actual rendered pages');
  assert.ok(Math.abs(page.ratio-page.clean.pages/page.baseline.pages)<=0.00000051,'Reported page ratio changed');
  assert.equal(page.minimum_source_pages,50);assert.equal(page.minimum_page_loss,20);assert.equal(extent.minimum_ratio,0.7);
  assert.ok(!(page.baseline.pages>=50&&page.baseline.pages-page.clean.pages>=20&&page.clean.pages<page.baseline.pages*0.7),'Passed page status contradicts document collapse');
 }else{assert.equal(extent.status,'not_applicable');assert.equal(extent.reason,'short_source');assert.equal(page?.status,'not_run');}
 return {version:WORD_QUALITY_EVIDENCE_VERSION,status:'passed',scope:'stored_server_mechanical_evidence',humanAcceptance:'not_evaluated',runId,inputHash,
  reportReference:ref,reportSha256:ref.sha256,reportBytes:reportBytes.length,report,artifacts,
  pageCount:{status:page.status,source:'stored_document_size_check',baseline:page.status==='passed'?page.baseline.pages:null,clean:page.status==='passed'?page.clean.pages:null,visualAcceptance:'not_performed'}};
}

export async function readStoredWordQuality(input,{client,readBlob}){
 identity(input.ownerId);identity(input.runId);sha(input.inputHash);assert.equal(typeof readBlob,'function');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='30s'");const result=await client.query(WORD_QUALITY_EVIDENCE_SQL,[input.ownerId,input.runId]);assert.equal(result.rows.length,1,'Expected one owned delivery pair');const row=result.rows[0];
  const ref=validateQualityRow(row,input),bytes=await readBlob(ref.key,ref.byte_size);
  return verifyWordQualityEvidence({...input,row,reportBytes:bytes});
 }finally{await client.query('ROLLBACK');}
}

export async function qualityEvidenceMain(){
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw Error('Oversized quality evidence input');}
 const input=JSON.parse(raw);assertQualityIsolation(process.env,input.project);
 const require=createRequire('/app/package.json'),pg=require('pg'),{BlobServiceClient}=require('@azure/storage-blob');
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});
 // azureBlobs().get* calls createIfNotExists. Use only SDK read methods here.
 const container=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private');
 const readBlob=async(key,byteSize)=>{
  const blob=container.getBlockBlobClient(key),signal=AbortSignal.timeout(60000),props=await blob.getProperties({abortSignal:signal});assert.equal(props.contentLength,byteSize);
  const response=await blob.download(0,byteSize,{abortSignal:signal}),chunks=[];let total=0;assert.ok(response.readableStreamBody);
  for await(const chunk of response.readableStreamBody){total+=chunk.length;assert.ok(total<=byteSize,'Quality JSON exceeds pinned size');chunks.push(Buffer.from(chunk));}assert.equal(total,byteSize);return Buffer.concat(chunks);
 };
 await client.connect();try{const result=await readStoredWordQuality(input,{client,readBlob});process.stdout.write(JSON.stringify(result));}finally{await client.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 qualityEvidenceMain().catch(error=>{process.stderr.write(JSON.stringify({code:'WORD_QUALITY_EVIDENCE_FAILED',message:String(error.message)})+'\n');process.exitCode=1;});
}
