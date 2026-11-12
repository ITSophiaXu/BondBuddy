import {INTEGRITY_COMMERCIAL_RULE,INTEGRITY_SITES,int64} from '@bondbuddy/contracts';
import type {IntegrityRound} from './billing-types.js';
import {displayCharge} from './commerce';
import {esc} from './ui';

/** The API projects the original settlement. The browser only explains it. */
export function integritySettlementHtml(round:IntegrityRound):string{
 if(round.operation!=='check'||round.manifest.price_version!==INTEGRITY_COMMERCIAL_RULE.version||!['succeeded','failed','cancelled','rejected'].includes(round.state))return '';
 const settled=round.settlement;
 if(!settled)return '<p class="muted" data-integrity-settlement-unavailable>本轮费用明细暂无法核对，请刷新后查看积分记录。</p>';
 const amount=(value:number|string)=>esc(displayCharge(round.manifest,value));
 const totals=`原预留 ${amount(settled.quoted_points)}，实际扣除 ${amount(settled.charged_points)}，已释放 ${amount(settled.released_points)}。`;
 if(settled.outcome==='not_delivered')return `<div data-integrity-settlement><p data-integrity-settlement-amounts>${totals}</p><p data-integrity-settlement-reason>本轮未完成交付，未扣费，原预留已全部释放。</p></div>`;
 const scope=round.manifest.scope_measurement,completed=settled.verified_query_pairs.length;
 if(!scope||completed>scope.executable_pairs||int64(settled.charged_points)!==int64(round.charged_points))return '<p class="muted" data-integrity-settlement-unavailable>本轮费用明细暂无法核对，请刷新后查看积分记录。</p>';
 const remaining=scope.executable_pairs-completed;
 const exclusions=scope.excluded_pairs+scope.unresolved_pairs;
 const reason=`本轮 ${scope.executable_pairs} 项可查询范围中，${completed} 项完成查询并保留官网证据；${remaining?`其余 ${remaining} 项未完成有效查询，不计费。`:'已全部完成有效查询。'}官网明确零结果也计为完成查询。${exclusions?`另有 ${exclusions} 项因不适用或属地尚未确定，提交时未计入预留。`:''}`;
 const items=settled.verified_query_pairs.map(pair=>{
  const subject=round.manifest.draft.subjects.find(s=>s.id===pair.subject_id),record=round.records.find(r=>r.subject_id===pair.subject_id&&r.site_id===pair.site_id),site=record?.site_name??INTEGRITY_SITES.find(s=>s.id===pair.site_id)?.name;
  return `<li data-integrity-billed-subject="${esc(pair.subject_id)}" data-integrity-billed-site="${esc(pair.site_id)}">${esc(subject?.name??'原核查对象')} · ${esc(site??'原核查网站')}</li>`;
 }).join('');
 return `<div data-integrity-settlement><p data-integrity-settlement-amounts>${totals}</p><p data-integrity-settlement-reason>${esc(reason)}</p><details data-integrity-settlement-scope><summary>查看本轮计费范围（${completed} 项）</summary><ul>${items}</ul></details></div>`;
}
