import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { getParseSnapshot, type StoredParseSnapshot } from './parse-evidence-repository.js';
import { selectIssuerIdentityEvidence } from './issuer-identity-evidence-selector.js';
import type { IssuerIdentityObservationCandidate, IssuerIdentityObservationContext } from './material-parse-job.js';

export function issuerNameKey(name: string): string {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return `issuer-name:v1:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

/** An observation represents one name and its complete anchor set, not a selected legal entity. */
export function createIssuerIdentityProducer(pool: Pool, options: {
  loadSnapshot?: (context: IssuerIdentityObservationContext) => Promise<StoredParseSnapshot | null>;
  warn?: (code: string) => void;
} = {}): (context: IssuerIdentityObservationContext) => Promise<readonly IssuerIdentityObservationCandidate[]> {
  const load = options.loadSnapshot ?? (context => getParseSnapshot({ pool }, context, context.snapshotId));
  const warn = options.warn ?? (code => process.emitWarning(code));
  return async context => {
    let selection;
    try {
      const snapshot = await load(context);
      if (!snapshot) throw new Error('ISSUER_IDENTITY_EVIDENCE_SNAPSHOT_MISSING');
      selection = selectIssuerIdentityEvidence(context, snapshot);
    } catch (error) {
      warn(`ISSUER_IDENTITY_SELECTION_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
      return [];
    }
    if (selection.coverage === 'incomplete') warn(`ISSUER_IDENTITY_COVERAGE_INCOMPLETE:${selection.reasonCode ?? 'unknown'}`);
    if (selection.status === 'no_candidate') return [];
    const allowed = new Set(context.evidence.map(anchor => anchor.recordId));
    if (selection.candidates.some(candidate => candidate.evidence.length === 0 ||
      candidate.evidence.some(anchor => !allowed.has(anchor.sourceRecordId)))) {
      warn('ISSUER_IDENTITY_SELECTION_ANCHOR_MISMATCH');
      return [];
    }
    return selection.candidates.map(candidate => {
      const anchors = candidate.evidence.map(anchor => anchor.sourceRecordId).sort();
      const normalizedName = candidate.issuerDisplayName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const digest = createHash('sha256').update(JSON.stringify({ snapshotId: context.snapshotId, name: normalizedName, anchors })).digest('hex');
      return {
        sourceRecordId: anchors[0]!, issuerDisplayName: candidate.issuerDisplayName,
        entityId: issuerNameKey(candidate.issuerDisplayName), observationId: `issuer-observation:v1:${digest}`,
        requestId: `issuer-${digest}`,
      };
    });
  };
}
