import {MARKET_LABELS,OFFERING_LABELS,isMarketOffering,type Market,type Offering} from '@bondbuddy/contracts';

export const DIRECT_DOCX_RULE_LIST_VERSION='direct-docx-rules-v1';

const marketRules:Record<Market,string>={
  sse:'上交所公司债：沿用本次历史稿的章节和已适用的披露口径；逐项核对本期发行条款、募集资金用途、重大事项、偿债安排和风险提示。',
  szse:'深交所公司债：沿用本次历史稿的章节和已适用的披露口径；逐项核对本期发行条款、募集资金用途、重大事项、偿债安排和风险提示。',
  nafmii:'交易商协会债务融资工具：沿用本次历史稿的章节和已适用的披露口径；逐项核对注册及本期发行安排、募集资金用途、偿债安排和风险提示。'
};
const offeringRules:Record<Offering,string>={
  private:'普通私募：核对专业投资者范围和非公开发行条款；不得把旧稿的发行批次、金额或机构直接沿用为本期事实。',
  public:'小公募：核对本期公开发行条款、注册或审核信息及适用的信息披露安排。',
  public_all:'大公募：核对本期面向公众投资者的发行条款、注册或审核信息及适用的信息披露安排。',
  ppn:'PPN：核对定向发行对象、注册额度和本期条款。',
  mtn:'MTN：核对注册额度、期限、本期条款和偿债安排。',
  cp:'CP：核对短期用途、期限、本期条款和到期偿付安排。',
  scp:'SCP：核对超短期限、流动性安排和到期偿付安排。',
  dfi:'DFI：区分注册框架和本期具体发行条款；不得把历史批次信息当作本期事实。'
};

/** Fixed trusted text: the model never chooses its own market or offering. */
export function directDocxRuleList(market:Market|null,offering:Offering|null):string|null {
  if(!market||!offering||!isMarketOffering(market,offering))return null;
  return `规则清单 ${DIRECT_DOCX_RULE_LIST_VERSION}｜${MARKET_LABELS[market]}｜${OFFERING_LABELS[offering]}\n`+
    `${marketRules[market]}\n${offeringRules[offering]}\n`+
    '逐项落实用户本次明确要求，保留其原意和范围。财务期间、单位、合并及母公司口径分开核对；没有可靠材料的事实标注待人工确认。只在有证据时更新数字，不猜测监管适用性。';
}
