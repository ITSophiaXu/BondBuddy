import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { isolatedTestDatabase } from './test-database.js';
import { appendTargetPeriodEvidenceDecision, changeTargetPeriodReviewerGrant, ocrPeriodUncertaintyRequiresConfirmation, withdrawTargetPeriodEvidenceDecision } from './target-period-evidence-decisions.js';
import { validTargetPeriodEvidenceDecision, type OcrEngineResponse, type TargetPeriodEvidenceDecisionRequest } from '@bondbuddy/contracts';
import { createUpdateDifficultySnapshotWithClient, ensureCurrentUpdateDifficultySnapshotWithClient, getCurrentUpdateDifficultySnapshotWithClient,
  getUpdateDifficultySnapshotWithClient, loadLockedUpdateDifficultyInputWithClient } from './update-difficulty-repository.js';
import { type PrivateBlobs } from './data.js';
import { readOcrPeriodEvidence, validateOcrResponse } from './ocr.js';
import { PNG, pngSample } from './upload-safety.samples.js';

const hash=(n:string)=>n.repeat(64);
function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const target={start:'2025-01-01',end:'2025-12-31',period_kind:'annual' as const,scope:'consolidated' as const,status:'user_asserted',evidence_refs:[]};
const materials=[{material_id:'source-doc',material_version:1,role:'historical',sha256:hash('a')},
  {material_id:'financial-doc',material_version:1,role:'financial',sha256:hash('b')}];
const parseRefs=['table_header','entity','scope','period_end'].map((anchor_kind,index)=>({
  evidence_method:'native_text' as const,material_id:'financial-doc',material_version:1,material_sha256:hash('b'),parse_snapshot_id:'parse-current',
  parser_version:'document-parser-1',response_sha256:hash('c'),record_id:`record-${index}`,record_sha256:hash(String(index+1)),
  anchor_kind:anchor_kind as 'table_header'|'entity'|'scope'|'period_end',
}));
const request:TargetPeriodEvidenceDecisionRequest={request_id:'period-decision-request',input_revision:2,input_hash:hash('d'),source_profile_version:3,
  periods:[{start:target.start,end:target.end,period_kind:target.period_kind,scope:target.scope,outcome:'confirmed',evidence:parseRefs,
    reason:'Header, entity, scope and cutoff align in the annual statement.'}]};

function fixture(options:{productionPin?:boolean;financialRole?:string;duplicateLock?:boolean}={}){
  let saved:Record<string,unknown>|null=null;let committed=false;
  const manifest={draft_revision:4,kind:'update',materials,
    update_details:{target_reporting_periods:[target]},...(options.productionPin?{manifest_schema:'production_rule_pin_v1'}:{})};
  const materialVersions=materials.map(m=>({material_id:m.material_id,material_version:m.material_version}));
  if(options.duplicateLock)materialVersions.push({...materialVersions[1]!});
  const client={async query(sql:string,values:unknown[]=[]){
    if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') {if(sql==='COMMIT')committed=true;return {rows:[]};}
    if(sql.includes('FROM bb_target_period_reviewer_grants g')&&sql.includes('JOIN bb_users'))return {rows:[{id:'reviewer-grant',scope_owner_user_id:'owner'}]};
    if(sql.includes('FROM bb_input_revisions i'))return {rows:[{input_hash:hash('d'),draft_revision:4,manifest,material_versions:materialVersions,
      latest_input_revision:2,current_draft_revision:4}]};
    if(sql.includes('FROM bb_material_versions m')&&sql.includes('JOIN bb_parse_snapshots s'))return {rows:[{role:'financial',deleted_at:null,
      response_sha256:hash('c'),parser_version:'document-parser-1',response_status:'parsed',record_sha256:values[9],
      literal_quote:'2025 annual consolidated statements',locator:{sheet:'Balance sheet',cell:'A1'},context:'Synthetic evidence context',uncertainty:[]}]};
    if(sql.includes('FROM bb_material_versions')&&sql.includes('FOR SHARE'))return {rows:[{role:values[2]==='source-doc'?'historical':options.financialRole??'financial',
      sha256:values[2]==='source-doc'?hash('a'):hash('b'),deleted_at:null}]};
    if(sql.includes('FROM bb_historical_profiles')&&sql.includes('recognition'))return {rows:[{material_id:'source-doc',material_version:1,profile_version:3,recognition:{material_id:'source-doc',profile_version:3}}]};
    if(sql.includes('FROM bb_target_period_evidence_decisions')&&sql.startsWith('SELECT *'))return {rows:saved?[saved]:[]};
    if(sql.startsWith('INSERT INTO bb_target_period_evidence_decisions')){
      saved={id:values[0],request_id:values[1],request_hash:values[2],owner_user_id:values[3],project_id:values[4],input_revision:values[5],
        input_hash:values[6],locked_materials:JSON.parse(String(values[7])),source_profile_material_id:values[8],source_profile_material_version:values[9],
        source_profile_version:values[10],source_profile_sha256:values[11],periods:JSON.parse(String(values[12])),reviewer_user_id:values[13],
        reviewer_grant_id:values[14],authority:'target_financial_period_reviewer',reviewed_at:new Date('2026-09-28T00:00:00Z')};return {rows:[saved]};
    }
    if(sql.includes('INSERT INTO bb_outbox'))return {rows:[]};
    throw new Error(`Unexpected SQL: ${sql}`);
  },async release(){}};
  const db={async connect(){return client;}};
  return {db,get committed(){return committed;}};
}

