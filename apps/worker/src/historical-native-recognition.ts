import type { Recognition, ReportingPeriod } from '@bondbuddy/contracts';
import { parseHistoricalNativeExtractorVersion } from '@bondbuddy/domain/historical-native-extractor-version';
import type { DocumentParseResponse, DocumentParseRecord } from './document-parser.js';
import { nafmiiOfferingEvidence } from './nafmii-offering-evidence.js';

/** Conservative native-text subset of historical prospectus recognition. */
export const HISTORICAL_NATIVE_RECOGNITION_VERSION = 'historical-native-recognition-v3' as const;
export { parseHistoricalNativeExtractorVersion };

type Market = NonNullable<Recognition['source_market']['value']>;
type Offering = NonNullable<Recognition['source_offering']['value']>;
type Candidate<T> = { value: T; records: DocumentParseRecord[] };

function normalize(value: string): string {
  return value.replace(/[\s\u3000]+/g, '').replace(/[：:]/g, ':');
}

function uniqueRecords(records: readonly DocumentParseRecord[]): DocumentParseRecord[] {
  return [...new Map(records.map(record => [record.record_id, record])).values()];
}

function raw(records: readonly DocumentParseRecord[]): string | null {
  const quotes = [...new Set(records.map(record => record.literal_quote.trim()).filter(Boolean))];
  return quotes.length ? quotes.join('\n') : null;
}

function uncertaintyOf(records: readonly DocumentParseRecord[], extra: readonly string[] = []): string[] {
  return [...new Set([...records.flatMap(record => record.uncertainty), ...extra])];
}

function recognizedField<T extends string>(input: {
  value: T | null;
  records: readonly DocumentParseRecord[];
  uncertainty?: readonly string[];
  status?: 'recognized' | 'needs_confirmation' | 'unknown';
  materialId: string;
  materialVersion: number;
  parserVersion: string;
}): Omit<Recognition['source_market'], 'value'> & { value: T | null } {
  const records = uniqueRecords(input.records);
  return {
    value: input.value,
    raw_value: raw(records),
    provenance: {
      material_id: input.materialId,
      material_version: input.materialVersion,
      method: 'native_text',
      extractor_version: input.parserVersion,
      evidence_refs: records.map(record => record.record_id),
    },
    uncertainty: uncertaintyOf(records, input.uncertainty),
    status: input.status ?? (input.value === null ? 'needs_confirmation' : 'recognized'),
  };
}

function field<T extends string>(input: Parameters<typeof recognizedField<T>>[0]): Omit<Recognition['source_market'], 'value'> & { value: T | null } {
  return recognizedField(input);
}

function isRuleCitation(text: string): boolean {
  const compact = normalize(text);
  return /根据|依据|按照|参照|遵照|适用|本规则|本办法|本指引|通知规定|规则要求/.test(compact)
    || /《[^》]*(?:办法|规则|指引|通知|规定|业务指南)[^》]*》/.test(compact);
}

function isNegatedClaim(text: string): boolean {
  return /(?:不属于|并非|不是|不在|未在|不由|未由|不得按|不能视为)/.test(normalize(text));
}

function allText(record: DocumentParseRecord): string {
  return `${record.literal_quote}\n${record.context}`;
}

function evidenceZone(record: DocumentParseRecord): string | null {
  const page = record.locator.page;
  if (record.locator_type === 'pdf_bbox' && Number.isSafeInteger(page) && Number(page) > 0) {
    return `page:${page}`;
  }
  const section = normalize(record.context);
  return section && !/^PDFpage\d+$/i.test(section) ? `section:${section}` : null;
}

function explicitVenue(record: DocumentParseRecord): Market | null {
  const text = allText(record);
  if (isRuleCitation(text) || isNegatedClaim(text)) return null;
  const compact = normalize(text);
  // Venue must be connected to this issuance/document, not just mentioned as a regulator.
  const issuance = /本期债券|本次债券|本期发行|本次发行|发行场所|发行市场|发行人(?:拟)?发行|债券(?:拟)?发行|挂牌转让|上市交易/.test(compact);
  if (!issuance) return null;
  const shanghai = /上海证券交易所|上交所/.test(compact);
  const shenzhen = /深圳证券交易所|深交所/.test(compact);
  const nafmii = /中国银行间市场交易商协会|银行间市场交易商协会|交易商协会|非金融企业债务融资工具/.test(compact);
  const matches = [shanghai, shenzhen, nafmii].filter(Boolean).length;
  if (matches !== 1) return null;
  return shanghai ? 'sse' : shenzhen ? 'szse' : 'nafmii';
}

