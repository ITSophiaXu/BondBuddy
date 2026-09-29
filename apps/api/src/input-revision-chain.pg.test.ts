import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { projectMessageSetRef, type GenerationIssuerBindingRef } from '@bondbuddy/contracts';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { pdfSample, PDF } from './upload-safety.samples.js';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from './issuer-identity-source.js';
import {
  appendGenerationIssuerBinding,
  loadApprovedGenerationIssuerBindingForLock,
  reviewGenerationIssuerBinding,
  type GenerationIssuerBindingDecisionInput,
} from './generation-issuer-binding.js';
import { loadCurrentProjectMessageSetPin } from './project-message-set-lock.js';
import { inputManifestHash } from './production-rule-pin.js';

// #33/#76/#15 HTTP-level chain: real registration/session, project creation and material upload drive
// the immutable input-revision lock, while reviewer grants, parse evidence, the approved generation
// issuer binding and the message-set pin are exact test fixtures around the HTTP calls. The module
// seams (imports above) are the same ones the public routes use; nothing here rewrites production logic.

const databaseUrl = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const connection = await isolatedTestDatabase(undefined, 'input-revision-chain');
const origin = 'http://bondbuddy.test';
const termsVersion = 'synthetic-chain-v1';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ENTITY = 'entity:11111111-1111-4111-8111-111111111111';
const ENTITY_BASIS = { verifiedEntityId: ENTITY, entityBasisKind: 'manual_attestation' as const, entityBasisRef: 'synthetic chain identity review' };

interface Session { readonly userId: string; readonly cookies: Record<string, string> }
interface MaterialRef { readonly materialId: string; readonly sha256: string }
interface EvidenceSpec { readonly recordId: string; readonly quote: string }

const cookieHeader = (session: Session) => Object.entries(session.cookies).map(([key, value]) => `${key}=${value}`).join('; ');
function parseJar(response: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
  return Object.fromEntries(values.map((value) => value.split(';')[0]!.split('=') as [string, string]));
}

function makeHarness(pool: Pool) {
  const blobs = azureBlobs(blobConnection!, `bb-chain-${randomUUID().replaceAll('-', '')}`);
  const app = createServer({ pool, blobs, allowedOrigin: origin, auth: { termsVersion, supportContact: 'synthetic-support' } });
  const send = (method: string, url: string, payload?: unknown, session?: Session) => app.inject({
    method: method as never, url,
    headers: { origin, ...(session ? { cookie: cookieHeader(session), 'x-bb-csrf': session.cookies.bb_csrf! } : {}),
      ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) },
    payload: payload as never,
  });
  const register = async (prefix: string, suffix: string): Promise<Session> => {
    const password = `synthetic chain password ${suffix}`;
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin },
      payload: { username: `${prefix}${suffix}`, password, accepted_terms_version: termsVersion } });
    assert.equal(response.statusCode, 201, response.body);
    return { userId: response.json().user_id as string, cookies: parseJar(response) };
  };
  const createGenerationProject = async (session: Session): Promise<string> => {
    const response = await send('POST', '/api/v1/projects', {
      name: 'Synthetic generation chain', kind: 'generation', issuer_name: 'Browser supplied name', market: 'sse', offering: 'private' }, session);
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const upload = async (projectId: string, session: Session, role: string, label: string): Promise<MaterialRef> => {
    const bytes = pdfSample({ tag: `chain-${label}` });
    const declaration = { byte_size: bytes.length, sha256: digest(bytes) };
    const created = await send('POST', `/api/v1/projects/${projectId}/materials/uploads`,
      { ...declaration, filename: `${label}.pdf`, media_type: PDF, role }, session);
    assert.equal(created.statusCode, 201, created.body);
    const uploadSession = created.json();
    const put = await send('PUT', uploadSession.upload_url as string, bytes, session);
    assert.equal(put.statusCode, 204, put.body);
    const complete = await send('POST', `/api/v1/projects/${projectId}/materials/uploads/${uploadSession.upload_id}/complete`, declaration, session);
    assert.equal(complete.statusCode, 200, complete.body);
    return { materialId: complete.json().material_id as string, sha256: declaration.sha256 };
  };
  return { app, send, register, createGenerationProject, upload };
}

