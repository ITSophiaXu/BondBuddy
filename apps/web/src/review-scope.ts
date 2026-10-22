import { MARKET_LABELS, OFFERING_LABELS, type Market, type Offering } from '@bondbuddy/contracts';
import { esc } from './ui';
import './review-scope.css';

/** Scope guidance for the current file-review flow; never a claim of completed checks. */
export function reviewRuleScope(market: Market | null, offering: Offering | null): string {
  if (!market || !offering) return '<p class="review-scope-note">选择发行市场和品种后，这里会显示对应的规范范围。未确定时可先保存项目。</p>';
  const label = `${MARKET_LABELS[market]} · ${OFFERING_LABELS[offering]}`;
  const exchange = market === 'sse' ? '上海证券交易所' : '深圳证券交易所';
  const rules = market === 'nafmii'
    ? ['《银行间债券市场非金融企业债务融资工具管理办法》',
      offering === 'ppn' ? '非公开定向发行规则及定向发行协议的披露要求' : offering === 'dfi' ? '分层分类管理、统一注册及具体发行工具的披露要求' : `《银行间债券市场非金融企业债务融资工具信息披露规则》及${OFFERING_LABELS[offering]}相关指引`,
      '注册文件、募集资金用途、持有人保护及存续期信息披露要求']
    : ['《公司债券发行与交易管理办法》',
      `${exchange}${offering === 'private' ? '非公开发行公司债券挂牌' : '公司债券发行上市审核及上市'}规则`,
      `${exchange}募集说明书编制／参考文本、申请文件及信息披露指引`,
      '募集资金管理、受托管理与债券持有人会议等配套规范'];
  return `<p class="review-scope-market">${esc(label)}</p><ul>${rules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul><p class="review-scope-note">依据本次材料和已载入的规则资料逐项核对。具体条款、版本与适用性在报告中列明；尚未确认的规则或缺少证据的事项标为待核实。</p>`;
}

export function reviewScope(market:Market|null=null,offering:Offering|null=null):string{
  const items=[
    ['financial','财务数据一致性','核对金额、期间、单位和合并/母公司口径，检查同一数据在各章节的披露。','对照已上传的审计报告、财务报表及附注；缺少材料时列明缺口。'],
    ['reconciliation','勾稽关系','复算报表合计、跨表勾稽关系及财务指标，标明比较值和计算依据。','保留计算口径和证据位置；识别不清的数字不作为已核实事实。'],
    ['compliance','政策要求与重点提示','列出命中的具体规则条款、适用理由、披露缺口和重点提示。','规则版本、效力或适用性无法确认时保留原文并批注，不编造条款。'],
    ['format','格式与标点','复核标题、编号、引用和中英文标点，保护小数点、千分位和金额表达。','英文或数字之间用英文标点，中文之间用中文标点；结合语境判断。'],
  ];
  return `<section class="review-scope-guide" aria-label="复核范围说明"><div class="review-scope-heading"><h3>本次会复核什么</h3><span>四项复核 · 原文修订与说明批注</span></div>${items.map(([id,title,description,detail],i)=>`<details class="review-scope-item" data-scope="${id}"><summary><span class="review-scope-number">0${i+1}</span><span class="review-scope-copy"><strong>${title}</strong><span>${description}</span></span><span class="review-scope-toggle">查看详情</span></summary><div class="review-scope-body"><p>${detail}</p>${id==='compliance'?`<div data-review-rule-scope>${reviewRuleScope(market,offering)}</div>`:''}</div></details>`).join('')}<p class="review-scope-note">有明确依据的建议直接修改并留下修订痕迹与原因批注；不确定事项保留原文并说明缺少材料。成果保存后，由你决定是否设为项目当前版本。</p></section>`;
}
