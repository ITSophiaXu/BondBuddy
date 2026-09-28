import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openApiDocument } from '@bondbuddy/contracts';
import { changeRuleApplicabilityReviewerGrant } from './rule-applicability-reviewer-grants.js';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl=await isolatedTestDatabase('REVIEWER_PARSE_EVIDENCE_TEST_DATABASE_URL');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ready=async()=>{
  if(!databaseUrl)return false;
  const pool=new Pool({connectionString:databaseUrl});
  try{return (await pool.query("SELECT to_regclass('public.bb_parse_evidence') AS evidence,to_regclass('public.bb_rule_applicability_reviewer_grants') AS grants")).rows[0]?.grants!=null;}
  finally{await pool.end();}
};
const schemaReady=await ready();

test('reviewer parse-evidence lookup pages immutable anchors, fails closed, and audits without excerpts',
  {skip:!schemaReady&&'set REVIEWER_PARSE_EVIDENCE_TEST_DATABASE_URL to a disposable PostgreSQL 16 template migrated through 0051'},async()=>{
    const pool=new Pool({connectionString:databaseUrl!});
    const suffix=randomUUID().replaceAll('-','').slice(0,12);
    const ownerId=`evidence-owner-${suffix}`,foreignOwnerId=`evidence-foreign-owner-${suffix}`;
    const reviewerId=`evidence-reviewer-${suffix}`,grantorId=`evidence-grantor-${suffix}`;
    const strangerId=`evidence-stranger-${suffix}`,projectId=`evidence-project-${suffix}`;
    const foreignProjectId=`evidence-foreign-project-${suffix}`,materialId=`evidence-material-${suffix}`;
    const uploadId=`evidence-upload-${suffix}`,snapshotId=`evidence-snapshot-${suffix}`,grantId=`evidence-grant-${suffix}`;
    const materialSha=sha(`source-${suffix}`),responseSha=sha(`response-${suffix}`),parserVersion=`parser-${suffix}`;
    let activeUser=reviewerId;
    const app=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:activeUser,csrfVerified:true})});
    const url=`/api/v1/reviewer/projects/${projectId}/materials/${materialId}/versions/1/parse-evidence`;
    const send=(path=url)=>app.inject({method:'GET',url:path,headers:{origin:'http://bondbuddy.test'}});
    const grantArgs={action:'grant' as const,reviewerUserId:reviewerId,actorUserId:grantorId,reasonCode:'test_authorized',
      authorizationBasis:'Synthetic authorization for isolated PostgreSQL regression only.',scopeOwnerUserId:ownerId,scopeProjectId:projectId};
    try{
      for(const [id,tag] of [[ownerId,'owner'],[foreignOwnerId,'foreign'],[reviewerId,'reviewer'],[grantorId,'grantor'],[strangerId,'stranger']] as const)
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,`evid${tag}${suffix}`]);
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
        VALUES($1,$2,'Synthetic evidence lookup','update','Synthetic issuer','sse','private'),
          ($3,$4,'Synthetic foreign project','update','Synthetic issuer','sse','private')`,[projectId,ownerId,foreignProjectId,foreignOwnerId]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'source.pdf','application/pdf',12,$4,'historical',$5,now()+interval '1 hour','completed',$4,12)`,
      [uploadId,ownerId,projectId,materialSha,`synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','source.pdf','application/pdf',12,$5,$6,'parsed')`,
      [materialId,ownerId,projectId,uploadId,materialSha,`users/${ownerId}/projects/${projectId}/materials/${materialId}`]);
      await changeRuleApplicabilityReviewerGrant(pool,grantArgs);
      await changeRuleApplicabilityReviewerGrant(pool,{...grantArgs,scopeOwnerUserId:foreignOwnerId,scopeProjectId:foreignProjectId});
      const meta={schema_version:'document-parse-response-v1',request_id:`parse-${suffix}`,status:'parsed',parser_version:parserVersion,
        material:{material_id:materialId,material_version:1,media_type:'application/pdf',sha256:materialSha},warnings:[],document:{page_count:1},error:null};
      const insertSnapshot=async(id:string,version:string,responseHash:string,createdAt?:string,snapshotContentSha=materialSha,recordCount=52)=>pool.query(`INSERT INTO bb_parse_snapshots
        (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,$9,$10::jsonb,COALESCE($11::timestamptz,now()))`,
      [id,ownerId,projectId,materialId,snapshotContentSha,version,sha(`request-${version}`),responseHash,recordCount,
        JSON.stringify({...meta,parser_version:version,material:{...meta.material,sha256:snapshotContentSha}}),createdAt??null]);
      await insertSnapshot(snapshotId,parserVersion,responseSha);
      for(let ordinal=0;ordinal<52;ordinal++){
        const recordId=`${snapshotId}-record-${ordinal}`;
        await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
          locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
          VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic context','native_text',$9,0.98,'[]'::jsonb,'{}'::jsonb,$10,$11)`,
        [ownerId,projectId,materialId,snapshotId,recordId,materialSha,JSON.stringify({page:1,bbox:[0,0,1,1]}),
          `Synthetic literal quote ${ordinal}`,parserVersion,sha(`record-${ordinal}`),ordinal]);
      }

      const first=await send(`${url}?q=literal%20quote`);
      assert.equal(first.statusCode,200,first.body);
      assert.equal(first.headers['cache-control'],'private, no-store');
      const documented=(openApiDocument().paths as Record<string,any>)['/api/v1/reviewer/projects/{project_id}/materials/{material_id}/versions/{v}/parse-evidence'].get;
      assert.equal(documented['x-implementation-status'],'implemented; requires-valid-session');
      const firstBody=first.json();
      assert.equal(firstBody.snapshot_id,snapshotId);
      assert.equal(firstBody.material_sha256,materialSha);
      assert.equal(firstBody.parser_version,parserVersion);
      assert.equal(firstBody.response_sha256,responseSha);
      assert.equal(firstBody.items.length,50);
      assert.equal(firstBody.items[0].record_sha256,sha('record-0'));
      assert.equal(firstBody.items[0].content_sha256,materialSha);
      assert.equal(firstBody.items[0].literal_quote,'Synthetic literal quote 0');
      assert.ok(firstBody.next_cursor);
      const second=await send(`${url}?q=literal%20quote&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
      assert.equal(second.statusCode,200,second.body);
      assert.equal(second.json().items.length,2);
      assert.equal(second.json().items[0].record_id,`${snapshotId}-record-50`);
      assert.equal(second.json().next_cursor,null);
      const cursorData=JSON.parse(Buffer.from(firstBody.next_cursor,'base64url').toString('utf8'));
      const transplantedCursor=Buffer.from(JSON.stringify({...cursorData,project_id:foreignProjectId})).toString('base64url');
      const transplanted=await send(`${url}?q=literal%20quote&cursor=${encodeURIComponent(transplantedCursor)}`);
      assert.ok(transplanted.statusCode===409,`cursor scope includes project and material identity: ${transplanted.body}`);
      assert.doesNotMatch(transplanted.body,/Synthetic literal quote/);

      const timeline=Date.now()+2000;
      const staleSnapshot=`${snapshotId}-new`;
      await insertSnapshot(staleSnapshot,`${parserVersion}-new`,sha('new-response'),new Date(timeline).toISOString());
      const stale=await send(`${url}?q=literal%20quote&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
      assert.equal(stale.statusCode,409,stale.body);
      assert.doesNotMatch(stale.body,/Synthetic literal quote/);

      const mismatchedSnapshot=`${snapshotId}-mismatched`;
      await insertSnapshot(mismatchedSnapshot,`${parserVersion}-mismatched`,sha('mismatched-response'),new Date(timeline+1000).toISOString(),sha('other-material'));
      const mismatched=await send();
      assert.ok(mismatched.statusCode===409,
        `a newer snapshot for another material hash must not fall back to the older matching snapshot: ${mismatched.body}`);
      assert.doesNotMatch(mismatched.body,/Synthetic literal quote/);

      const badRecordSnapshot=`${snapshotId}-bad-record`,badRecordParser=`${parserVersion}-bad-record`,badRecordSha=sha('bad-record-response');
      await insertSnapshot(badRecordSnapshot,badRecordParser,badRecordSha,new Date(timeline+2000).toISOString(),materialSha,1);
      await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox','{"page":1}'::jsonb,'Invalid synthetic evidence','synthetic context',
          'native_text','wrong-parser',0.98,'[]'::jsonb,'{}'::jsonb,$7,0)`,
      [ownerId,projectId,materialId,badRecordSnapshot,`${badRecordSnapshot}-record`,sha('wrong-material'),sha('bad-record')]);
      const badRecord=await send();
      assert.ok(badRecord.statusCode===409,
        `a newer snapshot with non-submittable evidence anchors must fail closed instead of returning older references: ${badRecord.body}`);
      assert.doesNotMatch(badRecord.body,/Invalid synthetic evidence|Synthetic literal quote/);

      const failedId=`${snapshotId}-failed`,failedParser=`${parserVersion}-failed`,failedSha=sha('failed-response');
      const failedMeta={schema_version:'document-parse-response-v1',request_id:`parse-failed-${suffix}`,status:'failed',
        parser_version:failedParser,material:{material_id:materialId,material_version:1,media_type:'application/pdf',sha256:materialSha},
        warnings:[],document:{page_count:0},error:{code:'synthetic_parse_failure'}};
      await pool.query(`INSERT INTO bb_parse_snapshots
        (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'failed','document-parse-response-v1',$8,0,$9::jsonb,$10::timestamptz)`,
      [failedId,ownerId,projectId,materialId,materialSha,failedParser,sha('failed-request'),failedSha,JSON.stringify(failedMeta),
        new Date(timeline+3000).toISOString()]);
      const latestFailed=await send();
      assert.ok(latestFailed.statusCode===409,
        `a newer failed parse snapshot must not silently fall back to the previous parsed snapshot: ${latestFailed.body}`);
      assert.doesNotMatch(latestFailed.body,/Synthetic literal quote/);

      activeUser=reviewerId;
      const crossOwner=await send(`/api/v1/reviewer/projects/${foreignProjectId}/materials/${materialId}/versions/1/parse-evidence`);
      assert.ok(crossOwner.statusCode===404,`a grant for a different owner/project cannot read this project: ${crossOwner.body}`);
      assert.doesNotMatch(crossOwner.body,/Synthetic literal quote/);
      activeUser=strangerId;
      const ungranted=await send();
      assert.equal(ungranted.statusCode,404,ungranted.body);
      assert.doesNotMatch(ungranted.body,/Synthetic literal quote/);
      activeUser=reviewerId;
      const unknown=await send(`/api/v1/reviewer/projects/${projectId}/materials/unknown-${suffix}/versions/1/parse-evidence`);
      assert.equal(unknown.statusCode,404,unknown.body);
      assert.doesNotMatch(unknown.body,/Synthetic literal quote/);

      await changeRuleApplicabilityReviewerGrant(pool,{...grantArgs,action:'revoke',reasonCode:'test_revoked',
        authorizationBasis:'Synthetic revocation for isolated PostgreSQL regression only.'});
      const revoked=await send();
      assert.equal(revoked.statusCode,404,revoked.body);
      assert.doesNotMatch(revoked.body,/Synthetic literal quote/);

      const audit=await pool.query(`SELECT payload FROM bb_outbox WHERE event_type='rule_applicability.reviewer_parse_evidence_read'
        AND aggregate_id=$1 ORDER BY created_at`,[projectId]);
      assert.equal(audit.rows.length,2,'successful pages are audited; stale/denied requests are not');
      assert.ok(audit.rows.every(row=>row.payload.reviewer_grant_id&&row.payload.snapshot_id));
      assert.ok(audit.rows.every(row=>!JSON.stringify(row.payload).includes('Synthetic literal quote')),
        'audit stores record IDs/hashes but never literal evidence content');
      assert.ok(audit.rows[0].payload.record_refs.some((row:any)=>row.record_sha256===sha('record-0')));
    }finally{await app.close();await pool.end();}
  });
