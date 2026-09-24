/** Pure, account-scoped helpers for issuer facts. These are internal domain
 * types; public API DTOs remain owned by @bondbuddy/contracts. */

export type FactSourceKind = 'audited' | 'user_statement' | 'external' | 'template' | 'reference';
export type FactStatus = 'extracted' | 'verified' | 'user_asserted' | 'conflicted' | 'needs_confirmation' | 'superseded';

export interface FactPeriod {
  readonly start?: string;
  readonly end?: string;
  readonly asOf?: string;
}

export interface FactIdentity {
  /** Account ownership is part of the identity to prevent cross-account reuse. */
  readonly accountId: string;
  readonly entityId: string;
  /** Examples: consolidated, parent_only, subsidiary:123. */
  readonly scope: string;
  readonly metric: string;
  readonly period: FactPeriod;
  readonly currency: string | null;
  readonly unit: string;
  readonly basis: string;
  readonly dataVersion: string;
}

export interface FactCandidate {
  readonly candidateId: string;
  readonly identity: FactIdentity;
  /** Explicitly distinguishes a reported zero from absent or inapplicable data. */
  readonly value:
    | { readonly kind: 'known'; readonly decimalOrText: string }
    | { readonly kind: 'unknown' }
    | { readonly kind: 'not_applicable' };
  readonly source: {
    readonly kind: FactSourceKind;
    readonly sourceId: string;
    readonly observedAt: string;
    readonly validAsOf?: string;
  };
  readonly confidence: number;
  readonly uncertainty?: string | null;
  /** A human check against the original audit anchor, not auditor attestation. */
  readonly auditCheck?: {
    readonly kind: 'source_anchor_review';
    readonly evidenceId: string;
    readonly verifierId: string;
    readonly verifierRole: 'internal_reviewer';
  } | null;
}

export interface FactGroup {
  readonly identityKey: string;
  readonly candidates: readonly FactCandidate[];
  readonly status: 'single' | 'consistent' | 'conflicted' | 'needs_confirmation';
}

const MIN_VERIFIED_CONFIDENCE = 0.9;
const FORBIDDEN_ISSUER_SOURCES = new Set<FactSourceKind>(['template', 'reference']);

function periodKey(period: FactPeriod): readonly (string | null)[] {
  return [period.start ?? null, period.end ?? null, period.asOf ?? null];
}

/** Exact identity includes account, entity, scope, period, units/basis and data version. */
export function factIdentityKey(identity: FactIdentity): string {
  return JSON.stringify([
    identity.accountId,
    identity.entityId,
    identity.scope,
    identity.metric,
    periodKey(identity.period),
    identity.currency,
    identity.unit,
    identity.basis,
    identity.dataVersion,
  ]);
}

/** Templates and reference issuers may guide structure, but can never contribute issuer facts. */
export function isIssuerFactSource(kind: FactSourceKind): boolean {
  return !FORBIDDEN_ISSUER_SOURCES.has(kind);
}

/** An uncertain or weakly supported extraction cannot become verified. User statements stay asserted. */
export function factCandidateStatus(candidate: FactCandidate): FactStatus {
  if (!isIssuerFactSource(candidate.source.kind)) throw new Error('NON_ISSUER_FACT_SOURCE');
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error('INVALID_CONFIDENCE');
  }
  if (candidate.source.kind === 'user_statement') return 'user_asserted';
  if (candidate.value.kind === 'unknown') return 'needs_confirmation';
  if ((candidate.uncertainty ?? '').trim() !== '' || candidate.confidence < MIN_VERIFIED_CONFIDENCE) {
    return 'needs_confirmation';
  }
  if (candidate.value.kind === 'known'
    && candidate.auditCheck?.kind === 'source_anchor_review'
    && candidate.auditCheck.evidenceId.trim() !== ''
    && candidate.auditCheck.verifierId.trim() !== ''
    && candidate.auditCheck.verifierRole === 'internal_reviewer'
    && candidate.source.kind === 'audited') return 'verified';
  return 'extracted';
}

