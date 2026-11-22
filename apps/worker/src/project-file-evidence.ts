import type {
  ProjectFileText,
  ProjectFileLink,
  ProjectFileFinding,
  ProjectFileCheckResult,
} from '@bondbuddy/contracts';

export function fileAnchor(text: ProjectFileText, id: unknown, quote: unknown) {
  if (typeof id !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const span = text.spans.find((p) => p.id === id);
  return span && span.text.split(quote).length === 2 ? span : null;
}
/** Persist host-verified quotations; a model cannot fabricate a paragraph or replace its hash. */
export function verifiedFileLinks(
  source: ProjectFileText,
  target: ProjectFileText,
  proposals: unknown,
  maxLinks = 10000,
): ProjectFileLink[] {
  if (!Array.isArray(proposals)) return [];
  const sources = new Map(source.spans.map((s) => [s.id, s])),
    targets = new Map(target.spans.map((s) => [s.id, s]));
  const anchor = (index: typeof sources, id: unknown, quote: unknown) => {
    if (typeof id !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
    const span = index.get(id);
    return span && span.text.split(quote).length === 2 ? span : null;
  };
  const result: ProjectFileLink[] = [];
  for (const p of proposals.slice(0, maxLinks)) {
    if (!p || typeof p !== 'object') continue;
    const from = anchor(sources, p.source_span_id, p.source_quote),
      to = anchor(targets, p.target_span_id, p.target_quote);
    if (!from || !to) continue;
    result.push({
      source_span_id: from.id,
      source_quote: p.source_quote,
      target_span_id: to.id,
      target_quote: p.target_quote,
      field: typeof p.field === 'string' ? p.field.slice(0, 200) : '',
      period: typeof p.period === 'string' ? p.period.slice(0, 200) : '',
      unit: typeof p.unit === 'string' ? p.unit.slice(0, 200) : '',
      source_location: from.location,
      target_location: to.location,
      source_sha256: source.sha256,
      target_sha256: target.sha256,
    });
  }
  return result;
}

/** Missing coverage and invalid evidence are visible manual items, never a clean check result. */
export function verifiedFileCheck(
  versionId: string,
  source: ProjectFileText,
  target: ProjectFileText,
  proposal: unknown,
): ProjectFileCheckResult['files'][number] {
  const p = proposal && typeof proposal === 'object' ? (proposal as Record<string, unknown>) : {};
  const findings: ProjectFileFinding[] = [];
  const strings = (v: unknown, max = 12000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const manual = (reason: string, original = '', target_span_id = 'unresolved') =>
    findings.push({
      id: `manual-${findings.length + 1}`,
      target_span_id,
      original,
      replacement: null,
      source_span_id: null,
      source_quote: '',
      source_location: '',
      target_location: target.spans.find((s) => s.id === target_span_id)?.location ?? '',
      reason,
      field: '',
      period: '',
      unit: '',
      kind: 'manual',
    });
  if (!Array.isArray(p.findings)) manual('本轮未得到可用的检查清单，需要重新检查。');
  else
    for (const [index, item] of p.findings.slice(0, 1800).entries()) {
      if (!item || typeof item !== 'object') {
        manual('检查条目缺少定位信息，需要人工核对。');
        continue;
      }
      const original = strings(item.original),
        to = fileAnchor(target, item.target_span_id, original),
        from = fileAnchor(source, item.source_span_id, item.source_quote);
      const confirmed =
        item.kind === 'conflict' &&
        to &&
        from &&
        typeof item.replacement === 'string' &&
        item.replacement !== original &&
        strings(item.reason).trim();
      findings.push({
        id: `finding-${index + 1}`,
        target_span_id: to?.id ?? (strings(item.target_span_id, 128) || 'unresolved'),
        original,
        replacement: confirmed ? strings(item.replacement) : null,
        source_span_id: from?.id ?? null,
        source_quote: from ? strings(item.source_quote) : '',
        source_location: from?.location ?? '',
        target_location: to?.location ?? '',
        reason: confirmed
          ? strings(item.reason)
          : strings(item.reason) || '依据或原文无法准确定位，请补充材料并人工核对。',
        field: strings(item.field, 200),
        period: strings(item.period, 200),
        unit: strings(item.unit, 200),
        kind: confirmed ? 'conflict' : 'manual',
      });
    }
  if (Array.isArray(p.findings) && p.findings.length > 1800)
    manual('检查条目过多，本轮仅展示前 1,800 项，剩余内容需人工核对。');
  const conflicts = findings.filter((f) => f.kind === 'conflict'),
    overlap = new Set<string>();
  for (let i = 0; i < conflicts.length; i++)
    for (let j = i + 1; j < conflicts.length; j++) {
      const a = conflicts[i],
        b = conflicts[j];
      if (a.target_span_id !== b.target_span_id) continue;
      const body = target.spans.find((s) => s.id === a.target_span_id)!.text,
        as = body.indexOf(a.original),
        bs = body.indexOf(b.original);
      if (as < bs + b.original.length && bs < as + a.original.length) {
        overlap.add(a.id);
        overlap.add(b.id);
      }
    }
  for (const f of conflicts)
    if (overlap.has(f.id)) {
      f.kind = 'manual';
      f.replacement = null;
      f.reason += '；同一原文存在重叠建议，请人工核对后修改。';
    }
  const reviewed = new Set(Array.isArray(p.checked_span_ids) ? p.checked_span_ids : []),
    nonempty = target.spans.filter((s) => s.text.trim());
  if (nonempty.some((s) => !reviewed.has(s.id)))
    manual('部分文件正文尚未完成核对，不能据此认定整份文件一致。');
  const links = verifiedFileLinks(source, target, p.links);
  if (!links.length && !findings.some((f) => f.kind === 'conflict'))
    manual('尚未建立可核验的募集书内容关联，需要补充依据或人工确认。');
  if (source.coverage === 'partial' || target.coverage === 'partial')
    manual(
      [...source.warnings, ...target.warnings].join('；').slice(0, 12000) ||
        '文件只能部分提取，需人工核对未读取内容。',
    );
  return {
    file_version_id: versionId,
    status: findings.some((f) => f.kind === 'conflict')
      ? 'conflict'
      : findings.length
        ? 'manual'
        : 'consistent',
    coverage: strings(p.coverage) || '本轮按募集书可读取内容核对项目文件；资料缺项保留人工确认。',
    findings,
    links,
  };
}

/** A visible manual fallback is useful diagnostic data, but is not a completed paid check. */
export function completedFileCheck(
  versionId: string,
  source: ProjectFileText,
  target: ProjectFileText,
  proposal: unknown,
): ProjectFileCheckResult['files'][number] {
  const p = proposal && typeof proposal === 'object' ? (proposal as Record<string, unknown>) : {};
  const nonempty = target.spans.filter((s) => s.text.trim()),
    ids = new Set(target.spans.map((s) => s.id));
  // Explicit admissions of unread/unchecked content contradict completion even
  // when a proposal copies every paragraph ID. Ordinary manual uncertainty
  // (e.g. missing supporting material) is still allowed after actual reading.
  const admitsIncomplete = (v: unknown) =>
    typeof v === 'string' &&
    /(?:尚未|未能|无法)(?:完整)?(?:读取|检查|核对)|未(?:读取|检查)(?!到|出)|(?:not\s+(?:read|checked|reviewed|performed)|unread)(?:\b|$)/i.test(
      v,
    );
  if (
    source.coverage !== 'complete' ||
    target.coverage !== 'complete' ||
    !source.spans.some((s) => s.text.trim()) ||
    !nonempty.length ||
    !Array.isArray(p.findings) ||
    p.findings.length > 1800 ||
    !Array.isArray(p.checked_span_ids) ||
    p.checked_span_ids.some((id) => typeof id !== 'string' || !ids.has(id)) ||
    admitsIncomplete(p.coverage) ||
    p.findings.some((item) => item && typeof item === 'object' && admitsIncomplete(item.reason))
  )
    throw Error('FILE_CHECK_INCOMPLETE');
  const covered = new Set(p.checked_span_ids),
    checked = verifiedFileCheck(versionId, source, target, p);
  if (
    nonempty.some((s) => !covered.has(s.id)) ||
    (!checked.links.length &&
      !checked.findings.some(
        (f) => fileAnchor(target, f.target_span_id, f.original) && f.reason.trim(),
      ))
  )
    throw Error('FILE_CHECK_INCOMPLETE');
  for (const finding of checked.findings)
    if (finding.kind === 'conflict' && !/^p\d+$/.test(finding.target_span_id)) {
      finding.kind = 'manual';
      finding.replacement = null;
      finding.reason += '；位于页眉、页脚或附注，请人工修订此处。';
    }
  checked.status = checked.findings.some((f) => f.kind === 'conflict')
    ? 'conflict'
    : checked.findings.length
      ? 'manual'
      : 'consistent';
  return checked;
}
