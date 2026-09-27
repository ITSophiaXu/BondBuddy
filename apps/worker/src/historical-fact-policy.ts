import type { Material } from '@bondbuddy/contracts';
import { updateContentHash, type UpdateFact } from '@bondbuddy/domain/historical-update';
import type { StoredFactCandidate } from './fact-repository.js';
import type { UpdateMaterialLock } from './historical-update.js';
import type { StoredParseSnapshot } from './parse-evidence-repository.js';

const financialRoles = new Set<Material['role']>(['audit', 'financial', 'interimFinancial', 'notes']);

/** Only this issuer's exact locked baseline may supply historical facts.
 * The role is not proof of an audit; source kind/status stay on the candidate. */
export function isHistoricalFactMaterial(
  material: UpdateMaterialLock,
  baseline: { materialId: string; materialVersion: number },
): boolean {
  return financialRoles.has(material.role) || (material.role === 'historical' &&
    material.materialId === baseline.materialId && material.materialVersion === baseline.materialVersion);
}

export function historicalFactMatchesMaterial(fact: StoredFactCandidate, material: UpdateMaterialLock): boolean {
  return fact.provenance.materialId === material.materialId &&
    fact.provenance.materialVersion === material.materialVersion && fact.provenance.evidence.length > 0 &&
    fact.provenance.evidence.every(anchor => anchor.material_id === material.materialId &&
      anchor.material_version === material.materialVersion && anchor.content_hash === material.contentHash);
}

/** Deleted historical text and another parse version cannot supply an effective-baseline fact. */
export function historicalFactMatchesBaseline(fact: StoredFactCandidate, snapshot: StoredParseSnapshot): boolean {
  return fact.provenance.evidence.every(anchor => snapshot.response.records.some(record =>
    record.record_id === anchor.evidence_id && record.material_id === anchor.material_id &&
    record.material_version === anchor.material_version && record.content_hash === anchor.content_hash &&
    record.literal_quote === anchor.literal_quote && record.locator_type === anchor.locator_type &&
    updateContentHash(record.locator) === updateContentHash(anchor.locator) &&
    record.extractor_version === anchor.extraction_version && record.uncertainty.length === 0));
}

/** Shared projection for pre-model eligibility and the deterministic planner. */
export function projectHistoricalFact({ candidate, provenance }: StoredFactCandidate, decisionVersion?: number): UpdateFact {
  return { candidate, status: provenance.status, ...(decisionVersion === undefined ? {} : { decisionVersion }),
    evidence: provenance.evidence.map(anchor => ({
      materialId: anchor.material_id, materialVersion: anchor.material_version, contentHash: anchor.content_hash,
      recordId: anchor.evidence_id, locatorType: anchor.locator_type, locator: anchor.locator, literalQuote: anchor.literal_quote,
      extractionVersion: anchor.extraction_version, uncertainty: anchor.uncertainty,
    })) };
}
