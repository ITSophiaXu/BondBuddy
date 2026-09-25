import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import type { Pool } from 'pg';
import { LibraryChapterMappingCreateRequestSchema, LibraryReviewActionRequestSchema, type LibraryChapterMappingCreateRequest, type LibraryReviewActionRequest } from '@bondbuddy/contracts';
import { digest, missing, Problem, uid, type PrivateBlobs } from './data.js';
import {
  enqueueLibraryRecordRerun, enqueueLibrarySync, libraryAlerts, libraryMissSummary, libraryOperatorRole, libraryOverview, libraryVersionDetail,
  recordChapterMappingVersion, registerLibrarySource, reviewLibraryVersion, withdrawChapterMappingVersion, rollbackLibraryRelease, setLibrarySourceRights, LIBRARY_OWNER, OPERATOR_IMPORT_SOURCE,
} from './library.js';

// #78 operator surface. Deny by default: a user without an active library grant gets the same 404 as an
// unknown route, so the library's existence, lists and candidates are not observable by ordinary accounts.
// Uses its own grant table until the #79 bb_operator_grants model (PR #152) lands.
type Deps = { db: () => Pool; blobs: () => PrivateBlobs; owner: (request: FastifyRequest) => Promise<string> };
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const param = (request: FastifyRequest, name: string) => {
  const value = (request.params as Record<string, string>)[name];
  if (!value || !safeId.test(value)) throw missing();
  return value;
};

