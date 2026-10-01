import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createServer } from '@bondbuddy/api';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadUserReferenceOutline } from './user-reference-outline.js';

const url = process.env.BB_TEST_DATABASE_URL;
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function savepointPool(connection: PoolClient): Pool {
  let sequence = 0;
  return {
    query: (sql: string, values?: unknown[]) => connection.query(sql, values),
    connect: async () => {
      const name = `user_reference_${++sequence}`;
      let active = false;
      return { release: () => undefined, query: async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') { await connection.query(`SAVEPOINT ${name}`); active = true; return { rows: [] }; }
        if (sql === 'COMMIT') { if (active) await connection.query(`RELEASE SAVEPOINT ${name}`); active = false; return { rows: [] }; }
        if (sql === 'ROLLBACK') { if (active) { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); } active = false; return { rows: [] }; }
        return connection.query(sql, values);
      } };
    },
  } as unknown as Pool;
}

test('user reference is owner scoped, immutable, review gated, and projects structure only', { skip: !url }, async () => {
  const root = new Pool({ connectionString: url });
  const connection = await root.connect();
  const pool = savepointPool(connection);
  const suffix = randomUUID().replace(/-/g, '');
  const owner = `refowner${suffix}`, foreign = `refforeign${suffix}`;
  const reviewer = `refreviewer${suffix}`, grantor = `refgrantor${suffix}`;
  const projectId = `refproject${suffix}`, materialId = `refmaterial${suffix}`;
  const wrongRoleId = `refaudit${suffix}`, snapshotId = `refsnapshot${suffix}`;
  const materialHash = sha(`synthetic-reference-${suffix}`);
  let activeOwner = owner;
  const app = createServer({ pool, allowedOrigin: origin, enableRunRuntime: true,
    principal: async () => ({ userId: activeOwner, csrfVerified: true }) });
  const request = (material: string, hash = materialHash, inputOwner = owner,
    targetProduct = 'synthetic_bond', targetStage = 'draft', parseId = snapshotId) => {
    activeOwner = inputOwner;
    return app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin }, payload: {
      draft_revision: 1, material_versions: [{ material_id: material, material_version: 1 }], requirement_message_ids: [],
      user_reference: { material_id: material, material_version: 1, material_sha256: hash,
        parse_snapshot_id: parseId, target_product: targetProduct, target_document_stage: targetStage },
    } });
  };
  try {
    await connection.query('BEGIN');
    for (const [id, name] of [[owner,'refowner'],[foreign,'refforeign'],[reviewer,'refreviewer'],[grantor,'refgrantor']] as const)
      await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id,`${name}${suffix.slice(0,12)}`]);
    await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering,update_details)
      VALUES($1,$2,'Synthetic generation','generation','sse','private','{}')`, [projectId,owner]);
    for (const [id,role] of [[materialId,'reference'],[wrongRoleId,'audit']] as const) {
      const uploadId = `upload${id}`;
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,$5,$6,now()+interval '1 hour','completed',$4,10)`,
        [uploadId,owner,projectId,materialHash,role,`synthetic/${uploadId}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$6,$7,'parsed')`,
        [id,owner,projectId,uploadId,role,materialHash,`synthetic/material/${id}`]);
    }
    const meta = { schema_version: 'document-parse-response-v1', request_id: `parse${suffix}`, status: 'parsed',
      parser_version: 'synthetic-parser', material: { material_id: materialId, material_version: 1,
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: materialHash },
      warnings: [], document: { page_count: 1 }, error: null };
    await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
      response_status,response_schema_version,response_sha256,record_count,response_meta)
      VALUES($1,$2,$3,$4,1,$5,'synthetic-parser',$6,'parsed','document-parse-response-v1',$7,1,$8)`,
      [snapshotId,owner,projectId,materialId,materialHash,sha(`request${suffix}`),sha(`response${suffix}`),JSON.stringify(meta)]);
    const addEvidence = async (parseId:string) => connection.query(`INSERT INTO bb_parse_evidence
      (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
       locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,
       uncertainty,formatting,record_sha256,ordinal)
      VALUES($1,$2,$3,1,$4,$5,$6,'docx_block','{}','发行概况','',
        'native_text','synthetic-parser',1,'[]','{}',$7,0)`,
    [owner,projectId,materialId,parseId,`record${parseId}`,materialHash,sha(`record${parseId}`)]);
    await addEvidence(snapshotId);

    assert.equal((await request(materialId, materialHash, foreign)).statusCode, 404, 'foreign owner cannot lock');
    assert.equal((await request(wrongRoleId)).statusCode, 422, 'wrong role cannot lock');
    assert.equal((await request(materialId, sha('wrong bytes'))).statusCode, 422, 'wrong hash cannot lock');
    const pending = await request(materialId);
    assert.equal(pending.statusCode, 201, pending.body);
    const first = pending.json();
    const pendingRow = (await connection.query('SELECT * FROM bb_user_reference_pins WHERE project_id=$1 AND input_revision=$2',
      [projectId,first.input_revision])).rows[0];
    assert.equal(pendingRow.status, 'needs_review');
    const scope = { ownerUserId: owner, projectId, runId: `run${suffix}`, inputRevision: first.input_revision, inputHash: first.input_hash };
    assert.deepEqual(await loadUserReferenceOutline(pool, scope), { status: 'needs_review', reason: 'pin_needs_review' });
    const preflight = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/preflight`,
      headers: { origin }, payload: { input_revision: first.input_revision, input_hash: first.input_hash } });
    assert.equal(preflight.statusCode, 200, preflight.body);
    assert.ok(preflight.json().missing_inputs.includes('user_reference_needs_review:needs_review'));
    const execution = { execution_request_id: `refexecute${suffix}`, project_id: projectId,
      input_revision: first.input_revision, input_hash: first.input_hash, task_kind: 'generation',
      input_manifest_ref: `manifest${suffix}`, storage_origin: 'cloud', workspace_id: `space${suffix}` };
    const execute = (payload: typeof execution) => app.inject({ method: 'POST', url: '/api/v1/runs/execute',
      headers: { origin }, payload });
    const firstRun = await execute(execution);
    assert.equal(firstRun.statusCode, 202, firstRun.body);
    const replay = await execute(execution);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().run_id, firstRun.json().run_id, 'same execution key replays one run');

    const grantId = `refgrant${suffix}`, reviewId = `refreview${suffix}`;
    await connection.query(`INSERT INTO bb_user_reference_reviewer_grants(id,reviewer_user_id,granted_by)
      VALUES($1,$2,$3)`, [grantId,reviewer,grantor]);
    const targetHash = inputManifestHash({ market:'sse',offering:'private',product:'synthetic_bond',document_stage:'draft' });
    await connection.query(`INSERT INTO bb_user_reference_target_contexts(id,owner_user_id,project_id,target_market,
      target_offering,target_product,target_document_stage,content_hash,status,reviewer_user_id,reviewer_grant_id)
      VALUES($1,$2,$3,'sse','private','synthetic_bond','draft',$4,'accepted',$5,$6)`,
      [`reftarget${suffix}`,owner,projectId,targetHash,reviewer,grantId]);
    assert.equal((await request(materialId,materialHash,owner,'other_bond','draft')).statusCode,422,
      'client product cannot select a different reviewed target');
    assert.equal((await request(materialId,materialHash,owner,'synthetic_bond','issuance')).statusCode,422,
      'client document stage cannot select a different reviewed target');
    const signedOutline = [{ order: 1, heading: '发行概况' }];
    await connection.query(`INSERT INTO bb_user_reference_reviews(id,owner_user_id,project_id,material_id,material_version,
      material_sha256,parse_snapshot_id,target_market,target_offering,target_product,target_document_stage,
      authorization_status,readability_status,applicability_status,status,fact_isolation_check_version,outline,
      confirmed_warning_codes,parse_response_sha256,signed_outline_sha256,
      reviewer_user_id,reviewer_grant_id)
      VALUES($1,$2,$3,$4,1,$5,$6,'sse','private','synthetic_bond','draft',
        'accepted','accepted','accepted','accepted','synthetic-isolation-v1',$7,'[]',$8,$9,$10,$11)`,
      [reviewId,owner,projectId,materialId,materialHash,snapshotId,JSON.stringify(signedOutline),
        sha(`response${suffix}`),inputManifestHash(signedOutline),reviewer,grantId]);
    const accepted = await request(materialId);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const second = accepted.json();
    const acceptedScope = { ...scope, inputRevision: second.input_revision, inputHash: second.input_hash };
    const loaded = await loadUserReferenceOutline(pool, acceptedScope);
    assert.equal(loaded.status, 'accepted');
    if (loaded.status === 'accepted') {
      assert.deepEqual(loaded.outline.chapters, [{ order: 1, heading: '发行概况' }]);
      assert.ok(!JSON.stringify(loaded.outline).includes('参考发行人甲'));
      assert.deepEqual(Object.keys(loaded.outline.chapters[0]!).sort(), ['heading','order'], 'no source facts or body fields');
    }
    assert.notEqual(first.input_hash, second.input_hash, 'review decision produces a new immutable input');
    const warningSnapshotId = `refwarnsnapshot${suffix}`, warningResponseHash = sha(`warningresponse${suffix}`);
    const warningMeta = { ...meta, request_id:`warningparse${suffix}`,status:'needs_confirmation',
      parser_version:'synthetic-parser-warning',warnings:[
        {code:'DOCX_DRAWINGS',message:'synthetic drawing'},
        {code:'DOCX_AUXILIARY_PARTS',message:'synthetic auxiliary part'}] };
    await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,
      content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,
      record_count,response_meta) VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-warning',$6,
      'needs_confirmation','document-parse-response-v1',$7,1,$8)`,
      [warningSnapshotId,owner,projectId,materialId,materialHash,sha(`warningrequest${suffix}`),
        warningResponseHash,JSON.stringify(warningMeta)]);
    await addEvidence(warningSnapshotId);
    await connection.query(`INSERT INTO bb_user_reference_reviews(id,owner_user_id,project_id,material_id,material_version,
      material_sha256,parse_snapshot_id,target_market,target_offering,target_product,target_document_stage,
      authorization_status,readability_status,applicability_status,status,fact_isolation_check_version,outline,
      confirmed_warning_codes,parse_response_sha256,signed_outline_sha256,reviewer_user_id,reviewer_grant_id)
      VALUES($1,$2,$3,$4,1,$5,$6,'sse','private','synthetic_bond','draft',
      'accepted','accepted','accepted','accepted','synthetic-isolation-v1',$7,$8,$9,$10,$11,$12)`,
      [`refwarnreview${suffix}`,owner,projectId,materialId,materialHash,warningSnapshotId,
        JSON.stringify(signedOutline),JSON.stringify(['DOCX_AUXILIARY_PARTS','DOCX_DRAWINGS']),
        warningResponseHash,inputManifestHash(signedOutline),reviewer,grantId]);
    const warningAccepted = await request(materialId,materialHash,owner,'synthetic_bond','draft',warningSnapshotId);
    assert.equal(warningAccepted.statusCode,201,warningAccepted.body);
    const warningInput = warningAccepted.json();
    assert.equal((await loadUserReferenceOutline(pool,{...scope,inputRevision:warningInput.input_revision,
      inputHash:warningInput.input_hash})).status,'accepted','confirmed body-safe DOCX warnings may be accepted');
    const changedReplay = await execute({ ...execution, input_revision: second.input_revision, input_hash: second.input_hash });
    assert.equal(changedReplay.statusCode, 409, 'same execution key cannot switch its locked input');
    await connection.query('UPDATE bb_user_reference_reviewer_grants SET revoked_at=now() WHERE id=$1', [grantId]);
    assert.deepEqual(await loadUserReferenceOutline(pool, acceptedScope), { status: 'needs_review', reason: 'target_context_stale' },
      'revoking a reviewer grant pauses the same immutable input');
    await connection.query('SAVEPOINT immutable_pin');
    await assert.rejects(connection.query(`UPDATE bb_user_reference_pins SET status='rejected' WHERE project_id=$1 AND input_revision=$2`,
      [projectId,second.input_revision]), /immutable input revision/);
    await connection.query('ROLLBACK TO SAVEPOINT immutable_pin');
  } finally {
    await connection.query('ROLLBACK');
    await app.close();
    connection.release();
    await root.end();
  }
});
