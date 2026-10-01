import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationIssuerBindingExpectedInput, GenerationIssuerBindingRef, GenerationIssuerBindingResponse } from '@bondbuddy/contracts';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { azureBlobs, digest } from './data.js';
import { createServer } from './server.js';
import type { GenerationIssuerBindingSeam } from './generation-issuer-binding-consumer.js';
import { PDF, pdfSample } from './upload-safety.samples.js';

const origin = 'http://bondbuddy.test';
const databaseUrl = process.env.BB_TEST_DATABASE_URL;
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const connection = await isolatedTestDatabase(undefined, 'generation-binding-seam');
const BINDING_REF: GenerationIssuerBindingRef = { binding_id: 'binding-synthetic', version: 1, content_sha256: 'a'.repeat(64) };
const ENTITY = 'entity:11111111-1111-4111-8111-111111111111';

function approvedBinding(scope: { ownerUserId: string; projectId: string }, expectedInput: GenerationIssuerBindingExpectedInput): GenerationIssuerBindingResponse {
  return {
    schema_version: 'generation-issuer-binding-v1', binding_id: BINDING_REF.binding_id, version: BINDING_REF.version,
    content_sha256: BINDING_REF.content_sha256, owner_user_id: scope.ownerUserId, project_id: scope.projectId,
    input_revision: expectedInput.input_revision, input_hash: expectedInput.input_hash,
    selected_materials: [{ material_id: 'generated-audit', material_version: 1, role: 'audit', material_sha256: 'c'.repeat(64),
      parse_snapshot_id: 'snapshot-audit', parse_response_sha256: 'd'.repeat(64), parse_coverage: 'complete', parse_warning_codes: [],
      identity_coverage: 'complete', identity_uncertainties: [] }],
    material_decisions: [], disputes: [], status: 'approved', issuer_entity_id: ENTITY,
    review_events: [], created_at: '2026-09-25T00:00:00Z',
  };
}

test('generation preflight cannot bypass the immutable input pin with an injected issuer binding',
  { skip: !databaseUrl || !blobConnection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const blobs = azureBlobs(blobConnection!);
    let providerMode: 'ref' | 'none' = 'none';
    let loaderMode: 'approved' | 'null' = 'null';
    const seam: GenerationIssuerBindingSeam = {
      provider: { provide: async () => providerMode === 'ref' ? BINDING_REF : null },
      load: async (_pool, scope, _ref, expectedInput) => loaderMode === 'approved' ? approvedBinding(scope, expectedInput) : null,
    };
    const app = createServer({ pool, blobs, principal: async () => ({ userId: 'binding-owner', csrfVerified: true }), allowedOrigin: origin,
      enableRunStaging: true, generationIssuerBinding: seam });
    const send = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      app.inject({ method: method as never, url, headers: { origin, ...extra }, payload: payload as never });
    const marker = 'issuer_identity_not_bound:generation_issuer_binding_missing_or_unapproved';
    const preflightMissing = (json: { missing_inputs: string[] }) => json.missing_inputs.includes(marker);
    try {
      const created = await send('POST', '/api/v1/projects', { name: 'Synthetic generation binding', kind: 'generation', issuer_name: 'Browser supplied name', market: 'sse', offering: 'private' });
      assert.equal(created.statusCode, 201, created.body);
      const project = created.json().project_id as string;
      const bytes = pdfSample(), sha = digest(bytes);
      const upload = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { filename: 'synthetic.pdf', media_type: PDF, byte_size: bytes.length, sha256: sha, role: 'audit' });
      assert.equal(upload.statusCode, 201, upload.body);
      assert.equal((await send('PUT', upload.json().upload_url, bytes, { 'content-type': 'application/octet-stream' })).statusCode, 204);
      const complete = await send('POST', `/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`, { byte_size: bytes.length, sha256: sha });
      assert.equal(complete.statusCode, 200, complete.body);
      const material = complete.json().material_id as string;
      const snapshot = await send('POST', `/api/v1/projects/${project}/input-revisions`, { draft_revision: 1, material_versions: [{ material_id: material, material_version: 1 }], requirement_message_ids: [] });
      assert.equal(snapshot.statusCode, 201, snapshot.body);
      const input = snapshot.json() as { input_revision: number; input_hash: string };
      const preflight = async () => (await send('POST', `/api/v1/projects/${project}/preflight`, { input_revision: input.input_revision, input_hash: input.input_hash })).json() as { status: string; missing_inputs: string[] };

      // No explicit ref: the stable issuer-identity gate stays closed.
      assert.equal(preflightMissing(await preflight()), true, 'missing ref must fail closed');
      // Explicit ref but not approved: still closed.
      providerMode = 'ref';
      assert.equal(preflightMissing(await preflight()), true, 'unapproved ref must fail closed');
      // Even an injected approved ref cannot replace the missing immutable input pin.
      loaderMode = 'approved';
      const approved = await preflight();
      assert.equal(preflightMissing(approved), true, 'an unpinned generation input remains blocked');
    } finally {
      await app.close();
      await pool.end();
    }
  });
