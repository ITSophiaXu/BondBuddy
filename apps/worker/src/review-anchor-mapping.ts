import type {
  ReviewEvidenceRef,
  ReviewFinding,
  ReviewReport,
} from '../../../packages/contracts/dist/review-results.js';
import {
  canonical,
  evidenceKey,
  referenceFor,
  validateReviewEvidence,
  type ReviewEvidenceContext,
  type TrustedReviewRecord,
} from '../../../packages/domain/dist/review-evidence.js';

/** Internal worker metadata, not an authorization supplied by a browser or model. */
export interface DifferentialAnchorMapping {
  historical_ref: ReviewEvidenceRef;
  current_ref: ReviewEvidenceRef | null;
  status: 'mapped' | 'unverified' | 'missing' | 'ambiguous' | 'uncertain';
  method: 'exact_pin' | 'unique_full_quote' | 'unique_table_row' | null;
  reason: string;
}
export interface DifferentialFindingMapping {
  finding_id: string;
  complete: boolean;
  source_changed: boolean;
  anchors: DifferentialAnchorMapping[];
  historical_target_refs: ReviewEvidenceRef[];
  current_target_refs: ReviewEvidenceRef[];
}
export interface DifferentialMappingInput {
  evidence: ReviewEvidenceContext;
  scope: ReviewReport['scope'];
  previous_report?: ReviewReport;
  /** All records from each hash-verified historical parse snapshot, loaded with the same owner/project. */
  historical_records?: readonly TrustedReviewRecord[];
}
const sameMaterial = (
  ref: Pick<ReviewEvidenceRef, 'material_id' | 'material_version' | 'material_sha256'>,
  source: ReviewEvidenceContext['source_material'],
) =>
  ref.material_id === source.material_id &&
  ref.material_version === source.material_version &&
  ref.material_sha256 === source.sha256;
const isCertain = (ref: Pick<ReviewEvidenceRef, 'extraction_method' | 'uncertainty'>) =>
  ref.extraction_method === 'native_text' && ref.uncertainty.length === 0;
const sameSnapshot = (a: TrustedReviewRecord, b: TrustedReviewRecord) =>
  a.material_id === b.material_id &&
  a.material_version === b.material_version &&
  a.material_sha256 === b.material_sha256 &&
  a.parse_snapshot_id === b.parse_snapshot_id &&
  a.parse_response_sha256 === b.parse_response_sha256;
const specific = (quote: string) =>
  quote.replace(/\s/g, '').length >= 16 && (quote.match(/\p{L}/gu)?.length ?? 0) >= 8;
