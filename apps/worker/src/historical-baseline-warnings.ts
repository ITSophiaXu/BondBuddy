import type { HistoricalBaseline } from '@bondbuddy/domain/historical-update';
import {
  supportsDocxAuxiliaryTargets,
  type DocumentParseResponse,
  type DocxAuxiliaryTarget,
} from './document-parser.js';

export const HISTORICAL_TEST_BASELINE_POLICY = 'localized-auxiliary-user-asserted-v1' as const;
const hash = (value: string | null) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** These objects are preserved, not approved, extracted facts or model-editable text. */
function preservedObject(target: DocxAuxiliaryTarget): boolean {
  const scope = target.scope;
  if (
    !target.locator_resolved ||
    !hash(target.part_sha256) ||
    !hash(target.target_sha256) ||
    scope.truncated ||
    !hash(scope.relationship_part_sha256)
  )
    return false;
  if (target.kind === 'drawing')
    return (
      target.part_name === 'word/document.xml' &&
      target.parse_status === 'not_extracted' &&
      scope.kind === 'drawing_relationship' &&
      scope.status === 'unknown' &&
      scope.reason === 'drawing_relationship_targets_not_extracted' &&
      scope.relationships.every(
        (r) =>
          r.mode === 'internal' && r.relationship_type === 'image' && r.status === 'unsupported',
      )
    );
  if (
    !target.parseable ||
    !['parsed', 'empty'].includes(target.parse_status) ||
    !scope.relationships.length ||
    scope.relationships.some(
      (r) => r.mode !== 'internal' || r.status !== 'resolved' || r.target_part !== target.part_name,
    )
  )
    return false;
  if (target.kind === 'header' || target.kind === 'footer')
    return (
      scope.kind === 'section_reference' &&
      ((scope.status === 'resolved' && scope.reason === null) ||
        (scope.status === 'partially_resolved' &&
          scope.reason === 'section_inheritance_or_missing_reference_unknown'))
    );
  if (target.kind === 'footnote' || target.kind === 'endnote')
    return (
      scope.kind === 'note_reference' &&
      ((scope.status === 'resolved' && scope.reason === null) ||
        (target.parse_status === 'empty' &&
          scope.status === 'unreferenced' &&
          scope.reason === 'no_body_reference'))
    );
  return false;
}

/** Called only after full parser response/hash validation; no text or warning is removed. */
export function localizedHistoricalWarnings(
  response: DocumentParseResponse,
): HistoricalBaseline['localizedWarnings'] {
  const targets = response.document.auxiliary_targets;
  if (
    !supportsDocxAuxiliaryTargets(response.parser_version) ||
    response.status !== 'needs_confirmation' ||
    !response.records.length ||
    !targets?.length ||
    !targets.every(preservedObject) ||
    response.warnings.some((w) => !['DOCX_DRAWINGS', 'DOCX_AUXILIARY_PARTS'].includes(w.code))
  )
    return [];
  const byStableRef = new Map(
    response.records
      .filter((r) => typeof r.locator.stable_ref === 'string')
      .map((r) => [r.locator.stable_ref, r.record_id]),
  );
  const groups = new Map<
    string,
    { code: string; targets: DocxAuxiliaryTarget[]; recordIds: Set<string> }
  >();
  for (const target of targets) {
    const code = target.kind === 'drawing' ? 'DOCX_DRAWINGS' : 'DOCX_AUXILIARY_PARTS';
    if (!response.warnings.some((w) => w.code === code)) return [];
    const key = `${code}:${target.part_name}`;
    const group = groups.get(key) ?? { code, targets: [], recordIds: new Set<string>() };
    group.targets.push(target);
    const refs = [
      target.locator.parent_stable_ref,
      ...target.scope.body_references.map((r) => r.stable_ref),
    ];
    const matched = refs
      .map((ref) => byStableRef.get(ref))
      .filter((id): id is string => Boolean(id));
    // Header/footer and blank drawing paragraphs have no body quote. Their exact
    // object location stays in the checklist; its attachment is not a location claim.
    for (const id of matched.length ? matched : [response.records[0]!.record_id])
      group.recordIds.add(id);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    code: group.code,
    recordIds: [...group.recordIds],
    message: `原稿辅助对象待人工确认清单（正文批注为清单入口，不表示对象位于此段）：${group.targets
      .map(
        (t) =>
          `${t.part_name}，定位${JSON.stringify(t.locator)}，状态${t.parse_status}，作用范围${t.scope.status}${t.scope.unknown_sections.length ? `，待核节号${t.scope.unknown_sections.join('、')}` : ''}`,
      )
      .join(
        '；',
      )}。原对象保留，图片内容及辅助部分未作为已核事实；请核对其中日期、名称、数字和适用节范围。`,
    targets: group.targets.map((target) => ({ ...target })),
  }));
}
