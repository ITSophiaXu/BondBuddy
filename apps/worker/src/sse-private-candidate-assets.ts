import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rulePackContentHash,
  validateRulePackCompanions,
  type CoverageManifest,
  type ChapterTemplate,
  type RulePack,
} from '@bondbuddy/domain';
import {
  SSE_PRIVATE_APPLICABILITY_DICTIONARY,
  SSE_PRIVATE_APPLICABILITY_TAXONOMY_VERSION,
} from '@bondbuddy/domain/sse-private-applicability';

const ASSET_DIRECTORY = 'knowledge/exchange-bonds/drafts/sse-private';
const RULE_PACK_FILE = 'rule-pack.json';
const CHAPTER_TEMPLATE_FILE = 'chapter-template.json';
const COVERAGE_FILE = 'coverage.json';
/** Stable for compiled /app/apps/worker/dist; independent of process.cwd(). */
export const SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT = fileURLToPath(
  new URL('../../../', import.meta.url),
);

/**
 * Immutable repository pin for the #20 SSE private draft.6 candidate only.
 * Updating these values requires reviewing the candidate assets as a new pin.
 */
export const SSE_PRIVATE_CANDIDATE_ASSET_PIN = Object.freeze({
  taxonomy: Object.freeze({
    dictionaryVersion: 'sse-private-applicability-v3',
    reviewTaxonomyVersion: 'bondbuddy-applicability-sse-private-v3',
    contentSha256: 'd3feccf27a5a4c833402cbc1dd08bb96edcc35cad2f0ed00626b986a663b1c95',
  }),
  rulePack: Object.freeze({
    id: 'sse-private',
    version: '2026.09.27-draft.6',
    status: 'draft',
    rawSha256: '47d01c552225a279463f118f67c528ec93d6b49ab10ac68f772d04ba30592e58',
    contentSha256: '283dbccfc944c9baecb010c758ec82587658b79ab7c4f702fdf447b4a4df47a3',
  }),
  chapterTemplate: Object.freeze({
    id: 'sse-private-chapters',
    version: '2026.09.27-draft.6',
    rawSha256: 'e5a2cb613648c1dd2e16e8ab6642e927f707309387a1af39079f2d904c7fb30b',
  }),
  coverage: Object.freeze({
    id: 'sse-private-coverage',
    version: '2026.09.27-draft.6',
    rawSha256: 'bc92432cd2b62a4c33712e5fd4d61884254a728325a2a4ec37f26d23c05a498a',
  }),
  scope: Object.freeze({
    market: 'sse',
    offering: 'private',
    instruments: Object.freeze(['ordinary-company-bond']),
    documentStages: Object.freeze(['registration', 'issuance']),
    issuerScopes: Object.freeze(['domestic-company']),
  }),
});

export type CandidateCoverageItem = Readonly<{
  manifestId: string;
  manifestVersion: string;
  itemId: string;
  disposition: string;
  area: string;
  rationale: string;
  sourceRefIds: readonly string[];
  ruleIds: readonly string[];
  candidateAssetSha256: string;
}>;

export type CandidateCoverageBlocker = Readonly<{
  blockerId: string;
  description: string;
  requiredEvidence: string;
  candidateAssetSha256: string;
}>;

export type SsePrivateCandidateBundle = Readonly<{
  status: 'candidate_only';
  taxonomy: Readonly<{
    dictionaryVersion: string;
    reviewTaxonomyVersion: string;
    contentSha256: string;
  }>;
  rulePack: Readonly<{
    id: string;
    version: string;
    contentSha256: string;
    scope: typeof SSE_PRIVATE_CANDIDATE_ASSET_PIN.scope;
  }>;
  chapterTemplate: Readonly<{ id: string; version: string; rawSha256: string }>;
  coverage: Readonly<{
    manifestId: string;
    version: string;
    rawSha256: string;
    items: readonly CandidateCoverageItem[];
    openBlockers: readonly CandidateCoverageBlocker[];
  }>;
}>;

export class SsePrivateCandidateAssetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SsePrivateCandidateAssetError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJsonAsset(bytes: Uint8Array, name: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SsePrivateCandidateAssetError(
      'ASSET_ENCODING_INVALID',
      `${name} must be valid UTF-8`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SsePrivateCandidateAssetError(
      'ASSET_JSON_INVALID',
      `${name} must contain valid JSON`,
    );
  }
}

