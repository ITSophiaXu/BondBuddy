import type { Pool } from 'pg';
import {
  produceParsedFactCandidates,
  type FactCandidateProductionContext,
  type FactCandidateProducerDependencies,
  type FactCandidateProductionResult,
  type SemanticFactExtractionRequest,
} from './fact-candidate-producer.js';
import {
  createNativeFinancialFactExtractor,
  type NativeFinancialParseCompletionResolver,
} from './native-financial-fact-extractor.js';
import { createRqProspectusAnnualFactExtractor } from './rq-prospectus-annual-fact-extractor.js';
import { getParseSnapshot, type StoredParseSnapshot } from './parse-evidence-repository.js';

type SnapshotLoader = typeof getParseSnapshot;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'ControlledNativeFactCandidateProducerError';
  return error;
}

/**
 * Resolves parser completion only from the exact owner/project/material/version/snapshot row
 * already pinned in the trusted extraction request. This is an internal test seam; callers must
 * not construct requests from browser-provided IDs.
 */
export function createTrustedNativeParseCompletionResolver(
  pool: Pool,
  loadSnapshot: SnapshotLoader = getParseSnapshot,
): NativeFinancialParseCompletionResolver {
  return async (request: SemanticFactExtractionRequest) => {
    const snapshot = await loadSnapshot({ pool }, {
      ownerUserId: request.owner_user_id,
      projectId: request.project_id,
      materialId: request.material_id,
      materialVersion: request.material_version,
    }, request.parse_snapshot_id);

    if (!snapshot) throw fail('FACT_EXTRACTION_PARSE_SNAPSHOT_MISSING');
    if (!matchesRequestPin(snapshot, request)) throw fail('FACT_EXTRACTION_PARSE_SNAPSHOT_MISMATCH');
    if (snapshot.response.status === 'failed') throw fail('FACT_EXTRACTION_PARSE_SNAPSHOT_FAILED');
    return { status: snapshot.response.status, warnings: snapshot.response.warnings };
  };
}

function matchesRequestPin(snapshot: StoredParseSnapshot, request: SemanticFactExtractionRequest): boolean {
  return snapshot.snapshotId === request.parse_snapshot_id &&
    snapshot.ownerUserId === request.owner_user_id && snapshot.projectId === request.project_id &&
    snapshot.materialId === request.material_id && snapshot.materialVersion === request.material_version &&
    snapshot.responseSha256 === request.parse_response_sha256 && snapshot.parserVersion === request.parser_version &&
    snapshot.contentSha256 === request.material_sha256 &&
    snapshot.response.material?.material_id === request.material_id &&
    snapshot.response.material.material_version === request.material_version &&
    snapshot.response.material.sha256 === request.material_sha256 &&
    snapshot.response.parser_version === request.parser_version;
}

/** Internal controlled composition installed by the default worker runtime configuration. */
export function createControlledNativeFactCandidateProducer(
  dependencies: Omit<FactCandidateProducerDependencies, 'extractor' | 'historicalProspectusExtractor'>,
): (context: FactCandidateProductionContext) => Promise<FactCandidateProductionResult> {
  const resolver = createTrustedNativeParseCompletionResolver(
    dependencies.pool as Pool, dependencies.loadSnapshot,
  );
  const extractor = createNativeFinancialFactExtractor(resolver);
  const historicalProspectusExtractor = createRqProspectusAnnualFactExtractor(resolver);
  return (context) => produceParsedFactCandidates({ ...dependencies, extractor, historicalProspectusExtractor }, context);
}