test('reviewer decision binds complete lock, exact evidence, and authentic actor; exact replay is idempotent',async()=>{
  const f=fixture();
  const appended=await appendTargetPeriodEvidenceDecision(f.db,{userId:'reviewer'},'project',request,()=> 'decision-id');
  assert.equal(appended.replayed,false);
  assert.equal(appended.reviewer_user_id,'reviewer');
  assert.equal(appended.authority,'target_financial_period_reviewer');
  assert.deepEqual(appended.locked_materials.map(x=>x.material_id),['financial-doc','source-doc']);
  assert.equal(f.committed,true);
  const replay=await appendTargetPeriodEvidenceDecision(f.db,{userId:'reviewer'},'project',request,()=> 'unused-id');
  assert.equal(replay.decision_id,'decision-id');
  assert.equal(replay.replayed,true);
  await assert.rejects(appendTargetPeriodEvidenceDecision(f.db,{userId:'reviewer'},'project',{
    ...request,periods:[{...request.periods[0]!,reason:'Different decision under same request key.'}],
  },()=> 'unused-id'),/TARGET_PERIOD_DECISION_REPLAY_CONFLICT/);
});

test('period confirmation requires four anchors from one exact parse response',async()=>{
  const f=fixture();
  await assert.rejects(appendTargetPeriodEvidenceDecision(f.db,{userId:'reviewer'},'project',{
    ...request,periods:[{...request.periods[0]!,evidence:parseRefs.slice(1)}],
  }),/TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE/);
  await assert.rejects(appendTargetPeriodEvidenceDecision(f.db,{userId:'reviewer'},'project',{
    ...request,periods:[{...request.periods[0]!,evidence:parseRefs.map((r,i)=>i===3?{...r,parse_snapshot_id:'other-parse'}:r)}],
  }),/TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE/);
});

test('period decision rejects unhashed production pins, mismatched current roles and duplicate locked materials',async()=>{
  await assert.rejects(appendTargetPeriodEvidenceDecision(fixture({productionPin:true}).db,{userId:'reviewer'},'project',request),
    /TARGET_PERIOD_DECISION_STALE_INPUT/,'production_rule_pin_v1 must be rehashed server-side before review');
  await assert.rejects(appendTargetPeriodEvidenceDecision(fixture({financialRole:'audit'}).db,{userId:'reviewer'},'project',request),
    /TARGET_PERIOD_DECISION_MATERIAL_MANIFEST_MISMATCH/,'manifest role must equal the current immutable material role');
  await assert.rejects(appendTargetPeriodEvidenceDecision(fixture({duplicateLock:true}).db,{userId:'reviewer'},'project',request),
    /TARGET_PERIOD_DECISION_MATERIAL_MANIFEST_MISMATCH/,'the complete lock is a unique set, not a multiset');
});

test('OCR anchors preserve method/page identity and date or scope suspicion cannot be confirmed',()=>{
  const ocrRequest:TargetPeriodEvidenceDecisionRequest={...request,periods:[{...request.periods[0]!,evidence:parseRefs.map((ref,index)=>({
    ...ref,evidence_method:'ocr' as const,page:2,page_image_sha256:hash('f'),ocr_uncertainty:['amount OCR requires independent review'],
    parser_version:'ocr-v2',response_sha256:hash('e'),record_sha256:hash(String(index+1))
  }))}]};
  assert.equal(validTargetPeriodEvidenceDecision(ocrRequest),true);
  assert.equal(validTargetPeriodEvidenceDecision({...ocrRequest,periods:[{...ocrRequest.periods[0]!,evidence:ocrRequest.periods[0]!.evidence.map(({page:_page,...ref})=>ref)}]}),false);
  assert.equal(ocrPeriodUncertaintyRequiresConfirmation(['period date uncertain']),true);
  assert.equal(ocrPeriodUncertaintyRequiresConfirmation(['issuer scope unclear']),true);
  assert.equal(ocrPeriodUncertaintyRequiresConfirmation(['table text OCR confidence requires visual review']),false,
    'generic OCR uncertainty can only be adjudicated against the exact verified page image');
  assert.equal(ocrPeriodUncertaintyRequiresConfirmation(['amount OCR requires independent review']),false,
    'amount review remains independent and the warning is retained in the immutable decision evidence');
});