function assertExactScope(pack: RulePack): void {
  const expected = SSE_PRIVATE_CANDIDATE_ASSET_PIN.scope;
  const sameList = (actual: readonly string[], pinned: readonly string[]) =>
    actual.length === pinned.length && actual.every((item, index) => item === pinned[index]);
  if (
    pack.scope.market !== expected.market ||
    pack.scope.offering !== expected.offering ||
    !sameList(pack.scope.instruments, expected.instruments) ||
    !sameList(pack.scope.document_stages, expected.documentStages) ||
    !sameList(pack.scope.issuer_scopes, expected.issuerScopes)
  ) {
    throw new SsePrivateCandidateAssetError(
      'CANDIDATE_SCOPE_MISMATCH',
      'Rule pack scope differs from the pinned SSE private candidate scope',
    );
  }
}

function createCoverageRecords(coverage: CoverageManifest, assetHash: string) {
  const sorted = <T extends { item_id?: string; blocker_id?: string }>(
    items: readonly T[],
    field: 'item_id' | 'blocker_id',
  ) =>
    [...items].sort((left, right) => {
      const leftKey = String(left[field]);
      const rightKey = String(right[field]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  const items: CandidateCoverageItem[] = sorted(coverage.items, 'item_id').map((item) =>
    Object.freeze({
      manifestId: coverage.manifest_id,
      manifestVersion: coverage.version,
      itemId: item.item_id,
      disposition: item.disposition,
      area: item.area,
      rationale: item.rationale,
      sourceRefIds: Object.freeze([...item.source_ref_ids].sort()),
      // The source manifest has no explicit coverage-item-to-rule link. Keep it empty;
      // item_id is not a rule_id and name/source similarity is not a mapping.
      ruleIds: Object.freeze([]),
      candidateAssetSha256: assetHash,
    }),
  );
  const openBlockers: CandidateCoverageBlocker[] = sorted(coverage.open_blockers, 'blocker_id').map(
    (blocker) =>
      Object.freeze({
        blockerId: blocker.blocker_id,
        description: blocker.description,
        requiredEvidence: blocker.required_evidence,
        candidateAssetSha256: assetHash,
      }),
  );
  return { items: Object.freeze(items), openBlockers: Object.freeze(openBlockers) };
}

/**
 * Verify the exact candidate asset bytes and schemas. This only prepares a
 * candidate descriptor; it does not select a run channel or grant capability.
 */
export function verifySsePrivateCandidateAssetBytes(input: {
  rulePackBytes: Uint8Array;
  chapterTemplateBytes: Uint8Array;
  coverageBytes: Uint8Array;
}): SsePrivateCandidateBundle {
  const pin = SSE_PRIVATE_CANDIDATE_ASSET_PIN;
  const hashes = {
    rulePack: sha256(input.rulePackBytes),
    chapterTemplate: sha256(input.chapterTemplateBytes),
    coverage: sha256(input.coverageBytes),
  };
  if (hashes.rulePack !== pin.rulePack.rawSha256)
    throw new SsePrivateCandidateAssetError(
      'RULE_PACK_BYTES_MISMATCH',
      'Rule pack bytes do not match the pinned candidate',
    );
  if (hashes.chapterTemplate !== pin.chapterTemplate.rawSha256)
    throw new SsePrivateCandidateAssetError(
      'TEMPLATE_BYTES_MISMATCH',
      'Chapter template bytes do not match the pinned candidate',
    );
  if (hashes.coverage !== pin.coverage.rawSha256)
    throw new SsePrivateCandidateAssetError(
      'COVERAGE_BYTES_MISMATCH',
      'Coverage bytes do not match the pinned candidate',
    );

  const packInput = parseJsonAsset(input.rulePackBytes, RULE_PACK_FILE);
  const templateInput = parseJsonAsset(input.chapterTemplateBytes, CHAPTER_TEMPLATE_FILE);
  const coverageInput = parseJsonAsset(input.coverageBytes, COVERAGE_FILE);
  const validated = validateRulePackCompanions(packInput, templateInput, coverageInput);
  if (!validated.ok) {
    const detail = validated.problems
      .map(({ code, path }) => `${code}:${path}`)
      .sort()
      .join(',');
    throw new SsePrivateCandidateAssetError('CANDIDATE_SCHEMA_INVALID', detail);
  }
  const { pack, template, coverage } = validated;
  const taxonomy = SSE_PRIVATE_APPLICABILITY_DICTIONARY;

  if (
    taxonomy.version !== pin.taxonomy.dictionaryVersion ||
    SSE_PRIVATE_APPLICABILITY_TAXONOMY_VERSION !== pin.taxonomy.reviewTaxonomyVersion ||
    taxonomy.contentSha256 !== pin.taxonomy.contentSha256
  ) {
    throw new SsePrivateCandidateAssetError(
      'TAXONOMY_PIN_MISMATCH',
      'Applicability dictionary version/hash differs from the pinned candidate',
    );
  }
  if (
    pack.pack_id !== pin.rulePack.id ||
    pack.version !== pin.rulePack.version ||
    pack.status !== 'draft' ||
    pack.release !== null ||
    pack.withdrawal !== null ||
    pack.reviews.length !== 0 ||
    pack.rules.length !== 31 ||
    pack.rules.some((rule) => rule.enabled || rule.enforcement !== 'research_only') ||
    pack.sample_suite.data_classification !== 'synthetic'
  ) {
    throw new SsePrivateCandidateAssetError(
      'RULE_PACK_PIN_MISMATCH',
      'Rule pack identity, draft status, rule state, or sample classification differs from the pinned candidate',
    );
  }
  if (rulePackContentHash(pack) !== pin.rulePack.contentSha256) {
    throw new SsePrivateCandidateAssetError(
      'RULE_PACK_CONTENT_HASH_MISMATCH',
      'Rule pack canonical content hash differs from the pinned candidate',
    );
  }
  assertExactScope(pack);
  if (
    template.template_id !== pin.chapterTemplate.id ||
    template.version !== pin.chapterTemplate.version ||
    template.rule_pack_id !== pin.rulePack.id ||
    template.market !== pin.scope.market ||
    template.offering !== pin.scope.offering ||
    template.document_stages.length !== pin.scope.documentStages.length ||
    !template.document_stages.every((stage, index) => stage === pin.scope.documentStages[index])
  ) {
    throw new SsePrivateCandidateAssetError(
      'TEMPLATE_PIN_MISMATCH',
      'Chapter template identity, version, pack linkage, or scope differs from the pinned candidate',
    );
  }
  if (
    coverage.manifest_id !== pin.coverage.id ||
    coverage.version !== pin.coverage.version ||
    coverage.rule_pack_id !== pin.rulePack.id
  ) {
    throw new SsePrivateCandidateAssetError(
      'COVERAGE_PIN_MISMATCH',
      'Coverage identity, version, or pack linkage differs from the pinned candidate',
    );
  }

  const records = createCoverageRecords(coverage, hashes.coverage);
  return Object.freeze({
    status: 'candidate_only',
    taxonomy: Object.freeze({
      dictionaryVersion: taxonomy.version,
      reviewTaxonomyVersion: SSE_PRIVATE_APPLICABILITY_TAXONOMY_VERSION,
      contentSha256: taxonomy.contentSha256,
    }),
    rulePack: Object.freeze({
      id: pack.pack_id,
      version: pack.version,
      contentSha256: pin.rulePack.contentSha256,
      scope: pin.scope,
    }),
    chapterTemplate: Object.freeze({
      id: template.template_id,
      version: template.version,
      rawSha256: hashes.chapterTemplate,
    }),
    coverage: Object.freeze({
      manifestId: coverage.manifest_id,
      version: coverage.version,
      rawSha256: hashes.coverage,
      ...records,
    }),
  });
}

/** Load only from an explicitly supplied repository/runtime root. */
export async function loadSsePrivateCandidateAssets(repositoryRoot: string) {
  const assetDirectory = join(repositoryRoot, ASSET_DIRECTORY);
  let rulePackBytes: Buffer;
  let chapterTemplateBytes: Buffer;
  let coverageBytes: Buffer;
  try {
    [rulePackBytes, chapterTemplateBytes, coverageBytes] = await Promise.all([
      readFile(join(assetDirectory, RULE_PACK_FILE)),
      readFile(join(assetDirectory, CHAPTER_TEMPLATE_FILE)),
      readFile(join(assetDirectory, COVERAGE_FILE)),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SsePrivateCandidateAssetError(
        'CANDIDATE_ASSET_MISSING',
        'A pinned candidate asset is missing from the runtime package',
      );
    }
    throw error;
  }
  const bundle = verifySsePrivateCandidateAssetBytes({
    rulePackBytes,
    chapterTemplateBytes,
    coverageBytes,
  });
  // Parse the SAME verified buffers; never reread files after checking their hashes.
  return {
    bundle,
    pack: parseJsonAsset(rulePackBytes, RULE_PACK_FILE) as RulePack,
    template: parseJsonAsset(chapterTemplateBytes, CHAPTER_TEMPLATE_FILE) as ChapterTemplate,
    coverage: parseJsonAsset(coverageBytes, COVERAGE_FILE) as CoverageManifest,
  };
}

export async function loadSsePrivateCandidateBundle(
  repositoryRoot: string,
): Promise<SsePrivateCandidateBundle> {
  return (await loadSsePrivateCandidateAssets(repositoryRoot)).bundle;
}
