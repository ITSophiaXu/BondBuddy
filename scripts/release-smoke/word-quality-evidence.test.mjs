import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {WORD_QUALITY_EVIDENCE_SQL,assertQualityIsolation,verifyWordQualityEvidence,readStoredWordQuality} from './word-quality-evidence-cli.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),hash='a'.repeat(64),trackedHash='b'.repeat(64),cleanHash='c'.repeat(64);
function fixture(){
 const input={ownerId:'owner',runId:'run',inputHash:hash,downloads:[{role:'tracked',sha256:trackedHash,bytes:1000},{role:'clean',sha256:cleanHash,bytes:900}]};
 const report={version:'word-quality-v1',status:'passed',issues:[],metrics:{},limitations:['Mechanical check only'],input_hash:hash,tracked_sha256:trackedHash,clean_sha256:cleanHash,visual_review:'not_run',factual_accuracy:'not_verified',document_size_check:{version:'whole-document-size-v1',status:'passed',issues:[],visual_acceptance:'not_performed',minimum_ratio:0.7,baseline:{cached_pages_hint_only:1},clean:{cached_pages_hint_only:1},page_check:{status:'passed',renderer:'LibreOffice',baseline:{pages:335},clean:{pages:349},ratio:1.041791,minimum_source_pages:50,minimum_page_loss:20}}};
 const artifacts=input.downloads.map(d=>({id:d.role,version:1,owner_user_id:'owner',run_id:'run',sha256:d.sha256,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',quality_status:'passed',delivery_status:'available',evidence_id:'evidence-'+d.role,candidate_sha256:d.sha256,readback_sha256:d.sha256,byte_size:String(d.bytes),readback_byte_size:String(d.bytes),evidence_quality_status:'passed',evidence_delivery_status:'available',delivery_code:'readback_verified'}));
 const row={run_id:'run',owner_user_id:'owner',project_id:'project',input_hash:hash,state:'succeeded',channel:'production',job_id:'job',transaction_read_only:'on',transaction_isolation:'repeatable read',pair:{revision_artifact_id:'tracked',clean_artifact_id:'clean',quality_gate:{version:'word-quality-v1',status:'passed'}},artifacts};
 const f={...input,row,report};return pin(f);
}
function pin(f){const reportBytes=Buffer.from(JSON.stringify(f.report)),sha256=digest(reportBytes);f.row.pair.quality_gate.report={key:'owners/owner/projects/project/runs/run/file-authoring/quality/'+sha256+'/quality-report.json',sha256,byte_size:reportBytes.length};f.reportBytes=reportBytes;return f;}
test('stored report is bound to the exact input, downloaded pair and actual rendered page counts',()=>{
 const f=fixture(),result=verifyWordQualityEvidence(f);assert.equal(result.status,'passed');assert.deepEqual(result.report,f.report);assert.equal(result.reportSha256,digest(f.reportBytes));assert.equal(result.artifacts.tracked.sha256,trackedHash);assert.equal(result.pageCount.baseline,335);assert.equal(result.pageCount.clean,349);assert.equal(result.pageCount.visualAcceptance,'not_performed');assert.equal(result.humanAcceptance,'not_evaluated');
});
test('every downloaded copy must match; a later good copy cannot hide an earlier mismatch',()=>{
 const f=fixture();f.downloads.push({...f.downloads[0]});assert.equal(verifyWordQualityEvidence(f).artifacts.tracked.downloadCopies,2);f.downloads[0].sha256=cleanHash;assert.throws(()=>verifyWordQualityEvidence(f),/hash mismatch/);
});
test('hash, size, input, pair, registry and server delivery evidence mismatches fail',()=>{
 for(const mutate of [f=>f.reportBytes[0]^=1,f=>f.row.pair.quality_gate.report.byte_size++,f=>f.inputHash=cleanHash,f=>f.row.pair.quality_gate.report.key='outside/report.json',f=>f.row.pair.quality_gate.status='failed',f=>f.row.artifacts.pop(),f=>f.row.artifacts.push({...f.row.artifacts[0]}),f=>f.row.artifacts[0].owner_user_id='other',f=>f.row.artifacts[0].readback_sha256=cleanHash,f=>f.row.artifacts[0].readback_byte_size='999',f=>f.row.artifacts[0].delivery_code='blob_hash_mismatch',f=>f.downloads[0].bytes++,f=>f.downloads.pop(),f=>f.row.transaction_read_only='off']){const f=fixture();mutate(f);assert.throws(()=>verifyWordQualityEvidence(f));}
});
test('a pinned JSON with a contradictory mechanical verdict cannot pass',()=>{
 for(const mutate of [r=>r.status='failed',r=>r.issues.push({code:'WORD_QUALITY_REJECTED'}),r=>r.input_hash=cleanHash,r=>r.tracked_sha256=cleanHash,r=>r.visual_review='passed',r=>r.factual_accuracy='verified',r=>r.document_size_check.visual_acceptance='passed',r=>r.document_size_check.page_check.ratio=1,r=>r.document_size_check.page_check.renderer='model',r=>r.document_size_check.page_check.baseline.pages=null,r=>{r.document_size_check.page_check.clean.pages=10;r.document_size_check.page_check.ratio=0.029851;}]){const f=fixture();mutate(f.report);pin(f);assert.throws(()=>verifyWordQualityEvidence(f));}
});
test('not_run/unavailable never become rendered page evidence; short-source status stays explicit',()=>{
 for(const status of ['not_run','unavailable','failed']){const f=fixture();f.report.document_size_check.page_check={status};pin(f);assert.throws(()=>verifyWordQualityEvidence(f),/rendered page counts/);}
 const f=fixture();Object.assign(f.report.document_size_check,{status:'not_applicable',reason:'short_source',page_check:{status:'not_run'}});pin(f);assert.throws(()=>verifyWordQualityEvidence(f));const result=verifyWordQualityEvidence({...f,requireRenderedPages:false});assert.equal(result.pageCount.status,'not_run');assert.equal(result.pageCount.baseline,null);assert.equal(result.pageCount.clean,null);
});
test('local database, azurite and release-instance markers are all required',()=>{
 const project='bb-release-0123456789',env={DATABASE_URL:'postgres://test:secret@postgres/bb_release_smoke',AZURE_STORAGE_CONNECTION_STRING:'DefaultEndpointsProtocol=http;AccountName=test;AccountKey=redacted;BlobEndpoint=http://azurite:10000/test;',BB_DEPLOYMENT_TIER:'local',BB_RELEASE_TEST_INSTANCE:project};assertQualityIsolation(env,project);
 for(const patch of [{DATABASE_URL:'postgres://db/production'},{DATABASE_URL:'postgres://remote/bb_release_smoke'},{AZURE_STORAGE_CONNECTION_STRING:'BlobEndpoint=https://account.blob.core.windows.net;'},{BB_DEPLOYMENT_TIER:'production'},{BB_RELEASE_TEST_INSTANCE:'other'}])assert.throws(()=>assertQualityIsolation({...env,...patch},project));
 assert.throws(()=>assertQualityIsolation({...env,AZURE_STORAGE_CONNECTION_STRING:env.AZURE_STORAGE_CONNECTION_STRING+'BlobEndpoint=https://remote;'},project));
});
test('only fixed SELECT is executed in a read-only repeatable-read transaction with rollback',async()=>{
 const f=fixture(),queries=[],reads=[];const client={query:async(text,values)=>{queries.push({text,values});return {rows:text===WORD_QUALITY_EVIDENCE_SQL?[f.row]:[]};}},readBlob=async(key,bytes)=>{reads.push({key,bytes});return f.reportBytes;};
 const result=await readStoredWordQuality(f,{client,readBlob});assert.equal(result.status,'passed');assert.equal(queries[0].text,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(queries.at(-1).text,'ROLLBACK');assert.deepEqual(queries.find(q=>q.text===WORD_QUALITY_EVIDENCE_SQL).values,['owner','run']);assert.deepEqual(reads,[{key:f.row.pair.quality_gate.report.key,bytes:f.reportBytes.length}]);
 assert.doesNotMatch(WORD_QUALITY_EVIDENCE_SQL,/\b(UPDATE|DELETE|INSERT|CREATE|ALTER)\b/i);
 const source=readFileSync(new URL('./word-quality-evidence-cli.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\.createIfNotExists\(|\.uploadData\(|\.put\(/);
});
test('blob errors and missing DB pairs still roll back and cannot produce a passed report',async()=>{
 const f=fixture(),queries=[],client={query:async text=>{queries.push(text);return {rows:text===WORD_QUALITY_EVIDENCE_SQL?[f.row]:[]};}};
 await assert.rejects(()=>readStoredWordQuality(f,{client,readBlob:async()=>{throw Error('missing blob');}}),/missing blob/);assert.equal(queries.at(-1),'ROLLBACK');
 queries.length=0;client.query=async text=>{queries.push(text);return {rows:[]};};await assert.rejects(()=>readStoredWordQuality(f,{client,readBlob:async()=>f.reportBytes}),/one owned/);assert.equal(queries.at(-1),'ROLLBACK');
});
