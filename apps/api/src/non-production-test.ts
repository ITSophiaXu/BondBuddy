import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { missing, Problem } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { documentParserVersion } from './material-jobs.js';
import { GENERATION_ISSUER_MATERIAL_ROLES, type GenerationIssuerBindingRef } from '@bondbuddy/contracts';
import { loadApprovedGenerationIssuerBindingForLock } from './generation-issuer-binding.js';
import { resolveUserReferencePin, type UserReferenceChoice } from './user-reference-lock.js';
import { canonicalInputManifest } from './production-rule-pin.js';

export const testChannelEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.BB_DEPLOYMENT_TIER === 'preprod' && env.BB_NON_PRODUCTION_TEST_CHANNEL === 'enabled';

/** Distinguishes owner-persisted material authorization from the fixed sample registry. */
export const OWNER_MATERIAL_SCOPE_SHA256 = createHash('sha256').update('bondbuddy:preprod-owner-materials:v1').digest('hex');

/** Test run metadata is unavailable whenever this deployment cannot serve test artifacts. */
export function assertTestChannelReadable(channel: string | null | undefined) {
  if (channel === 'non_production_test' && !testChannelEnabled()) throw missing();
}

export type TestGrantScope = { grantId: string; userId: string; projectId: string; inputRevision: number; inputHash: string };

type LockedInput = { input_hash: string; draft_revision: number; manifest: unknown; material_versions: unknown };
const workingDraftKeys = ['BB_PREPROD_WORKING_DRAFT_EXPIRES_AT', 'BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH',
  'BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH', 'BB_PREPROD_WORKING_DRAFT_STAGE', 'BB_PREPROD_WORKING_DRAFT_AS_OF'] as const;
