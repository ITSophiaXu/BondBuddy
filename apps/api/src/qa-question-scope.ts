/** Admission only: ambiguous or multiple commissions go to the existing owned
 * question list. This parser never creates extra billable questions from prose. */
export function requiresQuestionList(content:string):boolean{
  // Supporting instructions belong to the same deliverable, including numbered
  // arithmetic steps. Only an explicit supporting heading admits that block.
  const supportHeading=/(?:计算(?:过程|步骤)|(?:核对|计算|操作|分析)步骤|步骤如下|处理步骤)\s*[:：]/.exec(content);
  const supportSteps=supportHeading?content.slice(supportHeading.index+supportHeading[0].length):'';
  // A supporting heading cannot hide a new substantive question or a request
  // after its numbered steps. Only explicit calculation/check steps are folded.
  if(supportSteps&&supportSteps.split(/\n|[；;]/).filter(s=>s.trim()).some(s=>!/^\s*(?:\d+[.、)）]|[（(]\d+[)）])\s*(?:核对|计算|确认|代入|相除|相加|相减|相乘|列出)/.test(s)||/(?:多少|是否|为何|为什么|何时|哪些|什么|[?？])/.test(s)))return true;
  const main=supportHeading?content.slice(0,supportHeading.index):content;
  const numbered=main.match(/(?:^|\n)\s*(?:\d+[.、)）]|[（(]\d+[)）]|问题\s*\d+)/g)??[];
  if(numbered.length>1)return true;
  const supporting=/^(?:(?:并|另外|同时|另行|以及|和|及)\s*)?(?:请你|请|帮我)?(?:说明|解释|列出|给出|提供|附上|展示)?(?:其|该题|上述|本题|相关|所用|具体|详细|相应)?(?:计算过程|计算方法|计算公式|公式|过程|口径|步骤|依据|证据|出处|引用|来源|数据来源|财务数据|数据|该问题|该问询)(?:[。.!！?？]|$|和|及)/;
  const clauses=main.split(/[，,；;。！!？?\n]|(?=(?:并|另外|同时|另行)(?:请你|请|帮我)?(?:说明|解释|回答|回复|分析|核对|计算|比较|对比))/);
  let independent=0;
  for(const raw of clauses){
    const clause=raw.trim().replace(/^(?:\d+[.、)）]|[（(]\d+[)）])\s*/, '');
    if(!clause||supporting.test(clause))continue;
    const request=/^(?:(?:并|另外|同时|另行)\s*)?(?:请你|请|帮我)?(?:说明|解释|回答|回复|总结|归纳|概括|列出|写出|分析|核对|计算|比较|对比)(.+)$/.exec(clause);
    // Declarative question forms are explicit commissions too: no question mark
    // or leading verb is required for “资产负债率是多少；流动比率是多少”.
    const question=/(?:多少|几[个项年月日]?|是否|能否|可否|为什么|为何|何时|哪些|什么|如何|怎么|怎样)/.test(clause);
    if(request||question)independent++;
  }
  return independent>1;
}