type TableAddress = {
  kind: 'docx' | 'xlsx' | 'csv';
  group: string;
  row: number;
  column: number;
  within: string;
};
/** Position is used to reconstruct complete rows; it is never treated as a cross-version identity. */
function tableAddress(
  ref: Pick<ReviewEvidenceRef, 'locator_type' | 'locator'>,
): TableAddress | null {
  if (ref.locator_type === 'docx_block') {
    const path = ref.locator.path;
    if (!Array.isArray(path)) return null;
    const tables = path.flatMap((p, i) =>
      p && typeof p === 'object' && typeof p.table === 'number' ? [i] : [],
    );
    if (!tables.length) return null;
    const last = tables.at(-1)!;
    const row = path.slice(last).find((p) => typeof p?.row === 'number')?.row;
    const column = path.slice(last).find((p) => typeof p?.column === 'number')?.column;
    if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
    return {
      kind: 'docx',
      group: canonical([...path.slice(0, last), { table: path[last].table }]),
      row,
      column,
      within: canonical(
        path.slice(last).flatMap((p) => (typeof p?.paragraph === 'number' ? [p.paragraph] : [])),
      ),
    };
  }
  if (ref.locator_type === 'xlsx_cell') {
    const cell = /^([A-Z]+)([1-9]\d*)$/.exec(String(ref.locator.cell));
    if (!cell || typeof ref.locator.sheet !== 'string') return null;
    const column = [...cell[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    return { kind: 'xlsx', group: ref.locator.sheet, row: Number(cell[2]), column, within: '' };
  }
  if (
    ref.locator_type === 'csv_cell' &&
    Number.isInteger(ref.locator.row) &&
    Number.isInteger(ref.locator.column)
  )
    return {
      kind: 'csv',
      group: 'csv',
      row: Number(ref.locator.row),
      column: Number(ref.locator.column),
      within: '',
    };
  return null;
}
type Row = {
  records: TrustedReviewRecord[];
  signature: string;
  address: TableAddress;
  certain: boolean;
  hasLabel: boolean;
};
function rows(records: readonly TrustedReviewRecord[]): Row[] {
  const grouped = new Map<string, { record: TrustedReviewRecord; address: TableAddress }[]>();
  for (const r of records) {
    const address = tableAddress(r);
    if (!address) continue;
    const key = canonical([
      r.material_id,
      r.material_version,
      r.material_sha256,
      r.parse_snapshot_id,
      r.parse_response_sha256,
      address.kind,
      address.group,
      address.row,
    ]);
    const group = grouped.get(key) ?? [];
    group.push({ record: r, address });
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    group.sort(
      (a, b) =>
        a.address.column - b.address.column ||
        (a.address.within < b.address.within ? -1 : a.address.within > b.address.within ? 1 : 0),
    );
    return {
      records: group.map((g) => g.record),
      address: group[0]!.address,
      signature: canonical([
        group[0]!.address.kind,
        group.map((g) => [g.address.column, g.address.within, g.record.literal_quote]),
      ]),
      certain: group.every((g) => isCertain(g.record)),
      hasLabel:
        new Set(group.map((g) => g.address.column)).size >= 2 &&
        group.some((g) => (g.record.literal_quote.match(/\p{L}/gu)?.length ?? 0) >= 2),
    };
  });
}
function mapAnchor(
  ref: ReviewEvidenceRef,
  input: DifferentialMappingInput,
  current: readonly TrustedReviewRecord[],
): DifferentialAnchorMapping {
  const base = { historical_ref: structuredClone(ref), current_ref: null, method: null };
  const exact = current.filter((r) => evidenceKey(r) === evidenceKey(ref));
  if (exact.length === 1 && !validateReviewEvidence(ref, input.evidence, true).length)
    return {
      ...base,
      status: 'mapped',
      method: 'exact_pin',
      current_ref: referenceFor(exact[0]!, ref.quote),
      reason: '原文、解析及记录 pins 完全一致。',
    };
  if (sameMaterial(ref, input.evidence.source_material))
    return {
      ...base,
      status: 'unverified',
      reason: '同一源稿的解析或记录 pin 已变化，不能仅凭相同位置代替原证据。',
    };
  if (!isCertain(ref))
    return {
      ...base,
      status: 'uncertain',
      reason: '历史锚点含 OCR 或解析不确定性，跨版本位置需人工核对。',
    };
  const historic = (input.historical_records ?? []).filter(
    (r) =>
      r.owner_user_id === input.evidence.owner_user_id &&
      r.project_id === input.evidence.project_id,
  );
  const oldCtx = { ...input.evidence, records: historic };
  const old = historic.filter((r) => evidenceKey(r) === evidenceKey(ref));
  if (old.length !== 1 || validateReviewEvidence(ref, oldCtx).length)
    return {
      ...base,
      status: 'unverified',
      reason: '缺少唯一且经哈希核对的历史完整解析记录，不能根据截取引文猜测新位置。',
    };
  const original = old[0]!;
  if (!isCertain(original))
    return {
      ...base,
      status: 'uncertain',
      reason: '历史完整记录仍存在 OCR 或解析限制，不能自动迁移位置。',
    };
  const address = tableAddress(original);
  if (address) {
    const oldRows = rows(historic.filter((r) => sameSnapshot(r, original)));
    const oldRow = oldRows.find((row) =>
      row.records.some((r) => evidenceKey(r) === evidenceKey(original)),
    );
    if (!oldRow?.hasLabel)
      return {
        ...base,
        status: 'unverified',
        reason: '表格锚点缺少完整行及指标文字，不能只凭一个金额匹配其他单元格。',
      };
    if (!oldRow.certain)
      return {
        ...base,
        status: 'uncertain',
        reason: '历史表格行含 OCR 或解析限制，不能自动迁移位置。',
      };
    if (oldRows.filter((row) => row.signature === oldRow.signature).length !== 1)
      return {
        ...base,
        status: 'ambiguous',
        reason: '历史稿存在多个相同表格行，无法证明新稿对应哪一处。',
      };
    const candidates = rows(current).filter((row) => row.signature === oldRow.signature);
    if (candidates.length > 1)
      return {
        ...base,
        status: 'ambiguous',
        reason: '新稿存在多个相同完整表格行，不能任选一行建立映射。',
      };
    if (!candidates.length)
      return {
        ...base,
        status: 'missing',
        reason: '新稿没有唯一逐字相同的完整表格行；可能已删改，仍待人工定位。',
      };
    const row = candidates[0]!;
    if (!row.certain)
      return {
        ...base,
        status: 'uncertain',
        reason: '新稿表格行含 OCR 或解析限制，不能自动确认映射。',
      };
    const targets = row.records.filter((r) => {
      const at = tableAddress(r)!;
      return (
        at.column === address.column &&
        at.within === address.within &&
        r.literal_quote === original.literal_quote
      );
    });
    if (targets.length !== 1)
      return { ...base, status: 'ambiguous', reason: '完整行虽匹配，但单元格/段落仍有歧义。' };
    const currentRef = referenceFor(targets[0]!);
    if (validateReviewEvidence(currentRef, input.evidence, true).length)
      return { ...base, status: 'unverified', reason: '新稿表格位置未通过当前材料证据校验。' };
    return {
      ...base,
      status: 'mapped',
      method: 'unique_table_row',
      current_ref: currentRef,
      reason:
        '历史及新稿中均唯一的完整表格行逐字一致，已重新绑定当前单元格；不据此认定财务结论已通过。',
    };
  }
  if (!specific(original.literal_quote))
    return {
      ...base,
      status: 'unverified',
      reason: '历史段落过短或仅有数字，缺少足够文字识别新稿位置。',
    };
  const oldDuplicates = historic.filter(
    (r) =>
      sameSnapshot(r, original) && !tableAddress(r) && r.literal_quote === original.literal_quote,
  );
  if (oldDuplicates.length !== 1)
    return {
      ...base,
      status: 'ambiguous',
      reason: '历史稿存在多个相同完整段落，不能将新稿单一位置默认对应本项。',
    };
  const matches = current.filter(
    (r) => !tableAddress(r) && r.literal_quote === original.literal_quote,
  );
  if (matches.length > 1)
    return {
      ...base,
      status: 'ambiguous',
      reason: '新稿存在多个相同完整段落，不能根据旧段号选择其中一个。',
    };
  if (!matches.length)
    return {
      ...base,
      status: 'missing',
      reason: '新稿未找到逐字一致的完整段落；可能已移动并改写或删除，不能认定原问题已解决。',
    };
  if (!isCertain(matches[0]!))
    return {
      ...base,
      status: 'uncertain',
      reason: '新稿候选位置含 OCR 或解析不确定性，仍需人工确认。',
    };
  const currentRef = referenceFor(matches[0]!);
  if (validateReviewEvidence(currentRef, input.evidence, true).length)
    return { ...base, status: 'unverified', reason: '新稿段落位置未通过当前材料证据校验。' };
  return {
    ...base,
    status: 'mapped',
    method: 'unique_full_quote',
    current_ref: currentRef,
    reason: '历史及新稿中均唯一的完整段落逐字一致，已绑定当前记录；原问题仍须重新核查。',
  };
}

export function mapDifferentialReviewTargets(
  input: DifferentialMappingInput,
): DifferentialFindingMapping[] {
  if (input.scope.mode !== 'differential_review') return [];
  const previous = input.previous_report;
  if (!previous) throw new Error('REVIEW_PREVIOUS_REPORT_REQUIRED');
  const selected = new Set(input.scope.finding_ids);
  if (
    !selected.size ||
    selected.size !== input.scope.finding_ids.length ||
    input.scope.finding_ids.some((id) => !previous.findings.some((f) => f.finding_id === id))
  )
    throw new Error('REVIEW_DIFFERENTIAL_SELECTION_INVALID');
  const current = input.evidence.records.filter(
    (r) =>
      sameMaterial(r, input.evidence.source_material) &&
      r.owner_user_id === input.evidence.owner_user_id &&
      r.project_id === input.evidence.project_id,
  );
  return previous.findings
    .filter((f) => selected.has(f.finding_id))
    .map((finding) => {
      const anchors = finding.target_refs.map((ref) => mapAnchor(ref, input, current));
      return {
        finding_id: finding.finding_id,
        complete: anchors.length > 0 && anchors.every((a) => a.status === 'mapped'),
        source_changed: finding.target_refs.some(
          (ref) => !sameMaterial(ref, input.evidence.source_material),
        ),
        anchors,
        historical_target_refs: structuredClone(finding.target_refs),
        current_target_refs: anchors.flatMap((a) => (a.current_ref ? [a.current_ref] : [])),
      };
    });
}

/** Preserve old positions explicitly as historical data, with no revision permission on the new manuscript. */
export function retainUnmappedHistoricalFinding(
  prior: ReviewFinding,
  reportId: string,
  reasons: readonly string[],
): ReviewFinding {
  return {
    ...structuredClone(prior),
    report_id: reportId,
    origin_report_id: prior.origin_report_id,
    check_status: 'carried_forward',
    limitations: [
      ...new Set([
        ...prior.limitations,
        'historical_target_not_mapped_to_current_source',
        ...reasons,
      ]),
    ],
    repairability: {
      can_revise: false,
      allowed_record_ids: [],
      reason: '此处保留历史源稿位置；未完成当前源稿映射，不得用于当前 Word 批注或修订。',
    },
  };
}
