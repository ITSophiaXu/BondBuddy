import { createHash } from 'node:crypto';
import { isMarketOffering, type Market, type Offering } from '@bondbuddy/contracts';
import {
  matchBusinessReferences,
  type AcceptedChapterMapping,
  type ReferenceMatchInput,
  type ReferenceMatchStatus,
} from './reference-match.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';

/** Project identity must come from the authenticated server-side project lookup. */
export interface TrustedReferenceProject {
  readonly ownerId: string;
  readonly projectId: string;
}

export interface ReferenceMaterialScope {
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly ruleVersion: string;
}

/**
 * Internal, persistence-hydrated metadata. Load it through the trusted project owner scope; do not construct it from
 * client-supplied flags. This intentionally has no field for file bytes or extracted text.
 */
export interface ProjectReferenceMaterial {
  readonly materialId: string;
  readonly materialVersion: string;
  readonly contentHash: string;
  readonly role: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly deleted: boolean;
  readonly parseStatus: 'parsed' | 'pending' | 'failed';
  readonly readable: boolean;
  readonly mediaType: string;
  readonly useAuthorized: boolean;
  readonly market: Market;
  readonly offering: Offering;
  readonly instrument: string;
  readonly documentStage: 'registration' | 'issuance';
  readonly applicableScopes: readonly ReferenceMaterialScope[];
  readonly chapterMappings: readonly AcceptedChapterMapping[];
}

export interface UserReferenceDecision {
  readonly materialId: string;
  readonly materialVersion: string;
  readonly contentHash: string;
  readonly disposition: 'selected' | 'excluded';
  readonly reason: string;
}

export interface LibraryMatchDecision {
  readonly status: ReferenceMatchStatus;
  readonly selectionHash: string;
  readonly selectedReferenceId: string | null;
  readonly selectedDocumentVersion: string | null;
  readonly selectedProfileVersion: string | null;
  readonly selectedTaxonomyVersion: string | null;
  readonly chapterMappingVersion: string | null;
  readonly candidateDecisions: readonly {
    readonly referenceId: string;
    readonly documentVersion: string;
    readonly profileVersion: string;
    readonly disposition: 'matched' | 'excluded';
    readonly reason: string;
  }[];
  readonly reasons: readonly string[];
}

export type ReferenceSourceSelectionStatus =
  | 'selected_user_reference'
  | 'selected_library_reference'
  | 'needs_evidence'
  | 'needs_review'
  | 'no_match'
  | 'unavailable';

export interface ReferenceSourceSelectionResult {
  readonly schemaVersion: 'reference-source-selection-v1';
  readonly status: ReferenceSourceSelectionStatus;
  /** This only identifies a structure source; it says nothing about new-draft delivery readiness. */
  readonly selected: null | {
    readonly source: 'user_material' | 'business_library';
    readonly use: 'structure_only';
    readonly materialId?: string;
    readonly materialVersion?: string;
    readonly contentHash?: string;
    readonly referenceId?: string;
    readonly documentVersion?: string;
    readonly profileVersion?: string;
    readonly taxonomyVersion?: string;
    readonly chapterMappingVersion?: string | null;
  };
  readonly deliverableStatus: 'not_determined';
  /** Completeness of the issuer business profile used by the normal evidence workflow. */
  readonly issuerEvidenceStatus: 'ready' | 'needs_evidence' | 'needs_review';
  readonly userReferenceDecisions: readonly UserReferenceDecision[];
  readonly libraryDecision: LibraryMatchDecision | null;
  /** Safe operational hint; absence of a user reference never becomes an upload requirement. */
  readonly guidance: 'none' | 'issuer_evidence_missing' | 'internal_reference_capability_insufficient' | 'review_required';
  readonly selectionHash: string;
}