function pickConsensus<T extends string>(candidates: readonly Candidate<T>[], need: number): {
  value: T | null;
  records: DocumentParseRecord[];
  uncertainty: string[];
} {
  const byValue = new Map<T, DocumentParseRecord[]>();
  for (const candidate of candidates) {
    byValue.set(candidate.value, [...(byValue.get(candidate.value) ?? []), ...candidate.records]);
  }
  const qualified = [...byValue.entries()]
    .map(([value, records]) => ({ value, records: uniqueRecords(records) }))
    .filter(candidate => new Set(candidate.records.map(record => normalize(record.literal_quote))).size >= need
      && new Set(candidate.records.map(evidenceZone).filter((zone): zone is string => zone !== null)).size >= need);
  const allEvidence = uniqueRecords(candidates.flatMap(candidate => candidate.records));
  const hasConflict = byValue.size > 1;
  if (qualified.length === 1 && !hasConflict) {
    const selected = qualified[0]!;
    return { value: selected.value, records: selected.records, uncertainty: uncertaintyOf(selected.records) };
  }
  const conflicting = qualified.length > 1 || hasConflict;
  return {
    value: null,
    records: allEvidence,
    uncertainty: uncertaintyOf(allEvidence, [conflicting ? '多个相互冲突的明确候选，需人工确认' : `明确证据不足（至少需要 ${need} 条来自不同位置或章节的独立原文记录）`]),
  };
}

function marketEvidence(records: readonly DocumentParseRecord[]): Candidate<Market>[] {
  return records.flatMap(record => {
    const value = explicitVenue(record);
    return value ? [{ value, records: [record] }] : [];
  });
}

function sourceOffering(record: DocumentParseRecord, market: Market | null): Offering | null {
  const text = allText(record);
  if (isRuleCitation(text) || isNegatedClaim(text)) return null;
  const compact = normalize(text);
  const originalIssue = /本期(?:公司)?债券|本次(?:公司)?债券|本期发行|本次发行|发行方式|发行概况|债券名称|注册文件|统一注册/.test(compact);
  if (!originalIssue) return null;

  if (market === 'nafmii') {
    return nafmiiOfferingEvidence(record.literal_quote);
  }

  if (market !== 'sse' && market !== 'szse') return null;
  if (/非公开发行|私募(?:公司债|债券)?|面向合格投资者非公开发行/.test(compact)) return 'private';
  if (/大公募|面向公众投资者(?:和)?专业投资者公开发行|向公众投资者公开发行/.test(compact)) return 'public_all';
  if (/小公募|仅(?:面向|向)专业投资者公开发行|面向专业投资者公开发行/.test(compact)) return 'public';
  // “公开发行” alone does not distinguish the exchange's public offerings.
  if (/公开发行/.test(compact)) return null;
  return null;
}

function offeringEvidence(records: readonly DocumentParseRecord[], market: Market | null): Candidate<Offering>[] {
  if (market === null) return [];
  return records.flatMap(record => {
    const value = sourceOffering(record, market);
    return value ? [{ value, records: [record] }] : [];
  });
}

function offeringSourceRecords(records: readonly DocumentParseRecord[], market: Market | null): DocumentParseRecord[] {
  if (market === null) return [];
  return uniqueRecords(records.filter(record => {
    const text = normalize(allText(record));
    const originalIssue = /本期(?:公司)?债券|本次(?:公司)?债券|本期发行|本次发行|本期.*(?:公开|非公开|公募|私募)|发行方式|发行概况|债券名称|注册文件|统一注册/.test(text);
    if (!originalIssue) return false;
    if (market === 'nafmii') return /定向债务融资工具|PPN|中期票据|中票|MTN|短期融资券|CP|超短期融资券|SCP|DFI|储架发行|统一注册/i.test(text);
    return /非公开发行|私募|公开发行|公募/.test(text);
  }));
}

function inFinancialContext(record: DocumentParseRecord): boolean {
  const text = normalize(allText(record));
  return /财务会计信息|财务报表|审计报告|资产负债表|利润表|现金流量表|主要财务数据|报告期|合并口径|母公司口径/.test(text);
}