/** Groups only identical fact keys. Conflicting values are retained as candidates; none wins implicitly. */
export function groupFactCandidates(candidates: readonly FactCandidate[]): FactGroup[] {
  const grouped = new Map<string, FactCandidate[]>();
  for (const candidate of candidates) {
    if (!isIssuerFactSource(candidate.source.kind)) continue;
    const key = factIdentityKey(candidate.identity);
    const bucket = grouped.get(key) ?? [];
    bucket.push(candidate);
    grouped.set(key, bucket);
  }

  return [...grouped].map(([identityKey, entries]) => {
    const knownValues = new Set(entries.filter((entry) => entry.value.kind === 'known').map((entry) => {
      if (entry.value.kind !== 'known') return '';
      try {
        return `decimal:${normalizeDecimal(entry.value.decimalOrText)}`;
      } catch {
        return `text:${entry.value.decimalOrText.trim()}`;
      }
    }));
    const hasNotApplicableAndValue = knownValues.size > 0 && entries.some((entry) => entry.value.kind === 'not_applicable');
    const candidatesNeedConfirmation = entries.some((entry) => factCandidateStatus(entry) === 'needs_confirmation');
    const hasCrossSourceDisagreement = knownValues.size > 1 || hasNotApplicableAndValue;
    return {
      identityKey,
      candidates: entries,
      status: hasCrossSourceDisagreement
        ? 'conflicted'
        : candidatesNeedConfirmation
          ? 'needs_confirmation'
          : entries.length > 1
            ? 'consistent'
            : 'single',
    };
  });
}

interface DecimalParts {
  coefficient: bigint;
  scale: number;
}

function parseDecimal(value: string): DecimalParts {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error('INVALID_DECIMAL');
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return { coefficient: sign * BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function alignDecimals(left: DecimalParts, right: DecimalParts): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [left.coefficient * 10n ** BigInt(scale - left.scale), right.coefficient * 10n ** BigInt(scale - right.scale), scale];
}

/** Canonicalizes plain base-10 decimal strings without floating-point conversion. */
export function normalizeDecimal(value: string): string {
  const { coefficient, scale } = parseDecimal(value);
  if (coefficient === 0n) return '0';
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  return formatDecimal(normalizedCoefficient, normalizedScale);
}

export interface CreditFacilityAmount {
  readonly bank: string;
  readonly asOf: string;
  readonly currency: string;
  readonly unit: string;
  readonly basis: string;
  readonly scope: string;
  readonly amount: string | null;
}

export type CreditFacilityCheck =
  | { readonly status: 'needs_confirmation'; readonly reason: 'missing_amount' | 'context_mismatch' }
  | { readonly status: 'consistent' | 'conflicted'; readonly statedTotal: string; readonly calculatedTotal: string };

/** Checks total = used + unused only when all three amounts share the same complete context. */
export function checkCreditFacilityAmounts(
  total: CreditFacilityAmount,
  used: CreditFacilityAmount,
  unused: CreditFacilityAmount,
): CreditFacilityCheck {
  const context = (entry: CreditFacilityAmount) => JSON.stringify([
    entry.bank, entry.asOf, entry.currency, entry.unit, entry.basis, entry.scope,
  ]);
  if (context(total) !== context(used) || context(total) !== context(unused)) {
    return { status: 'needs_confirmation', reason: 'context_mismatch' };
  }
  if (total.amount === null || used.amount === null || unused.amount === null) {
    return { status: 'needs_confirmation', reason: 'missing_amount' };
  }
  const totalValue = parseDecimal(total.amount);
  const usedValue = parseDecimal(used.amount);
  const unusedValue = parseDecimal(unused.amount);
  if ([totalValue, usedValue, unusedValue].some((value) => value.coefficient < 0n)) throw new Error('NEGATIVE_CREDIT_FACILITY_AMOUNT');
  const [usedCoefficient, unusedCoefficient, resultScale] = alignDecimals(usedValue, unusedValue);
  const calculated = normalizeDecimal(formatDecimal(usedCoefficient + unusedCoefficient, resultScale));
  const stated = normalizeDecimal(total.amount);
  return stated === calculated
    ? { status: 'consistent', statedTotal: stated, calculatedTotal: calculated }
    : { status: 'conflicted', statedTotal: stated, calculatedTotal: calculated };
}

export interface ParseCacheIdentity {
  readonly accountId: string;
  readonly fileSha256: string;
  readonly parserVersion: string;
  readonly ocrVersion: string;
  readonly basisVersion: string;
  /** Deliberately ignored: names and projects do not change content identity. */
  readonly filename?: string;
  readonly projectId?: string;
}

/** Content cache key is account-isolated and independent of filename/project. */
export function parseCacheKey(identity: ParseCacheIdentity): string {
  if ([identity.accountId, identity.parserVersion, identity.ocrVersion, identity.basisVersion]
    .some((part) => part.trim() === '')) {
    throw new Error('INVALID_CACHE_IDENTITY');
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.fileSha256)) throw new Error('INVALID_SHA256');
  return JSON.stringify([
    identity.accountId,
    identity.fileSha256.toLowerCase(),
    identity.parserVersion,
    identity.ocrVersion,
    identity.basisVersion,
  ]);
}