/** Fixture only: the real parser worker writes these rows; the API chain reads them as immutable evidence. */
async function insertParseEvidence(pool: Pool, args: {
  owner: string; projectId: string; materialId: string; materialSha256: string; parserVersion: string; evidence: EvidenceSpec;
}): Promise<void> {
  const { owner, projectId, materialId, materialSha256, parserVersion, evidence } = args;
  const snapshotId = `snapshot-${materialId}`;
  const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${snapshotId}`, status: 'parsed',
    parser_version: parserVersion, material: { material_id: materialId, material_version: 1, media_type: PDF, sha256: materialSha256 },
    warnings: [], document: { page_count: 1 }, error: null };
  await pool.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
    response_status,response_schema_version,response_sha256,record_count,response_meta)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
  [snapshotId, owner, projectId, materialId, materialSha256, parserVersion, sha(`parse-request-${snapshotId}`),
    sha(`parse-response-${snapshotId}`), JSON.stringify(meta)]);
  await pool.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
    locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
    VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,$8,'synthetic chain evidence','native_text',$9,0.99,'[]','{}',$10,0)`,
  [owner, projectId, materialId, snapshotId, evidence.recordId, materialSha256,
    JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), evidence.quote, parserVersion, sha(evidence.recordId)]);
}

/** Fixture only: the conversation seam writes these rows; #76 reads them as the active message-set pin. */
async function insertProjectMessage(pool: Pool, args: { owner: string; projectId: string; messageId: string; version: number; messageVersion: number; body: string }) {
  const { owner, projectId, messageId, version, messageVersion, body } = args;
  const snapshotId = `msg-snapshot-${messageId}-${version}`;
  await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
    VALUES($1,$2,$3,'user_prompt',$4,$5,$6,'v1')`,
  [snapshotId, owner, projectId, version, `users/${owner}/projects/${projectId}/snapshots/${snapshotId}`, digest(body)]);
  await pool.query(`INSERT INTO bb_user_submission_versions(id,owner_user_id,project_id,snapshot_id,submission_kind,message_id,submission_request_id,message_version,version,content_sha256)
    VALUES($1,$2,$3,$4,'project_message',$5,$6,$7,$8,$9)`,
  [`msg-submission-${messageId}-${version}`, owner, projectId, snapshotId, messageId, `msg-request-${messageId}-${version}`, messageVersion, version, digest(body)]);
}

/**
 * Real HTTP chain through input revision 1, then exact fixtures plus an approved binding and a
 * non-empty message set ready for the pinned input revision under test.
 */
async function provisionHttpChain(harness: ReturnType<typeof makeHarness>, pool: Pool, suffix: string) {
  const owner = await harness.register('own', suffix);
  const reviewer = await harness.register('rev', suffix);
  const grantor = await harness.register('grt', suffix);
  const factReviewer = await harness.register('fct', suffix);
  const intruder = await harness.register('int', suffix);

  const projectId = await harness.createGenerationProject(owner);
  const audit = await harness.upload(projectId, owner, 'audit', `audit-${suffix}`);
  const notes = await harness.upload(projectId, owner, 'notes', `notes-${suffix}`);
  const materials = [{ material_id: audit.materialId, material_version: 1 }, { material_id: notes.materialId, material_version: 1 }];

  const first = await harness.send('POST', `/api/v1/projects/${projectId}/input-revisions`,
    { draft_revision: 1, requirement_message_ids: [], material_versions: materials }, owner);
  assert.equal(first.statusCode, 201, first.body);
  const inputRevision = first.json().input_revision as number;
  const inputHash = (first.json().input_hash as string).trim();
  const firstManifest = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
    [owner.userId, projectId, inputRevision])).rows[0].manifest as Record<string, unknown>;
  assert.equal(Object.hasOwn(firstManifest, 'generation_issuer_binding_ref'), false, 'the first lock never fabricates a binding pin');
  const missingPreflight=await harness.send('POST',`/api/v1/projects/${projectId}/preflight`,
    {input_revision:inputRevision,input_hash:inputHash},owner);
  assert.equal(missingPreflight.statusCode,200,missingPreflight.body);
  assert.ok(missingPreflight.json().missing_inputs.includes('issuer_identity_not_bound:generation_issuer_binding_missing_or_unapproved'));

  const parserVersion = `parser-chain-${suffix}`;
  const auditEvidence = `audit-evidence-${suffix}`, notesEvidence = `notes-evidence-${suffix}`;
  await insertParseEvidence(pool, { owner: owner.userId, projectId, materialId: audit.materialId, materialSha256: audit.sha256,
    parserVersion, evidence: { recordId: auditEvidence, quote: '合成发行人甲合并资产负债表' } });
  await insertParseEvidence(pool, { owner: owner.userId, projectId, materialId: notes.materialId, materialSha256: notes.sha256,
    parserVersion, evidence: { recordId: notesEvidence, quote: '本公司为合成发行人甲有限公司' } });

  await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
    VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [`grant-${suffix}`, reviewer.userId, grantor.userId, owner.userId, projectId]);
  await pool.query(`INSERT INTO bb_fact_evidence_reviewer_grants(id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
    VALUES($1,$2,'fact_evidence_reviewer',$3,'synthetic_test','synthetic chain fixture',$4,$5)`,
  [`fact-grant-${suffix}`, factReviewer.userId, grantor.userId, owner.userId, projectId]);

  assert.equal(await authorizeIssuerIdentityReviewer(pool, factReviewer.userId, { ownerUserId: owner.userId, projectId }), null,
    'a project-scoped fact evidence reviewer never holds issuer identity authority');
  const reviewerContext = await authorizeIssuerIdentityReviewer(pool, reviewer.userId, { ownerUserId: owner.userId, projectId });
  assert.ok(reviewerContext, 'the exact project-scoped issuer identity grant authorizes the reviewer');

  const addReview = async (materialId: string, recordId: string) => {
    const reviewerBase=`/api/v1/reviewer/projects/${projectId}/materials/${materialId}/versions/1`;
    const evidence=await harness.send('GET',`${reviewerBase}/issuer-parse-evidence`,undefined,reviewer);
    assert.equal(evidence.statusCode,200,evidence.body);
    assert.equal(evidence.json().items[0].record_id,recordId);
    assert.equal((await harness.send('GET',`${reviewerBase}/issuer-parse-evidence`,undefined,factReviewer)).statusCode,404,
      'another reviewer role cannot read issuer anchors');
    const proposalUrl=`${reviewerBase}/issuer-identity/observations`;
    const proposalBody={request_id:`request-${recordId}`,evidence_record_id:recordId,
      issuer_display_name:'合成发行人甲',candidate_key:`issuer-name:v1:${sha('合成发行人甲').slice(0,32)}`};
    const proposed=await harness.send('POST',proposalUrl,proposalBody,reviewer);
    assert.equal(proposed.statusCode,201,proposed.body);
    const proposalEvent=(await pool.query(`SELECT payload FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2
      AND event_type='issuer.identity_source.needs_review' AND payload->>'source_record_row_id'=$3`,
    [owner.userId,projectId,proposed.json().source_record_id])).rows[0]?.payload;
    assert.equal(proposalEvent?.proposed_by,reviewer.userId,'proposal audit identifies the authorized reviewer');
    assert.equal(proposalEvent?.source_quote,undefined,'outbox does not copy source text');
    assert.equal((await harness.send('POST',proposalUrl,proposalBody,reviewer)).json().replayed,true);
    assert.equal((await harness.send('POST',proposalUrl,{...proposalBody,issuer_display_name:'另一合成主体'},reviewer)).statusCode,409,
      'a reused request key cannot change the source observation');
    const ownerRead=await harness.send('GET',`/api/v1/projects/${projectId}/materials/${materialId}/versions/1/issuer-identity/observations`,undefined,owner);
    assert.equal(ownerRead.statusCode,200,ownerRead.body);
    assert.equal(ownerRead.json().items[0].quote,undefined,'owner receives status without original quote');
    const listed=await harness.send('GET',proposalUrl,undefined,reviewer);
    assert.equal(listed.statusCode,200,listed.body);
    const item=listed.json().items[0];
    const reviewed=await harness.send('POST',`/api/v1/projects/${projectId}/materials/${materialId}/versions/1/issuer-identity/observations/${proposed.json().source_record_id}/review`,{
      decision:'verified',reason_code:'synthetic_verified',expected_content_sha256:item.content_sha256,
      expected_snapshot_sha256:item.snapshot_sha256,verified_entity_id:ENTITY,
      entity_basis_kind:'manual_attestation',entity_basis_ref:'synthetic chain identity review',
    },reviewer);
    assert.equal(reviewed.statusCode,201,reviewed.body);
    return reviewed.json().review_id as string;
  };
  const auditReview = await addReview(audit.materialId, auditEvidence);
  const notesReview = await addReview(notes.materialId, notesEvidence);

  const deps = { pool, newId: randomUUID };
  const materialDecisions: GenerationIssuerBindingDecisionInput[] = [
    { material_id: audit.materialId, material_version: 1, disposition: 'classified', reason: '合并编制主体。',
      observations: [{ source_record_id: auditEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'financial_statement',
        subject_relation: 'issuer_compiler', accounting_scope: 'consolidated', relation_reason: '合并编制主体。', source_identity_review_id: auditReview }] },
    { material_id: notes.materialId, material_version: 1, disposition: 'classified', reason: '附注主体说明。',
      observations: [{ source_record_id: notesEvidence, observed_subject_label: '合成发行人甲', evidence_context: 'identity_relationship',
        subject_relation: 'issuer_compiler', accounting_scope: 'not_applicable', relation_reason: '附注主体说明。', source_identity_review_id: notesReview }] },
  ];
  const bindingUrl=`/api/v1/reviewer/projects/${projectId}/generation-issuer-bindings`;
  assert.equal((await harness.send('GET',`/api/v1/reviewer/projects/${projectId}/materials/${audit.materialId}/versions/1/issuer-parse-evidence`,undefined,owner)).statusCode,404);
  const bindingBody={request_id:`binding-${suffix}`,input_revision:inputRevision,input_hash:inputHash,material_decisions:materialDecisions};
  assert.equal((await harness.send('POST',bindingUrl,bindingBody,owner)).statusCode,404,
    'owner without a reviewer grant cannot append a binding');
  const appended=await harness.send('POST',bindingUrl,bindingBody,reviewer);
  assert.equal(appended.statusCode,201,appended.body);
  const bindingRef=appended.json().binding_ref as GenerationIssuerBindingRef;
  assert.equal((await harness.send('POST',bindingUrl,bindingBody,reviewer)).json().created,false);
  assert.equal((await harness.send('POST',bindingUrl,{...bindingBody,input_hash:sha('different lock')},reviewer)).statusCode,409,
    'a binding request key cannot be rebound to another input');
  const refUrl=`/api/v1/projects/${projectId}/generation-issuer-bindings/${bindingRef.binding_id}/versions/${bindingRef.version}/approved-ref`;
  assert.equal((await harness.send('GET',refUrl,undefined,owner)).statusCode,404,'pending binding has no owner ref');
  assert.equal((await harness.send('POST',`${bindingUrl}/${bindingRef.binding_id}/review`,{
    request_id:`unauthorized-${suffix}`,action:'approve',expected_binding:bindingRef,reason:'逐项核验。',
  },owner)).statusCode,404,'owner cannot approve the binding');
  const approved=await harness.send('POST',`${bindingUrl}/${bindingRef.binding_id}/review`,{
    request_id:`approve-${suffix}`,action:'approve',expected_binding:bindingRef,reason:'逐项核验。',
  },reviewer);
  assert.equal(approved.statusCode,201,approved.body);
  assert.equal(approved.json().status,'approved');
  const readRef=await harness.send('GET',refUrl,undefined,owner);
  assert.equal(readRef.statusCode,200,readRef.body);
  assert.deepEqual(readRef.json().binding_ref,bindingRef);
  assert.equal(readRef.json().selected_materials,undefined,'owner ref response excludes evidence');
  assert.equal((await harness.send('GET',refUrl,undefined,reviewer)).statusCode,404,'reviewer cannot read an owner ref');
  assert.equal((await harness.send('POST',bindingUrl,bindingBody,reviewer)).json().status,'approved',
    'a replay returns the current reviewed status without creating another binding');
  assert.ok(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: owner.userId, projectId }, bindingRef),
    'the approved binding re-verifies against the live anchors for the lock');

  await insertProjectMessage(pool, { owner: owner.userId, projectId, messageId: `message-a-${suffix}`, version: 1, messageVersion: 1, body: '合成补充要求一' });
  await insertProjectMessage(pool, { owner: owner.userId, projectId, messageId: `message-b-${suffix}`, version: 2, messageVersion: 1, body: '合成补充要求二' });
  const pin = await loadCurrentProjectMessageSetPin(pool, { ownerUserId: owner.userId, projectId });
  const messageRef = projectMessageSetRef(pin);
  assert.equal(messageRef.message_ids.length, 2);

  const withdraw = () => reviewGenerationIssuerBinding(deps, { ownerUserId: owner.userId, projectId, bindingId: bindingRef.binding_id,
    version: bindingRef.version, contentSha256: bindingRef.content_sha256, requestId: `withdraw-${suffix}`, action: 'withdraw', reason: '材料撤回。', reviewer: reviewerContext });

  return { owner, reviewer, factReviewer, intruder, projectId, materials, audit, notes, bindingRef, messageRef, withdraw };
}

const revisions = async (pool: Pool, ownerId: string, projectId: string) => {
  const row = (await pool.query('SELECT latest_input_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2', [ownerId, projectId])).rows[0];
  const count = (await pool.query('SELECT count(*)::int AS n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2', [ownerId, projectId])).rows[0].n;
  return { latest: Number(row.latest_input_revision), count: Number(count) };
};

test('HTTP chain: register/session, project and upload drive a locked input revision that pins an approved issuer binding and exact message set', 
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const harness = makeHarness(pool);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    try {
      const chain = await provisionHttpChain(harness, pool, suffix);
      const pinned = await harness.send('POST', `/api/v1/projects/${chain.projectId}/input-revisions`, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: chain.materials,
        generation_issuer_binding_ref: chain.bindingRef,
        project_message_set_ref: chain.messageRef,
      }, chain.owner);
      assert.equal(pinned.statusCode, 201, pinned.body);
      const revision = pinned.json().input_revision as number;
      const row = (await pool.query('SELECT revision, input_hash, manifest, requirement_message_ids FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [chain.owner.userId, chain.projectId, revision])).rows[0];
      assert.deepEqual(row.manifest.generation_issuer_binding_ref, chain.bindingRef, 'the exact binding ref is pinned into the immutable manifest');
      assert.equal(row.manifest.generation_issuer_entity_id, ENTITY, 'the approved legal entity is pinned, never the browser name');
      assert.equal(row.manifest.issuer_name, 'Browser supplied name');
      assert.deepEqual(row.manifest.project_message_set_ref, chain.messageRef, 'the exact message-set aggregate ref is pinned');
      assert.deepEqual(row.requirement_message_ids, chain.messageRef.message_ids, 'the legacy requirement column mirrors the pinned set');
      assert.equal(inputManifestHash(row.manifest), String(row.input_hash).trim(), 'the stored input_hash commits to the pinned manifest');
      const preflight=await harness.send('POST',`/api/v1/projects/${chain.projectId}/preflight`,
        {input_revision:revision,input_hash:pinned.json().input_hash},chain.owner);
      assert.equal(preflight.statusCode,200,preflight.body);
      assert.equal(preflight.json().missing_inputs.includes('issuer_identity_not_bound:generation_issuer_binding_missing_or_unapproved'),false,
        'the approved exact binding passes the issuer admission gate');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2',
        [chain.owner.userId,chain.projectId])).rows[0].n,0,'preflight and rejected calls create no run');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id WHERE a.owner_user_id=$1 AND j.project_id=$2',
        [chain.owner.userId,chain.projectId])).rows[0].n,0,'no model attempt is created');

      // Replay idempotency: an identical draft and refs produce the same immutable input hash.
      const replayed = await harness.send('POST', `/api/v1/projects/${chain.projectId}/input-revisions`, {
        draft_revision: 1, requirement_message_ids: [],
        material_versions: chain.materials,
        generation_issuer_binding_ref: chain.bindingRef,
        project_message_set_ref: chain.messageRef,
      }, chain.owner);
      assert.equal(replayed.statusCode, 201, replayed.body);
      assert.equal((replayed.json().input_hash as string).trim(), String(row.input_hash).trim(), 'identical refs share one input hash');

      // Owner isolation on the read path.
      const ownRead = await harness.send('GET', `/api/v1/projects/${chain.projectId}/input-revisions/${revision}`, undefined, chain.owner);
      assert.equal(ownRead.statusCode, 200, ownRead.body);
      assert.equal(ownRead.json().input_hash, pinned.json().input_hash);
      for (const outsider of [chain.intruder, chain.reviewer, chain.factReviewer]) {
        const denied = await harness.send('GET', `/api/v1/projects/${chain.projectId}/input-revisions/${revision}`, undefined, outsider);
        assert.equal(denied.statusCode, 404, `a non-owner session cannot read the pinned revision (${outsider.userId})`);
      }
    } finally { await harness.app.close(); await pool.end(); }
  });

test('HTTP chain: missing, withdrawn, mismatched and cross-account refs are refused without persisting a revision',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const harness = makeHarness(pool);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    try {
      const chain = await provisionHttpChain(harness, pool, suffix);
      const before = await revisions(pool, chain.owner.userId, chain.projectId);
      assert.equal(before.count, 1);
      const post = (payload: Record<string, unknown>, session = chain.owner) =>
        harness.send('POST', `/api/v1/projects/${chain.projectId}/input-revisions`, payload, session);
      const base = { draft_revision: 1, requirement_message_ids: [], material_versions: chain.materials };

      // A non-empty active message set must be pinned exactly; omission is refused, never bound as [].
      const missingMessage = await post({ ...base, generation_issuer_binding_ref: chain.bindingRef });
      assert.equal(missingMessage.statusCode, 409, missingMessage.body);

      // An unknown/withdrawn binding ref never falls back to a latest binding or the browser name.
      const unknownBinding = await post({ ...base, generation_issuer_binding_ref: { binding_id: `unknown-${suffix}`, version: 1, content_sha256: 'a'.repeat(64) }, project_message_set_ref: chain.messageRef });
      assert.equal(unknownBinding.statusCode, 409, unknownBinding.body);

      // A bare or divergent member projection can never match the exact aggregate ref.
      const divergentSet = await post({ ...base, generation_issuer_binding_ref: chain.bindingRef,
        project_message_set_ref: { ...chain.messageRef, message_ids: [chain.messageRef.message_ids[0]!] } });
      assert.equal(divergentSet.statusCode, 409, divergentSet.body);

      // A member not covered by the approved binding's issuer-material set is refused.
      const extra = await harness.upload(chain.projectId, chain.owner, 'audit', `extra-audit-${suffix}`);
      const memberMismatch = await post({ draft_revision: 1, requirement_message_ids: [],
        material_versions: [...chain.materials, { material_id: extra.materialId, material_version: 1 }],
        generation_issuer_binding_ref: chain.bindingRef, project_message_set_ref: chain.messageRef });
      assert.equal(memberMismatch.statusCode, 409, memberMismatch.body);

      // Cross-account: another owner's session cannot reach this project, and this binding ref grants nothing in their own project.
      const intruder = await harness.register('frn', suffix);
      const crossProject = await harness.send('POST', `/api/v1/projects/${chain.projectId}/input-revisions`,
        { ...base, generation_issuer_binding_ref: chain.bindingRef, project_message_set_ref: chain.messageRef }, intruder);
      assert.equal(crossProject.statusCode, 404, crossProject.body);
      const intruderProject = await harness.createGenerationProject(intruder);
      const intruderMaterial = await harness.upload(intruderProject, intruder, 'audit', `intruder-audit-${suffix}`);
      const crossRef = await harness.send('POST', `/api/v1/projects/${intruderProject}/input-revisions`,
        { draft_revision: 1, requirement_message_ids: [], material_versions: [{ material_id: intruderMaterial.materialId, material_version: 1 }],
          generation_issuer_binding_ref: chain.bindingRef }, intruder);
      assert.equal(crossRef.statusCode, 409, crossRef.body);

      const after = await revisions(pool, chain.owner.userId, chain.projectId);
      assert.deepEqual(after, before, 'every refusal leaves the immutable revision ledger and project pointer untouched');
    } finally { await harness.app.close(); await pool.end(); }
  });

test('HTTP chain: a withdrawn approved binding is refused for the lock and leaves no new revision',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const harness = makeHarness(pool);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    try {
      const chain = await provisionHttpChain(harness, pool, suffix);
      await chain.withdraw();
      assert.equal(await loadApprovedGenerationIssuerBindingForLock(pool, { ownerUserId: chain.owner.userId, projectId: chain.projectId }, chain.bindingRef), null,
        'a withdrawn binding no longer re-verifies for the lock');
      const before = await revisions(pool, chain.owner.userId, chain.projectId);
      const denied = await harness.send('POST', `/api/v1/projects/${chain.projectId}/input-revisions`, {
        draft_revision: 1, requirement_message_ids: [], material_versions: chain.materials,
        generation_issuer_binding_ref: chain.bindingRef, project_message_set_ref: chain.messageRef }, chain.owner);
      assert.equal(denied.statusCode, 409, denied.body);
      assert.deepEqual(await revisions(pool, chain.owner.userId, chain.projectId), before);
    } finally { await harness.app.close(); await pool.end(); }
  });
