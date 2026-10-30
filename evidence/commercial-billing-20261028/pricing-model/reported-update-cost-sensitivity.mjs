import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const dir=path.dirname(fileURLToPath(import.meta.url));
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
const cfg=read('inputs.json'), base=read('results.json'), rates=read('rate-card.json');
const observation=cfg.userReportedUpdateApiCostObservation;
assert.equal(observation.evidenceType,'USER_REPORTED_ACTUAL');
const P=rates.prices.period/100;
const fixed=Object.values(cfg.fixedMonthly).reduce((a,b)=>a+b,0);
const sum=(rows,key)=>rows.reduce((n,r)=>n+r[key],0);
const money=x=>x.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});

// Reproduce calendar-year accrual and loss carryforward before changing a cost.
function recalculate(rows,otherCost){
  let year=null,lossOpen=0,yearPbt=0,yearTax=0;
  return rows.map(m=>{
    const yr=m.date.slice(0,4);
    if(yr!==year){
      if(year!==null)lossOpen=Math.max(0,lossOpen-yearPbt);
      yearPbt=0;yearTax=0;year=yr;
    }
    const replacement=otherCost(m);
    const pbt=m.netRevenue-m.fixed-m.payment-m.vatSurcharge-m.quoteCost-replacement.total;
    yearPbt+=pbt;
    const ytd=Math.max(0,yearPbt-lossOpen)*cfg.tax.income;
    const tax=ytd-yearTax;yearTax=ytd;
    return {...m,...replacement,otherVariableAssumed:replacement.total,profitBeforeTax:pbt,
      incomeTaxAccrual:tax,conditionalNetProfit:pbt-tax,actualNetProfit:null};
  });
}
function summarize(rows){
  const out=Object.fromEntries(['netRevenue','fixed','payment','vatSurcharge','quoteCost',
    'otherVariableAssumed','profitBeforeTax','incomeTaxAccrual','conditionalNetProfit']
    .map(key=>[key,sum(rows,key)]));
  out.periodUpdateUnits=rows.reduce((n,m)=>n+m.quantities.period,0);
  out.conditionalNetMargin=out.netRevenue?out.conditionalNetProfit/out.netRevenue:null;
  return out;
}
const checks=[];
function check(name,condition){assert(condition,name);checks.push({name,pass:true});}
const scenarios=base.scenarios.map(s=>{
  const original=s.central.monthly;
  const reproduced=recalculate(original,m=>({total:m.otherVariableAssumed}));
  check(s.id+' reproduce original 24 monthly taxes and profits',reproduced.every((m,i)=>
    Math.abs(m.conditionalNetProfit-original[i].conditionalNetProfit)<1e-7&&
    Math.abs(m.incomeTaxAccrual-original[i].incomeTaxAccrual)<1e-7));
  const paths=observation.sensitivityPointsNotNewMeasurements.flatMap(apiCost=>[0,5,15].map(extra=>{
    const monthly=recalculate(original,m=>{
      const q=m.quantities.period;
      const periodRevenue=q*P*(1-cfg.refundedDeliveredSalesFraction)/(1+cfg.tax.vat);
      const residualNonUpdateBudget=0.1*(m.netRevenue-periodRevenue);
      check(s.id+' valid period revenue '+apiCost+'/'+extra+'/'+m.month,
        periodRevenue<=m.netRevenue+1e-7&&residualNonUpdateBudget>=-1e-7);
      const updateApiAssumed=q*apiCost,updateNonApiAssumed=q*extra;
      return {total:residualNonUpdateBudget+updateApiAssumed+updateNonApiAssumed,
        updateApiAssumed,updateNonApiAssumed,residualNonUpdateBudget};
    });
    check(s.id+' revenue and demand unchanged '+apiCost+'/'+extra,monthly.every((m,i)=>
      m.netRevenue===original[i].netRevenue&&m.newPayers===original[i].newPayers&&
      JSON.stringify(m.quantities)===JSON.stringify(original[i].quantities)));
    const total=summarize(monthly);
    return {apiCostPerUpdate:apiCost,extraNonApiPerUpdate:extra,monthly,
      year1:summarize(monthly.slice(0,12)),year2:summarize(monthly.slice(12)),total,
      profitChangeFromOldBudget:total.conditionalNetProfit-s.central.total.conditionalNetProfit};
  }));
  return {id:s.id,label:cfg.scenarios.find(x=>x.id===s.id).label,
    previous:s.central.total,paths};
});
const R=P*(1-cfg.refundedDeliveredSalesFraction)/(1+cfg.tax.vat);
const payment=P*cfg.tax.paymentOnGrossReceipt;
const surcharge=(P*(1-cfg.refundedDeliveredSalesFraction)-R)*cfg.tax.vatSurchargeOnOutputVat;
const unitSensitivity=observation.sensitivityPointsNotNewMeasurements.map(apiCost=>{
  const contribution=R-payment-surcharge-apiCost;
  const marginBudget=(1-.60/(1-cfg.tax.income))*R-payment-surcharge-apiCost;
  const breakevenUnits=Math.ceil(fixed/contribution);
  const sixtyPercentUnits=marginBudget>0?Math.ceil(fixed/marginBudget):null;
  check('unit breakeven boundary '+apiCost,breakevenUnits*contribution>=fixed&&
    (breakevenUnits-1)*contribution<fixed);
  check('unit 60 percent boundary '+apiCost,sixtyPercentUnits*marginBudget>=fixed&&
    (sixtyPercentUnits-1)*marginBudget<fixed);
  return {price:P,apiCost,netRevenue:R,payment,vatSurcharge:surcharge,partialCostBalance:contribution,
    partialCostBalanceFraction:contribution/R,breakevenMonthlyUnitsLowerBound:breakevenUnits,
    sixtyPercentMonthlyUnitsLowerBound:sixtyPercentUnits};
});
const out={asOf:'2026-10-28',status:'USER_REPORTED_ACTUAL_ANCHOR_WITH_CONDITIONAL_SENSITIVITIES',
  observation,originalResultsSha256:createHash('sha256').update(fs.readFileSync(path.join(dir,'results.json'))).digest('hex'),
  scopeMappingAssumed:'For this sensitivity only, one user-reported update execution maps to one period SKU. Actual scope mapping has not been supplied.',
  limitations:['No new API requests or payments.','3/5/8 are sensitivity points, not three measurements.',
    'Only period SKU cost is replaced; no borrowing update costs for first drafts, replies, checks or reviews.',
    'Non-update other-variable budget remains the old unvalidated 10% of its net revenue.',
    'Extra update non-API 0/5/15 are sensitivities; zero is a partial-cost lower-bound diagnostic, not measured absence.',
    'All demand, purchase and repeat hypotheses are unchanged and remain unvalidated.'],
  actualFullTaskCost:null,actualNetProfit:null,unitSensitivity,scenarios,checks};
