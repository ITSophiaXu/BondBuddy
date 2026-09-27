import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { appendTargetPeriodEvidenceDecision, changeTargetPeriodReviewerGrant, ocrPeriodUncertaintyRequiresConfirmation, withdrawTargetPeriodEvidenceDecision } from './target-period-evidence-decisions.js';
import { validTargetPeriodEvidenceDecision, type TargetPeriodEvidenceDecisionRequest } from '@bondbuddy/contracts';
import { ensureCurrentUpdateDifficultySnapshotWithClient, loadLockedUpdateDifficultyInputWithClient } from './update-difficulty-repository.js';

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

function fixture(){
  let saved:Record<string,unknown>|null=null;let committed=false;
  const client={async query(sql:string,values:unknown[]=[]){
    if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') {if(sql==='COMMIT')committed=true;return {rows:[]};}
    if(sql.includes('FROM bb_target_period_reviewer_grants g')&&sql.includes('JOIN bb_users'))return {rows:[{id:'reviewer-grant',scope_owner_user_id:'owner'}]};
    if(sql.includes('FROM bb_input_revisions i'))return {rows:[{input_hash:hash('d'),draft_revision:4,manifest:{draft_revision:4,kind:'update',materials,
      update_details:{target_reporting_periods:[target]}},material_versions:materials.map(m=>({material_id:m.material_id,material_version:m.material_version})),
      latest_input_revision:2,current_draft_revision:4}]};
    if(sql.includes('FROM bb_material_versions m')&&sql.includes('JOIN bb_parse_snapshots s'))return {rows:[{role:'financial',deleted_at:null,
      response_sha256:hash('c'),parser_version:'document-parser-1',response_status:'parsed',record_sha256:values[9],
      literal_quote:'2025 annual consolidated statements',locator:{sheet:'Balance sheet',cell:'A1'},context:'Synthetic evidence context',uncertainty:[]}]};
    if(sql.includes('FROM bb_material_versions')&&sql.includes('FOR SHARE'))return {rows:[{role:values[2]==='source-doc'?'historical':'financial',
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

test('PostgreSQL 16 migration 0057: append, assemble and withdraw decisions fail closed',
  {skip:!process.env.BB_TEST_DATABASE_URL&&'set BB_TEST_DATABASE_URL to a disposable PostgreSQL 16 database migrated through 0057'},async()=>{
    const pool=new Pool({connectionString:process.env.BB_TEST_DATABASE_URL});
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
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,4,$9::jsonb)`,[snapshot,owner,project,finance,fsha,parserVersion,digest('parse request'),responseHash,
          JSON.stringify({schema_version:'document-parse-response-v1',request_id:`parse-request-${suffix}`,status:'parsed',parser_version:parserVersion,material:{material_id:finance,material_version:1,media_type:'application/pdf',sha256:fsha},warnings:[],document:{page_count:1},error:null})]);
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
      const review:TargetPeriodEvidenceDecisionRequest={request_id:requestId,input_revision:revision,input_hash:inputHash,source_profile_version:1,
        periods:[{start:target.start,end:target.end,period_kind:'annual',scope:'consolidated',outcome:'confirmed',reason:'All four synthetic anchors align.',evidence:periods}]};
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
      const snapshot1=await ensureCurrentUpdateDifficultySnapshotWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:revision,inputHash});
      assert.equal(snapshot1.estimate.estimatedN,1,'confirmed later target financial cutoff persists N=1');

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
      const withdrawn=await withdrawTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,{request_id:`withdraw-${suffix}`,decision_id:appended2.decision_id,reason:'Synthetic withdrawal negative case'});
      assert.equal(withdrawn.replayed,false);
      const afterWithdrawal=await loadLockedUpdateDifficultyInputWithClient({query:(sql,values)=>client.query(sql,values as any)},
        {ownerUserId:owner,projectId:project,inputRevision:2,inputHash:inputHash2,requestId:`period-load-after-withdrawal-${suffix}`});
      assert.equal(afterWithdrawal.targetReportingPeriods[0]?.status,'user_asserted','withdrawal immediately removes the decision from trusted period assembly');
      await client.query('SAVEPOINT immutable_check');
      await assert.rejects(client.query('UPDATE bb_target_period_evidence_decisions SET periods=periods WHERE id=$1',[appended2.decision_id]),/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT immutable_check');
      await assert.rejects(appendTargetPeriodEvidenceDecision(pg,{userId:owner},project,{...review2,request_id:`owner-denied-${suffix}`}),/TARGET_PERIOD_REVIEWER_FORBIDDEN/);
      await changeTargetPeriodReviewerGrant(pg,{action:'revoke',reviewerUserId:reviewer,actorUserId:actor,reasonCode:'synthetic_test',
        authorizationBasis:'Explicit synthetic PG16 integration authorization',ownerUserId:owner,projectId:project,reason:'synthetic revoke'});
      await assert.rejects(appendTargetPeriodEvidenceDecision(pg,{userId:reviewer},project,{...review2,request_id:`revoked-${suffix}`}),/TARGET_PERIOD_REVIEWER_FORBIDDEN/);
    }finally{
      await client.query('ROLLBACK').catch(()=>undefined);
      client.release();
      await pool.end();
    }
  });
