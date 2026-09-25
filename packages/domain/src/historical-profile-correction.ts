import { Value } from '@sinclair/typebox/value';
import { isMarketOffering, schemas, type Market, type Offering, type Recognition, type RecognitionPatchRequest } from '@bondbuddy/contracts';

function fail(code: string): never {
  throw new Error(code);
}

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readySupported(recognition: Recognition): boolean {
  const periodsSupported = recognition.reporting_periods.length > 0 && recognition.reporting_periods.every(period =>
    validDate(period.start) && validDate(period.end) && period.start <= period.end &&
    period.period_kind !== null && period.scope !== null && period.status === 'recognized' &&
    period.uncertainty.length === 0 && period.provenance.evidence_refs.length > 0);
  const latestEnd = periodsSupported
    ? recognition.reporting_periods.reduce((latest, period) => period.end! > latest ? period.end! : latest, '')
    : null;
  const readyField = (field: Recognition['source_market'] | Recognition['source_offering'] | Recognition['latest_reporting_cutoff']) =>
    field.value !== null && field.status === 'recognized' && field.uncertainty.length === 0 && field.provenance.evidence_refs.length > 0;
  return readyField(recognition.source_market) && readyField(recognition.source_offering) &&
    readyField(recognition.latest_reporting_cutoff) && periodsSupported && recognition.latest_reporting_cutoff.value === latestEnd;
}

/** Validates semantic invariants shared by the API and worker profile repositories. */
export function validateHistoricalRecognitionProfile(value: unknown): asserts value is Recognition {
  if (!Value.Check(schemas.RecognitionResponse, value)) fail('INVALID_RECOGNITION_SCHEMA');
  const recognition = value as Recognition;
  const provenance = [recognition.source_market.provenance, recognition.source_offering.provenance,
    recognition.latest_reporting_cutoff.provenance, ...recognition.reporting_periods.map(period => period.provenance)];
  if (provenance.some(source => source.material_id !== recognition.material_id ||
      source.material_version !== recognition.material_version)) fail('HISTORICAL_PROFILE_EVIDENCE_MATERIAL_MISMATCH');
  if (recognition.source_market.value !== null && recognition.source_offering.value !== null &&
      !isMarketOffering(recognition.source_market.value, recognition.source_offering.value as Offering)) {
    fail('INVALID_SOURCE_MARKET_OFFERING');
  }
  if (recognition.state === 'ready' && !readySupported(recognition)) fail('UNSUPPORTED_READY_PROFILE');
}

/**
 * Applies a user assertion to an immutable source profile snapshot. Cited anchors
 * are provenance only: callers must verify that they belong to this material
 * version, and this function always leaves the result needing confirmation.
 */
export function applyHistoricalProfileCorrection(
  prior: Recognition,
  patch: RecognitionPatchRequest,
  context: { materialId: string; materialVersion: number; profileVersion: number },
): Recognition {
  if (patch.reason.trim().length === 0) fail('INVALID_HISTORICAL_PROFILE_CORRECTION_REASON');
  const resultingMarket = patch.source_market === undefined ? prior.source_market.value : patch.source_market;
  const resultingOffering = patch.source_offering === undefined ? prior.source_offering.value : patch.source_offering;
  if (resultingMarket !== null && resultingOffering !== null &&
      !isMarketOffering(resultingMarket, resultingOffering)) {
    fail('INVALID_SOURCE_MARKET_OFFERING');
  }

  const corrected = structuredClone(prior);
  corrected.profile_version = context.profileVersion;
  const correctionField = <T extends Market | Offering>(
    current: Recognition['source_market'] | Recognition['source_offering'], value: T | null,
  ): Recognition['source_market'] | Recognition['source_offering'] => ({
    value,
    raw_value: current.raw_value,
    provenance: {
      material_id: context.materialId,
      material_version: context.materialVersion,
      method: 'user_correction',
      extractor_version: current.provenance.extractor_version,
      evidence_refs: [...new Set(patch.evidence_refs)],
    },
    uncertainty: patch.evidence_refs.length === 0
      ? ['用户校正缺少来源锚点']
      : ['锚点存在但不证明所校正值，需人工核对原文语义'],
    status: 'user_asserted',
  });

  if (patch.source_market !== undefined) {
    corrected.source_market = correctionField(prior.source_market, patch.source_market) as Recognition['source_market'];
  }
  if (patch.source_offering !== undefined) {
    corrected.source_offering = correctionField(prior.source_offering, patch.source_offering) as Recognition['source_offering'];
  }
  if (patch.reporting_periods !== undefined) {
    corrected.reporting_periods = patch.reporting_periods.map((period, index) => {
      const current = prior.reporting_periods[index];
      return {
        start: period.start,
        end: period.end,
        period_kind: period.period_kind,
        scope: period.scope,
        raw_value: null,
        provenance: {
          material_id: context.materialId,
          material_version: context.materialVersion,
          method: 'user_correction' as const,
          extractor_version: current?.provenance.extractor_version ?? prior.latest_reporting_cutoff.provenance.extractor_version,
          evidence_refs: [...new Set(period.evidence_refs)],
        },
        uncertainty: period.evidence_refs.length === 0
          ? ['用户校正的报告期间缺少来源锚点，需人工核对']
          : ['用户校正的报告期间尚未人工核验'],
        status: 'user_asserted' as const,
      };
    });
    const periodsValid = corrected.reporting_periods.length > 0 && corrected.reporting_periods.every(period =>
      validDate(period.start) && validDate(period.end) && period.start <= period.end);
    const validEnds = periodsValid ? corrected.reporting_periods.map(period => period.end!) : [];
    const latestEnd = validEnds.length ? validEnds.reduce((latest, end) => end > latest ? end : latest) : null;
    const cutoffRefs = [...new Set(corrected.reporting_periods.flatMap(period => period.provenance.evidence_refs))];
    corrected.latest_reporting_cutoff = {
      value: latestEnd,
      raw_value: null,
      provenance: {
        material_id: context.materialId,
        material_version: context.materialVersion,
        method: 'user_correction',
        extractor_version: prior.latest_reporting_cutoff.provenance.extractor_version,
        evidence_refs: cutoffRefs,
      },
      uncertainty: latestEnd === null
        ? ['用户校正期间没有有效截止日，需人工核对']
        : ['最新截止日由用户校正期间推导，尚未人工核验'],
      status: 'user_asserted',
    };
  }
  corrected.state = 'needs_confirmation';
  return corrected;
}
