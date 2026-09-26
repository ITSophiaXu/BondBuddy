import type { StoredParseSnapshot } from './parse-evidence-repository.js';

/** Server supplied scope for one already loaded, immutable parse snapshot. */
export interface IssuerIdentityEvidenceScope {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly snapshotId: string;
}

export interface IssuerIdentityEvidenceAnchor {
  readonly snapshotId: string;
  readonly responseSha256: string;
  readonly parserVersion: string;
  readonly materialId: string;
  readonly materialVersion: number;
  readonly sourceRecordId: string;
  readonly sourceLocatorType: StoredParseSnapshot['evidence'][number]['locator_type'];
  readonly sourceLocator: Record<string, unknown>;
  readonly sourceQuote: string;
}

export interface IssuerIdentityEvidenceCandidate {
  /** Text copied from an explicit issuer-name statement; this is not a verified identity. */
  readonly issuerDisplayName: string;
  readonly state: 'needs_review';
  readonly evidence: readonly IssuerIdentityEvidenceAnchor[];
}

export interface IssuerIdentityEvidenceSelection {
  readonly status: 'no_candidate' | 'needs_review' | 'conflict';
  readonly reasonCode: 'NO_UNAMBIGUOUS_ISSUER_NAME_STATEMENT' | 'PARSER_WARNING' | 'PARSE_EVIDENCE_INCOMPLETE' |
    'PARSE_FAILED' | 'LOCAL_UNCERTAINTY_SKIPPED' | 'PARSER_COVERAGE_INCOMPLETE' | null;
  readonly coverage: 'complete' | 'incomplete';
  readonly warningCodes: readonly string[];
  readonly candidates: readonly IssuerIdentityEvidenceCandidate[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const issuerStatement = /(?:^|[\s，,。；;])(?:\d{1,3}[、.)）]\s*)?(?:本项目)?(?:发行人(?:法定)?(?:名称|全称)\s*(?:(?:为|是)\s*[:：]?|[:：])\s*["“「『]?([^"”」』，,。；;\r\n]+)|发行人\s*[:：]\s*["“「『]?([^"”」』，,。；;\r\n]+)|发行人\s*为\s*["“「『]?([^"”」』，,。；;\r\n]+))/gu;
const genericNames = new Set(['本公司', '我公司', '发行人', '公司', 'issuer', 'the issuer', 'company']);
const legalEntityEnding = /(?:有限责任公司|股份有限公司|有限公司|股份公司|合伙企业)$/u;
const safeCompletionWarnings = new Set(['DOCX_REVISIONS_RESOLVED']);
const reviewOnlyCoverageWarnings = new Set(['DOCX_AUXILIARY_PARTS', 'DOCX_CONTENT_CONTROLS', 'DOCX_DRAWINGS', 'DOCX_TEXT_BOXES']);

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'IssuerIdentityEvidenceSelectorError';
  return error;
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('zh-CN');
}

function extractIssuerNames(text: string): string[] {
  const names: string[] = [];
  issuerStatement.lastIndex = 0;
  for (const match of text.matchAll(issuerStatement)) {
    const name = (match[1] ?? match[2] ?? match[3])?.trim().replace(/^["“「『]/u, '').replace(/["”」』]$/u, '').trim();
    if (!name || name.length > 200 || name.includes('、') || genericNames.has(normalizeName(name)) ||
        /^(?:待定|未定|不详|未知|\.{2,}|…+)$/u.test(name)) continue;
    // A bare “发行人为” statement is less explicit than a labeled name field; accept it only
    // when the bounded value has a recognized legal-entity ending. Never parse “发行人是…” prose.
    if (match[3] !== undefined && !legalEntityEnding.test(name)) continue;
    names.push(name);
  }
  return names;
}

function validateLoadedSnapshot(scope: IssuerIdentityEvidenceScope, snapshot: StoredParseSnapshot): void {
  if (![scope.ownerUserId, scope.projectId, scope.materialId, scope.snapshotId].every(value => idPattern.test(value)) ||
      !Number.isSafeInteger(scope.materialVersion) || scope.materialVersion < 1) throw fail('INVALID_ISSUER_IDENTITY_EVIDENCE_SCOPE');
  if (snapshot.ownerUserId !== scope.ownerUserId || snapshot.projectId !== scope.projectId ||
      snapshot.materialId !== scope.materialId || snapshot.materialVersion !== scope.materialVersion ||
      snapshot.snapshotId !== scope.snapshotId || (snapshot.response.status !== 'failed' &&
        (snapshot.response.material?.material_id !== scope.materialId ||
         snapshot.response.material.material_version !== scope.materialVersion ||
         snapshot.response.material.sha256 !== snapshot.contentSha256))) {
    throw fail('ISSUER_IDENTITY_EVIDENCE_SNAPSHOT_SCOPE_MISMATCH');
  }
  if (snapshot.evidenceComplete === false || (snapshot.response.status !== 'failed' && snapshot.evidence.length === 0) ||
      (snapshot.evidenceRecordCount !== undefined && snapshot.evidenceRecordCount !== snapshot.evidence.length)) {
    throw fail('ISSUER_IDENTITY_EVIDENCE_SNAPSHOT_INCOMPLETE');
  }
}

