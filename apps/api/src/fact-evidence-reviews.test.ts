import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { appendFactEvidenceReview, changeFactEvidenceReviewerGrant, withdrawFactEvidenceReview } from './fact-evidence-reviews.js';
import type { FactEvidenceReviewRequest } from '@bondbuddy/contracts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const testUrl=process.env.BB_TEST_DATABASE_URL;

test('fact evidence reviewer ledger is exact, append-only, external-safe, and fail-closed (PostgreSQL 16)',{skip:!testUrl&&'set BB_TEST_DATABASE_URL to a disposable PostgreSQL 16 database migrated through 0065'},async()=>{
  const db=new Pool({connectionString:testUrl});
  const suffix=randomUUID().replaceAll('-',''),owner=`fer-owner-${suffix}`,reviewer=`fer-reviewer-${suffix}`,manager=`fer-manager-${suffix}`,project=`fer-project-${suffix}`;
  const material=`fer-material-${suffix}`,upload=`fer-upload-${suffix}`,snapshot=`fer-parse-${suffix}`,candidate=`fer-candidate-${suffix}`,context=`fer-context-${suffix}`;
  const contentHash=sha(`synthetic material ${suffix}`),responseHash=sha(`synthetic response ${suffix}`),inputHash=sha(`synthetic input ${suffix}`),factHash=sha(`synthetic fact ${suffix}`),evidenceHash=sha(`synthetic context ${suffix}`);
  const incompleteContext=`fer-context-incomplete-${suffix}`,incompleteHash=sha(`synthetic incomplete context ${suffix}`);
  const legacyContext=`fer-context-legacy-${suffix}`,legacyHash=sha(`synthetic legacy context ${suffix}`);
  const factKey={accountId:owner,entityId:'synthetic-issuer',scope:'consolidated',metric:'assets',period:{end:'2025-12-31'},currency:'CNY',unit:'yuan',basis:'balance_sheet',dataVersion:'synthetic-v1'};
  const manifest={schema_version:'fact-evidence-context-v1',owner_user_id:owner,project_id:project,candidate_id:candidate,input_revision:1,input_hash:inputHash,
    candidate_identity_sha256:factHash,fact_identity:factKey,candidate_value:{value_kind:'decimal',value_decimal:'100',value_text:null},
    source_kind:'external',candidate_status:'needs_confirmation',
    candidate_uncertainty:['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED'],candidate_confidence:0.72,material_id:material,material_version:1,material_sha256:contentHash,
    snapshot_id:snapshot,parser_version:'synthetic-parser-1',parse_request_hash:sha('request'),parse_response_sha256:responseHash,parse_status:'needs_confirmation',original_warnings:[],
    selected_body:[{record_id:'body-anchor',content_sha256:sha('cell'),locator_type:'xlsx_cell',locator:{sheet:'Synthetic',cell:'A1'},confidence:null,uncertainty:[]}],
    auxiliary_targets:[],completeness_status:'complete',completeness_reasons:[],reviewable:true,evidence_set_sha256:evidenceHash};
  const client=await db.connect();
  try{
    const version=await client.query("SELECT current_setting('server_version_num')::integer AS v");assert.ok(Number(version.rows[0]!.v)>=160000,'requires PostgreSQL 16+');
    const migrationOrder=await client.query(`SELECT filename,applied_at FROM bb_schema_migrations
      WHERE filename=ANY($1::text[]) ORDER BY applied_at`,[[
        '0059_m1_issuer_annual_profile_reviews.sql','0060_m1_fact_evidence_context_sets.sql','0061_m1_model_cost_attribution.sql','0065_m1_fact_evidence_reviews.sql']]);
    assert.deepEqual(migrationOrder.rows.map(row=>row.filename),[
      '0059_m1_issuer_annual_profile_reviews.sql','0060_m1_fact_evidence_context_sets.sql','0061_m1_model_cost_attribution.sql','0065_m1_fact_evidence_reviews.sql'],
      'PG16 schema applies 0059, immutable value-pinned 0060 contexts, current develop 0061 attribution, then 0065 reviews');
    const migrations=await client.query("SELECT to_regclass('public.bb_fact_evidence_reviewer_grants') g,to_regclass('public.bb_fact_evidence_context_sets') c");assert.ok(migrations.rows[0]!.g&&migrations.rows[0]!.c,'migrations 0060 and 0065 must be applied');
    const phoneTail=(Number.parseInt(suffix.slice(-6),16)%1000000).toString().padStart(6,'0');
    for(const [id,n] of [[owner,1],[reviewer,2],[manager,3]] as const) await client.query('INSERT INTO bb_users(id,phone_e164,username) VALUES($1,$2,$3)',[id,`+1202555${phoneTail}${n}`,`fer${n}${suffix.slice(0,10)}`]);
    await client.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,draft_revision) VALUES($1,$2,'synthetic fact evidence review','update',1)",[project,owner]);
    await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$4,'financial',$5,now()+interval '1 hour','completed')`,[upload,owner,project,contentHash,`synthetic/${suffix}/upload`]);
    await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial','synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',20,$5,$6,'parsed')`,[material,owner,project,upload,contentHash,`synthetic/${suffix}/material`]);
    await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[project,owner,inputHash]);
    await client.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[project]);
    await client.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-1',$6,'needs_confirmation','document-parse-response-v1',$7,1,$8::jsonb)`,[snapshot,owner,project,material,contentHash,sha('request'),responseHash,
        JSON.stringify({schema_version:'document-parse-response-v1',request_id:`parse-${suffix}`,status:'needs_confirmation',parser_version:'synthetic-parser-1',material:{material_id:material,material_version:1,media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',sha256:contentHash},warnings:[],document:{},error:null})]);
    await client.query(`INSERT INTO bb_fact_candidates(id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_decimal,value_kind,source_kind,source_ref,status,material_id,material_version,evidence,uncertainty)
      VALUES($1,$2,$3,'synthetic-issuer',$4,$5::jsonb,'100.00','decimal','external','external-cache','needs_confirmation',$6,1,$7::jsonb,$8::jsonb)`,[candidate,owner,project,factHash,JSON.stringify(factKey),material,JSON.stringify([{evidence_id:'body-anchor',material_id:material,material_version:1,candidate_confidence:0.72}]),JSON.stringify(['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED'])]);
    await client.query(`INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
      VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,'complete',true,$11::jsonb)`,[context,owner,project,candidate,inputHash,material,snapshot,responseHash,contentHash,evidenceHash,JSON.stringify(manifest)]);
    const incompleteManifest={...manifest,completeness_status:'incomplete',completeness_reasons:['AUXILIARY_SCOPE_UNKNOWN'],reviewable:false,evidence_set_sha256:incompleteHash};
    await client.query(`INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
      VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,'incomplete',false,$11::jsonb)`,[incompleteContext,owner,project,candidate,inputHash,material,snapshot,responseHash,contentHash,incompleteHash,JSON.stringify(incompleteManifest)]);
    const {candidate_value:_oldContextHadNoValuePin,...legacyBase}=manifest;
    const legacyManifest={...legacyBase,evidence_set_sha256:legacyHash};
    await client.query(`INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
      VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,'complete',true,$11::jsonb)`,[legacyContext,owner,project,candidate,inputHash,material,snapshot,responseHash,contentHash,legacyHash,JSON.stringify(legacyManifest)]);
  }finally{client.release();}
  const grant=await changeFactEvidenceReviewerGrant(db,{action:'grant',reviewerUserId:reviewer,actorUserId:manager,reasonCode:'authorized_review',authorizationBasis:'Synthetic test-only authorization',ownerUserId:owner,projectId:project});
  const pinned=(await db.query('SELECT bb_fact_evidence_candidate_snapshot(c) AS snapshot FROM bb_fact_candidates c WHERE c.id=$1',[candidate])).rows[0]!.snapshot;
  await assert.rejects(db.query(`INSERT INTO bb_fact_evidence_reviews
    (id,request_id,request_hash,owner_user_id,project_id,candidate_id,candidate_identity_sha256,candidate_snapshot,evidence_context_set_id,evidence_set_sha256,
     input_revision,input_hash,material_id,material_version,material_sha256,snapshot_id,parser_version,parse_response_sha256,source_kind,assessments,outcome,
     reviewer_user_id,reviewer_grant_id,authority,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1,$11,$12,1,$13,$14,'synthetic-parser-1',$15,'external',$16::jsonb,
      'external_evidence_impact_reviewed',$17,$18,'fact_evidence_reviewer','synthetic direct SQL')`,
    [`malformed-review-${suffix}`,`malformed-request-${suffix}`,sha(`malformed ${suffix}`),owner,project,candidate,factHash,JSON.stringify(pinned),context,evidenceHash,inputHash,material,contentHash,snapshot,responseHash,
      JSON.stringify([{target_id:'body-anchor'}]),reviewer,grant]),/fact evidence review must assess every exact context member once/,
      'direct SQL cannot omit the assessment or reason and still record an externally reviewed result');
  const request:FactEvidenceReviewRequest={request_id:`review-${suffix}`,candidate_id:candidate,evidence_context_set_id:context,evidence_set_sha256:evidenceHash,
    assessments:[{target_id:'body-anchor',assessment:'supports_candidate',reason:'Synthetic exact evidence inspected'}],reason:'Synthetic evidence and impact reviewed'};
  const directSqlInsert = async (requestId:string) => {
    const currentPinned=(await db.query('SELECT bb_fact_evidence_candidate_snapshot(c) AS snapshot FROM bb_fact_candidates c WHERE c.id=$1',[candidate])).rows[0]!.snapshot;
    return db.query(`INSERT INTO bb_fact_evidence_reviews
      (id,request_id,request_hash,owner_user_id,project_id,candidate_id,candidate_identity_sha256,candidate_snapshot,evidence_context_set_id,evidence_set_sha256,
       input_revision,input_hash,material_id,material_version,material_sha256,snapshot_id,parser_version,parse_response_sha256,source_kind,assessments,outcome,
       reviewer_user_id,reviewer_grant_id,authority,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1,$11,$12,1,$13,$14,'synthetic-parser-1',$15,'external',$16::jsonb,
        'external_evidence_impact_reviewed',$17,$18,'fact_evidence_reviewer','Synthetic direct stale-context SQL')`,
      [`direct-${requestId}`,requestId,sha(requestId),owner,project,candidate,factHash,JSON.stringify(currentPinned),context,evidenceHash,inputHash,material,contentHash,snapshot,responseHash,
        JSON.stringify([{target_id:'body-anchor',assessment:'supports_candidate',reason:'Synthetic exact evidence inspected'}]),reviewer,grant]);
  };
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`legacy-${suffix}`,evidence_context_set_id:legacyContext,evidence_set_sha256:legacyHash}),
    /FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'contexts created before candidate-value pinning cannot be reviewed');
  await db.query("UPDATE bb_fact_candidates SET value_decimal='101.00' WHERE id=$1",[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-value-${suffix}`}),
    /FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects a current candidate value that differs from the context pin');
  const changedPinned=(await db.query('SELECT bb_fact_evidence_candidate_snapshot(c) AS snapshot FROM bb_fact_candidates c WHERE c.id=$1',[candidate])).rows[0]!.snapshot;
  await assert.rejects(db.query(`INSERT INTO bb_fact_evidence_reviews
    (id,request_id,request_hash,owner_user_id,project_id,candidate_id,candidate_identity_sha256,candidate_snapshot,evidence_context_set_id,evidence_set_sha256,
     input_revision,input_hash,material_id,material_version,material_sha256,snapshot_id,parser_version,parse_response_sha256,source_kind,assessments,outcome,
     reviewer_user_id,reviewer_grant_id,authority,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1,$11,$12,1,$13,$14,'synthetic-parser-1',$15,'external',$16::jsonb,
      'external_evidence_impact_reviewed',$17,$18,'fact_evidence_reviewer','Synthetic direct stale-value SQL')`,
    [`stale-direct-review-${suffix}`,`stale-direct-request-${suffix}`,sha(`stale direct ${suffix}`),owner,project,candidate,factHash,JSON.stringify(changedPinned),context,evidenceHash,inputHash,material,contentHash,snapshot,responseHash,
      JSON.stringify([{target_id:'body-anchor',assessment:'supports_candidate',reason:'Synthetic exact evidence inspected'}]),reviewer,grant]),
    /fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL with candidate value drift');
  await db.query("UPDATE bb_fact_candidates SET value_decimal='100.00' WHERE id=$1",[candidate]);
  await db.query("UPDATE bb_fact_candidates SET status='extracted' WHERE id=$1",[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-status-${suffix}`}),/FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects status drift from the frozen context');
  await assert.rejects(directSqlInsert(`stale-status-${suffix}`),/fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL after candidate status drift');
  await db.query("UPDATE bb_fact_candidates SET status='needs_confirmation' WHERE id=$1",[candidate]);
  await db.query("UPDATE bb_fact_candidates SET uncertainty='[]'::jsonb WHERE id=$1",[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-uncertainty-${suffix}`}),/FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects uncertainty drift from the frozen context');
  await assert.rejects(directSqlInsert(`stale-uncertainty-${suffix}`),/fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL after candidate uncertainty drift');
  await db.query('UPDATE bb_fact_candidates SET uncertainty=$2::jsonb WHERE id=$1',[candidate,JSON.stringify(['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED'])]);
  await db.query("UPDATE bb_fact_candidates SET evidence=jsonb_set(evidence,'{0,candidate_confidence}','0.71'::jsonb) WHERE id=$1",[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-confidence-${suffix}`}),/FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects candidate confidence drift from the frozen context');
  await assert.rejects(directSqlInsert(`stale-confidence-${suffix}`),/fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL after candidate confidence drift');
  await db.query("UPDATE bb_fact_candidates SET evidence=jsonb_set(evidence,'{0,candidate_confidence}','0.72'::jsonb) WHERE id=$1",[candidate]);
  await db.query("UPDATE bb_fact_candidates SET fact_key=jsonb_set(fact_key,'{metric}',to_jsonb('gross_assets'::text)) WHERE id=$1",[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-identity-${suffix}`}),/FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects fact identity drift even when the stored identity hash is unchanged');
  await assert.rejects(directSqlInsert(`stale-identity-${suffix}`),/fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL after fact identity drift');
  await db.query('UPDATE bb_fact_candidates SET fact_key=$2::jsonb WHERE id=$1',[candidate,JSON.stringify(factKey)]);
  await db.query('UPDATE bb_fact_candidates SET material_id=NULL,material_version=NULL WHERE id=$1',[candidate]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`stale-candidate-material-${suffix}`}),/FACT_EVIDENCE_CONTEXT_PIN_MISMATCH/,'API rejects candidate material drift from the frozen context');
  await assert.rejects(directSqlInsert(`stale-candidate-material-${suffix}`),/fact evidence review pins or active grant mismatch/,'database guard rejects direct SQL after candidate material drift');
  await db.query('UPDATE bb_fact_candidates SET material_id=$2,material_version=1 WHERE id=$1',[candidate,material]);
  await assert.rejects(appendFactEvidenceReview(db,{userId:owner},project,{...request,request_id:`owner-${suffix}`}),/FACT_EVIDENCE_REVIEWER_FORBIDDEN/,'owner cannot self-review');
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`missing-${suffix}`,assessments:[]}),/FACT_EVIDENCE_REVIEW_INVALID/);
  const reviewed=await appendFactEvidenceReview(db,{userId:reviewer},project,request,()=>`review-${suffix}`);
  assert.equal(reviewed.outcome,'external_evidence_impact_reviewed');assert.equal(reviewed.source_kind,'external');assert.equal(reviewed.verification_effect,'none');
  assert.deepEqual(reviewed.candidate_snapshot.uncertainty,['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED']);
  const status=await db.query('SELECT status,source_kind,uncertainty FROM bb_fact_candidates WHERE id=$1',[candidate]);
  assert.equal(status.rows[0]!.status,'needs_confirmation');assert.equal(status.rows[0]!.source_kind,'external');
  const current=await db.query('SELECT id,outcome FROM bb_current_fact_evidence_reviews WHERE id=$1',[reviewed.review_id]);assert.equal(current.rows.length,1);
  const replay=await appendFactEvidenceReview(db,{userId:reviewer},project,request,()=>`unused-${suffix}`);assert.equal(replay.review_id,reviewed.review_id);assert.equal(replay.replayed,true);
  await db.query("UPDATE bb_fact_candidates SET uncertainty='[]'::jsonb WHERE id=$1",[candidate]);
  assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[reviewed.review_id])).rows.length,0,'changed candidate state removes the historical review from the current projection');
  const staleReplay=await appendFactEvidenceReview(db,{userId:reviewer},project,request,()=>`must-not-create-${suffix}`);
  assert.equal(staleReplay.review_id,reviewed.review_id);assert.equal(staleReplay.replayed,true,'same-request replay retains audit semantics after candidate drift');
  assert.equal(Number((await db.query('SELECT count(*)::integer AS n FROM bb_fact_evidence_reviews WHERE owner_user_id=$1 AND project_id=$2 AND candidate_id=$3',[owner,project,candidate])).rows[0]!.n),1,
    'stale replay cannot append a new review');
  await db.query('UPDATE bb_fact_candidates SET uncertainty=$2::jsonb WHERE id=$1',[candidate,JSON.stringify(['EXTERNAL_WORKBOOK_SOURCE_NOT_AUTHORIZED'])]);
  const incomplete=await appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`incomplete-${suffix}`,evidence_context_set_id:incompleteContext,evidence_set_sha256:incompleteHash},()=>`incomplete-review-${suffix}`);
  assert.equal(incomplete.outcome,'needs_more_evidence','unknown or incomplete context cannot produce a reviewed/offerable outcome');
  const withdrawal=await withdrawFactEvidenceReview(db,{userId:reviewer},project,{request_id:`withdraw-${suffix}`,review_id:reviewed.review_id,reason:'Synthetic withdrawal'});
  assert.equal(withdrawal.replayed,false);assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[reviewed.review_id])).rows.length,0);
  await assert.rejects(db.query('UPDATE bb_fact_evidence_reviews SET reason=\'rewritten\' WHERE id=$1',[reviewed.review_id]),/fact evidence reviews are append-only/);
  const rechecked=await appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`review-again-${suffix}`},()=>`review-again-${suffix}`);
  assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[rechecked.review_id])).rows.length,1);
  await changeFactEvidenceReviewerGrant(db,{action:'revoke',reviewerUserId:reviewer,actorUserId:manager,reasonCode:'scope_ended',authorizationBasis:'Synthetic test revocation',ownerUserId:owner,projectId:project,reason:'Synthetic revocation'});
  assert.equal((await db.query('SELECT id FROM bb_fact_evidence_reviewer_grants WHERE id=$1 AND revoked_at IS NOT NULL',[grant])).rows.length,1);
  assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[rechecked.review_id])).rows.length,0,'grant revocation immediately removes the review from current projection');
  await assert.rejects(appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`after-revoke-${suffix}`}),/FACT_EVIDENCE_REVIEWER_FORBIDDEN/);
  await changeFactEvidenceReviewerGrant(db,{action:'grant',reviewerUserId:reviewer,actorUserId:manager,reasonCode:'authorized_review',authorizationBasis:'Synthetic renewed test authorization',ownerUserId:owner,projectId:project});
  const currentAgain=await appendFactEvidenceReview(db,{userId:reviewer},project,{...request,request_id:`review-currentness-${suffix}`},()=>`review-currentness-${suffix}`);
  await db.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2',[owner,project]);
  assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[currentAgain.review_id])).rows.length,0,'draft/input change fails closed');
  await db.query('UPDATE bb_projects SET draft_revision=1 WHERE owner_user_id=$1 AND id=$2',[owner,project]);
  const newerSnapshot=`${snapshot}-v2`,newerResponse=sha(`newer parse ${suffix}`);
  await db.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
    VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-2',$6,'needs_confirmation','document-parse-response-v1',$7,1,$8::jsonb,now()+interval '1 second')`,[newerSnapshot,owner,project,material,contentHash,sha(`new request ${suffix}`),newerResponse,
      JSON.stringify({schema_version:'document-parse-response-v1',request_id:`parse-v2-${suffix}`,status:'needs_confirmation',parser_version:'synthetic-parser-2',material:{material_id:material,material_version:1,media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',sha256:contentHash},warnings:[],document:{},error:null})]);
  assert.equal((await db.query('SELECT id FROM bb_current_fact_evidence_reviews WHERE id=$1',[currentAgain.review_id])).rows.length,0,'newer parse version fails closed');
  await db.end();
});