test('PostgreSQL 16 migration 0058: evidence-state snapshots append, replay and invalidate after review changes',
  {skip:!process.env.BB_TEST_DATABASE_URL&&!process.env.TARGET_PERIOD_EVIDENCE_TEST_DATABASE_URL&&'set TARGET_PERIOD_EVIDENCE_TEST_DATABASE_URL (or BB_TEST_DATABASE_URL) to a disposable PostgreSQL 16 database migrated through 0058'},async()=>{
    const databaseUrl=await isolatedTestDatabase('TARGET_PERIOD_EVIDENCE_TEST_DATABASE_URL','target-period-evidence-decisions');
    assert.ok(databaseUrl,'the suite must run against a private clone, not a shared template');
    const pool=new Pool({connectionString:databaseUrl});
    const suffix=randomUUID().replaceAll('-','').slice(0,14), owner=`period-owner-${suffix}`,reviewer=`period-reviewer-${suffix}`,
      actor=`period-actor-${suffix}`,project=`period-project-${suffix}`,history=`period-history-${suffix}`,finance=`period-finance-${suffix}`;
    const digest=(value:string)=>createHash('sha256').update(value).digest('hex'), sha=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
    const hsha=digest('synthetic history bytes'), fsha=digest('synthetic financial bytes');
    const target={start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]};
    const sourceRef={material_id:history,material_version:1,method:'native_text',extractor_version:'historical-native-recognition-v1/parser-synthetic',evidence_refs:['history-source-ref']};
    const field=(value:string)=>({value,raw_value:value,provenance:sourceRef,uncertainty:[],status:'recognized' as const});
    const recognition={material_id:history,material_version:1,profile_version:1,state:'ready',source_market:field('sse'),source_offering:field('private'),
      reporting_periods:[{start:'2024-01-01',end:'2024-12-31',period_kind:'annual',scope:'consolidated',raw_value:'2024 annual',provenance:sourceRef,uncertainty:[],status:'recognized'}],
      latest_reporting_cutoff:field('2024-12-31')};
    const evidenceIds=['header','entity','scope','date'].map(tag=>`period-${tag}-${suffix}`), responseHash=digest(`parse response ${suffix}`),
      parserVersion=`period-parser-${suffix}`, snapshot=`period-parse-${suffix}`;
    const historySnapshot=`history-parse-${suffix}`,historyResponseHash=digest(`history response ${suffix}`);
    const periods=[...parseRefs].map((ref,index)=>({...ref,material_id:finance,material_sha256:fsha,parse_snapshot_id:snapshot,
      parser_version:parserVersion,response_sha256:responseHash,record_id:evidenceIds[index],record_sha256:digest(evidenceIds[index]),evidence_method:'native_text' as const}));
    const requestId=`period-decision-${suffix}`;
    const revision=1;
    const targetConfirmation={status:'confirmed',market:'sse',offering:'private',document_purpose:null,as_of:null,target_reporting_periods:[target],confirmed_by:owner,confirmed_at:'2026-09-28T00:00:00.000Z'};
    const materials=[{material_id:history,material_version:1,role:'historical',sha256:hsha},{material_id:finance,material_version:1,role:'financial',sha256:fsha}];
    const manifest={kind:'update',draft_revision:1,market:'sse',offering:'private',materials,update_details:{target_reporting_periods:[target]},
      target_confirmation:targetConfirmation,manifest_schema:'production_rule_pin_v1'};
    const inputHash=sha(manifest);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const version=await client.query("SELECT current_setting('server_version_num')::integer AS v");
      assert.ok(Number(version.rows[0]!.v)>=160000,'requires PostgreSQL 16+');
      const applied=await client.query("SELECT to_regclass('public.bb_target_period_evidence_decisions') AS t, to_regclass('public.bb_target_period_evidence_decision_withdrawals') AS w");
      assert.ok(applied.rows[0]!.t&&applied.rows[0]!.w,'migration 0057 must be applied');
      const identityConstraint=await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='bb_update_difficulty_snapshots'::regclass AND conname='bb_update_difficulty_snapshot_evidence_identity_key'`);
      assert.match(String(identityConstraint.rows[0]?.definition??''),/evidence_identity/,'migration 0058 must replace the over-broad snapshot uniqueness key');
      assert.match(String(identityConstraint.rows[0]?.definition??''),/source_material_id.*source_material_version.*source_profile_version.*target_revision.*input_revision.*evidence_identity/,
        'the unique key remains scoped and deduplicates exact derivation identities');
      const phoneTail=Number.parseInt(suffix.slice(-4),16).toString().padStart(4,'0');
      for(const [id,username,phone] of [[owner,`po${suffix}`,`+1202555${phoneTail}`],[reviewer,`pr${suffix}`,`+1202556${phoneTail}`],[actor,`pa${suffix}`,`+1202557${phoneTail}`]] as const)
        await client.query('INSERT INTO bb_users(id,phone_e164,username) VALUES($1,$2,$3)',[id,phone,username]);
      await client.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering) VALUES($1,$2,'synthetic period test','update','sse','private')",[project,owner]);
      const addMaterial=async(id:string,role:string,sha256:string)=>{
        const upload=`${id}-upload`;
        await client.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
          VALUES($1,$2,$3,'source.pdf','application/pdf',10,$4,$5,$6,now()+interval '1 hour','completed')`,[upload,owner,project,sha256,role,`synthetic/${suffix}/${upload}`]);
        await client.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,$5,'source.pdf','application/pdf',10,$6,$7,'parsed')`,[id,owner,project,upload,role,sha256,`users/${owner}/${id}`]);
      };
      await addMaterial(history,'historical',hsha);await addMaterial(finance,'financial',fsha);
      await client.query(`INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
        VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,[owner,project,history,`profile-${suffix}`,digest(`profile ${suffix}`),JSON.stringify(recognition)]);
      await client.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,'parser-synthetic',$6,'parsed','document-parse-response-v1',$7,1,$8::jsonb)`,[historySnapshot,owner,project,history,hsha,digest('history parse request'),historyResponseHash,
          JSON.stringify({schema_version:'document-parse-response-v1',request_id:`history-parse-request-${suffix}`,status:'parsed',parser_version:'parser-synthetic',material:{material_id:history,material_version:1,media_type:'application/pdf',sha256:hsha},warnings:[],document:{page_count:1},error:null})]);
      await client.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,'history-source-ref',$5,'pdf_bbox','{"page":1,"bbox":[0,0,1,1]}'::jsonb,'Synthetic historical issuer identity and 2024 reporting cutoff','synthetic historical anchor','native_text','parser-synthetic',0.99,'[]','{}',$6,0)`,
        [owner,project,history,historySnapshot,hsha,digest('history-source-ref')]);
      await client.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'needs_confirmation','document-parse-response-v1',$8,4,$9::jsonb)`,[snapshot,owner,project,finance,fsha,parserVersion,digest('parse request'),responseHash,
          JSON.stringify({schema_version:'document-parse-response-v1',request_id:`parse-request-${suffix}`,status:'needs_confirmation',parser_version:parserVersion,material:{material_id:finance,material_version:1,media_type:'application/pdf',sha256:fsha},warnings:[{code:'UNRELATED_GLOBAL_WARNING',message:'Synthetic parser warning unrelated to selected anchors.'}],document:{page_count:1},error:null})]);
      for(let index=0;index<4;index++)await client.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1,"bbox":[0,0,1,1]}'::jsonb,$7,'synthetic exact financial evidence','native_text',$8,0.99,'[]','{}',$9,$10)` ,
        [owner,project,finance,snapshot,evidenceIds[index],fsha,`synthetic ${['header','entity','scope','date'][index]} anchor`,parserVersion,digest(evidenceIds[index]),index]);
      const lockedMaterials=materials.map(({material_id,material_version})=>({material_id,material_version}));
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,'[]'::jsonb)`,[project,revision,owner,inputHash,JSON.stringify(manifest),JSON.stringify(lockedMaterials)]);
      await client.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,target_reporting_periods,confirmed_by,confirmed_at)
        VALUES($1,$2,$3,'sse','private',$4::jsonb,$5,$6)`,[owner,project,revision,JSON.stringify([target]),owner,targetConfirmation.confirmed_at]);
      await client.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2',[owner,project]);
      let savepoint=0;
      const pg: any={connect:async()=>{const name=`period_test_${++savepoint}`;return {query:(sql:string,values?:unknown[])=>{
        if(sql==='BEGIN')return client.query(`SAVEPOINT ${name}`);
        if(sql==='COMMIT')return client.query(`RELEASE SAVEPOINT ${name}`);
        if(sql==='ROLLBACK')return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return client.query(sql,values as any);
      },release:()=>undefined};}};
      const grant=await changeTargetPeriodReviewerGrant(pg,{action:'grant',reviewerUserId:reviewer,actorUserId:actor,reasonCode:'synthetic_test',
        authorizationBasis:'Explicit synthetic PG16 integration authorization',ownerUserId:owner,projectId:project});
      const rawInput=await loadLockedUpdateDifficultyInputWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash,requestId:`period-raw-${suffix}`});
      const forgedInput={...rawInput,targetReportingPeriods:[{...rawInput.targetReportingPeriods[0]!,status:'recognized' as const,
        raw_value:'Forged parse-shaped target period',
        provenance:{material_id:finance,material_version:1,method:'native_text' as const,extractor_version:parserVersion,evidence_refs:evidenceIds},uncertainty:[]}]};
      await assert.rejects(createUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},forgedInput),
        /TARGET_PERIOD_DECISION_ASSEMBLY_MISMATCH/,'a direct caller cannot upgrade target intent using parse-shaped provenance without an active review decision');
      const preflight=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash});
      assert.equal(preflight.estimate.estimatedN,null,'same locked input first persists an unreviewed N=null preflight');
      const legacyRow=(await client.query(`INSERT INTO bb_update_difficulty_snapshots
        (id,owner_user_id,project_id,request_id,request_hash,source_material_id,source_material_version,source_profile_version,
         target_revision,source_market,source_offering,target_market,target_offering,input_revision,input_hash,evidence_identity,
         financial_material_versions,comparison_input,old_profile_completeness,estimate)
        SELECT $2,owner_user_id,project_id,$3,$4,source_material_id,source_material_version,source_profile_version,target_revision,
          source_market,source_offering,target_market,target_offering,input_revision,input_hash,NULL,
          financial_material_versions,comparison_input,old_profile_completeness,estimate
        FROM bb_update_difficulty_snapshots WHERE id=$1 RETURNING id`,
        [preflight.id,`legacy-${suffix}`,`legacy-request-${suffix}`,digest(`legacy ${suffix}`)])).rows[0]!;
      assert.equal((await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:String(legacyRow.id)}))?.id,legacyRow.id,
        'a pre-0058 row without a review ledger remains current after the migration');
      await client.query('SAVEPOINT duplicate_identity_check');
      await assert.rejects(client.query(`INSERT INTO bb_update_difficulty_snapshots
        (id,owner_user_id,project_id,request_id,request_hash,source_material_id,source_material_version,source_profile_version,
         target_revision,source_market,source_offering,target_market,target_offering,input_revision,input_hash,evidence_identity,
         financial_material_versions,comparison_input,old_profile_completeness,estimate)
        SELECT $2,owner_user_id,project_id,$3,$4,source_material_id,source_material_version,source_profile_version,target_revision,
          source_market,source_offering,target_market,target_offering,input_revision,input_hash,evidence_identity,
          financial_material_versions,comparison_input,old_profile_completeness,estimate
        FROM bb_update_difficulty_snapshots WHERE id=$1`,[preflight.id,`duplicate-${suffix}`,`duplicate-request-${suffix}`,digest(`duplicate ${suffix}`)]),
        /bb_update_difficulty_snapshot_evidence_identity_key/,'a different request key cannot persist a duplicate of the same derivation identity');
      await client.query('ROLLBACK TO SAVEPOINT duplicate_identity_check');
      const review:TargetPeriodEvidenceDecisionRequest={request_id:requestId,input_revision:revision,input_hash:inputHash,source_profile_version:1,
        periods:[{start:target.start,end:target.end,period_kind:'annual',scope:'consolidated',outcome:'confirmed',reason:'All four synthetic anchors align.',evidence:periods}]};
      const entityUncertainParseSnapshot=`period-parse-uncertain-${suffix}`,entityUncertainParserVersion=`${parserVersion}-uncertain`,uncertainResponseHash=digest(`uncertain parse response ${suffix}`);
      await client.query('SAVEPOINT uncertain_entity_anchor_check');
      await client.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'needs_confirmation','document-parse-response-v1',$8,4,$9::jsonb,now()+interval '1 second')`,
        [entityUncertainParseSnapshot,owner,project,finance,fsha,entityUncertainParserVersion,digest('uncertain parse request'),uncertainResponseHash,
          JSON.stringify({schema_version:'document-parse-response-v1',request_id:`uncertain-parse-request-${suffix}`,status:'needs_confirmation',parser_version:entityUncertainParserVersion,
            material:{material_id:finance,material_version:1,media_type:'application/pdf',sha256:fsha},warnings:[],document:{page_count:1},error:null})]);
      for(let index=0;index<4;index++)await client.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1,"bbox":[0,0,1,1]}'::jsonb,$7,'synthetic exact financial evidence','native_text',$8,0.99,$9::jsonb,'{}',$10,$11)` ,
        [owner,project,finance,entityUncertainParseSnapshot,evidenceIds[index],fsha,`synthetic ${['header','entity','scope','date'][index]} anchor`,entityUncertainParserVersion,
          JSON.stringify(index===1?['formula_cached_result_unverified']:[]),digest(evidenceIds[index]),index]);
      const entityUncertainRefs=periods.map(ref=>({...ref,parse_snapshot_id:entityUncertainParseSnapshot,parser_version:entityUncertainParserVersion,response_sha256:uncertainResponseHash}));
      await assert.rejects(appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,{...review,request_id:`${requestId}-uncertain-entity`,periods:[{...review.periods[0]!,evidence:entityUncertainRefs}]}),
        /TARGET_PERIOD_DECISION_EVIDENCE_INCOMPLETE/,'a selected entity anchor with its own cached-formula uncertainty cannot be confirmed');
      await client.query('ROLLBACK TO SAVEPOINT uncertain_entity_anchor_check');
      await client.query('RELEASE SAVEPOINT uncertain_entity_anchor_check');
      const appended=await appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,review,()=>`period-decision-row-${suffix}`);
      assert.equal(appended.replayed,false);
      const replay=await appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,review,()=>`unused-period-row-${suffix}`);
      assert.equal(replay.decision_id,appended.decision_id);assert.equal(replay.replayed,true);
      const load=async()=>{
        const result=await loadLockedUpdateDifficultyInputWithClient({query:(sql,values)=>client.query(sql,values as any)},
          {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash,requestId:`period-load-${suffix}`});
        return result.targetReportingPeriods[0];
      };
      assert.equal((await load())?.status,'recognized','exact active grant and latest native parse load confirmed period');
      await client.query('SAVEPOINT tampered_decision_check');
      await client.query(`INSERT INTO bb_target_period_evidence_decisions
        (id,request_id,request_hash,owner_user_id,project_id,input_revision,input_hash,locked_materials,source_profile_material_id,
         source_profile_material_version,source_profile_version,source_profile_sha256,periods,reviewer_user_id,reviewer_grant_id,authority,reviewed_at)
        SELECT $2,$3,$4,owner_user_id,project_id,input_revision,input_hash,locked_materials,source_profile_material_id,
         source_profile_material_version,source_profile_version,source_profile_sha256,$5::jsonb,reviewer_user_id,reviewer_grant_id,authority,now()+interval '1 second'
        FROM bb_target_period_evidence_decisions WHERE id=$1`,[appended.decision_id,`tampered-${suffix}`,`tampered-request-${suffix}`,
          digest(`tampered decision ${suffix}`),JSON.stringify([{...review.periods[0]!,evidence:periods.map((ref,index)=>index===1?{...ref,record_sha256:digest('wrong selected entity hash')}:ref)}])]);
      assert.equal((await load())?.status,'user_asserted','a newer altered decision cannot bypass exact native evidence-ref revalidation');
      await client.query('ROLLBACK TO SAVEPOINT tampered_decision_check');
      await client.query('RELEASE SAVEPOINT tampered_decision_check');

      const snapshot1=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash});
      assert.notEqual(snapshot1.id,preflight.id,'a period decision appends a new immutable derivation for the exact same locked input');
      assert.equal(snapshot1.estimate.estimatedN,1,'confirmed later target financial cutoff persists N=1');
      const postReviewSnapshot=`period-parse-post-review-${suffix}`,postReviewParser=`${parserVersion}-post-review`,postReviewResponseHash=digest(`post-review parse response ${suffix}`);
      await client.query('SAVEPOINT post_review_uncertainty_check');
      await client.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'needs_confirmation','document-parse-response-v1',$8,4,$9::jsonb,now()+interval '2 seconds')`,
        [postReviewSnapshot,owner,project,finance,fsha,postReviewParser,digest('post-review parse request'),postReviewResponseHash,
          JSON.stringify({schema_version:'document-parse-response-v1',request_id:`post-review-parse-request-${suffix}`,status:'needs_confirmation',parser_version:postReviewParser,
            material:{material_id:finance,material_version:1,media_type:'application/pdf',sha256:fsha},warnings:[],document:{page_count:1},error:null})]);
      for(let index=0;index<4;index++)await client.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1,"bbox":[0,0,1,1]}'::jsonb,$7,'synthetic exact financial evidence','native_text',$8,0.99,$9::jsonb,'{}',$10,$11)` ,
        [owner,project,finance,postReviewSnapshot,evidenceIds[index],fsha,`synthetic ${['header','entity','scope','date'][index]} anchor`,postReviewParser,
          JSON.stringify(index===1?['formula_cached_result_unverified']:[]),digest(evidenceIds[index]),index]);
      const postReviewRefs=periods.map(ref=>({...ref,parse_snapshot_id:postReviewSnapshot,parser_version:postReviewParser,response_sha256:postReviewResponseHash}));
      await client.query(`INSERT INTO bb_target_period_evidence_decisions
        (id,request_id,request_hash,owner_user_id,project_id,input_revision,input_hash,locked_materials,source_profile_material_id,
         source_profile_material_version,source_profile_version,source_profile_sha256,periods,reviewer_user_id,reviewer_grant_id,authority,reviewed_at)
        SELECT $2,$3,$4,owner_user_id,project_id,input_revision,input_hash,locked_materials,source_profile_material_id,
         source_profile_material_version,source_profile_version,source_profile_sha256,$5::jsonb,reviewer_user_id,reviewer_grant_id,authority,now()+interval '3 seconds'
        FROM bb_target_period_evidence_decisions WHERE id=$1`,[appended.decision_id,`post-review-tampered-${suffix}`,`post-review-request-${suffix}`,
          digest(`post-review decision ${suffix}`),JSON.stringify([{...review.periods[0]!,evidence:postReviewRefs}])]);
      assert.equal((await load())?.status,'user_asserted','a forged confirmed decision is rechecked against each latest anchor uncertainty and fails closed');
      await client.query('ROLLBACK TO SAVEPOINT post_review_uncertainty_check');
      await client.query('RELEASE SAVEPOINT post_review_uncertainty_check');
      const replayedSnapshot=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash});
      assert.equal(replayedSnapshot.id,snapshot1.id,'same reviewed evidence identity replays the same immutable snapshot');
      assert.equal(await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:preflight.id}),null,'pre-review estimate is no longer current after a new decision');
      assert.equal(await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:String(legacyRow.id)}),null,
        'a legacy snapshot becomes non-current once its locked input gains a reviewer decision');

      // Same financial period as the historical source, with a cross-market target: it persists N=0.
      const target2={...target,start:'2024-01-01',end:'2024-12-31'};
      const confirmation2={...targetConfirmation,market:'szse',target_reporting_periods:[target2]};
      const manifest2={...manifest,draft_revision:2,market:'szse',update_details:{target_reporting_periods:[target2]},target_confirmation:confirmation2};
      const inputHash2=sha(manifest2);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,2,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,[project,owner,inputHash2,JSON.stringify(manifest2),JSON.stringify(lockedMaterials)]);
      await client.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,target_reporting_periods,confirmed_by,confirmed_at)
        VALUES($1,$2,2,'szse','private',$3::jsonb,$4,$5)`,[owner,project,JSON.stringify([target2]),owner,confirmation2.confirmed_at]);
      await client.query("UPDATE bb_projects SET draft_revision=2,latest_input_revision=2,market='szse' WHERE owner_user_id=$1 AND id=$2",[owner,project]);
      const review2:TargetPeriodEvidenceDecisionRequest={...review,request_id:`${requestId}-same-period`,input_revision:2,input_hash:inputHash2,
        periods:[{...review.periods[0]!,start:target2.start,end:target2.end,reason:'Same-period cross-market comparison.',evidence:periods}]};
      const appended2=await appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,review2);
      const snapshot2=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:2,inputHash:inputHash2});
      assert.equal(snapshot2.estimate.estimatedN,0,'same cutoff with a market change persists N=0');
      assert.equal(snapshot2.estimate.structureAdaptationRequired,true);
      const staleReviewedInput=await loadLockedUpdateDifficultyInputWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:2,inputHash:inputHash2,requestId:`period-capture-before-withdrawal-${suffix}`});
      assert.equal(staleReviewedInput.targetReportingPeriods[0]?.status,'recognized');
      const withdrawn=await withdrawTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,{request_id:`withdraw-${suffix}`,decision_id:appended2.decision_id,reason:'Synthetic withdrawal negative case'});
      assert.equal(withdrawn.replayed,false);
      const afterWithdrawal=await loadLockedUpdateDifficultyInputWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:2,inputHash:inputHash2,requestId:`period-load-after-withdrawal-${suffix}`});
      assert.equal(afterWithdrawal.targetReportingPeriods[0]?.status,'user_asserted','withdrawal immediately removes the decision from trusted period assembly');
      const afterWithdrawalEstimate=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:2,inputHash:inputHash2});
      assert.notEqual(afterWithdrawalEstimate.id,snapshot2.id,'withdrawal creates a fresh pending estimate instead of replaying stale N=0 evidence');
      assert.equal(afterWithdrawalEstimate.estimate.estimatedN,null);
      assert.equal((await getUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:snapshot2.id}))?.id,snapshot2.id,'withdrawn estimate remains available for immutable audit');
      assert.equal(await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:snapshot2.id}),null,'withdrawn estimate is not returned as current');
      await assert.rejects(createUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},staleReviewedInput),
        /TARGET_PERIOD_DECISION_ASSEMBLY_MISMATCH/,'a pre-withdrawal trusted input cannot be replayed to recreate N after withdrawal');
      await client.query('SAVEPOINT immutable_check');
      await assert.rejects(client.query('UPDATE bb_target_period_evidence_decisions SET periods=periods WHERE id=$1',[appended2.decision_id]),/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT immutable_check');

      // Exercise the real OCR repository path with a hash-checking private-object reader.
      // The backing object map is synthetic; database snapshot metadata and all loader reads are PostgreSQL-backed.
      const blobObjects=new Map<string,Buffer>();
      const blobs={async getIfExistsBounded(key:string,maxBytes:number){const value=blobObjects.get(key);return value&&value.length<=maxBytes?value:null;}} as PrivateBlobs;
      const saveOcr=async(rev:number,uncertainty:string[])=>{
        const snapshotId=`ocr-${suffix}-${rev}`,requestIdOcr=`ocr-request-${suffix}-${rev}`,processorVersion='synthetic-ocr-period-v1';
        const hashBytes=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
        const imageHash=hashBytes(pngSample),imageKey=`synthetic/${suffix}/${rev}/page-1.png`,resultKey=`synthetic/${suffix}/${rev}/result.json`;
        blobObjects.set(imageKey,pngSample);
        const response:OcrEngineResponse={schema_version:'ocr-response-v1',request_id:requestIdOcr,processor_version:processorVersion,
          engine_version:'synthetic-only',language:'eng',language_data_sha256:{eng:digest('synthetic language data')},purpose:'source_preflight',status:'needs_confirmation',
          material:{material_id:finance,material_version:1,media_type:'application/pdf',sha256:fsha},page_count:1,coverage:'complete',
          pages:[{page:1,width:pngSample.readUInt32BE(16),height:pngSample.readUInt32BE(20),rotation_clockwise:0,
            coordinate_system:'rendered_pixels_top_left',image_sha256:imageHash,image_base64:pngSample.toString('base64'),warnings:['synthetic_only']}],
          records:['header','entity','scope','date'].map((tag)=>({record_id:`${tag}-${rev}`,page:1,bbox:[0,0,pngSample.readUInt32BE(16),pngSample.readUInt32BE(20)] as [number,number,number,number],
            text:`synthetic ${tag}`,confidence:0.8,numeric:{kind:'unparsed' as const,decimal:null,unit:null},cell:null,uncertainty:[...uncertainty],eligible_for_manuscript:false})),
          warnings:['synthetic_only'],error:null,eligible_for_manuscript:false};
        validateOcrResponse(response,{materialId:finance,version:1,sha256:fsha,mediaType:'application/pdf',requestId:requestIdOcr,purpose:'source_preflight'});
        const stored={response:structuredClone(response),page_objects:{'1':{key:imageKey,sha256:imageHash}}};
        stored.response.pages[0]!.image_base64='';
        const bytes=Buffer.from(canonical(stored)),resultHash=hashBytes(bytes);blobObjects.set(resultKey,bytes);
        await client.query(`INSERT INTO bb_ocr_snapshots(id,owner_user_id,project_id,material_id,material_version,request_id,request_hash,result_hash,result_key,purpose)
          VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'source_preflight')`,[snapshotId,owner,project,finance,requestIdOcr,digest(`request ${rev}`),resultHash,resultKey]);
        return {snapshotId,resultHash,processorVersion,imageHash,records:response.records};
      };
      const addOcrRevision=async(rev:number,targetPeriod:typeof target)=>{
        const confirmation={...targetConfirmation,market:'sse',target_reporting_periods:[targetPeriod]};
        const ocrManifest={...manifest,draft_revision:rev,market:'sse',update_details:{target_reporting_periods:[targetPeriod]},target_confirmation:confirmation};
        const ocrInputHash=sha(ocrManifest);
        await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
          VALUES($1,$2,$3,$2,$4,$5::jsonb,$6::jsonb,'[]'::jsonb)`,[project,rev,owner,ocrInputHash,JSON.stringify(ocrManifest),JSON.stringify(lockedMaterials)]);
        await client.query(`INSERT INTO bb_input_revision_target_confirmations(owner_user_id,project_id,input_revision,market,offering,target_reporting_periods,confirmed_by,confirmed_at)
          VALUES($1,$2,$3,'sse','private',$4::jsonb,$5,$6)`,[owner,project,rev,JSON.stringify([targetPeriod]),owner,confirmation.confirmed_at]);
        await client.query('UPDATE bb_projects SET draft_revision=$3,latest_input_revision=$3,market=\'sse\' WHERE owner_user_id=$1 AND id=$2',[owner,project,rev]);
        return ocrInputHash;
      };
      const ocrTarget=await saveOcr(3,['amount/formula requires independent review']);
      const ocrHash=await addOcrRevision(3,target);
      const ocrRefs=ocrTarget.records.map((record,index)=>({evidence_method:'ocr' as const,material_id:finance,material_version:1,material_sha256:fsha,
        parse_snapshot_id:ocrTarget.snapshotId,parser_version:ocrTarget.processorVersion,response_sha256:ocrTarget.resultHash,record_id:record.record_id,
        record_sha256:digest(canonical(record)),anchor_kind:(['table_header','entity','scope','period_end'] as const)[index]!,page:1,page_image_sha256:ocrTarget.imageHash,
        ocr_uncertainty:['amount/formula requires independent review']}));
      for(const ref of ocrRefs) await readOcrPeriodEvidence(client,blobs,{owner,projectId:project,materialId:finance,version:1,snapshotId:ocrTarget.snapshotId,
        resultSha256:ocrTarget.resultHash,recordId:ref.record_id,page:ref.page,pageImageSha256:ref.page_image_sha256});
      const ocrDecision:TargetPeriodEvidenceDecisionRequest={...review,request_id:`${requestId}-ocr-amount`,input_revision:3,input_hash:ocrHash,
        periods:[{...review.periods[0]!,evidence:ocrRefs,reason:'Identity anchors are visually aligned; amount and formula remain independently unreviewed.'}]};
      await appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,ocrDecision,()=>`ocr-decision-${suffix}-3`,blobs);
      const ocrSnapshot=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:3,inputHash:ocrHash},{blobs});
      assert.equal(ocrSnapshot.estimate.estimatedN,1,'OCR amount/formula-only uncertainty is retained in audit evidence but does not block period identity N=1');
      const reparsedOcr=await saveOcr(30,['synthetic reparse creates a newer OCR snapshot']);
      assert.ok(reparsedOcr.snapshotId!==ocrTarget.snapshotId);
      assert.equal(await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:ocrSnapshot.id},{blobs}),null,'new OCR parse makes the prior reviewed snapshot non-current');
      const afterReparse=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:3,inputHash:ocrHash},{blobs});
      assert.notEqual(afterReparse.id,ocrSnapshot.id,'reparse state gets a distinct immutable snapshot identity');
      assert.equal(afterReparse.estimate.estimatedN,null,'review against a superseded OCR response cannot preserve N=1');
      assert.equal((await getUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:ocrSnapshot.id}))?.id,ocrSnapshot.id,'reparsed old estimate remains auditable by ID');

      const uncertainTarget=await saveOcr(4,['reporting date is uncertain','consolidation scope unclear']);
      const uncertainHash=await addOcrRevision(4,target);
      const uncertainRefs=uncertainTarget.records.map((record,index)=>({evidence_method:'ocr' as const,material_id:finance,material_version:1,material_sha256:fsha,
        parse_snapshot_id:uncertainTarget.snapshotId,parser_version:uncertainTarget.processorVersion,response_sha256:uncertainTarget.resultHash,record_id:record.record_id,
        record_sha256:digest(canonical(record)),anchor_kind:(['table_header','entity','scope','period_end'] as const)[index]!,page:1,page_image_sha256:uncertainTarget.imageHash,
        ocr_uncertainty:['reporting date is uncertain','consolidation scope unclear']}));
      const uncertainDecision:TargetPeriodEvidenceDecisionRequest={...review,request_id:`${requestId}-ocr-uncertain`,input_revision:4,input_hash:uncertainHash,
        periods:[{...review.periods[0]!,outcome:'needs_confirmation',evidence:uncertainRefs,reason:'Date and scope OCR ambiguity remain unresolved.'}]};
      await appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,uncertainDecision,()=>`ocr-decision-${suffix}-4`,blobs);
      const uncertainSnapshot=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:4,inputHash:uncertainHash},{blobs});
      assert.equal(uncertainSnapshot.estimate.estimatedN,null,'date/scope uncertainty stays pending and cannot be confirmed');
      assert.equal((await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:uncertainSnapshot.id},{blobs}))?.id,uncertainSnapshot.id,
        'the same active reviewer-grant state keeps the pending estimate current');

      await assert.rejects(appendTargetPeriodEvidenceDecision(pg,{userId:owner},project,{...review2,request_id:`owner-denied-${suffix}`}),/TARGET_PERIOD_REVIEWER_FORBIDDEN/);
      await changeTargetPeriodReviewerGrant(pg,{action:'revoke',reviewerUserId:reviewer,actorUserId:actor,reasonCode:'synthetic_test',
        authorizationBasis:'Explicit synthetic PG16 integration authorization',ownerUserId:owner,projectId:project,reason:'synthetic revoke'});
      assert.equal(await getCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:uncertainSnapshot.id},{blobs}),null,
        'grant revocation changes the evidence identity and makes the prior current estimate stale');
      assert.equal((await getUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,snapshotId:uncertainSnapshot.id}))?.id,uncertainSnapshot.id,
        'grant-revoked estimate remains available for audit');
      await assert.rejects(appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,{...review2,request_id:`revoked-${suffix}`}),/TARGET_PERIOD_REVIEWER_FORBIDDEN/);
    }finally{
      await client.query('ROLLBACK').catch(()=>undefined);
      client.release();
      await pool.end();
    }
  });