export function installLibraryAdminRoutes(app: FastifyInstance, deps: Deps) {
  async function operator(request: FastifyRequest, need: 'library_reader' | 'library_operator') {
    const user = await deps.owner(request);
    const role = await libraryOperatorRole(deps.db(), user);
    if (!role || (need === 'library_operator' && role !== 'library_operator')) throw missing();
    await deps.db().query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash) VALUES($1,$2,$3,$4,$5)',
      [uid(), user, LIBRARY_OWNER, need === 'library_operator' ? 'library_operate' : 'library_read', digest(`${request.method} ${request.routeOptions.url} ${JSON.stringify(request.params)}`)]);
    return user;
  }
  const base = '/api/v1/admin/library';
  app.get(`${base}/overview`, async request => { await operator(request, 'library_reader'); return libraryOverview(deps.db()); });
  app.get(`${base}/alerts`, async request => { await operator(request, 'library_reader'); return { items: await libraryAlerts(deps.db()) }; });
  app.get(`${base}/misses`, async request => { await operator(request, 'library_reader'); return { items: await libraryMissSummary(deps.db()) }; });
  app.get(`${base}/reviews`, async request => {
    await operator(request, 'library_reader');
    const rows = (await deps.db().query(`SELECT r.id, r.document_version_id, r.profile_id, r.opened_reason, r.created_at, v.state, v.market, v.offering, v.instrument, v.document_stage, p.completeness
      FROM bb_library_review_items r JOIN bb_library_document_versions v ON v.id=r.document_version_id LEFT JOIN bb_library_profiles p ON p.id=r.profile_id
      WHERE r.state='open' ORDER BY r.created_at LIMIT 200`)).rows;
    return { items: rows.map(r => ({ ...r, created_at: new Date(r.created_at).toISOString() })) };
  });
  app.get(`${base}/versions/:version_id`, async request => { await operator(request, 'library_reader'); return libraryVersionDetail(deps.db(), param(request, 'version_id')); });
  app.post(`${base}/versions/:version_id/rerun`, async (request, reply) => {
    const actor = await operator(request, 'library_operator');
    const out = await enqueueLibraryRecordRerun(deps.db(), param(request, 'version_id'), actor);
    return reply.code(202).send({ job_id: out.jobId, created: out.created });
  });
  app.post(`${base}/versions/:version_id/review`, async request => {
    const actor = await operator(request, 'library_operator');
    if (!Value.Check(LibraryReviewActionRequestSchema, request.body)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid review action');
    const body = request.body as LibraryReviewActionRequest;
    if (body.action === 'rollback') throw new Problem(422, 'VALIDATION_FAILED', 'Rollback is a release operation');
    return reviewLibraryVersion(deps.db(), param(request, 'version_id'), body, actor);
  });
  app.post(`${base}/releases/:release_id/rollback`, async request => {
    const actor = await operator(request, 'library_operator');
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== 'string') throw new Problem(422, 'VALIDATION_FAILED', 'reason required');
    return rollbackLibraryRelease(deps.db(), param(request, 'release_id'), reason, actor);
  });
  app.post(`${base}/chapter-mappings`, async (request, reply) => {
    const actor = await operator(request, 'library_operator');
    if (!Value.Check(LibraryChapterMappingCreateRequestSchema, request.body)) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid chapter mapping');
    return reply.code(201).send(await recordChapterMappingVersion(deps.db(), request.body as LibraryChapterMappingCreateRequest, actor));
  });
  app.post(`${base}/chapter-mappings/:mapping_version_id/withdraw`, async request => {
    const actor = await operator(request, 'library_operator');
    const reason = (request.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason !== 'string') throw new Problem(422, 'VALIDATION_FAILED', 'reason required');
    return withdrawChapterMappingVersion(deps.db(), param(request, 'mapping_version_id'), reason, actor);
  });
  app.post(`${base}/sources/:source_id/sync`, async (request, reply) => {
    await operator(request, 'library_operator');
    const out = await enqueueLibrarySync(deps.db(), param(request, 'source_id'));
    return reply.code(202).send({ job_id: out.jobId, created: out.created });
  });
  app.post(`${base}/sources/:source_id/rights`, async request => {
    const actor = await operator(request, 'library_operator');
    const body = request.body as { usage_rights?: unknown; reason?: unknown } | undefined;
    if (!['commercial_licensed', 'evaluation_only', 'revoked'].includes(body?.usage_rights as string) || typeof body?.reason !== 'string') throw new Problem(422, 'VALIDATION_FAILED', 'usage_rights and reason required');
    await setLibrarySourceRights(deps.db(), param(request, 'source_id'), body.usage_rights as 'commercial_licensed', body.reason, actor);
    return { source_id: param(request, 'source_id'), usage_rights: body.usage_rights };
  });
  // Operator bulk import: bytes are staged under library/import-staging/ and flow through the same sync pipeline.
  app.post(`${base}/imports`, async (request, reply) => {
    await operator(request, 'library_operator');
    const body = request.body as { items?: unknown } | undefined;
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) throw new Problem(422, 'VALIDATION_FAILED', '1-50 items required');
    const staged = [];
    for (const raw of body.items as Record<string, unknown>[]) {
      const need = ['external_key', 'issuer_key', 'issuer_name', 'title', 'source_revision', 'media_type', 'content_base64'];
      if (need.some(k => typeof raw[k] !== 'string' || !(raw[k] as string).length)) throw new Problem(422, 'VALIDATION_FAILED', `Import item requires ${need.join(', ')}`);
      if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(raw.media_type as string)) throw new Problem(422, 'MATERIAL_FORMAT_UNSUPPORTED', 'PDF or DOCX only');
      const bytes = Buffer.from(raw.content_base64 as string, 'base64');
      if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid import bytes');
      const sha256 = digest(bytes), key = `library/import-staging/${sha256}`;
      if (!(await deps.blobs().exists(key))) await deps.blobs().put(key, bytes, raw.media_type as string);
      staged.push({ external_key: raw.external_key, issuer_key: raw.issuer_key, issuer_name: raw.issuer_name, title: raw.title, source_revision: raw.source_revision,
        source_revision_rank: Number.isSafeInteger(raw.source_revision_rank) ? raw.source_revision_rank : 1, media_type: raw.media_type, staged_key: key, sha256,
        disclosed_at: typeof raw.disclosed_at === 'string' ? raw.disclosed_at : null, market: typeof raw.market === 'string' ? raw.market : null });
    }
    await registerLibrarySource(deps.db(), OPERATOR_IMPORT_SOURCE);
    const out = await enqueueLibrarySync(deps.db(), OPERATOR_IMPORT_SOURCE.id, { checkpoint: { import_items: staged } });
    if (!out.created) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'An import is already running; retry after it completes');
    return reply.code(202).send({ job_id: out.jobId, items: staged.length });
  });
}
