import type { Offering } from '@bondbuddy/contracts';

/** Classify an assertion about this document, not a rule citation or list of possible tools. */
export function nafmiiOfferingEvidence(quote: string): Offering | null {
  const value = quote.replace(/[\s\u3000]+/g, '');
  if (
    /根据|依据|按照|参照|遵照|适用|本规则|本办法|本指引|不属于|并非|不是|不得按|不能视为|未确定|待确定/.test(
      value,
    ) ||
    /《[^》]*(?:办法|规则|指引|通知|规定)[^》]*》/.test(value)
  )
    return null;
  const instruments: Offering[] = [];
  if (/定向债务融资工具|PPN/i.test(value)) instruments.push('ppn');
  if (/中期票据|中票|MTN/i.test(value)) instruments.push('mtn');
  if (/超短期融资券|SCP/i.test(value)) instruments.push('scp');
  if (/(?<!超)短期融资券|(?<![a-z])CP(?![a-z])/i.test(value)) instruments.push('cp');

  const toolList = /覆盖|包括|涵盖|可发行|拟发行|可用于|额度用于/.test(value);
  const unifiedDocument =
    /(?:DFI|储架发行|统一注册)(?:文件|募集说明书)/i.test(value) ||
    /本(?:次|期|文件|募集说明书).{0,25}(?:统一注册|储架发行)/.test(value);
  const actualTranche =
    /本期(?:发行)?(?:工具|品种|债券名称)(?:为|是|系|[:：])?(?:中期票据|中票|MTN|短期融资券|CP|超短期融资券|SCP|定向债务融资工具|PPN)/i.test(
      value,
    ) ||
    /本期(?:债券|发行)(?:为|是|系)(?:中期票据|中票|MTN|短期融资券|CP|超短期融资券|SCP|定向债务融资工具|PPN)/i.test(
      value,
    );
  // A registration document may cover one or many instruments. That is not proof
  // that a tranche has been issued. Conversely, DFI background cannot rename MTN.
  if (actualTranche) return instruments.length === 1 ? instruments[0]! : null;
  if (unifiedDocument) return 'dfi';
  if (toolList && /注册|储架|DFI/i.test(value)) return null;
  if (!/本期|本次|发行方式|发行概况|债券名称/.test(value)) return null;
  return instruments.length === 1 ? instruments[0]! : null;
}
