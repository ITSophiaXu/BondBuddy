import type { OcrReview, Recognition, ReportingPeriod } from '@bondbuddy/contracts';

export const HISTORICAL_OCR_RECOGNITION_VERSION = 'historical-ocr-recognition-v1';

export function historicalOcrExtractorVersion(snapshotId: string, resultSha256: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId) || !/^[a-f0-9]{64}$/.test(resultSha256)) {
    throw new Error('INVALID_OCR_PROFILE_SOURCE');
  }
  return `${HISTORICAL_OCR_RECOGNITION_VERSION}:${snapshotId}:${resultSha256}`;
}

export function parseHistoricalOcrExtractorVersion(value: unknown): { snapshotId: string; resultSha256: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^historical-ocr-recognition-v1:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([a-f0-9]{64})$/.exec(value);
  return match ? { snapshotId: match[1]!, resultSha256: match[2]! } : null;
}

type Market = NonNullable<Recognition['source_market']['value']>;
type Offering = NonNullable<Recognition['source_offering']['value']>;

function independent(records: OcrReview['records']): boolean {
  return new Set(records.map(record => record.page)).size >= 2;
}

function uncertain<T extends string>(value: T | null, raw: string | null, refs: string[], sourceVersion: string, reason: string) {
  return { value, raw_value: raw, provenance: { material_id: '', material_version: 1, method: 'ocr' as const,
    extractor_version: sourceVersion, evidence_refs: refs }, uncertainty: [reason], status: 'needs_confirmation' as const };
}