export const workingDraftConfigured = (env: NodeJS.ProcessEnv = process.env) =>
  workingDraftKeys.some(key => env[key]?.trim());
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Admission checks the persisted lock and current material/parse rows before any grant or run is written. */
async function assertWorkingDraftMaterials(db: PoolClient, scope: Omit<TestGrantScope, 'grantId'>, input: LockedInput) {
  const manifest = input.manifest;
  if (!record(manifest) || String(input.input_hash).trim() !== scope.inputHash ||
      inputManifestHash(manifest) !== scope.inputHash || manifest.draft_revision !== Number(input.draft_revision) ||
      !Array.isArray(manifest.materials) || !Array.isArray(input.material_versions))
    throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Locked input manifest changed');
  const materials = manifest.materials;
  const refs = input.material_versions;
  if (materials.length === 0 || materials.length !== refs.length)
    throw new Problem(409, 'INPUT_REQUIRED', 'Working draft requires locked issuer financial material');
  const ids = new Set<string>();
  let historical = 0, financial = 0;
  for (let index = 0; index < materials.length; index++) {
    const pin = materials[index], ref = refs[index];
    if (!record(pin) || !record(ref) || typeof pin.material_id !== 'string' || !pin.material_id ||
        !Number.isSafeInteger(pin.material_version) || Number(pin.material_version) < 1 ||
        pin.material_id !== ref.material_id || pin.material_version !== ref.material_version ||
        typeof pin.role !== 'string' || typeof pin.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) || ids.has(pin.material_id))
      throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Locked material references changed');
    ids.add(pin.material_id);
    const row = (await db.query(`SELECT role,sha256,media_type,deleted_at FROM bb_material_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 FOR SHARE`,
    [scope.userId,scope.projectId,pin.material_id,pin.material_version])).rows[0];
    if (!row || row.deleted_at || row.role !== pin.role || String(row.sha256).trim() !== pin.sha256)
      throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Locked material is missing or changed');
    if (row.role === 'historical') {
      historical++;
      if (!['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(row.media_type))
        throw new Problem(409, 'MATERIAL_UNREADABLE', 'Historical draft format is not readable');
    }
    if (['audit','financial','interimFinancial','notes'].includes(row.role)) financial++;
    const parse = (await db.query(`SELECT state,material_sha256,result FROM bb_jobs
      WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
        AND job_type='parse' AND subtype='material_parse' AND parser_version=$5`,
    [scope.userId,scope.projectId,pin.material_id,pin.material_version,documentParserVersion()])).rows[0];
    if (!parse)
      throw new Problem(409, 'INPUT_REQUIRED',
        'No current parse job exists for this locked material; complete its saved upload again to start parsing');
    if (['queued','running','paused'].includes(parse.state))
      throw new Problem(409, 'CAPABILITY_NOT_READY', 'Locked material parsing is pending; retry after parsing completes');
    if (parse.state === 'cancelled')
      throw new Problem(409, 'CAPABILITY_NOT_READY', 'Locked material parsing was cancelled; restart parsing before retrying');
    if (parse.state !== 'succeeded' ||
        String(parse.material_sha256).trim() !== pin.sha256 ||
        !['parsed','needs_confirmation'].includes(parse.result?.outcome))
      throw new Problem(409, 'MATERIAL_UNREADABLE', 'Locked material has no successful parse');
  }
  if (financial < 1 || (manifest.kind === 'update' && historical !== 1))
    throw new Problem(409, 'INPUT_REQUIRED', manifest.kind === 'update'
      ? 'Working draft requires one historical draft and financial material'
      : 'Generation working draft requires issuer financial material');
}

/** A generation run can only use the binding pinned at input lock, verified against today's reviews and parse snapshots. */
export async function assertGenerationIssuerBinding(db: PoolClient, scope: Omit<TestGrantScope, 'grantId'>,
  input: LockedInput): Promise<void> {
  const manifest = input.manifest;
  const unavailable = () => new Problem(409, 'INPUT_REQUIRED',
    'Approved generation issuer binding is missing, withdrawn or stale; review and lock the exact binding before retrying');
  if (!record(manifest) || manifest.kind !== 'generation' || !Array.isArray(manifest.materials)) throw unavailable();
  const raw = manifest.generation_issuer_binding_ref;
  if (!record(raw) || typeof raw.binding_id !== 'string' || !Number.isSafeInteger(raw.version) ||
      typeof raw.content_sha256 !== 'string') throw unavailable();
  const ref: GenerationIssuerBindingRef = { binding_id: raw.binding_id, version: raw.version as number,
    content_sha256: raw.content_sha256 };
  const binding = await loadApprovedGenerationIssuerBindingForLock(db,
    { ownerUserId: scope.userId, projectId: scope.projectId }, ref);
  if (!binding || binding.status !== 'approved' || !binding.issuer_entity_id ||
      binding.issuer_entity_id !== manifest.generation_issuer_entity_id) throw unavailable();
  const key = (item: { material_id: string; material_version: number; role: string; sha256: string }) =>
    `${item.material_id}\u0000${item.material_version}\u0000${item.role}\u0000${item.sha256}`;
  const issuerRoles = new Set<string>(GENERATION_ISSUER_MATERIAL_ROLES);
  const pins = manifest.materials.filter((item): item is Record<string, unknown> => record(item) && issuerRoles.has(String(item.role)));
  const selected = binding.selected_materials.map(item => key({ material_id: item.material_id, material_version: item.material_version,
    role: item.role, sha256: item.material_sha256 })).sort();
  const locked = pins.map(item => key({ material_id: String(item.material_id), material_version: Number(item.material_version),
    role: String(item.role), sha256: String(item.sha256) })).sort();
  if (!locked.length || locked.length !== selected.length || locked.some((value, index) => value !== selected[index])) throw unavailable();
  if (manifest.user_reference_pin !== undefined) {
    const pin = manifest.user_reference_pin;
    if (!record(pin) || pin.status !== 'accepted')
      throw new Problem(409, 'INPUT_REQUIRED', 'Selected user reference requires accepted review');
    const choice: UserReferenceChoice = {
      material_id: String(pin.material_id), material_version: Number(pin.material_version),
      material_sha256: String(pin.material_sha256), parse_snapshot_id: String(pin.parse_snapshot_id),
      target_product: String(pin.target_product), target_document_stage: String(pin.target_document_stage),
    };
    const current = await resolveUserReferencePin(db, { owner: scope.userId, projectId: scope.projectId,
      revision: scope.inputRevision, market: String(manifest.market), offering: String(manifest.offering) }, choice,
    manifest.materials as { material_id: string; material_version: number; role: string; sha256: string }[]);
    if (current.pin.status !== 'accepted' || canonicalInputManifest(current.pin) !== canonicalInputManifest(pin))
      throw new Problem(409, 'INPUT_REQUIRED', 'Selected user reference review is no longer current');
  }
}

export async function assertGenerationWorkingDraftInput(db: PoolClient, scope: Omit<TestGrantScope, 'grantId'>,
  input: LockedInput): Promise<void> {
  await assertGenerationIssuerBinding(db, scope, input);
  await assertWorkingDraftMaterials(db, scope, input);
}

/** Server-owned, time-bounded admission for a preproduction working draft. */
export async function autoWorkingDraftGrant(db: PoolClient, scope: Omit<TestGrantScope, 'grantId'>,
  input: LockedInput, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!record(input.manifest) || !['update', 'generation'].includes(String(input.manifest.kind))) return null;
  if (!workingDraftConfigured(env)) return null;
  if (!testChannelEnabled(env)) throw new Problem(409, 'TEST_CHANNEL_DISABLED', 'Configured working draft channel is unavailable');
  const until = env.BB_PREPROD_WORKING_DRAFT_EXPIRES_AT;
  const expires = until ? new Date(until).getTime() : NaN;
  const hashes = [OWNER_MATERIAL_SCOPE_SHA256,
    env.BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH, env.BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH];
  const stage=env.BB_PREPROD_WORKING_DRAFT_STAGE, asOf=env.BB_PREPROD_WORKING_DRAFT_AS_OF;
  if (!Number.isFinite(expires) || expires > Date.now() + 7 * 86_400_000 ||
      hashes.some(value => !value || !/^[a-f0-9]{64}$/.test(value)) ||
      !['registration','issuance'].includes(stage ?? '') || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !Number.isFinite(Date.parse(`${asOf}T00:00:00Z`)) ||
      new Date(`${asOf}T00:00:00Z`).toISOString().slice(0,10)!==asOf)
    throw new Problem(409, 'TEST_GRANT_INVALID', 'Configured working draft window is invalid');
  if (expires <= Date.now()) throw new Problem(409, 'TEST_GRANT_EXPIRED', 'Configured working draft window expired');
  // Serialize admission of this exact immutable input. A revoked or expired
  // grant is deliberately not replaced by an ordinary browser retry.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`working-draft:${scope.userId}:${scope.projectId}:${scope.inputRevision}:${scope.inputHash}`]);
  if (input.manifest.kind === 'generation') await assertGenerationWorkingDraftInput(db, scope, input);
  else await assertWorkingDraftMaterials(db, scope, input);
  const existing = await db.query(`SELECT grant_id,revoked_at,expires_at FROM bb_non_production_test_grants
    WHERE user_id=$1 AND project_id=$2 AND input_revision=$3 AND input_hash=$4
      AND granted_by='preprod_service' ORDER BY created_at LIMIT 1`,
  [scope.userId, scope.projectId, scope.inputRevision, scope.inputHash]);
  if (existing.rows[0]) {
    if (existing.rows[0].revoked_at) throw new Problem(409,'TEST_GRANT_REVOKED','Test grant was revoked');
    if (new Date(existing.rows[0].expires_at).getTime() <= Date.now())
      throw new Problem(409,'TEST_GRANT_EXPIRED','Test grant expired');
    return existing.rows[0].grant_id;
  }
  const grantId = randomUUID();
  await db.query(`INSERT INTO bb_non_production_test_grants
    (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,
     rule_pack_hash,granted_by,reason,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'preprod_service',$9,$10)`,
  [grantId,scope.userId,scope.projectId,scope.inputRevision,scope.inputHash,...hashes,
    `controlled_working_draft:${stage}:${asOf}`,until]);
  await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'test_grant',$3,'test_grant.created',$4)`,
  [randomUUID(),scope.userId,grantId,{grant_id:grantId,project_id:scope.projectId,
    input_revision:scope.inputRevision,granted_by:'preprod_service'}]);
  return grantId;
}

/** Every submit, claim and external-call gate uses this exact current grant check. */
export async function assertTestGrant(db: Pool | PoolClient, scope: TestGrantScope) {
  if (!testChannelEnabled()) throw new Problem(403, 'TEST_CHANNEL_DISABLED', 'Test channel is disabled');
  const q = await db.query(`SELECT user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at,revoked_at
    FROM bb_non_production_test_grants WHERE grant_id=$1`, [scope.grantId]);
  const grant = q.rows[0];
  if (!grant || grant.user_id !== scope.userId) throw new Problem(404, 'TEST_GRANT_INVALID', 'Test grant not found');
  if (grant.revoked_at) throw new Problem(409, 'TEST_GRANT_REVOKED', 'Test grant was revoked');
  if (new Date(grant.expires_at).getTime() <= Date.now()) throw new Problem(409, 'TEST_GRANT_EXPIRED', 'Test grant expired');
  if (grant.project_id !== scope.projectId || Number(grant.input_revision) !== scope.inputRevision ||
      grant.input_hash.trim() !== scope.inputHash.trim())
    throw new Problem(409, 'TEST_GRANT_MISMATCH', 'Test grant does not match the input');
  return grant;
}
