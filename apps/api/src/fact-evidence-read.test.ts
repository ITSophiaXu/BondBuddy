import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openApiDocument } from '@bondbuddy/contracts';
import { changeFactEvidenceReviewerGrant } from './fact-evidence-reviews.js';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('FACT_EVIDENCE_READ_TEST_DATABASE_URL');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const ready = async () => {
  if (!databaseUrl) return false;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query("SELECT to_regclass('public.bb_fact_evidence_context_sets') AS contexts,to_regclass('public.bb_fact_evidence_reviewer_grants') AS grants,to_regclass('public.bb_parse_evidence') AS evidence");
    return !!result.rows[0]?.contexts && !!result.rows[0]?.grants && !!result.rows[0]?.evidence;
  } finally { await pool.end(); }
};
const schemaReady = await ready();

test('fact evidence reviewer read exposes only current pinned native evidence and audits no quote text',
  { skip: !schemaReady && 'set FACT_EVIDENCE_READ_TEST_DATABASE_URL to a disposable PostgreSQL 16 template migrated through 0061' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `fer-owner-${suffix}`, reviewer = `fer-reviewer-${suffix}`, manager = `fer-manager-${suffix}`;
    const stranger = `fer-stranger-${suffix}`, foreignOwner = `fer-foreign-${suffix}`;
    const project = `fer-project-${suffix}`, foreignProject = `fer-project-x-${suffix}`;
    const material = `fer-material-${suffix}`, upload = `fer-upload-${suffix}`, snapshot = `fer-snapshot-${suffix}`;
    const candidate = `fer-candidate-${suffix}`, context = `fer-context-${suffix}`;
    const contentHash = sha(`synthetic material ${suffix}`), inputHash = sha(`synthetic input ${suffix}`);
    const responseHash = sha(`synthetic parse response ${suffix}`), factKey = {
      account_id: owner, entity_id: `issuer-${suffix}`, scope: 'consolidated', metric: 'assets',
      period: { start: null, end: '2025-12-31', as_of: null }, currency: 'CNY', unit: 'yuan', basis: 'balance_sheet', data_version: 'synthetic-v1',
    };
    const identityHash = sha(`identity ${suffix}`), recordIds = Array.from({ length: 51 }, (_, index) => `parse-record-${suffix}-${index}`);
    const recordHash = (index: number) => sha(`parse record ${suffix} ${index}`);
    const locator = (index: number) => ({ sheet: 'Synthetic', cell: `B${index + 4}` }), quote = (index: number) => `SENSITIVE SYNTHETIC QUOTE ${suffix} ${index}`;
    const auxiliary = { target_id: `header-target-${suffix}`, kind: 'header', part_name: 'word/header1.xml', part_sha256: sha(`header part ${suffix}`),
      target_sha256: sha(`header target ${suffix}`), parse_status: 'parsed', scope: { kind: 'section_reference', status: 'unknown',
        relationship_part_sha256: sha(`relationships ${suffix}`), relationships: [], section_references: [], unknown_sections: [0],
        body_references: [], reason: 'section relation is unknown', truncated: false } };
    let activeUser = reviewer;
    const app = createServer({ pool, allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: activeUser, csrfVerified: true }) });
    const url = `/api/v1/reviewer/projects/${project}/facts/candidates/${candidate}/evidence`;
    const send = (path = url) => app.inject({ method: 'GET', url: path, headers: { origin: 'http://bondbuddy.test' } });
    const grantInput = { action: 'grant' as const, reviewerUserId: reviewer, actorUserId: manager, reasonCode: 'authorized_test',
      authorizationBasis: 'Synthetic isolated PostgreSQL integration fixture only.', ownerUserId: owner, projectId: project };
    try {
      const users = [[owner, 'owner'], [reviewer, 'reviewer'], [manager, 'manager'], [stranger, 'stranger'], [foreignOwner, 'foreign']] as const;
      for (const [id, tag] of users) await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `fer${tag}${suffix}`]);
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,draft_revision)
        VALUES($1,$2,'Synthetic fact evidence read','update',1),($3,$4,'Synthetic foreign project','update',1)`, [project, owner, foreignProject, foreignOwner]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',30,$4,'financial',$5,now()+interval '1 hour','completed')`,
      [upload, owner, project, contentHash, `synthetic/${upload}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'financial','synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',30,$5,$6,'parsed')`,
      [material, owner, project, upload, contentHash, `users/${owner}/projects/${project}/${material}`]);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,'{}','[]','[]')`, [project, owner, inputHash]);
      await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, project]);
      const responseMeta = { schema_version: 'document-parse-response-v1', request_id: `parse-${suffix}`, status: 'parsed', parser_version: 'synthetic-parser-1',
        material: { material_id: material, material_version: 1, media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sha256: contentHash },
        warnings: [{ code: 'SYNTHETIC_WARNING', message: 'Synthetic parser warning retained for reviewer context.' }], document: { auxiliary_targets: [auxiliary] }, error: null };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-1',$6,'parsed','document-parse-response-v1',$7,51,$8::jsonb)`,
      [snapshot, owner, project, material, contentHash, sha(`request ${suffix}`), responseHash, JSON.stringify(responseMeta)]);
      for (const [index, recordId] of recordIds.entries()) await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,
        extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'xlsx_cell',$7::jsonb,$8,'synthetic context','native_text','synthetic-parser-1',0.75,'["CELL_PARSE_UNCERTAIN"]'::jsonb,'{}'::jsonb,$9,$10)`,
      [owner, project, material, snapshot, recordId, contentHash, JSON.stringify(locator(index)), quote(index), recordHash(index), index]);
      await pool.query(`INSERT INTO bb_fact_candidates(id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_decimal,value_kind,source_kind,source_ref,status,material_id,material_version,evidence,uncertainty)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,'123.450','decimal','audited','audit-report-page-4','extracted',$7,1,$8::jsonb,$9::jsonb)`,
      [candidate, owner, project, factKey.entity_id, identityHash, JSON.stringify(factKey), material,
        JSON.stringify([{ evidence_id: recordIds[0], material_id: material, material_version: 1 }]), JSON.stringify(['CELL_PARSE_UNCERTAIN'])]);
      const manifestBase = { schema_version: 'fact-evidence-context-v1', owner_user_id: owner, project_id: project, candidate_id: candidate,
        input_revision: 1, input_hash: inputHash, candidate_identity_sha256: identityHash, fact_identity: factKey, source_kind: 'audited', candidate_status: 'extracted',
        candidate_value: { value_kind: 'decimal', value_decimal: '123.45', value_text: null },
        candidate_uncertainty: ['CELL_PARSE_UNCERTAIN'], candidate_confidence: 0.75, material_id: material, material_version: 1, material_sha256: contentHash,
        snapshot_id: snapshot, parser_version: 'synthetic-parser-1', parse_request_hash: sha(`request ${suffix}`), parse_response_sha256: responseHash, parse_status: 'parsed',
        original_warnings: responseMeta.warnings, selected_body: recordIds.map((recordId, index) => ({ record_id: recordId, content_sha256: contentHash, locator_type: 'xlsx_cell', locator: locator(index),
          confidence: 0.75, uncertainty: ['CELL_PARSE_UNCERTAIN'] })), auxiliary_targets: [{ ...auxiliary, relevance: 'unknown',
          relevance_reason: 'section_scope_not_mapped_to_selected_body_records' }], completeness_status: 'incomplete',
        completeness_reasons: ['SYNTHETIC_INCOMPLETE_FIXTURE'], reviewable: false };
      const contextHash = sha(canonical(manifestBase));
      await pool.query(`INSERT INTO bb_fact_evidence_context_sets(id,owner_user_id,project_id,candidate_id,input_revision,input_hash,material_id,material_version,snapshot_id,parser_version,
        parse_response_sha256,content_sha256,schema_version,evidence_set_sha256,completeness_status,reviewable,manifest)
        VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'synthetic-parser-1',$8,$9,'fact-evidence-context-v1',$10,'incomplete',false,$11::jsonb)`,
      [context, owner, project, candidate, inputHash, material, snapshot, responseHash, contentHash, contextHash,
        JSON.stringify({ ...manifestBase, evidence_set_sha256: contextHash })]);
      await changeFactEvidenceReviewerGrant(pool, grantInput);

      const current = await send();
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.headers['cache-control'], 'private, no-store');
      const body = current.json();
      assert.equal(body.evidence_context_set_id, context);
      assert.equal(body.evidence_set_sha256, contextHash);
      assert.equal(body.candidate.value_decimal, '123.45');
      assert.deepEqual(body.candidate.identity, factKey);
      assert.equal(body.candidate.source_kind, 'audited');
      assert.equal(body.items.length, 50);
      assert.equal(body.items[0].record_id, recordIds[0]);
      assert.equal(body.items[0].record_sha256, recordHash(0));
      assert.equal(body.items[0].literal_quote, quote(0));
      assert.equal(body.parse_warnings[0].code, 'SYNTHETIC_WARNING');
      assert.equal(body.auxiliary_targets[0].part_sha256, auxiliary.part_sha256);
      assert.equal(body.auxiliary_targets[0].scope.status, 'unknown');
      assert.equal(body.verification_effect, 'none');
      assert.ok(body.next_cursor);
      const secondPage = await send(`${url}?cursor=${encodeURIComponent(body.next_cursor)}`);
      assert.equal(secondPage.statusCode, 200, secondPage.body);
      assert.equal(secondPage.json().items.length, 1);
      assert.equal(secondPage.json().items[0].record_id, recordIds[50]);
      assert.equal(secondPage.json().next_cursor, null);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,2,$2,1,$3,'{}','[]','[]')`, [project, owner, sha(`changed input ${suffix}`)]);
      await pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE owner_user_id=$1 AND id=$2', [owner, project]);
      const changedInput = await send(); assert.equal(changedInput.statusCode, 409, changedInput.body);
      await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2', [owner, project]);
      const op = (openApiDocument().paths as Record<string, any>)['/api/v1/reviewer/projects/{project_id}/facts/candidates/{candidate_id}/evidence'].get;
      assert.equal(op['x-implementation-status'], 'implemented; requires-valid-session');

      activeUser = stranger;
      const denied = await send(); assert.equal(denied.statusCode, 404, denied.body); assert.doesNotMatch(denied.body, new RegExp(quote(0)));
      activeUser = owner;
      const ownerDenied = await send(); assert.equal(ownerDenied.statusCode, 404, 'owner cannot act as their own reviewer');
      activeUser = reviewer;
      const wrongProject = await send(`/api/v1/reviewer/projects/${foreignProject}/facts/candidates/${candidate}/evidence`);
      assert.equal(wrongProject.statusCode, 404, wrongProject.body);

      const latestSnapshot = `${snapshot}-latest`, latestHash = sha(`new failed parse response ${suffix}`);
      const latestMeta = { ...responseMeta, request_id: `parse-latest-${suffix}`, status: 'failed', parser_version: 'synthetic-parser-2',
        document: { page_count: 0 }, error: { code: 'SYNTHETIC_PARSE_FAILED' } };
      await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,response_status,response_schema_version,response_sha256,record_count,response_meta,created_at)
        VALUES($1,$2,$3,$4,1,$5,'synthetic-parser-2',$6,'failed','document-parse-response-v1',$7,0,$8::jsonb,now()+interval '1 second')`,
      [latestSnapshot, owner, project, material, contentHash, sha(`request latest ${suffix}`), latestHash, JSON.stringify(latestMeta)]);
      const stale = await send(`${url}?cursor=${encodeURIComponent(body.next_cursor)}`); assert.equal(stale.statusCode, 409, stale.body); assert.doesNotMatch(stale.body, new RegExp(quote(0)));
      const uploadV2 = `${upload}-v2`, materialHashV2 = sha(`changed material ${suffix}`);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic-v2.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',31,$4,'financial',$5,now()+interval '1 hour','completed')`,
      [uploadV2, owner, project, materialHashV2, `synthetic/${uploadV2}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,2,$2,$3,$4,'financial','synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',31,$5,$6,'parsed')`,
      [material, owner, project, uploadV2, materialHashV2, `users/${owner}/projects/${project}/${material}/v2`]);
      const changedMaterial = await send(); assert.equal(changedMaterial.statusCode, 409, changedMaterial.body);
      await changeFactEvidenceReviewerGrant(pool, { ...grantInput, action: 'revoke', reasonCode: 'scope_ended',
        authorizationBasis: 'Synthetic revocation fixture', reason: 'Synthetic revocation fixture' });
      const revoked = await send(); assert.equal(revoked.statusCode, 404, revoked.body); assert.doesNotMatch(revoked.body, new RegExp(quote(0)));

      const audit = await pool.query(`SELECT payload FROM bb_outbox WHERE event_type='fact_evidence.reviewer_read' AND aggregate_id=$1`, [project]);
      assert.equal(audit.rows.length, 2, 'each successful page is audited; denied and stale reads are not');
      assert.deepEqual(audit.rows[0]!.payload.record_refs[0], { record_id: recordIds[0], record_sha256: recordHash(0) });
      assert.ok(audit.rows.every(row => !JSON.stringify(row.payload).includes(`SENSITIVE SYNTHETIC QUOTE ${suffix}`)));
      assert.equal((await pool.query('SELECT status FROM bb_fact_candidates WHERE id=$1', [candidate])).rows[0]!.status, 'extracted', 'read does not mutate candidate status');
    } finally { await app.close(); await pool.end(); }
  });
