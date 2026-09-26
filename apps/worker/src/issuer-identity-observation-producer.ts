import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { IssuerIdentityObservationCandidate, IssuerIdentityObservationContext } from './material-parse-job.js';
import { selectIssuerIdentityEvidence, type IssuerIdentityEvidenceScope } from './issuer-identity-evidence-selector.js';
import { getParseSnapshot, type StoredParseSnapshot } from './parse-evidence-repository.js';

export interface IssuerIdentityObservationProducerDependencies {
  readonly pool: Pick<Pool, 'connect'>;
  /** Resolve only through a trusted server-side entity registry. Missing or invalid results are skipped. */
  readonly resolveEntityId: (input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly materialId: string;
    readonly materialVersion: number;
    readonly issuerDisplayName: string;
    readonly snapshotId: string;
    readonly responseSha256: string;
    readonly parserVersion: string;
    readonly selectionStatus: 'needs_review' | 'conflict';
    readonly coverage: 'complete' | 'incomplete';
    readonly warningCodes: readonly string[];
    readonly evidence: readonly {
      readonly sourceRecordId: string;
      readonly sourceRecordSha256: string;
      readonly sourceLocatorType: string;
      readonly sourceLocator: Record<string, unknown>;
      readonly sourceQuote: string;
    }[];
  }) => Promise<string | null | undefined>;
  /** Test seam. Production uses the exact, full getParseSnapshot lookup. */
  readonly loadSnapshot?: typeof getParseSnapshot;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'IssuerIdentityObservationProducerError';
  return error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateContext(context: IssuerIdentityObservationContext): IssuerIdentityEvidenceScope {
  if (![context.ownerUserId, context.projectId, context.materialId, context.snapshotId].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1 || !sha256Pattern.test(context.materialSha256) ||
      !Array.isArray(context.evidence)) throw fail('INVALID_ISSUER_IDENTITY_OBSERVATION_CONTEXT');
  return { ownerUserId: context.ownerUserId, projectId: context.projectId, materialId: context.materialId,
    materialVersion: context.materialVersion, snapshotId: context.snapshotId };
}

function validateContextEvidence(context: IssuerIdentityObservationContext, snapshot: StoredParseSnapshot) {
  const records = new Map<string, { recordSha256: string; locatorType: string }>();
  const seenRecordIds = new Set<string>();
  for (const record of snapshot.evidence) {
    if (seenRecordIds.has(record.record_id)) throw fail('ISSUER_IDENTITY_OBSERVATION_EVIDENCE_MISMATCH');
    seenRecordIds.add(record.record_id);
    if (!Array.isArray(record.uncertainty)) throw fail('ISSUER_IDENTITY_OBSERVATION_EVIDENCE_MISMATCH');
    if (record.uncertainty.length === 0) {
      records.set(record.record_id, { recordSha256: sha256(canonical(record)), locatorType: record.locator_type });
    }
  }
  const contextAnchors = new Map<string, { recordSha256: string; locatorType: string }>();
  for (const item of context.evidence) {
    if (!item || !idPattern.test(item.recordId) || !sha256Pattern.test(item.recordSha256) ||
        typeof item.locatorType !== 'string' || !item.locatorType || contextAnchors.has(item.recordId)) {
      throw fail('INVALID_ISSUER_IDENTITY_OBSERVATION_EVIDENCE');
    }
    const record = records.get(item.recordId);
    if (!record || record.locatorType !== item.locatorType || record.recordSha256 !== item.recordSha256) {
      throw fail('ISSUER_IDENTITY_OBSERVATION_EVIDENCE_MISMATCH');
    }
    contextAnchors.set(item.recordId, { recordSha256: item.recordSha256, locatorType: item.locatorType });
  }
  if (contextAnchors.size !== records.size || [...records.keys()].some(recordId => !contextAnchors.has(recordId))) {
    throw fail('ISSUER_IDENTITY_OBSERVATION_EVIDENCE_SET_MISMATCH');
  }
  return contextAnchors;
}

/**
 * Builds review-only identity observations from the immutable full parse ledger. It never writes,
 * reviews, or approves an identity; the #17 parse hook owns persistence of returned observations.
 */