fs.writeFileSync(path.join(dir,'reported-update-cost-results.json'),JSON.stringify(out,null,2));
const L=[
  '# 用户实测更新成本：定价与盈利复核','',
  '2026-10-28。用户说明已实际用DeepSeek更新募集说明书，API成本为几元人民币。本轮采用该用户自报实际观察继续定价；没有新增API调用或支出。3／5／8元是对“几元”的敏感点，并非三个实测值。固定预算仍为33,100元/月。','',
  '## 对定价的直接影响','',
  '这条观察支持“募集更新API成本是几元量级”的工作假设，不支持把token费用当成此前预测亏损的主要原因。249元候选价不必因模型多读材料、多重试而升档；价格差异应对应用户真实新增的业务范围及成果。原范围必要工作、补证和平台纠错包含。价格仍须检验用户愿付及实际交付价值，不能用高贡献率证明用户愿买。','',
  '用户没有提供该次更新的精确目标期数；下列单包及24个月敏感性暂将一次执行对应一个249元期间更新包。这是映射假设，不把几元成本扩展到首稿、149元复核、9.8元回复或499元所有复杂组。','',
  '## 249元更新单的空间','',
  '沿原条件：VAT6%、交付后退款2%、支付0.6%按退款前金额、销项VAT附加12%且未计进项抵扣、所得税25%。表中余额尚未扣固定费用、其他工具/OCR、未包含的失败重试与返工、预算外支持和销售费用。预算内人员及基础云计入固定预算一次。','',
  '| API敏感点 | 扣已列成本后余额 | 余额比例（部分成本口径） | 月保本单量下界 | 月60%净利单量下界 |',
  '| ---: | ---: | ---: | ---: | ---: |',
  ...unitSensitivity.map(u=>`| ${money(u.apiCost)} | ${money(u.partialCostBalance)} | ${(u.partialCostBalanceFraction*100).toFixed(2)}% | ${u.breakevenMonthlyUnitsLowerBound} | ${u.sixtyPercentMonthlyUnitsLowerBound} |`),'',
  '单量为同类已收费交付更新单，包含2%后退款，既不是用户人数，也不是需求预测。只有表内列出的成本，故为理论下界；其他成本不能因未知而断言为0。以5元点计，约222元留给固定、其他成本和利润，说明该更新价位仍有覆盖固定和其他支出的空间；并不等于公司已获96%净利。','',
  '## 保持原需求不变，24个月会改变多少','',
  '原模型将所有其他动态成本暂记净收入10%，其中含模型和其他履约费用；对249元更新，这个合计预算约23.02元/单。下面只替换期间更新这一行：API取3／5／8元；其余非更新工作继续保留原10%预算。更新非API余项另用0／5／15元敏感性，不重复保留原23.02元再加模型费。所有来访、转化、任务量、采购比例及复购参数均不改。年度税及亏损结转重新计算。','',
  '下表取更新非API余项0元，专门展示替换成本的最大方向影响；它是部分成本诊断，不是新盈利预测。','',
  '| 原需求场景 | 原24月条件净利 | 更新API3元 | 更新API5元 | 更新API8元 | 24月更新包数 |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...scenarios.map(s=>`| ${s.label} | ${money(s.previous.conditionalNetProfit)} | ${[3,5,8].map(k=>money(s.paths.find(p=>p.apiCostPerUpdate===k&&p.extraNonApiPerUpdate===0).total.conditionalNetProfit)).join(' | ')} | ${s.paths[0].total.periodUpdateUnits.toFixed(2)} |`),'',
  '原基准24月净收入约30.95万元，固定预算79.44万元；即使所有履约成本都归零，收入仍覆盖不了固定预算。这揭示原低需求假设与预算的错配，不能据此认定249元定价或商业模式不成立，更不能把该需求序列当已测事实。也不能为达60%直接抬高用户数。','',
  '## 需要优先解决的规则','',
  '1. 同一目标复杂度波动由公司承担，不能以token、模型轮数、材料首次读取或平台漏估触发升级。真实新增期间、口径或独立成果才重新计算公开价格。',
  '2. 已购分析复用，必要主稿落地、原范围补证与纠错不重收；同组封顶、升级只补差额。249／499等金额继续作候选价，不借低模型成本证明全部范围都可交付。',
  '3. 小额检查和直接回复需要独立的自动路径与成本观察。不能将完整更新的几元成本直接套到9.8／9.9元，再笼统称所有SKU都健康。',
  '4. 不恢复逐单人工核价作为默认购买流程。标准范围按公开规则立即报一笔总价，例外再审；范围识别不交付免费实质检查或复核。',
  '5. 购买验证看具体总价、成果采用和下一次真实需求的复购；需要分别诊断范围、质量、购买主体和成交价，不只调整获客漏斗。','',
  '这次可以继续讨论并修订价格，不需要用户再提供API凭据。已有100元授权保留；若确需新增调用，再先验证费率和可靠支出控制。候选规则现已在本工作树实现，生产收费开关默认关闭；语义分类、真实成交、完整成本及正式收款仍须分别验证。','',
  '复算：`pricing-model/reported-update-cost-sensitivity.mjs`；逐月结果及0／5／15元余项敏感性：`pricing-model/reported-update-cost-results.json`（本地生成，不提交Git）。原30路径模型结果保持不变；本补充显式记录成本替换边界与用户观测。',''
];
fs.writeFileSync(path.join(dir,'..','用户实测更新成本-定价与盈利复核.md'),L.join('\n'));
console.log(JSON.stringify({checks:checks.length,unitSensitivity,scenarios:scenarios.map(s=>({id:s.id,previous:s.previous.conditionalNetProfit,api5extra0:s.paths.find(p=>p.apiCostPerUpdate===5&&p.extraNonApiPerUpdate===0).total.conditionalNetProfit,api5extra5:s.paths.find(p=>p.apiCostPerUpdate===5&&p.extraNonApiPerUpdate===5).total.conditionalNetProfit,api5extra15:s.paths.find(p=>p.apiCostPerUpdate===5&&p.extraNonApiPerUpdate===15).total.conditionalNetProfit}))},null,2));
