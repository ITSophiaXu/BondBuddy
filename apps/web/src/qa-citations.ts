import type {QaAnswer,QaResult} from './billing-types.js';
import {esc} from './ui.js';

/** Render the structured citations stored with an answer. They are audit
 * evidence, not prose, and must stay outside the answer body. */
export function qaCitationDetails(result: QaResult | null | undefined, answer: QaAnswer): string {
  if (!answer.citations.length) return '';
  const items = answer.citations.map(citation => {
    const evidence = result?.evidence[citation.asset_index];
    const span = evidence?.snapshot.spans.find(item => item.id === citation.span_id);
    const version = evidence?.snapshot.sha256
      ? ` · 材料 ${esc(evidence.snapshot.sha256.slice(0, 12))}…`
      : '';
    return `<li>《${esc(evidence?.filename ?? '材料')}》 · ${esc(span?.location ?? citation.span_id)}：${esc(citation.quote)}${version}</li>`;
  }).join('');
  return `<details class="qa-citations"><summary>依据 ${answer.citations.length} 处</summary><ul>${items}</ul></details>`;
}
