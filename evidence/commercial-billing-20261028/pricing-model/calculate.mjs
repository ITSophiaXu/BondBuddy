import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const cfg=JSON.parse(fs.readFileSync(path.join(dir,'inputs.json'),'utf8'));
const rateCard=JSON.parse(fs.readFileSync(path.join(dir,cfg.rateCard),'utf8'));
const sum=arr=>arr.reduce((a,b)=>a+b,0);
const F=sum(Object.values(cfg.fixedMonthly));
const sku=cfg.annualOpportunityVectorAt10Projects.map(k=>{
  const entries=k.priceComponents?Object.entries(k.priceComponents):[[k.priceKey,1]];
  const cents=sum(entries.map(([key,n])=>{
    assert(Number.isSafeInteger(rateCard.prices[key]),'missing candidate price '+key);
    return rateCard.prices[key]*n;
  }));
  return {...k,price:cents/100};
});
const money=x=>x.toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:0});
const pct=x=>x==null?'不适用':(x*100).toFixed(1)+'%';
const avgFirst=s=>sum(sku.map(k=>(s.firstOrderVector[k.id]??0)*k.price));
const annual=(s,full=false)=>sum(sku.map(k=>k.count*s.projects/10*(full?1:s.purchaseFractions[k.id])*k.price));
function simulate(s,otherRate,opts={}){
  const Q=Array.from({length:24},(_,m)=>s.qualifiedQuarterMonthly[Math.floor(m/3)]);
  const E=Q.map(q=>q*s.qualifiedToEvaluation);
  const N=E.map((_,m)=>m===0?0:E[m-1]*s.evaluationToFirstPay);
  const priceScale=opts.priceScale??1;
  const A=annual(s,opts.fullPurchase??false)*priceScale, first=avgFirst(s)*priceScale;
  const eligibility=opts.secondYearEligible??s.secondYearEligible;
  let lossOpen=0, yearPbt=0, yearTax=0, taxYear=null;
  const monthly=[];
  for(let m=0;m<24;m++){
    const date=new Date(Date.UTC(2026,10+m,1));
    const yr=date.getUTCFullYear(), label=date.toISOString().slice(0,7);
    if(taxYear!==yr){
      if(taxYear!==null)lossOpen=Math.max(0,lossOpen-yearPbt);
      yearPbt=0;yearTax=0;taxYear=yr;
    }
    let gross=0,units=0,eligible=0;
    const quantities=Object.fromEntries(sku.map(k=>[k.id,0]));
    for(let c=0;c<=m;c++){
      const age=m-c, survive=age<12?1:eligibility;
      eligible+=N[c]*survive;
      for(const k of sku){
        const a=k.count*s.projects/10*((opts.fullPurchase??false)?1:s.purchaseFractions[k.id]);
        const f=s.firstOrderVector[k.id]??0;
        const u=age===0?f:age<12?(a-f)/11:a/12;
        assert(u>=-1e-10,'first order exceeds selected annual scope: '+s.id+'/'+k.id);
        const q=u*N[c]*survive;
        quantities[k.id]+=q;
        units+=q;
        gross+=q*k.price*priceScale;
      }
    }
    const refunds=gross*cfg.refundedDeliveredSalesFraction;
    const afterRefund=gross-refunds;
    const R=afterRefund/(1+cfg.tax.vat);
    const payment=gross*cfg.tax.paymentOnGrossReceipt;
    const surcharge=(afterRefund-R)*cfg.tax.vatSurchargeOnOutputVat;
    const quoteCost=E[m]*cfg.quoteEvaluationCostAssumed;
    const other=R*otherRate;
    const pbt=R-F-payment-surcharge-quoteCost-other;
    yearPbt+=pbt;
    const taxYtd=Math.max(0,yearPbt-lossOpen)*cfg.tax.income;
    const tax=taxYtd-yearTax;
    yearTax=taxYtd;
    monthly.push({month:m+1,date:label,qualified:Q[m],evaluations:E[m],newPayers:N[m],eligiblePayers:eligible,gross,refundedDeliveredSales:refunds,netRevenue:R,paidPackageUnits:units,quantities,payment,vatSurcharge:surcharge,quoteCost,otherVariableAssumed:other,fixed:F,profitBeforeTax:pbt,incomeTaxAccrual:tax,conditionalNetProfit:pbt-tax,actualNetProfit:null});
  }
  function summary(rows){
    const fields=['qualified','evaluations','newPayers','gross','netRevenue','paidPackageUnits','payment','vatSurcharge','quoteCost','otherVariableAssumed','fixed','profitBeforeTax','incomeTaxAccrual','conditionalNetProfit'];
    const out=Object.fromEntries(fields.map(k=>[k,sum(rows.map(r=>r[k]))]));
    out.conditionalNetMargin=out.netRevenue?out.conditionalNetProfit/out.netRevenue:null;
    out.averageEligiblePayers=sum(rows.map(r=>r.eligiblePayers))/rows.length;
    return out;
  }
  const cum=monthly.map((_,i)=>sum(monthly.slice(0,i+1).map(r=>r.conditionalNetProfit)));
  return {scenario:s.id,otherRate,secondYearEligible:eligibility,annualSelectedCustomerPrice:A,annualFullPurchasePrice:annual(s,true),firstOrderAveragePrice:first,monthly,year1:summary(monthly.slice(0,12)),year2:summary(monthly.slice(12)),total:summary(monthly),firstPositiveMonth:monthly.find(r=>r.conditionalNetProfit>0)?.month??null,firstCumulativeBreakevenMonth:monthly.find((r,i)=>cum[i]>=0)?.month??null};
}
const scenarios=cfg.scenarios.map(s=>({id:s.id,label:s.label,central:simulate(s,0.10),costSensitivity:cfg.otherVariableCostRateSensitivity.map(r=>simulate(s,r)),secondYearSensitivity:[0,0.5,1].map(e=>simulate(s,0.10,{secondYearEligible:e})),zeroOtherCost:simulate(s,0),fullPurchase:simulate(s,0.10,{fullPurchase:true}),doublePriceDiagnostic:simulate(s,0.10,{priceScale:2})}));
function priceThreshold(s,targetMargin){
  let low=0.01,high=200;
  for(let i=0;i<60;i++){
    const mid=(low+high)/2, r=simulate(s,0.10,{priceScale:mid});
    if(r.total.conditionalNetMargin<targetMargin)low=mid;else high=mid;
  }
  return high;
}
const diagnostic={
  notice:'Price-only algebra with no demand elasticity. Not recommended prices, not a forecast and not evidence that anyone accepts the price.',
  baseBreakevenPriceMultiple:priceThreshold(cfg.scenarios[1],0),
  baseSixtyPercentNetMarginPriceMultiple:priceThreshold(cfg.scenarios[1],0.60)
};
const checks=[];
function check(name,condition){assert(condition,name);checks.push({name,pass:true});}
check('fixed monthly budget unchanged',F===33100);
check('annual full purchase independent sum',Math.abs(annual(cfg.scenarios[1],true)-11849.8)<1e-7);
for(const s of cfg.scenarios){
  check(s.id+' first order is one business package in expectation',Math.abs(sum(Object.values(s.firstOrderVector))-1)<1e-10);
  for(const k of sku)check(s.id+' first order scope exists '+k.id,(s.firstOrderVector[k.id]??0)<=k.count*s.projects/10*s.purchaseFractions[k.id]);
  const Q=sum(s.qualifiedQuarterMonthly)*3;
  const expected=(Q-s.qualifiedQuarterMonthly[7])*s.qualifiedToEvaluation*s.evaluationToFirstPay;
  const result=scenarios.find(r=>r.id===s.id).central;
  check(s.id+' M24 evaluations excluded from M24 first pays',Math.abs(result.total.newPayers-expected)<1e-7);
  check(s.id+' first month has zero delivered sales',result.monthly[0].gross===0);
  check(s.id+' first 12-month selected vector counted once',Math.abs(avgFirst(s)+11*(annual(s)-avgFirst(s))/11-annual(s))<1e-7);
  check(s.id+' period summary reconciles',Math.abs(result.year1.conditionalNetProfit+result.year2.conditionalNetProfit-result.total.conditionalNetProfit)<1e-7);
  check(s.id+' actual cost and profit remain unknown',result.monthly.every(m=>m.actualNetProfit===null));
  const costs=scenarios.find(r=>r.id===s.id).costSensitivity;
  check(s.id+' higher assumed costs never increase total profit',costs.every((r,i)=>i===0||r.total.conditionalNetProfit<=costs[i-1].total.conditionalNetProfit+1e-7));
  check(s.id+' income tax cumulative nonnegative',result.total.incomeTaxAccrual>=-1e-7);
}
const out={asOf:cfg.asOf,status:cfg.status,scope:'Conditional pricing-first economic simulation, not observed token costs or validated demand',inputsFile:'inputs.json',rateCardVersion:rateCard.version,checks,diagnostic,scenarios};
fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(out,null,2));
const L=[
  '# 定价优先：24个月条件测算',
  '',
  '2026-10-28。2026年11月至2028年10月。三情景均为未验证规划；真实完整履约成本、实际利润为unknown。固定预算仍为每月33,100元。用户已补充真实DeepSeek更新募集API费用为几元的观察；本表保留原其他动态成本10%假设供对照，支付、VAT附加及评估另列，其3／5／8元更新成本替换复算见[用户实测更新成本-定价与盈利复核.md](../用户实测更新成本-定价与盈利复核.md)。无需新API凭据即可据此继续设计。此表不宣布已经达到盈利目标。',
  '',
  '## 1. 先从工作推消费',
  '',
  '十个项目的完整工作清单，按全部发生且购买计算为11,849.8元/年。它是潜在全买对照，不是用户必付金额。实际选择层按工作类型分别给出采购比例；所有项目均可进入工作台，没有再乘35%项目覆盖率，也没有再乘付费月份比例。',
  '',
  '| 场景 | 年项目数 | 完整清单全买 | 分类型选择后年金额 | 首单均价 | 24月合格访问 | 评估率 / 评估后首付 | 第二年仍考虑采购 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ...scenarios.map((r,i)=>{const s=cfg.scenarios[i],c=r.central;return `| ${r.label} | ${s.projects} | ${money(c.annualFullPurchasePrice)} | ${money(c.annualSelectedCustomerPrice)} | ${c.firstOrderAveragePrice.toFixed(2)} | ${c.total.qualified} | ${pct(s.qualifiedToEvaluation)} / ${pct(s.evaluationToFirstPay)} | ${pct(s.secondYearEligible)} |`;}),
  '',
  '**这些百分比全部是敏感性输入，没有竞品或3位试用者的实测支持。** 合格访问序列沿用原需求审计，避免为了盈利提高人数；有效评估指范围和产品评估，不交付免费的本人专业检查/复核。第二年参数重新限定为仍具备使用条件并愿考虑新采购，与无项目沉睡分开，不能称为已测留存。',
  '',
  '| 工作类型 | 十项目机会量 | 单价 | 保守选择 | 基准选择 | 乐观选择 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...sku.map(k=>`| ${k.label} | ${k.count} | ${k.price} | ${cfg.scenarios.map(s=>pct(s.purchaseFractions[k.id])).join(' | ')} |`),
  '',
  '旧日历只提供合成事件。3份首稿各4个新披露目标、11更新各1个新增主要期、20修订拆14事实/6论证、96初答拆60事实/24计算/12论证，都是本轮新增的明确假设；不能称为已经重新核验的真实订单。财务复核已收窄为财务组，不借用旧全文复核token量。全部15个追问单位暂按原范围包含，不增加收入。24同步和15纯检查仅在确属原生成之外独立购买时进入机会量。',
  '',
  '**跨包独立性尚未验证。** 本表假定首稿、后续论证和回复的业务目标不同，更新属于不同新增目标版本，同步属于后续新事实。如果实际共用分析、同属原范围或同一锁定目标版本，必须先合并/封顶，不能直接使用本表数量作为实付预测。当前脚本只核验SKU算术，不能从缺少范围关联的数据中证明已去重。',
  '',
  '首单绑定具体包：事实回复/事实修订/论证回复/报告期更新；三场景分布依次为60/30/8/2%、30/30/20/20%、10/20/25/45%。先从同一年度该包的选择量中扣首单，剩余分到随后11月；第二年用新的年度工作量。这里只作平滑时序，不伪装成真实工作季节性，也不会给新用户追补进入前的历史工作收入。',
  '',
  '## 2. 收入与利润',
  '',
  '下表的“净利”是**条件值**：用户价含6%增值税、交付销售退款2%、支付费按退款前金额0.6%、销项VAT附加12%（未扣进项抵扣的压力口径）、所得税25%、每次有效评估额外0.8元预算，以及**其他动态成本=净收入10%**。这10%排除另列的支付、VAT附加、评估费；全部动态成本率约为11.369%＋评估成本/净收入。0.8元是假设的预算外按次解析/范围识别API/工具现金支出，不重复分摊预算内人员或基础云。10%和0.8元都不是实测成本；真实利润尚不能确定。退款本金已冲收入，其他动态成本只再含不可回收履约/处理/返工费用，不能重复扣本金。预算内人工/基础云只计一次，额外人工及边际云属于动态预算。',
  '',
  '| 场景 | 第1年首付人数期望 | 第1年净收入 | 第1年条件净利 | 第2年新增首付期望 | 第2年净收入 | 第2年条件净利 | 24月条件净利 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...scenarios.map(r=>{const c=r.central;return `| ${r.label} | ${c.year1.newPayers.toFixed(1)} | ${money(c.year1.netRevenue)} | ${money(c.year1.conditionalNetProfit)} | ${c.year2.newPayers.toFixed(1)} | ${money(c.year2.netRevenue)} | ${money(c.year2.conditionalNetProfit)} | ${money(c.total.conditionalNetProfit)} |`;}),
  '',
  '| 场景 | M24累计独立首付期望 | M24可考虑采购存量* | 首个单月盈利 | 累计回本月 | 24月条件净利率 | 其他成本0时24月净利 | 全工作流都买时24月净利** |',
  '| --- | ---: | ---: | --- | --- | ---: | ---: | ---: |',
  ...scenarios.map(r=>{const c=r.central;return `| ${r.label} | ${c.total.newPayers.toFixed(1)} | ${c.monthly[23].eligiblePayers.toFixed(1)} | ${c.firstPositiveMonth??'24月内无'} | ${c.firstCumulativeBreakevenMonth??'24月内无'} | ${pct(c.total.conditionalNetMargin)} | ${money(r.zeroOtherCost.total.conditionalNetProfit)} | ${money(r.fullPurchase.total.conditionalNetProfit)} |`;}),
  '',
  '*该列为M24当月可考虑采购的期望存量，不是实际当月付款人数。连续量表示期望，不存在0.5位真实客户。**全买仅移除工作类型选择折减，保留原获客、首付、第一笔范围及第二年参数，是价格/选择诊断，不是新预测。其他成本0只是下界诊断，仍有固定、支付、评估及税费，不表示免费推理。',
  '',
  '## 3. 动态成本和复购敏感性',
  '',
  '| 场景 | 其他成本5%：24月净利 | 10% | 15% | 第二年考虑率0%：24月净利 | 50% | 100% |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...scenarios.map(r=>`| ${r.label} | ${r.costSensitivity.map(x=>money(x.total.conditionalNetProfit)).join(' | ')} | ${r.secondYearSensitivity.map(x=>money(x.total.conditionalNetProfit)).join(' | ')} |`),
  '',
  '这分别检验成本和第二年存续，其他变量保持相同；不能把乐观需求同时绑定最低成本来掩盖不确定性。未核实DeepSeek价和完整任务usage，因此本模型不输出“真实token利润”。税按自然年计算累计应税利润、结转模型内亏损，月度税额可以转回当年已计提金额；不假设亏损取得现金税收补助。',
  '',
  '## 4. 全面debug，而不是直接改人数',
  '',
  `基准在原需求序列下：其他动态成本从10%降到0%，24月条件净利由${money(scenarios[1].central.total.conditionalNetProfit)}变为${money(scenarios[1].zeroOtherCost.total.conditionalNetProfit)}；即使用户全买完整工作清单，仍为${money(scenarios[1].fullPurchase.total.conditionalNetProfit)}。价格翻倍且假定购买量完全不下降，仍为${money(scenarios[1].doublePriceDiagnostic.total.conditionalNetProfit)}。这几项诊断说明：该需求序列下收入相对固定预算太小，不能靠把token成本压成0、补收费项或一次温和涨价解决。`,
  '',
  `若固定所有购买量并忽略价格弹性，基准仅靠价格需约${diagnostic.baseBreakevenPriceMultiple.toFixed(2)}倍才24月回本，约${diagnostic.baseSixtyPercentNetMarginPriceMultiple.toFixed(2)}倍才在此窗口达60%条件净利率。这里只暴露规模与预算的错配，**不推荐把价格乘这些倍数，也不假设用户愿意买**。`,
  '',
  '定价设计负责纠正错误统一价、范围不清和重复收费，提供真实可成交的工作包；任务选择和交付质量负责让用户实际采购必要工作；动态成本与人工容量决定单包经济性；获客与复购决定固定预算利用率。四项都要过关，不能把任何一项宣称为唯一原因。',
  '',
  '## 5. 每月明细',
  '',
  '净收入为交付销售扣退款及VAT，充值不是收入。净利均沿用其他动态成本10%的条件值。',
  '',
  '| 月 | 保守新首付 | 保守净收入 | 保守条件净利 | 基准新首付 | 基准净收入 | 基准条件净利 | 乐观新首付 | 乐观净收入 | 乐观条件净利 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...Array.from({length:24},(_,i)=>`| ${scenarios[0].central.monthly[i].date} | ${scenarios.flatMap(r=>{const m=r.central.monthly[i];return [m.newPayers.toFixed(2),money(m.netRevenue),money(m.conditionalNetProfit)];}).join(' | ')} |`),
  '',
  '## 6. 来源与复算',
  '',
  '- 已知事实：用户给出的成本预算、个人付款、每年5–20项目、3试用0付费。',
  '- 用户新增实测观察：DeepSeek更新募集说明书的API费用为几元人民币；记录于inputs.json的userReportedUpdateApiCostObservation。3／5／8元是敏感点，未外推其他SKU；reported-update-cost-sensitivity.mjs单独替换更新行并重算24个月，其余需求与成本假设保留。',
  '- 原研究目录的`daily-workload-calendar.json`提供合成日历，非行业测量；来源位置见本目录README。复算只读取本目录的`inputs.json`和`rate-card.json`，首稿按财务组＋4个独立目标组合计算，不另存一份整稿单价。',
  '- 原研究目录的`projection-build/audit-config.json`是沿用合格访问、评估、首付序列的来源；相关参数已固定在本目录inputs.json，复算不依赖原文件。没有沿用旧35%项目覆盖率和725元年消费。',
  '- 原研究目录的`market-workforce-evidence.md`和`competitor-demand-evidence.md`仅为公开背景，不能验证本模型转化/复购；最小快照不复制这些原始背景，来源见README。',
  '- `calculate.mjs`为独立商业算术，`results.json`保存逐月逐包数量、税费、三情景和敏感性。所有真实成本/真实利润字段保持null。',
  `- ${checks.length}项算术及边界核验通过；这些不是用户验证或盈利证明。`,
  '- 独立审阅另外用分组卷积SKU及自然年亏损桶复算30条路径、720个月度记录，与本模型一致；商业假设和真实成本仍未验证。',
  '',
  '完整模型仍需真实支付、采用、去重归类、下一次需求机会和完整履约成本替换假设。财务结果不能用来证明这些假设存在。'
];
fs.writeFileSync(path.join(dir,'24个月条件测算.md'),L.join('\n')+'\n');
console.log(JSON.stringify({checks:checks.length,fullAnnualAt10Projects:annual(cfg.scenarios[1],true),scenarios:scenarios.map(r=>({label:r.label,selectedAnnual:r.central.annualSelectedCustomerPrice,year1:r.central.year1,year2:r.central.year2,total:r.central.total,firstProfit:r.central.firstPositiveMonth,cumulative:r.central.firstCumulativeBreakevenMonth}))},null,2));