/**
 * Selects only explicit issuer-name statements from a complete `getParseSnapshot` result.
 * Do not pass `getParseSnapshotForMaterialJob` compact reads: those do not validate the full
 * response hash. The loader must receive owner/project/material/version/snapshot from trusted server state;
 * this pure function rechecks that scope and never consults filenames, project form fields,
 * latest snapshots, or a first-row convention. Results are always review-only and have no entity ID.
 */
export function selectIssuerIdentityEvidence(
  scope: IssuerIdentityEvidenceScope,
  snapshot: StoredParseSnapshot,
): IssuerIdentityEvidenceSelection {
  validateLoadedSnapshot(scope, snapshot);

  if (snapshot.response.status === 'failed') {
    return { status: 'no_candidate', reasonCode: 'PARSE_FAILED', coverage: 'incomplete', warningCodes: [], candidates: [] };
  }
  const warningCodes = [...new Set(snapshot.response.warnings.map(warning => warning.code))].sort((left, right) => left.localeCompare(right, 'en'));
  const blockedWarnings = warningCodes.filter(code => !safeCompletionWarnings.has(code) && !reviewOnlyCoverageWarnings.has(code));
  // Known non-body DOCX omissions permit using a directly anchored body statement as a
  // review candidate, but make coverage incomplete: the result cannot claim uniqueness.
  // Other warnings may mean unresolved, damaged or truncated content and fail closed.
  if (blockedWarnings.length > 0) {
    return { status: 'no_candidate', reasonCode: 'PARSER_WARNING', coverage: 'incomplete', warningCodes, candidates: [] };
  }
  const coverage: IssuerIdentityEvidenceSelection['coverage'] = warningCodes.some(code => reviewOnlyCoverageWarnings.has(code))
    ? 'incomplete' : 'complete';

  const grouped = new Map<string, { name: string; evidence: IssuerIdentityEvidenceAnchor[] }>();
  let skippedUncertain = false;
  for (const record of snapshot.evidence) {
    if (record.material_id !== scope.materialId || record.material_version !== scope.materialVersion ||
        record.content_hash !== snapshot.contentSha256 || !record.record_id || !record.literal_quote ||
        !record.locator || typeof record.locator !== 'object' || Array.isArray(record.locator)) {
      throw fail('ISSUER_IDENTITY_EVIDENCE_RECORD_SCOPE_MISMATCH');
    }
    if (record.uncertainty.length > 0) {
      skippedUncertain = true;
      continue;
    }
    for (const name of extractIssuerNames(record.literal_quote)) {
      const key = normalizeName(name);
      const candidate = grouped.get(key) ?? { name, evidence: [] };
      if (name < candidate.name) candidate.name = name;
      if (!candidate.evidence.some(anchor => anchor.sourceRecordId === record.record_id)) {
        candidate.evidence.push({
          snapshotId: scope.snapshotId,
          responseSha256: snapshot.responseSha256,
          parserVersion: snapshot.parserVersion,
          materialId: scope.materialId,
          materialVersion: scope.materialVersion,
          sourceRecordId: record.record_id,
          sourceLocatorType: record.locator_type,
          sourceLocator: structuredClone(record.locator),
          sourceQuote: record.literal_quote,
        });
      }
      grouped.set(key, candidate);
    }
  }

  const candidates = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([, candidate]) => ({
      issuerDisplayName: candidate.name,
      state: 'needs_review' as const,
      evidence: candidate.evidence.sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId, 'en')),
    }));
  const reasonCode = coverage === 'incomplete' ? 'PARSER_COVERAGE_INCOMPLETE' : null;
  if (candidates.length > 1) return { status: 'conflict', reasonCode, coverage, warningCodes, candidates };
  if (candidates.length === 1) return { status: 'needs_review', reasonCode, coverage, warningCodes, candidates };
  return {
    status: 'no_candidate',
    reasonCode: reasonCode ?? (skippedUncertain ? 'LOCAL_UNCERTAINTY_SKIPPED' : 'NO_UNAMBIGUOUS_ISSUER_NAME_STATEMENT'),
    coverage,
    warningCodes,
    candidates: [],
  };
}
