import { createHash } from 'node:crypto';
import capcoDivisionSelectorMapping from './capco-division-selector-mapping.json' with { type: 'json' };

export const SSE_PRIVATE_APPLICABILITY_DICTIONARY_VERSION = 'sse-private-applicability-v2' as const;
export const SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1_VERSION = 'sse-private-applicability-v1' as const;

export const SSE_PRIVATE_FEATURE_DIMENSIONS = [
  { code: 'city-infrastructure', label: '城市建设审核重点', selectorCode: 'city-infrastructure' },
  { code: 'real-estate', label: '房地产审核重点', selectorCode: 'real-estate' },
  { code: 'group-operated', label: '集团型经营审核重点', selectorCode: 'group-operated' },
  { code: 'special-product-purpose', label: '专项品种或用途', selectorCode: 'special-product-purpose' },
  { code: 'convertible-structure', label: '可转结构', selectorCode: 'convertible-structure' },
  { code: 'exchangeable-structure', label: '可交换结构', selectorCode: 'exchangeable-structure' },
  { code: 'perpetual-structure', label: '可续期结构', selectorCode: 'perpetual-structure' },
  { code: 'optimized-review', label: '优化审核', selectorCode: 'optimized-review' },
  { code: 'simplified-disclosure', label: '简明披露', selectorCode: 'simplified-disclosure' },
  { code: 'restructuring', label: '重组事项', selectorCode: 'restructuring' },
  { code: 'special-issuer', label: '特殊主体', selectorCode: 'special-issuer' },
  { code: 'transition-arrangement', label: '过渡安排', selectorCode: 'transition-arrangement' },
] as const;

export type SsePrivateFeatureCode = typeof SSE_PRIVATE_FEATURE_DIMENSIONS[number]['code'];

export interface ExternalIndustryStandardBinding {
  readonly kind: 'external-standard';
  readonly standardId: string;
  readonly standardVersion: string;
  readonly definitionSha256: string;
  readonly mappingVersion: string;
  readonly selectorLevel: 'division';
  readonly codes: readonly string[];
  /** Exact, reviewed-source-code to division mapping. Unlisted codes stay unbound. */
  readonly sourceCodeToSelectorCode: Readonly<Record<string, string>>;
  readonly unboundSourceCodes: readonly string[];
}