export function createIssuerIdentityObservationProducer(
  dependencies: IssuerIdentityObservationProducerDependencies,
): (context: IssuerIdentityObservationContext) => Promise<readonly IssuerIdentityObservationCandidate[]> {
  if (typeof dependencies.resolveEntityId !== 'function') throw fail('ISSUER_IDENTITY_ENTITY_RESOLVER_REQUIRED');
  const loadSnapshot = dependencies.loadSnapshot ?? getParseSnapshot;

  return async context => {
    const scope = validateContext(context);
    const snapshot = await loadSnapshot({ pool: dependencies.pool as Pool }, {
      ownerUserId: context.ownerUserId,
      projectId: context.projectId,
      materialId: context.materialId,
      materialVersion: context.materialVersion,
    }, context.snapshotId);
    if (!snapshot) throw fail('ISSUER_IDENTITY_OBSERVATION_SNAPSHOT_NOT_FOUND');
    if (snapshot.contentSha256 !== context.materialSha256) throw fail('ISSUER_IDENTITY_OBSERVATION_MATERIAL_HASH_MISMATCH');

    const snapshotRecords = new Map(snapshot.evidence.map(record => [record.record_id, record]));
    const contextAnchors = validateContextEvidence(context, snapshot);
    const selection = selectIssuerIdentityEvidence(scope, snapshot);
    if (selection.status === 'no_candidate') return [];

    // PR #265's request key is unique per sourceRecordId. If one parser row explicitly names
    // multiple entities, emitting it twice would collide in the append-only observation store;
    // dropping only that row could hide a conflicting name. Fail closed for this selection.
    const namesByRecord = new Map<string, Set<string>>();
    for (const candidate of selection.candidates) {
      for (const anchor of candidate.evidence) {
        const names = namesByRecord.get(anchor.sourceRecordId) ?? new Set<string>();
        names.add(candidate.issuerDisplayName.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN'));
        namesByRecord.set(anchor.sourceRecordId, names);
      }
    }
    if ([...namesByRecord.values()].some(names => names.size > 1)) return [];

    const output: IssuerIdentityObservationCandidate[] = [];
    for (const candidate of selection.candidates) {
      const selectedAnchors = candidate.evidence.filter(anchor => {
        const contextAnchor = contextAnchors.get(anchor.sourceRecordId);
        return contextAnchor !== undefined && anchor.sourceLocatorType === contextAnchor.locatorType && snapshotRecords.has(anchor.sourceRecordId);
      });
      if (selectedAnchors.length !== candidate.evidence.length) throw fail('ISSUER_IDENTITY_OBSERVATION_CANDIDATE_EVIDENCE_MISMATCH');
      const anchors = selectedAnchors;
      if (anchors.length === 0) return [];
      const entityId = await dependencies.resolveEntityId({
        ownerUserId: context.ownerUserId,
        projectId: context.projectId,
        materialId: context.materialId,
        materialVersion: context.materialVersion,
        issuerDisplayName: candidate.issuerDisplayName,
        snapshotId: snapshot.snapshotId,
        responseSha256: snapshot.responseSha256,
        parserVersion: snapshot.parserVersion,
        selectionStatus: selection.status,
        coverage: selection.coverage,
        warningCodes: selection.warningCodes,
        evidence: anchors.map(anchor => ({
          sourceRecordId: anchor.sourceRecordId,
          sourceRecordSha256: contextAnchors.get(anchor.sourceRecordId)!.recordSha256,
          sourceLocatorType: anchor.sourceLocatorType,
          sourceLocator: structuredClone(anchor.sourceLocator),
          sourceQuote: anchor.sourceQuote,
        })),
      });
      // A partial registry resolution would hide other names in a conflict. Do not return any
      // observation unless every candidate in this selection has a valid trusted entity mapping.
      if (typeof entityId !== 'string' || !idPattern.test(entityId)) return [];
      for (const anchor of anchors) {
        output.push({ sourceRecordId: anchor.sourceRecordId, issuerDisplayName: candidate.issuerDisplayName, entityId });
      }
    }
    return output;
  };
}