function reportingPeriodMatches(record: DocumentParseRecord): ReportingPeriod[] {
  const text = record.literal_quote;
  const compact = normalize(text);
  const hasSigningOrIssueDate = /签署日|签署日期|发行日|发行日期|签署于|发行于/.test(compact);
  const explicitPeriod = /报告期|财务报表|财务数据|财务会计信息|审计报告|资产负债表|利润表|现金流量表/.test(compact);
  const periodTableHeader = Array.isArray(record.locator.path) && record.locator.path.some(part => typeof part === 'object' && part !== null && 'table' in part);
  const annualHeaderInContext = periodTableHeader && inFinancialContext(record);
  const halfYearLabel = /20\d{2}\s*年\s*(?:半年度|上半年)/.test(text);
  // Native parsers can put a financial heading in the record context and the
  // period label alone in the quote. Accept that label only under a financial
  // heading; a date or a similarly worded nonfinancial reference is not enough.
  const halfYearLabelInFinancialSection = halfYearLabel && inFinancialContext(record);
  if (hasSigningOrIssueDate || (!explicitPeriod && !annualHeaderInContext && !halfYearLabelInFinancialSection)) return [];
  const periodRecords: ReportingPeriod[] = [];
  const scopeText = normalize(allText(record));
  const hasParentScope = /母公司|公司本部/.test(scopeText);
  const hasConsolidatedScope = /合并/.test(scopeText);
  const scope = hasParentScope === hasConsolidatedScope ? null : hasParentScope ? 'parent' : 'consolidated';
  const provenance = {
    material_id: record.material_id,
    material_version: record.material_version,
    method: 'native_text' as const,
    extractor_version: `${HISTORICAL_NATIVE_RECOGNITION_VERSION}/${record.extractor_version}`,
    evidence_refs: [record.record_id],
  };
  const uncertainty = [...record.uncertainty];
  if (hasParentScope && hasConsolidatedScope) uncertainty.push('同一证据同时出现合并与母公司口径，需拆分或确认');
  else if (scope === null) uncertainty.push('未能从原文或所属财务章节确定报表口径');

  const explicitRanges = [...text.matchAll(/(20\d{2})\s*年?\s*(?:至|到|—|–|-|~|～)\s*(20\d{2})\s*年?(?:度|年度)?/g)];
  for (const match of explicitRanges) {
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (last < first || last - first > 10) continue;
    for (let year = first; year <= last; year++) periodRecords.push({
      start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope,
      raw_value: match[0], provenance, uncertainty: [...uncertainty],
      status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
    });
  }

  const monthRanges = [...text.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*[-—–至到]\s*(\d{1,2})\s*月/g)];
  for (const match of monthRanges) {
    const year = Number(match[1]);
    const firstMonth = Number(match[2]);
    const lastMonth = Number(match[3]);
    if (firstMonth < 1 || firstMonth > 12 || lastMonth < firstMonth || lastMonth > 12) continue;
    const endDay = new Date(Date.UTC(year, lastMonth, 0)).getUTCDate();
    periodRecords.push({
      start: `${year}-${String(firstMonth).padStart(2, '0')}-01`,
      end: `${year}-${String(lastMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
      period_kind: 'interim', scope, raw_value: match[0], provenance,
      uncertainty: [...uncertainty],
      status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
    });
  }

  for (const match of text.matchAll(/(20\d{2})\s*年\s*(?:半年度|上半年)/g)) {
    const year = Number(match[1]);
    periodRecords.push({
      start: `${year}-01-01`, end: `${year}-06-30`, period_kind: 'interim', scope,
      raw_value: match[0], provenance, uncertainty: [...uncertainty],
      status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
    });
  }

  const threeMonthCutoffs = [...text.matchAll(/截至\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日[^。；\n]{0,12}三个月/g)];
  for (const match of threeMonthCutoffs) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const end = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || end.getUTCFullYear() !== year || end.getUTCMonth() !== month - 1 || end.getUTCDate() !== day) continue;
    const start = new Date(Date.UTC(year, month - 1 - 3, day + 1));
    periodRecords.push({
      start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
      period_kind: 'interim', scope, raw_value: match[0], provenance,
      uncertainty: [...uncertainty],
      status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
    });
  }

  // Financial table headers often list one annual column per record instead
  // of spelling a range. Require an annual/report-period marker, so a cover
  // year or an ordinary date is not treated as a reporting period.
  if (/年度|年报|报告期/.test(compact) || annualHeaderInContext) {
    for (const match of text.matchAll(/(20\d{2})\s*年(?:度)?/g)) {
      const year = Number(match[1]);
      const atYear = text.slice(match.index);
      if (/^20\d{2}\s*年\s*(?:半年度|上半年)/.test(atYear)) continue;
      if (/^20\d{2}\s*年.{0,5}(?:第\s*)?[一二三四1-4]\s*季/.test(atYear)) continue;
      if (/^20\d{2}\s*年\s*\d{1,2}\s*[-—–至到]/.test(atYear)) continue;
      if (/^20\d{2}\s*年\s*\d{1,2}月\s*\d{1,2}日/.test(atYear)) continue;
      if (periodRecords.some(period => period.start === `${year}-01-01` && period.end === `${year}-12-31`)) continue;
      periodRecords.push({
        start: `${year}-01-01`, end: `${year}-12-31`, period_kind: 'annual', scope,
        raw_value: match[0], provenance, uncertainty: [...uncertainty],
        status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
      });
    }
  }

  const quarters = [...text.matchAll(/(20\d{2})\s*年?\s*(?:第\s*)?([一二三四1-4])\s*季(?:度)?/g)];
  for (const match of quarters) {
    const q = ({ '一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4 } as Record<string, number>)[match[2]!];
    const year = Number(match[1]);
    const ends = ['03-31', '06-30', '09-30', '12-31'];
    const starts = ['01-01', '04-01', '07-01', '10-01'];
    periodRecords.push({
      start: `${year}-${starts[q - 1]}`, end: `${year}-${ends[q - 1]}`, period_kind: 'interim', scope,
      raw_value: match[0], provenance, uncertainty: [...uncertainty],
      status: uncertainty.length || scope === null ? 'needs_confirmation' : 'recognized',
    });
  }

  if (periodRecords.length === 0 && /报告期/.test(compact)) {
    const years = [...text.matchAll(/20\d{2}/g)].map(match => match[0]);
    if (years.length) periodRecords.push({
      start: null, end: null, period_kind: null, scope, raw_value: raw([record]), provenance,
      uncertainty: [...uncertainty, '报告期表述无法解析为明确年度或中期期间'], status: 'needs_confirmation',
    });
  }
  return periodRecords;
}

function recognitionPeriod(records: readonly DocumentParseRecord[]): ReportingPeriod[] {
  const byPeriod = new Map<string, ReportingPeriod[]>();
  for (const record of records) {
    if (!inFinancialContext(record)) continue;
    for (const period of reportingPeriodMatches(record)) {
      const key = `${period.start ?? ''}/${period.end ?? ''}/${period.period_kind ?? ''}/${period.scope ?? ''}`;
      byPeriod.set(key, [...(byPeriod.get(key) ?? []), period]);
    }
  }
  return [...byPeriod.values()].map(periods => {
    const first = periods[0]!;
    const refs = [...new Set(periods.flatMap(period => period.provenance.evidence_refs))];
    const uncertainties = [...new Set(periods.flatMap(period => period.uncertainty))];
    const scopes = new Set(periods.map(period => period.scope));
    const uncertainty = [...uncertainties];
    if (scopes.size > 1) uncertainty.push('同一期间出现不同报表口径');
    const rawValue = [...new Set(periods.map(period => period.raw_value).filter((value): value is string => value !== null))].join('；') || null;
    return {
      ...first,
      raw_value: rawValue,
      provenance: { ...first.provenance, evidence_refs: refs },
      uncertainty: [...new Set(uncertainty)],
      status: uncertainty.length ? 'needs_confirmation' as const : first.status,
    };
  }).sort((a, b) => (a.end ?? '').localeCompare(b.end ?? '') || (a.scope ?? '').localeCompare(b.scope ?? ''));
}

/**
 * Derives source fields only from the version-bound parser records. It has no
 * filename, client authorization, signing-date, or issuance-date input.
 */
export function recognizeHistoricalNativeText(response: DocumentParseResponse, options: { profileVersion: number }): Recognition {
  if (!Number.isSafeInteger(options.profileVersion) || options.profileVersion < 1) throw new Error('INVALID_PROFILE_VERSION');
  if (!response.material) throw new Error('HISTORICAL_RECOGNITION_MATERIAL_REQUIRED');
  const { material } = response;
  const records = (response.status === 'failed' ? [] : response.records).filter(record => record.extraction_method === 'native_text'
    && record.material_id === material.material_id
    && record.material_version === material.material_version
    && record.content_hash === material.sha256);
  const base = {
    materialId: material.material_id,
    materialVersion: material.material_version,
    parserVersion: `${HISTORICAL_NATIVE_RECOGNITION_VERSION}/${response.parser_version || 'unknown-parser'}`,
  };
  const noRecords = records.length === 0;
  const failed = response.status === 'failed';
  const marketDecision = pickConsensus(marketEvidence(records), 2);
  const marketField = field<NonNullable<Market>>({
    ...base,
    ...marketDecision,
    records: marketDecision.records,
    uncertainty: failed ? ['原生文本解析失败'] : response.status === 'needs_confirmation'
      ? [...marketDecision.uncertainty, ...response.warnings.map(warning => warning.message), '解析器标记材料仍需确认，native_text 子集不覆盖全部识别要求']
      : noRecords ? ['没有可用的同版本原生文本证据'] : marketDecision.uncertainty,
    status: failed ? 'unknown' : response.status === 'needs_confirmation' ? 'needs_confirmation' : undefined,
  });
  const offeringDecision = pickConsensus(offeringEvidence(records, marketDecision.value), 2);
  const ambiguousDfiReferences = marketDecision.value === 'nafmii'
    ? records.filter(record => /DFI|储架发行|统一注册/.test(normalize(allText(record))) && isRuleCitation(allText(record)))
    : [];
  const offeringRecordsForField = uniqueRecords([
    ...offeringDecision.records,
    ...ambiguousDfiReferences,
    ...offeringSourceRecords(records, marketDecision.value),
  ]);
  const offeringUncertainty = [
    ...offeringDecision.uncertainty,
    ...(ambiguousDfiReferences.length ? ['原稿引用DFI规则/通知，但不能据此判定原稿为DFI注册文件，需确认具体文书阶段'] : []),
  ];
  const offeringField = field<NonNullable<Offering>>({
    ...base,
    ...offeringDecision,
    records: offeringRecordsForField,
    uncertainty: failed ? ['原生文本解析失败'] : response.status === 'needs_confirmation'
      ? [...offeringUncertainty, ...response.warnings.map(warning => warning.message), '解析器标记材料仍需确认，native_text 子集不覆盖全部识别要求']
      : noRecords ? ['没有可用的同版本原生文本证据'] : offeringUncertainty,
    status: failed ? 'unknown' : response.status === 'needs_confirmation' || ambiguousDfiReferences.length > 0 ? 'needs_confirmation' : undefined,
  });

  const reportingPeriods = failed ? [] : recognitionPeriod(records).map(period => response.status === 'needs_confirmation'
    ? { ...period, status: 'needs_confirmation' as const, uncertainty: [...period.uncertainty, ...response.warnings.map(warning => warning.message), '解析器标记材料仍需确认，native_text 子集不覆盖全部识别要求'] }
    : period);
  const validEnds = reportingPeriods.filter(period => period.end !== null && period.status === 'recognized').map(period => period.end!);
  const uniqueEnds = [...new Set(validEnds)].sort();
  const cutoffConflict = new Set(reportingPeriods.filter(period => period.end !== null).map(period => period.end)).size > 1
    && reportingPeriods.some(period => period.status === 'needs_confirmation');
  const cutoffValue = uniqueEnds.length && !cutoffConflict ? uniqueEnds.at(-1)! : null;
  const cutoffEvidenceIds = new Set(reportingPeriods
    .filter(period => cutoffValue === null || period.end === cutoffValue)
    .flatMap(period => period.provenance.evidence_refs));
  const cutoffEvidence = records.filter(record => cutoffEvidenceIds.has(record.record_id));
  const cutoffField = field<NonNullable<Recognition['latest_reporting_cutoff']['value']>>({
    ...base,
    value: cutoffValue,
    records: cutoffEvidence,
    uncertainty: failed ? ['原生文本解析失败'] : response.status === 'needs_confirmation'
      ? [...response.warnings.map(warning => warning.message), '解析器标记材料仍需确认，不能将 native_text 子集视为完整识别']
      : cutoffValue === null
      ? [reportingPeriods.length ? '报告期存在歧义或口径未确认，不能确认最新截止日' : '没有可识别的财务报告期间']
      : [],
    status: failed ? 'unknown' : response.status === 'needs_confirmation' ? 'needs_confirmation' : undefined,
  });

  return {
    material_id: material.material_id,
    material_version: material.material_version,
    profile_version: options.profileVersion,
    state: failed ? 'failed' : response.status === 'needs_confirmation' ? 'needs_confirmation'
      : [marketField.value, offeringField.value, reportingPeriods.length > 0, cutoffField.value].every(Boolean)
      && marketField.status === 'recognized' && offeringField.status === 'recognized' && reportingPeriods.every(period => period.status === 'recognized')
      ? 'ready' : 'needs_confirmation',
    source_market: marketField,
    source_offering: offeringField,
    reporting_periods: reportingPeriods,
    latest_reporting_cutoff: cutoffField,
  };
}