interface DictionaryContent {
  readonly dictionaryId: 'sse-private-applicability';
  readonly version: string;
  readonly market: 'sse';
  readonly offering: 'private';
  readonly purpose: 'issuer-applicability-review';
  readonly industry: {
    readonly selectorField: 'industry';
    readonly standardBinding: ExternalIndustryStandardBinding | null;
    readonly unboundReason: string;
  };
  readonly featureSelectorField: 'specialFeatures';
  readonly featureDimensions: typeof SSE_PRIVATE_FEATURE_DIMENSIONS;
  readonly isolation: {
    readonly referenceMatchingDictionary: 'not-a-#77-business-matching-dictionary';
    readonly companyNameInference: false;
    readonly featureConcatenation: false;
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const v1DictionaryContent: DictionaryContent = {
  dictionaryId: 'sse-private-applicability',
  version: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1_VERSION,
  market: 'sse',
  offering: 'private',
  purpose: 'issuer-applicability-review',
  industry: {
    selectorField: 'industry',
    standardBinding: null,
    unboundReason: '基础行业分类标准及版本尚未确定；不得产生非空 selector industry。',
  },
  featureSelectorField: 'specialFeatures',
  featureDimensions: SSE_PRIVATE_FEATURE_DIMENSIONS,
  isolation: {
    referenceMatchingDictionary: 'not-a-#77-business-matching-dictionary',
    companyNameInference: false,
    featureConcatenation: false,
  },
};

const capcoMapping = capcoDivisionSelectorMapping as {
  readonly standard_id: string;
  readonly standard_version: string;
  readonly definition_sha256: string;
  readonly mapping_version: string;
  readonly scope: { readonly market: string; readonly offering: string };
  readonly selector_level: string;
  readonly unbound_source_codes: readonly string[];
  readonly entries: Readonly<Record<string, string>>;
};
const capcoDivisionCodes = Object.keys(capcoMapping.entries)
  .filter((code) => code.length === 2 && capcoMapping.entries[code] === code)
  .sort();
const capcoStandardBinding: ExternalIndustryStandardBinding = {
  kind: 'external-standard',
  standardId: capcoMapping.standard_id,
  standardVersion: capcoMapping.standard_version,
  definitionSha256: capcoMapping.definition_sha256,
  mappingVersion: capcoMapping.mapping_version,
  selectorLevel: 'division',
  codes: capcoDivisionCodes,
  sourceCodeToSelectorCode: capcoMapping.entries,
  unboundSourceCodes: capcoMapping.unbound_source_codes,
};

const v2DictionaryContent: DictionaryContent = {
  ...v1DictionaryContent,
  version: SSE_PRIVATE_APPLICABILITY_DICTIONARY_VERSION,
  industry: {
    selectorField: 'industry',
    standardBinding: capcoStandardBinding,
    unboundReason: '仅绑定协会2023指引中有明确两位大类或唯一父级的代码；其余分类须待审核。',
  },
};

function fingerprintDictionary(content: DictionaryContent) {
  return deepFreeze({ ...content, contentSha256: createHash('sha256').update(canonicalJson(content)).digest('hex') });
}

/** Historical v1 snapshot retained so persisted v1 pins keep their original meaning and hash. */
export const SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1 = fingerprintDictionary(v1DictionaryContent);
export const SSE_PRIVATE_APPLICABILITY_DICTIONARY = fingerprintDictionary(v2DictionaryContent);
const dictionariesByVersion = deepFreeze({
  [SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.version]: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1,
  [SSE_PRIVATE_APPLICABILITY_DICTIONARY.version]: SSE_PRIVATE_APPLICABILITY_DICTIONARY,
});

export type ApplicabilityDimensionStatus = 'present' | 'absent' | 'not_applicable' | 'unknown';

export interface ApplicabilityEvidenceReference {
  readonly materialId: string;
  readonly materialVersion: number;
  readonly materialSha256: string;
  readonly parseSnapshotId: string;
  readonly sourceRecordId: string;
  readonly recordSha256: string;
  readonly locator: string;
}

export interface ApplicabilityDimensionAssessment {
  readonly code: SsePrivateFeatureCode;
  readonly status: ApplicabilityDimensionStatus;
  readonly evidence: readonly ApplicabilityEvidenceReference[];
  readonly reason: string | null;
}

export type IndustryClassification =
  | { readonly status: 'unknown' }
  | {
    readonly status: 'classified';
    readonly standardId: string;
    readonly standardVersion: string;
    readonly definitionSha256: string;
    /** Code in the named source standard; v2 maps exact listed groups to parent divisions. */
    readonly code: string;
  };

export interface SelectorApplicabilityCandidate {
  readonly dictionaryVersion: string;
  readonly dictionarySha256: string;
  readonly industry: string | null;
  readonly specialFeatures: readonly string[] | null;
  readonly status: 'candidate_only';
  readonly reviewAuthorization: 'not_established';
  readonly productionEligible: false;
}

export type ApplicabilityCandidateResult =
  | { readonly accepted: true; readonly candidate: SelectorApplicabilityCandidate }
  | {
    readonly accepted: false;
    readonly reason: 'dictionary_version_mismatch' | 'invalid_dictionary_hash' | 'industry_standard_unbound'
      | 'invalid_industry_binding' | 'invalid_industry_classification' | 'industry_code_needs_review'
      | 'invalid_feature_code' | 'incomplete_dimensions'
      | 'invalid_dimension_status' | 'evidence_required' | 'evidence_invalid' | 'reason_required';
  };

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validEvidence(evidence: unknown): evidence is ApplicabilityEvidenceReference {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const ref = evidence as Record<string, unknown>;
  return isNonBlank(ref.materialId) && typeof ref.materialVersion === 'number'
    && Number.isSafeInteger(ref.materialVersion) && ref.materialVersion > 0 && isSha256(ref.materialSha256)
    && isNonBlank(ref.parseSnapshotId) && isNonBlank(ref.sourceRecordId)
    && isSha256(ref.recordSha256) && isNonBlank(ref.locator);
}

function mapIndustryToSelector(classification: unknown, dictionary: DictionaryContent):
  | { readonly accepted: true; readonly code: string | null }
  | { readonly accepted: false; readonly reason: 'industry_standard_unbound' | 'invalid_industry_binding' | 'invalid_industry_classification' | 'industry_code_needs_review' } {
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)
      || !('status' in classification)) {
    return { accepted: false, reason: 'invalid_industry_classification' };
  }
  const value = classification as Partial<IndustryClassification>;
  if (value.status === 'unknown') return { accepted: true, code: null };
  if (value.status !== 'classified') return { accepted: false, reason: 'invalid_industry_classification' };
  const binding = dictionary.industry.standardBinding;
  if (!binding) return { accepted: false, reason: 'industry_standard_unbound' };
  if (value.standardId !== binding.standardId || value.standardVersion !== binding.standardVersion
      || value.definitionSha256 !== binding.definitionSha256 || typeof value.code !== 'string') {
    return { accepted: false, reason: 'invalid_industry_binding' };
  }
  if (binding.unboundSourceCodes.includes(value.code)) return { accepted: false, reason: 'industry_code_needs_review' };
  const selectorCode = binding.sourceCodeToSelectorCode[value.code];
  if (!selectorCode || !binding.codes.includes(selectorCode)) return { accepted: false, reason: 'invalid_industry_binding' };
  return { accepted: true, code: selectorCode };
}