export interface ReferenceSourceSelectionInput {
  readonly project: TrustedReferenceProject;
  readonly userReferences: readonly ProjectReferenceMaterial[];
  /** Explicit user choice; null means use the automatic internal library path. */
  readonly preferredUserReference: null | { readonly materialId: string; readonly materialVersion: string };
  /** Existing exact-business-set library matcher input. */
  readonly automaticMatch: ReferenceMatchInput;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function safeContentHash(value: string): string {
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

function applicableToTarget(material: ProjectReferenceMaterial, target: ReferenceMatchInput['target'], ruleVersion: string): boolean {
  return material.applicableScopes.some((scope) => scope.market === target.market
    && scope.offering === target.offering
    && scope.instrument === target.instrument
    && scope.documentStage === target.documentStage
    && scope.ruleVersion === ruleVersion);
}

function acceptedUserMapping(material: ProjectReferenceMaterial, target: ReferenceMatchInput['target'], ruleVersion: string): AcceptedChapterMapping | null {
  if (material.market === target.market && material.offering === target.offering) return null;
  return material.chapterMappings.find((mapping) => mapping.status === 'accepted'
    && mapping.version.trim() !== ''
    && mapping.sourceMarket === material.market
    && mapping.targetMarket === target.market
    && mapping.sourceOffering === material.offering
    && mapping.targetOffering === target.offering
    && mapping.instrument === target.instrument
    && mapping.documentStage === target.documentStage
    && mapping.ruleVersion === ruleVersion) ?? null;
}

function exclusionReason(
  material: ProjectReferenceMaterial,
  project: TrustedReferenceProject,
  match: ReferenceMatchInput,
): string | null {
  if (!isMarketOffering(match.target.market, match.target.offering)
    || !match.target.instrument.trim() || !match.ruleVersion.trim()
    || match.ruleVersion !== match.target.ruleVersion) return 'target_rule_or_scope_version_invalid';
  if (material.ownerId !== project.ownerId) return 'owner_mismatch';
  if (material.projectId !== project.projectId) return 'project_mismatch';
  if (material.role !== 'reference') return 'role_not_reference';
  if (material.deleted) return 'material_deleted';
  if (material.parseStatus !== 'parsed') return `material_${material.parseStatus}`;
  if (!material.readable) return 'material_not_readable';
  if (material.mediaType !== DOCX && material.mediaType !== PDF) return 'unsupported_material_format';
  if (!material.useAuthorized) return 'material_use_not_authorized';
  if (!material.materialId.trim() || !material.materialVersion.trim() || !/^[a-f0-9]{64}$/i.test(material.contentHash)) {
    return 'material_identity_version_or_hash_missing';
  }
  if (!material.instrument.trim() || !match.target.instrument.trim()
    || !isMarketOffering(material.market, material.offering)) return 'material_scope_invalid';
  if (!applicableToTarget(material, match.target, match.ruleVersion)) return 'target_rule_scope_not_applicable';
  if (material.market !== match.target.market || material.offering !== match.target.offering) {
    if (!acceptedUserMapping(material, match.target, match.ruleVersion)) return 'cross_market_or_offering_mapping_not_accepted';
  }
  return null;
}

function libraryDecision(match: ReturnType<typeof matchBusinessReferences>): LibraryMatchDecision {
  return {
    status: match.status,
    selectionHash: match.selectionHash,
    selectedReferenceId: match.snapshot.selectedReferenceId,
    selectedDocumentVersion: match.snapshot.selectedDocumentVersion,
    selectedProfileVersion: match.snapshot.selectedProfileVersion,
    selectedTaxonomyVersion: match.snapshot.selectedTaxonomyVersion,
    chapterMappingVersion: match.snapshot.chapterMappingVersion,
    candidateDecisions: match.decisions.map(({ referenceId, documentVersion, profileVersion, disposition, reason }) => ({
      referenceId, documentVersion, profileVersion, disposition, reason,
    })),
    reasons: [...match.reasons],
  };
}

function result(fields: Omit<ReferenceSourceSelectionResult, 'selectionHash'>): ReferenceSourceSelectionResult {
  return { ...fields, selectionHash: hash(fields) };
}

/** Select a usable user supplied structure first, then conservatively fall back to the existing library matcher. */
export function selectReferenceSource(input: ReferenceSourceSelectionInput): ReferenceSourceSelectionResult {
  const preferred = input.preferredUserReference;
  const requestedMaterial = preferred && input.userReferences.find((material) => material.materialId === preferred.materialId
    && material.materialVersion === preferred.materialVersion);
  const userReferenceDecisions: UserReferenceDecision[] = [];
  if (preferred && requestedMaterial) {
    const belongsToTrustedProject = requestedMaterial.ownerId === input.project.ownerId && requestedMaterial.projectId === input.project.projectId;
    const reason = exclusionReason(requestedMaterial, input.project, input.automaticMatch);
    userReferenceDecisions.push({ materialId: requestedMaterial.materialId, materialVersion: requestedMaterial.materialVersion,
      contentHash: belongsToTrustedProject ? safeContentHash(requestedMaterial.contentHash) : '',
      disposition: reason === null ? 'selected' : 'excluded', reason: reason ?? 'usable_project_reference_selected' });
  }

  if (preferred && !requestedMaterial) {
    userReferenceDecisions.push({
      materialId: preferred.materialId, materialVersion: preferred.materialVersion, contentHash: '',
      disposition: 'excluded', reason: 'specified_reference_not_found_in_project',
    });
  }

  if (preferred && requestedMaterial) {
    const requestedReason = exclusionReason(requestedMaterial, input.project, input.automaticMatch);
    if (requestedReason === null) {
      // Run the existing matcher in validation-only mode so a usable structure cannot hide an incomplete issuer business profile.
      const evidenceCheck = matchBusinessReferences({
        ...input.automaticMatch,
        // A local sentinel is used only to reuse target-profile validation; this path does not select or persist a library index.
        referenceIndexVersion: input.automaticMatch.referenceIndexVersion.trim() || 'user-reference-validation-only',
        candidates: [],
      });
      const issuerEvidenceStatus = evidenceCheck.status === 'needs_evidence' ? 'needs_evidence'
        : evidenceCheck.status === 'needs_review' && evidenceCheck.snapshot.targetTop3SetKey === null ? 'needs_review' : 'ready';
      const material = requestedMaterial;
      if (issuerEvidenceStatus !== 'ready') {
        userReferenceDecisions[0] = { ...userReferenceDecisions[0]!, disposition: 'excluded', reason: `issuer_profile_${issuerEvidenceStatus}` };
        return result({
          schemaVersion: 'reference-source-selection-v1', status: issuerEvidenceStatus, selected: null,
          deliverableStatus: 'not_determined', issuerEvidenceStatus, userReferenceDecisions, libraryDecision: null,
          guidance: issuerEvidenceStatus === 'needs_evidence' ? 'issuer_evidence_missing' : 'review_required',
        });
      }
      const mapping = acceptedUserMapping(material, input.automaticMatch.target, input.automaticMatch.ruleVersion);
      return result({
        schemaVersion: 'reference-source-selection-v1',
        status: issuerEvidenceStatus === 'ready' ? 'selected_user_reference' : issuerEvidenceStatus,
        selected: {
          source: 'user_material', use: 'structure_only', materialId: material.materialId,
          materialVersion: material.materialVersion, contentHash: safeContentHash(material.contentHash),
          chapterMappingVersion: mapping?.version ?? null,
        },
        deliverableStatus: 'not_determined', issuerEvidenceStatus, userReferenceDecisions, libraryDecision: null,
        guidance: 'none',
      });
    }
  }

  const matched = matchBusinessReferences(input.automaticMatch);
  const decision = libraryDecision(matched);
  if (matched.status === 'exact') {
    return result({
      schemaVersion: 'reference-source-selection-v1', status: 'selected_library_reference',
      selected: {
        source: 'business_library', use: 'structure_only',
        referenceId: matched.snapshot.selectedReferenceId!, documentVersion: matched.snapshot.selectedDocumentVersion!,
        profileVersion: matched.snapshot.selectedProfileVersion!, taxonomyVersion: matched.snapshot.selectedTaxonomyVersion!,
        chapterMappingVersion: matched.snapshot.chapterMappingVersion,
      },
      deliverableStatus: 'not_determined', issuerEvidenceStatus: 'ready', userReferenceDecisions, libraryDecision: decision, guidance: 'none',
    });
  }
  const guidance = matched.status === 'needs_evidence' ? 'issuer_evidence_missing'
    : matched.status === 'needs_review' ? 'review_required' : 'internal_reference_capability_insufficient';
  const issuerEvidenceStatus = matched.status === 'needs_evidence' ? 'needs_evidence'
    : matched.status === 'needs_review' && matched.snapshot.targetTop3SetKey === null ? 'needs_review' : 'ready';
  return result({
    schemaVersion: 'reference-source-selection-v1', status: matched.status, selected: null,
    deliverableStatus: 'not_determined', issuerEvidenceStatus, userReferenceDecisions, libraryDecision: decision, guidance,
  });
}