/** OCR-derived recognition remains provisional regardless of confidence or page coverage. */
export function recognizeHistoricalOcr(review: OcrReview, options: { profileVersion: number }): Recognition {
  if (!Number.isSafeInteger(options.profileVersion) || options.profileVersion < 1) throw new Error('INVALID_PROFILE_VERSION');
  if (review.eligible_for_manuscript !== false || review.material_version < 1 || !review.records.length) {
    throw new Error('INVALID_OCR_PROFILE_SOURCE');
  }
  const version = historicalOcrExtractorVersion(review.snapshot_id, review.result_sha256);
  const materialId = review.material_id;
  const materialVersion = review.material_version;
  const records = review.records;
  const text = (record: OcrReview['records'][number]) => record.text;
  const refsFor = (selected: OcrReview['records']) => [...new Set(selected.map(record => record.record_id))];
  const rawFor = (selected: OcrReview['records']) => [...new Set(selected.map(text).filter(Boolean))].join('\n') || null;
  const marketMatches = new Map<Market, OcrReview['records']>();
  for (const record of records) {
    const value = text(record);
    if (/根据|依据|按照|参照|遵照|适用|规则|办法|指引/.test(value) || /不属于|并非|不是|不在|未由/.test(value)) continue;
    if (!/本期债券|本次债券|本期发行|本次发行|发行场所|发行市场|债券发行|挂牌转让|上市交易/.test(value)) continue;
    const hits: Market[] = [];
    if (/上海证券交易所|上交所/.test(value)) hits.push('sse');
    if (/深圳证券交易所|深交所/.test(value)) hits.push('szse');
    if (/中国银行间市场交易商协会|银行间市场交易商协会|交易商协会|非金融企业债务融资工具/.test(value)) hits.push('nafmii');
    if (hits.length === 1) marketMatches.set(hits[0]!, [...(marketMatches.get(hits[0]!) ?? []), record]);
  }
  const qualifiedMarkets = [...marketMatches].filter(([, hits]) => independent(hits));
  const market: Market | null = qualifiedMarkets.length === 1 && marketMatches.size === 1 ? qualifiedMarkets[0]![0] : null;
  const marketRecords = market === null ? records.filter(record => /上交所|上海证券交易所|深交所|深圳证券交易所|交易商协会|银行间市场/.test(text(record))) : marketMatches.get(market)!;

  const offeringMatches = new Map<Offering, OcrReview['records']>();
  if (market !== null) for (const record of records) {
    const value = text(record);
    if (/根据|依据|按照|参照|遵照|适用|规则|办法|指引|不属于|并非|不是|不在|未由/.test(value)) continue;
    if (!/本期|本次|发行方式|发行概况|债券名称|注册文件|统一注册/.test(value)) continue;
    const matches: Offering[] = [];
    if (market === 'nafmii') {
      if (/定向债务融资工具|\bPPN\b/i.test(value)) matches.push('ppn');
      if (/中期票据|中票|\bMTN\b/i.test(value)) matches.push('mtn');
      if (/超短期融资券|\bSCP\b/i.test(value)) matches.push('scp');
      if (/短期融资券|\bCP\b/i.test(value) && !/超短期融资券|\bSCP\b/i.test(value)) matches.push('cp');
      if (/采用DFI|DFI储架|储架发行|统一注册文件/.test(value) && matches.length === 0) matches.push('dfi');
    } else {
      if (/非公开发行|私募(?:公司债|债券)?|面向合格投资者非公开发行/.test(value)) matches.push('private');
      if (/大公募|面向公众投资者(?:和)?专业投资者公开发行|向公众投资者公开发行/.test(value)) matches.push('public_all');
      if (/小公募|仅(?:面向|向)专业投资者公开发行|面向专业投资者公开发行/.test(value)) matches.push('public');
      // Bare “公开发行” does not distinguish the two exchange categories.
    }
    if (matches.length === 1) offeringMatches.set(matches[0]!, [...(offeringMatches.get(matches[0]!) ?? []), record]);
  }
  const qualifiedOfferings = [...offeringMatches].filter(([, hits]) => independent(hits));
  const offering: Offering | null = qualifiedOfferings.length === 1 && offeringMatches.size === 1 ? qualifiedOfferings[0]![0] : null;
  const offeringRecords = offering === null ? records.filter(record => /私募|非公开发行|公开发行|公募|\bPPN\b|\bMTN\b|\bSCP\b|\bCP\b|\bDFI\b/i.test(text(record))) : offeringMatches.get(offering)!;

  const periods: ReportingPeriod[] = [];
  const periodRecords: OcrReview['records'] = [];
  for (const record of records) {
    const value = text(record);
    if (!/报告期|财务报表|财务数据|审计报告|资产负债表|利润表|现金流量表|财务会计信息/.test(value)) continue;
    periodRecords.push(record);
    const scopeHit = /合并/.test(value) === /母公司|公司本部/.test(value) ? null : /母公司|公司本部/.test(value) ? 'parent' : 'consolidated';
    const uncertainty = ['OCR来源需要人工确认', ...(scopeHit === null ? ['OCR证据未能唯一确定报表口径'] : [])];
    const provenance = { material_id: materialId, material_version: materialVersion, method: 'ocr' as const,
      extractor_version: version, evidence_refs: [record.record_id] };
    const years = [...value.matchAll(/(20\d{2})\s*年\s*(?:半年度|上半年)/g)];
    for (const match of years) periods.push({ start: `${match[1]}-01-01`, end: `${match[1]}-06-30`, period_kind: 'interim', scope: scopeHit,
      raw_value: match[0], provenance, uncertainty: [...uncertainty], status: scopeHit ? 'needs_confirmation' : 'needs_confirmation' });
    for (const match of value.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*[-—–至到]\s*(\d{1,2})\s*月/g)) {
      const year = Number(match[1]), first = Number(match[2]), last = Number(match[3]);
      if (first < 1 || last < first || last > 12) continue;
      const end = new Date(Date.UTC(year, last, 0)).getUTCDate();
      periods.push({ start: `${year}-${String(first).padStart(2, '0')}-01`, end: `${year}-${String(last).padStart(2, '0')}-${end}`,
        period_kind: 'interim', scope: scopeHit, raw_value: match[0], provenance, uncertainty: [...uncertainty], status: 'needs_confirmation' });
    }
    for (const match of value.matchAll(/(20\d{2})\s*年(?!\s*(?:半年度|上半年|\d{1,2}\s*[-—–至到]\s*\d{1,2}\s*月))(?:度|末)?/g)) {
      periods.push({ start: `${match[1]}-01-01`, end: `${match[1]}-12-31`, period_kind: 'annual', scope: scopeHit,
        raw_value: match[0], provenance, uncertainty: [...uncertainty], status: 'needs_confirmation' });
    }
  }
  const uniquePeriods = [...new Map(periods.map(period => [`${period.start}/${period.end}/${period.scope}`, period])).values()]
    .sort((a, b) => (a.end ?? '').localeCompare(b.end ?? ''));
  const latestEnd = uniquePeriods.map(period => period.end).filter((end): end is string => end !== null).sort().at(-1) ?? null;
  const latestRefs = uniquePeriods.filter(period => period.end === latestEnd).flatMap(period => period.provenance.evidence_refs);
  const sourceMarket = uncertain(market, rawFor(marketRecords), refsFor(marketRecords), version,
    market === null ? 'OCR中的原发行市场证据不足或冲突，需确认' : 'OCR识别结果未核验，需确认');
  const sourceOffering = uncertain(offering, rawFor(offeringRecords), refsFor(offeringRecords), version,
    offering === null ? 'OCR中的原发行方式证据不足或冲突，需确认' : 'OCR识别结果未核验，需确认');
  const latest = uncertain(latestEnd, rawFor(periodRecords.filter(record => latestRefs.includes(record.record_id))), refsFor(periodRecords.filter(record => latestRefs.includes(record.record_id))), version,
    latestEnd === null ? 'OCR未提取到可识别的财务报告期间' : 'OCR报告期及截止日未核验，需确认');
  for (const field of [sourceMarket, sourceOffering, latest]) {
    field.provenance.material_id = materialId;
    field.provenance.material_version = materialVersion;
  }
  if (review.coverage !== 'complete') {
    for (const field of [sourceMarket, sourceOffering, latest]) field.uncertainty.push('OCR仅覆盖部分页面，不能视为完整文档');
  }
  return { material_id: materialId, material_version: materialVersion, profile_version: options.profileVersion,
    state: 'needs_confirmation', source_market: sourceMarket, source_offering: sourceOffering,
    reporting_periods: uniquePeriods, latest_reporting_cutoff: latest };
}
