import type { QaAnswer } from '@bondbuddy/contracts';

/** Saved-prompt marker: never impose today's writing checks on an older replay. */
export const QA_REPLY_POLICY = 'project-qa-reply-focus-v1';
type Reply = Pick<QaAnswer, 'answer' | 'status' | 'missing_materials'>;
export type QaReplyIssue =
  'internal_process' | 'invented_rebuttal' | 'repeated_gap_list' | 'gap_placement';
const gapKey = (text: string) => text.replace(/\s/g, '').replace(/[。；;]+$/, '');

/** Narrow mechanical checks, NOT a semantic verdict on relevance or evidence.
 * Return only host-owned codes; never copy untrusted prose into retry instructions.
 * Do not delete sentences or blacklist negative/risk conclusions. */
export function qaReplyIssues(reply: Reply, question: string): QaReplyIssue[] {
  const issues: QaReplyIssue[] = [],
    text = reply.answer.replace(/\s/g, '');
  if (
    /(?:当前|本次|现有)(?:可读取|已读取|可读|选入|选文)|可读取或选入|本轮选入|提取范围|选文范围|partial_tables|evidence_refs|span_id/.test(
      text,
    )
  )
    issues.push('internal_process');
  if (
    (/并非(?:披露的)?资质丧失|并非(?:披露的)?资质丧失或业务退出/.test(text) &&
      !/资质|业务退出/.test(question)) ||
    (/不能据此认定(?:仅有|只有|仅存在)一个项目/.test(text) &&
      !/仅有|只有|仅存在|认定/.test(question))
  )
    issues.push('invented_rebuttal');
  if (/(?:^|\n)\s*(?:#{1,6}\s*|\*\*)?待补材料或待确认事项/.test(reply.answer))
    issues.push('repeated_gap_list');
  const markers = [...reply.answer.matchAll(/【(?:待确认|需补充)[:：]([^【】]+)】/g)].map((m) =>
    gapKey(m[1]),
  );
  const gaps = reply.missing_materials.map(gapKey);
  if (
    (reply.status === 'draft' && (gaps.length > 0 || markers.length > 0)) ||
    (reply.status === 'missing' &&
      (!gaps.length ||
        gaps.some((g) => !g || !markers.includes(g)) ||
        markers.some((m) => !gaps.includes(m))))
  )
    issues.push('gap_placement');
  return issues;
}

const feedback: Record<QaReplyIssue, string> = {
  internal_process:
    'Use project-team business wording. Replace extraction, selection or model-process commentary with only the specific unresolved business item at its relevant conclusion; do not claim the source omits it.',
  invented_rebuttal:
    'Explain the facts, reasons and requested conclusion directly. Remove the invented qualification-loss or project-count rebuttal that the question did not ask.',
  repeated_gap_list:
    'Keep each necessary gap at the affected conclusion. Do not append a second missing-materials checklist to answer.',
  gap_placement:
    'For status missing, place each minimal missing_materials item exactly inside a local 【待确认：item】 or 【需补充：item】 marker. For status draft, use no gap markers and an empty missing_materials array. Do not erase a real gap to pass validation.',
};
export function qaReplyFeedback(issues: QaReplyIssue[]) {
  return (
    issues.map((code) => feedback[code]).join(' ') +
    ' Preserve relevant adverse facts, amounts, periods, qualifications and evidence_refs. Return the complete JSON.'
  );
}