/**
 * Checks candidate shape and maps the independent feature dimensions to the
 * legacy selector fields. It does not authenticate a reviewer or approve a
 * production applicability context.
 */
export function buildSsePrivateApplicabilityCandidate(input: {
  readonly dictionaryVersion: string;
  readonly dictionarySha256: string;
  readonly industry: IndustryClassification;
  readonly dimensions: readonly ApplicabilityDimensionAssessment[] | null;
}): ApplicabilityCandidateResult {
  const dictionary = dictionariesByVersion[input.dictionaryVersion as keyof typeof dictionariesByVersion] as typeof SSE_PRIVATE_APPLICABILITY_DICTIONARY | undefined;
  if (!dictionary) return { accepted: false, reason: 'dictionary_version_mismatch' };
  if (input.dictionarySha256 !== dictionary.contentSha256) return { accepted: false, reason: 'invalid_dictionary_hash' };
  const industry = mapIndustryToSelector(input.industry, dictionary);
  if (!industry.accepted) return industry;
  if (input.dimensions === null) {
    return {
      accepted: true,
      candidate: {
        dictionaryVersion: dictionary.version,
        dictionarySha256: dictionary.contentSha256,
        industry: industry.code,
        specialFeatures: null,
        status: 'candidate_only',
        reviewAuthorization: 'not_established',
        productionEligible: false,
      },
    };
  }

  const validCodes = new Set<string>(dictionary.featureDimensions.map((dimension) => dimension.code));
  const seen = new Set<string>();
  const presentCodes: SsePrivateFeatureCode[] = [];
  for (const assessment of input.dimensions) {
    if (!assessment || !validCodes.has(assessment.code) || seen.has(assessment.code)) {
      return { accepted: false, reason: 'invalid_feature_code' };
    }
    seen.add(assessment.code);
    if (!['present', 'absent', 'not_applicable', 'unknown'].includes(assessment.status)) {
      return { accepted: false, reason: 'invalid_dimension_status' };
    }
    if (!Array.isArray(assessment.evidence)) return { accepted: false, reason: 'evidence_invalid' };
    if (assessment.status === 'present' || assessment.status === 'absent' || assessment.status === 'not_applicable') {
      if (assessment.evidence.length === 0) return { accepted: false, reason: 'evidence_required' };
      if (!assessment.evidence.every(validEvidence)) return { accepted: false, reason: 'evidence_invalid' };
      if (!isNonBlank(assessment.reason)) return { accepted: false, reason: 'reason_required' };
    } else if (assessment.evidence.some((ref) => !validEvidence(ref))) {
      return { accepted: false, reason: 'evidence_invalid' };
    }
    if (assessment.status === 'present') presentCodes.push(assessment.code);
  }
  if (seen.size !== dictionary.featureDimensions.length) return { accepted: false, reason: 'incomplete_dimensions' };
  if (input.dimensions.some((dimension) => dimension.status === 'unknown')) {
    return {
      accepted: true,
      candidate: {
        dictionaryVersion: dictionary.version,
        dictionarySha256: dictionary.contentSha256,
        industry: industry.code,
        specialFeatures: null,
        status: 'candidate_only',
        reviewAuthorization: 'not_established',
        productionEligible: false,
      },
    };
  }

  const presentSet = new Set(presentCodes);
  const selectorFeatures = dictionary.featureDimensions
    .filter(({ code }) => presentSet.has(code))
    .map(({ selectorCode }) => selectorCode);
  return {
    accepted: true,
    candidate: {
      dictionaryVersion: dictionary.version,
      dictionarySha256: dictionary.contentSha256,
      industry: industry.code,
      specialFeatures: selectorFeatures,
      status: 'candidate_only',
      reviewAuthorization: 'not_established',
      productionEligible: false,
    },
  };
}
