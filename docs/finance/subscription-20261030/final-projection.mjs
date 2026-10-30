import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Read-only product/baseline inputs; only the two final artifacts below are written.
const self = fileURLToPath(import.meta.url), dir = path.dirname(self);
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = {
  inputs: 'inputs.json', baseline: 'results.json', calculator: 'calculate.mjs',
  priorInputs: '../subscription-20261029/inputs.json',
  taskPrices: '../../../packages/contracts/src/automatic-pricing.ts',
  taskPriceResolver: '../../../apps/api/src/automatic-pricing.ts',
  subscriptionCatalog: '../../../packages/contracts/src/subscriptions.ts',
  subscriptionChangeDecision: '../../product-decisions/2026-10-30-subscription-changes.md',
  taskBillingDecision: '../../product-decisions/2026-10-30-task-billing-completion.md'
};
const sources = Object.fromEntries(Object.entries(sourcePaths).map(([key, relative]) => {
  const bytes = fs.readFileSync(path.resolve(dir, relative));
  return [key, { path: relative, sha256: sha(bytes), bytes }];
}));
const cfg = JSON.parse(sources.inputs.bytes), baseline = JSON.parse(sources.baseline.bytes);
const prior = JSON.parse(sources.priorInputs.bytes);
const checks = [], check = (name, condition) => { assert(condition, name); checks.push(name); };
const near = (name, a, b, tolerance = 1e-6) => { check(name, Math.abs(a - b) <= tolerance); };
const exact = (name, a, b) => { assert.deepEqual(a, b, name); checks.push(name); };
const sum = xs => xs.reduce((a, b) => a + b, 0);
exact('baseline inputs match their original hash', baseline.inputSha256, sources.inputs.sha256);
for (const value of Object.values(baseline.sourceHashes))
  exact('baseline source remains frozen: ' + value.path, sha(fs.readFileSync(path.resolve(dir, value.path))), value.sha256);
const pools = cfg.budget.proposedOperatingBreakdownCny, historical = cfg.budget.historicalRecoveryCny;
const envelope = cfg.userConfirmed.managementBudget24MonthsCny - historical;
exact('confirmed complete management budget', cfg.userConfirmed.managementBudget24MonthsCny, 2458500);
exact('historical recovery is included once', historical, 456200);
exact('operating envelope excludes history and income tax', envelope, 2002300);
near('proposed allocations sum to operating envelope', sum(Object.values(pools)), envelope);
exact('income tax is outside the old budget convention', cfg.budget.mainIncludesIncomeTax, false);
exact('registered users are not assumed paid', cfg.userConfirmed.networkAcquiredUsersFirst6Months, 1000);

const priceSource = sources.taskPrices.bytes.toString('utf8');
const catalogSource = sources.subscriptionCatalog.bytes.toString('utf8');
const taskPrices = [...prior.tariff.tasks.map(t => ({ id: t.id, label: t.label, points: t.points })),
  { id: 'full_review', label: '独立全面复核', points: prior.fullReview.points }];
for (const task of prior.tariff.tasks) {
  const row = priceSource.match(new RegExp(task.id + ':\\{base_fen:(\\d+),points:(\\d+),'));
  check('product has task row ' + task.id, !!row);
  exact('product price unchanged ' + task.id, Number(row[2]), task.points);
  exact('1.7 rounding retained ' + task.id, Math.ceil(Number(row[1]) * 17 / 10), task.points);
}
check('full review planning formula is still the implemented formula',
  priceSource.includes('cost*2120n') && priceSource.includes('base*17n,10n')
  && priceSource.includes("FULL_REVIEW_PLANNED_COST_CNY='" + prior.fullReview.CPlanCny + "'"));
exact('full review price follows two rounding stages',
  Math.ceil(Math.ceil(Number(prior.fullReview.CPlanCny) * 2120) * 17 / 10), prior.fullReview.points);
exact('all twelve task prices retained', taskPrices.length, 12);
const retainedLegacyReviewPrices = [{ id: 'differential_review', label: '差异复核', points: 14900 },
  { id: 'review_revision', label: '复核后原文修订', points: 14900 }];
for (const task of retainedLegacyReviewPrices) check('retained separately commissioned legacy review price ' + task.id,
  sources.taskPriceResolver.bytes.toString('utf8').includes("sku==='" + task.id + "'?{points:" + task.points));
const plans = [...catalogSource.matchAll(/\{id:'([^']+)',label:'([^']+)',amount_fen:(\d+),annual_amount_fen:(\d+),points:(\d+),/g)]
  .map(([, id, label, monthly, annual, points]) => ({ id, label, monthlyPaidFen: Number(monthly), annualPaidFen: Number(annual), monthlyPoints: Number(points) }));
exact('all three current subscription plans read from source', plans.length, 3);
for (const plan of plans) {
  const old = prior.funding.plans.find(p => p.id === plan.id);
  check('current subscription catalog ' + plan.id, catalogSource.includes(
    "id:'" + plan.id + "',label:'" + old.label + "',amount_fen:" + plan.monthlyPaidFen
    + ',annual_amount_fen:' + plan.annualPaidFen + ',points:' + plan.monthlyPoints));
  exact('monthly original consideration ' + plan.id, plan.monthlyPaidFen, old.paidFen);
  exact('monthly rights ' + plan.id, plan.monthlyPoints, old.points);
  exact('annual 9折 integer fen ' + plan.id, plan.annualPaidFen * 10, plan.monthlyPaidFen * 12 * 9);
}
const weights = prior.funding.mainConsumedPointsWeights;
near('consumed point origin weights sum to one', sum(Object.values(weights)), 1);
const ratio = share => sum(Object.entries(weights).map(([id, weight]) => {
  if (id === 'topup') return weight;
  const p = plans.find(p => p.id === id);
  return weight * ((1 - share) * (p.monthlyPaidFen / p.monthlyPoints) + share * (p.annualPaidFen / (12 * p.monthlyPoints)));
}));
near('zero annual share uses the original funding ratio', ratio(0), baseline.unitEconomics.considerationRatio, 0);
const fields = ['newRegistrations', 'firstPayers', 'retainedPayerMonths', 'activePayerMonths',
  'projectEquivalents', 'originalTaskEquivalents', 'fullReviewEquivalents', 'grossFace',
  'bonusReleased', 'bonusUsed', 'consumedPaidConsideration', 'refundProvision', 'netRevenue',
  'resourceRequirement', 'supportRequirement', 'resourceUnusedBudgetPressure', 'supportUnusedBudgetPressure',
  'paymentFee', 'taxSurcharge', 'fullReviewCostRequirement', 'contingencyUnusedBudgetPressure',
  'fixedOtherBudgetPressure', 'operatingCostIncludingSurcharge', 'profitBeforeIncomeTax', 'incomeTax',
  'operatingNetProfit', 'historicalRecovery', 'afterRecovery'];
function aggregate(rows) {
  const r = Object.fromEntries(fields.map(k => [k, sum(rows.map(row => row[k]))]));
  r.operatingNetMargin = r.netRevenue ? r.operatingNetProfit / r.netRevenue : null;
  r.afterRecoveryMargin = r.netRevenue ? r.afterRecovery / r.netRevenue : null;
  r.netRevenuePerRetainedPayerMonth = r.retainedPayerMonths ? r.netRevenue / r.retainedPayerMonths : null;
  return r;
}
function simulate(original, share, { faceMultiplier = 1, resourceMultiplier = 1, supportMultiplier = 1, costScale = 1, fundingRatio } = {}) {
  const result = structuredClone(original), rows = result.monthly;
  let bonusCarry = 0;
  for (const r of rows) {
    r.grossFace *= faceMultiplier;
    if (faceMultiplier !== 1) {
      bonusCarry += r.bonusReleased; r.bonusUsed = Math.min(bonusCarry, r.grossFace);
      bonusCarry -= r.bonusUsed; r.bonusCarry = bonusCarry;
    }
    r.consumedPaidConsideration = (r.grossFace - r.bonusUsed) * (fundingRatio ?? ratio(share));
    r.refundProvision = r.consumedPaidConsideration * prior.refundRate;
    r.netRevenue = (r.consumedPaidConsideration - r.refundProvision) / (1 + prior.tax.vat);
    r.paymentFee = r.consumedPaidConsideration * prior.tax.payment;
    r.taxSurcharge = r.netRevenue * prior.tax.vat * prior.tax.surchargeOnVat;
    r.resourceRequirement *= resourceMultiplier; r.supportRequirement *= supportMultiplier;
  }
  const resources = sum(rows.map(r => r.resourceRequirement)), support = sum(rows.map(r => r.supportRequirement));
  const resourceExtra = Math.max(0, resources - pools.paidResources), supportExtra = Math.max(0, support - pools.paidSupport);
  const paymentAndSurcharge = sum(rows.map(r => r.paymentFee + r.taxSurcharge));
  const fullReview = sum(rows.map(r => r.fullReviewCostRequirement));
  const claims = resourceExtra + supportExtra + paymentAndSurcharge + fullReview;
  const unusedContingency = Math.max(0, pools.paymentSurchargeAndContingency - claims);
  let openingLoss = 0, yearPretax = 0, yearTax = 0, cumulative = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    r.resourceUnusedBudgetPressure = Math.max(0, pools.paidResources - resources) / 24;
    r.supportUnusedBudgetPressure = Math.max(0, pools.paidSupport - support) / 24;
    r.contingencyUnusedBudgetPressure = unusedContingency / 24;
    r.operatingCostIncludingSurcharge = (r.fixedOtherBudgetPressure + r.resourceRequirement + r.supportRequirement
      + r.fullReviewCostRequirement + r.resourceUnusedBudgetPressure + r.supportUnusedBudgetPressure
      + r.paymentFee + r.taxSurcharge + r.contingencyUnusedBudgetPressure) * costScale;
    r.profitBeforeIncomeTax = r.netRevenue - r.operatingCostIncludingSurcharge;
    if (i && i % 12 === 0) { openingLoss = Math.max(0, openingLoss - yearPretax); yearPretax = 0; yearTax = 0; }
    yearPretax += r.profitBeforeIncomeTax;
    const nextTax = Math.max(0, yearPretax - openingLoss) * prior.tax.income;
    r.incomeTax = nextTax - yearTax; yearTax = nextTax;
    r.operatingNetProfit = r.profitBeforeIncomeTax - r.incomeTax;
    r.afterRecovery = r.operatingNetProfit - r.historicalRecovery;
    cumulative += r.afterRecovery; r.cumulativeAfterRecovery = cumulative;
  }
  result.total = aggregate(rows); result.year1 = aggregate(rows.slice(0, 12)); result.year2 = aggregate(rows.slice(12));
  result.costBridge = { ...result.costBridge, resourceRequirement: resources, supportRequirement: support,
    resourceExtra, supportExtra, paymentAndSurcharge, addedFullReview: fullReview, contingencyClaims: claims,
    contingencyUnused: unusedContingency, excessBeyondEnvelope: Math.max(0, claims - pools.paymentSurchargeAndContingency) };
  if (share === 0 && faceMultiplier === 1 && resourceMultiplier === 1 && supportMultiplier === 1 && costScale === 1 && fundingRatio === undefined)
    exact(original.id + ' zero annual share exact frozen result', result, original);
  return { annualShareOfConsumedSubscriptionPoints: share, considerationRatio: fundingRatio ?? ratio(share), result };
}
const annualShares = [0, 0.25, 0.5, 1], mainShare = 0.25;
const cases = baseline.main.flatMap(r => annualShares.map(share => simulate(r, share)));
const main = cases.filter(c => c.annualShareOfConsumedSubscriptionPoints === mainShare);
// Necessary M1 supply checks only. No opening paid lots or invented purchase calendar.
// Monthly-to-annual conversion can grant another month's rights, so each cadence
// is bounded separately; annual plans cannot be repeatedly changed mid-contract.
function firstMonthSupply(c) {
  const r = c.result.monthly[0], paidPoints = (r.grossFace - r.bonusUsed) * 100;
  const rows = plans.map(p => {
    const monthlyRequestedPoints = paidPoints * weights[p.id] * (1 - c.annualShareOfConsumedSubscriptionPoints);
    const annualRequestedPoints = paidPoints * weights[p.id] * c.annualShareOfConsumedSubscriptionPoints;
    const perCadenceMaximumPoints = r.firstPayers * p.monthlyPoints;
    return { planId: p.id, monthlyRequestedPoints, annualRequestedPoints, perCadenceMaximumPoints,
      monthlyShortagePoints: Math.max(0, monthlyRequestedPoints - perCadenceMaximumPoints),
      annualShortagePoints: Math.max(0, annualRequestedPoints - perCadenceMaximumPoints),
      minimumAnnualContractEquivalents: annualRequestedPoints / p.monthlyPoints };
  });
  const annualEquivalent = sum(rows.map(r => r.minimumAnnualContractEquivalents));
  const failureReasons = rows.flatMap(r => [
    ...(r.monthlyShortagePoints > 1e-6 ? [r.planId + ' monthly credit shortage'] : []),
    ...(r.annualShortagePoints > 1e-6 ? [r.planId + ' annual credit shortage'] : [])
  ]);
  if (annualEquivalent > r.firstPayers + 1e-6) failureReasons.push('annual contract equivalents exceed first payers');
  return { scenarioId: c.result.id, annualShare: c.annualShareOfConsumedSubscriptionPoints,
    firstPayers: r.firstPayers, initialPaidPointBalanceAssumed: 0, paidTaskPoints: paidPoints, rows,
    minimumAnnualContractEquivalents: annualEquivalent, failureReasons,
    necessaryConditionsPass: rows.every(r => r.monthlyShortagePoints < 1e-6 && r.annualShortagePoints < 1e-6) && annualEquivalent <= r.firstPayers + 1e-6,
    scope: 'Necessary M1 per-plan/cadence and total annual-contract bounds; a pass is not proof of a joint customer/lot purchase schedule.' };
}
const supplyDiagnostics = cases.map(firstMonthSupply);
check('audit catches optimistic first-month monthly credit shortage',
  supplyDiagnostics.find(c => c.scenarioId === 'optimistic' && c.annualShare === 0).necessaryConditionsPass === false);
check('audit catches optimistic 25% annual monthly credit shortage',
  supplyDiagnostics.find(c => c.scenarioId === 'optimistic' && c.annualShare === 0.25).necessaryConditionsPass === false);
const lowestAnnualRatio = Math.min(...plans.map(p => p.annualPaidFen / (12 * p.monthlyPoints)));
const fundingBounds = baseline.main.flatMap(r => [
  { id: 'all_payg', label: '全部按需充值', fundingRatio: 1, issuanceMeaning: 'PAYG point supply can meet requested tasks; willingness/ability to buy remains unverified.' },
  { id: 'minimum_annual_ratio', label: '全部按最低年付对价', fundingRatio: lowestAnnualRatio, issuanceMeaning: 'Mathematical maximum-discount bound only; subscription issuance feasibility is not asserted.' }
].map(b => ({ ...b, scenarioId: r.id, result: simulate(r, 0, { fundingRatio: b.fundingRatio }).result })));
for (const r of baseline.main) {
  const lower = fundingBounds.find(b => b.scenarioId === r.id && b.id === 'minimum_annual_ratio');
  const upper = fundingBounds.find(b => b.scenarioId === r.id && b.id === 'all_payg');
  const middle = main.find(b => b.result.id === r.id);
  check(r.id + ' funding revenue bounds', lower.result.total.netRevenue <= middle.result.total.netRevenue && middle.result.total.netRevenue <= upper.result.total.netRevenue);
}
const fullReviewSensitivity = baseline.fullReviewSensitivity.map(r => simulate(r, mainShare));
const costSensitivity = baseline.main.flatMap(r => [1, 1.5, 2].map(multiplier => ({
  scenarioId: r.id, resourceAndSupportMultiplier: multiplier,
  result: simulate(r, mainShare, { resourceMultiplier: multiplier, supportMultiplier: multiplier }).result.total
})));
const objectiveDefs = [
  { id: 'operating_break_even', label: '税后经营保本', margin: 0, recovery: false },
  { id: 'recovery_break_even', label: '完成历史回收后保本', margin: 0, recovery: true },
  { id: 'operating_margin_60', label: '税后经营净利60%', margin: 0.6, recovery: false },
  { id: 'recovery_margin_60', label: '历史回收后余量率60%', margin: 0.6, recovery: true }
];
const base = baseline.main.find(r => r.id === 'base');
const metric = (r, objective) => (objective.recovery ? r.total.afterRecovery : r.total.operatingNetProfit) - objective.margin * r.total.netRevenue;
const thresholds = objectiveDefs.map(objective => {
  let lo = 0, hi = 1;
  while (metric(simulate(base, mainShare, { faceMultiplier: hi }).result, objective) < 0 && hi < 1024) hi *= 2;
  check('bounded revenue diagnostic ' + objective.id, hi < 1024);
  for (let i = 0; i < 75; i++) {
    const mid = (lo + hi) / 2;
    if (metric(simulate(base, mainShare, { faceMultiplier: mid }).result, objective) < 0) lo = mid; else hi = mid;
  }
  const r = simulate(base, mainShare, { faceMultiplier: hi }).result;
  near('revenue target ' + objective.id, metric(r, objective), 0, 0.0001);
  return { ...objective, faceMultiplier: hi, requiredNetRevenueCny: r.total.netRevenue,
    requiredOperatingCostCny: r.total.operatingCostIncludingSurcharge,
    projectFaceCny: baseline.unitEconomics.projectFace * hi, firstPayers: r.total.firstPayers,
    projectEquivalents: r.total.projectEquivalents };
});
const costCaps = objectiveDefs.map(objective => {
  const atZero = simulate(base, mainShare, { costScale: 0 }).result;
  if (metric(atZero, objective) < 0) return { ...objective, possibleAtFixedRevenue: false,
    maximumOperatingCostCny: null, zeroOperatingCostMargin: objective.recovery ? atZero.total.afterRecoveryMargin : atZero.total.operatingNetMargin };
  let lo = 0, hi = 1;
  while (metric(simulate(base, mainShare, { costScale: hi }).result, objective) > 0 && hi < 1024) hi *= 2;
  for (let i = 0; i < 75; i++) {
    const mid = (lo + hi) / 2;
    if (metric(simulate(base, mainShare, { costScale: mid }).result, objective) >= 0) lo = mid; else hi = mid;
  }
  const r = simulate(base, mainShare, { costScale: lo }).result;
  near('cost cap target ' + objective.id, metric(r, objective), 0, 0.0001);
  return { ...objective, possibleAtFixedRevenue: true, maximumOperatingCostCny: r.total.operatingCostIncludingSurcharge,
    reductionFromCurrentOperatingBudgetCny: envelope - r.total.operatingCostIncludingSurcharge,
    note: 'A mathematical total-cost ceiling using the same monthly cost shape; not an approved cut or an executable service budget.' };
});
for (const c of [...cases, ...fullReviewSensitivity]) {
  const r = c.result, label = r.id + ' annual=' + c.annualShareOfConsumedSubscriptionPoints + ' review=' + r.options.fullReviewFrequency;
  exact(label + ' horizon', r.monthly.length, 24);
  near(label + ' one acquisition', r.total.newRegistrations, 1000);
  near(label + ' first paid not inflated', r.total.firstPayers, 1000 * r.scenario.registeredToFirstPaid);
  near(label + ' original budget and one contingency', r.total.operatingCostIncludingSurcharge, envelope + r.costBridge.excessBeyondEnvelope);
  near(label + ' history once after tax', r.total.afterRecovery, r.total.operatingNetProfit - historical);
  near(label + ' independent two-year tax', r.total.incomeTax,
    Math.max(0, r.year1.profitBeforeIncomeTax) * prior.tax.income
    + Math.max(0, r.year2.profitBeforeIncomeTax - Math.max(0, -r.year1.profitBeforeIncomeTax)) * prior.tax.income);
  for (const f of fields) near(label + ' annual sum ' + f, r.total[f], r.year1[f] + r.year2[f]);
  for (const row of r.monthly) {
    near(label + ' M' + row.month + ' pnl', row.afterRecovery, row.netRevenue - row.operatingCostIncludingSurcharge - row.incomeTax - row.historicalRecovery);
    check(label + ' M' + row.month + ' unknown cash preserved', row.actualCashReceipts === null && row.actualProfit === null && row.subscriptionCount === null);
  }
}
for (const original of baseline.main) {
  const ordered = cases.filter(c => c.result.id === original.id);
  for (let i = 1; i < ordered.length; i++) check(original.id + ' annual fixed-demand profit monotonic ' + i,
    ordered[i].result.total.operatingNetProfit <= ordered[i - 1].result.total.operatingNetProfit + 1e-6);
}
const perUser = main.map(c => {
  const r = c.result, t = r.total;
  return { scenarioId: r.id, facePerFullRetainedYearCny: baseline.unitEconomics.projectFace * r.scenario.annualProjectsPerRetainedPayer,
    consumedConsiderationPerRetainedMonthCny: t.consumedPaidConsideration / t.retainedPayerMonths,
    consumedConsiderationAnnualizedCny: t.consumedPaidConsideration / t.retainedPayerMonths * 12,
    consumedConsiderationPerActiveMonthCny: t.consumedPaidConsideration / t.activePayerMonths,
    netRevenuePerRetainedMonthCny: t.netRevenuePerRetainedPayerMonth,
    independentTasksPerActiveMonth: (t.originalTaskEquivalents + t.fullReviewEquivalents) / t.activePayerMonths };
});
const output = { asOf: '2026-10-30', status: 'IMPLEMENTED_RULES_UNCONSTRAINED_ORIGIN_DISCOUNT_PRESSURE_NOT_EXECUTABLE_SUBSCRIBER_FORECAST',
  featureCommit: 'b3f596e6dcc5514490e01af1321d80f24d097377', generatorSha256: sha(fs.readFileSync(self)),
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { path: v.path, sha256: v.sha256 }])),
  mainAnnualShare: mainShare, annualShareMeaning: 'share of consumed subscription points, not customers or cash',
  budget: baseline.budget, tax: prior.tax, refundProvisionRate: prior.refundRate,
  taskPrices, retainedLegacyReviewPrices, subscriptionPlans: plans, consumedPointOriginWeights: weights,
  workload: baseline.unitEconomics, cases, supplyDiagnostics, fundingBounds, fullReviewSensitivity, costSensitivity, thresholds, costCaps, perUser,
  actualCashReceipts: null, subscriberCounts: null, cashFundingPeak: null, cashPaybackMonth: null,
  checks: { count: checks.length, failures: 0, names: checks } };
const wan = n => (n / 10000).toFixed(2), n2 = n => n.toFixed(2), pct = n => (n * 100).toFixed(2) + '%';
const table = (headers, rows) => ['|' + headers.join('|') + '|', '|' + headers.map(() => '---').join('|') + '|', ...rows.map(r => '|' + r.join('|') + '|')].join('\n');
const currentBase = main.find(c => c.result.id === 'base').result;
const lines = [
  '# 最终计费规则下的24个月利润', '',
  '2026-10-30｜条件测算。收费功能已先推送 b3f596e6；本报告不改价格、客户权益、旧模型或业务代码，不使用模拟付款作为营业收入。', '',
  '主表是**未约束来源组合的折扣压力**，取“已消费订阅积分中25%来自年付”作展示参数，没有真实采用率证据。沿用前6个月1,000注册／激活用户和原三组付费、留存、项目任务量；不为了60%目标增加用户。', '',
  '在该算术条件下，保守／基准／乐观24个月税后经营净利分别为' + main.map(c => wan(c.result.total.operatingNetProfit)).join('／') + '万元；经营净利率分别为' + main.map(c => pct(c.result.total.operatingNetMargin)).join('／') + '。扣除45.62万元历史回收后的管理余量分别为' + main.map(c => wan(c.result.total.afterRecovery)).join('／') + '万元。基准18.39%及回收后3.16万元是条件数，不能证明达到60%。**原来源权重在乐观M1未通过积分供给必要检查，不能把该情景当作可执行订阅销量／利润预测。**', '',
  '## 1. 使用的规则与口径', '',
  '- 24个月245.85万元含历史回收45.62万元，经营额度200.23万元。**沿旧模型口径，企业所得税另算，不含在245.85万元内**；这不是用户已批准的新税费预算。表内另列税和“经营＋税＋历史”压力总额。',
  '- 成本分池是原测算建议，不代表逐项获批、已花费或已签约。主表保留全预算支出压力：未用额度假设最终用于其他可税前扣除的经营支出，未花准备金本身不能作为真实费用或抵税。',
  '- 新充值1元100积分；月订阅按原实付／原积分折算，年付月价×12×90%、积分逐月发放。原消费来源权重为充值50%、轻量30%、专业15%、密集5%，同样只是模型条件。',
  '- 收入＝扣赠额后的任务票面×积分原对价系数×97%÷1.06。任务预留、月发积分、预收年费、未用或到期积分都不额外创造本模型的任务收入。',
  '- 月付转年付及升档仅承接未用原对价；订单只收新现金，旧对价不再计一次收入。本模型没有购买／转换时点和次数，因此不臆测转换现金流、舍入让利总额或新增客户。',
  '- 税率沿旧条件：VAT6%、附加税为VAT的12%、所得税25%、售后准备3%。支付手续费按消费对价0.6%作预算代理；真实预收款手续费需付款日历，不能从本表推断。',
  '- M1为计划启动月；M1—12、M13—24是两个规划税年。年度亏损向后结转；月所得税为年度累计应计差额，负值不表示收到退税。历史研发假定过去已费用化，回收不再税前抵扣。', '',
  table(['方案', '月付元', '年付元', '每月积分', '月付每积分原对价分', '年付每积分原对价分'], plans.map(p => [p.label, n2(p.monthlyPaidFen / 100), n2(p.annualPaidFen / 100), p.monthlyPoints, (p.monthlyPaidFen / p.monthlyPoints).toFixed(6), (p.annualPaidFen / (12 * p.monthlyPoints)).toFixed(6)])), '',
  '## 2. 从日常任务到收入的假设', '',
  table(['条件', '累计首次付费', '注册→首付', '月关系留存', '对应12月留存', '返访活跃月比例', '年项目'], cfg.scenarios.map(s => [s.label, 1000 * s.registeredToFirstPaid, pct(s.registeredToFirstPaid), pct(s.monthlyPaidRelationshipRetention), pct(s.monthlyPaidRelationshipRetention ** 12), pct(s.taskActiveShareOfRetainedPaid), s.annualProjectsPerRetainedPayer])), '',
  '1000人仅获取一次：M1—6新增100/150/150/200/200/200，M7—24主表不加入未知新增；首付60%/30%/10%分别发生于注册当月／后1月／后2月。除用户确认的总数和年项目5—20范围外，这些分布、转化、留存和活跃比例均无实证。关系留存不是自动续费率，首次付费人数不是当前订阅人数。', '',
  '每个项目16.5项独立任务等价、标价808.81元：1项主稿作业（六类互斥选择）＋2份关联文件＋1份独立底稿＋平均0.5轮诚信核查＋10道问题回复＋2份独立一致性维护。它是可审阅的工作篮子，不是已观察的订单结构。父任务自检、同轮修订、同题补证、平台重试、重复点击不另计销量。全面复核的主表需求保持0，避免凭新增SKU虚构销量；后文保留原敏感性。', '',
  table(['任务', '积分', '票面元', '每项目次数'], taskPrices.map(t => [t.label, t.points, n2(t.points / 100), t.id === 'full_review' ? '主表0，另列敏感性' : baseline.unitEconomics.projectVector[t.id].toFixed(4)])), '',
  '另行委托的差异复核、复核后原文修订各保留14,900积分，只核对现价，不凭空添加需求频次。M4误免单修复保证现有收费边界一致，本模型不因此自动增加收入或任务数。', '',
  '项目数＝留存付费人月×年项目量÷12，覆盖这些用户的全部项目，不再乘35%或活跃月比例。活跃比例只将任务分配到有工作的月份，并影响增量支持成本。', '',
  table(['条件', '全年票面需求元/完整留存年', '原对价消费元/留存人月', '原对价消费年化元', '原对价消费元/活跃人月', '任务/活跃人月'], perUser.map(r => [cfg.scenarios.find(s => s.id === r.scenarioId).label, n2(r.facePerFullRetainedYearCny), n2(r.consumedConsiderationPerRetainedMonthCny), n2(r.consumedConsiderationAnnualizedCny), n2(r.consumedConsiderationPerActiveMonthCny), n2(r.independentTasksPerActiveMonth)])), '',
  '上述“消费”是已使用积分的含税原对价、售后准备前金额；它不是订阅月费、充值收款或个人当月实付现金。年化是同一分母的12倍，不能当作每位实际客户必付金额。高频用户可能跨多个月份结转积分或混合使用充值，但购买行为尚未验证。', '',
  '## 3. 未约束来源组合的24个月折扣压力', '', '金额单位：万元；主表年付消费份额25%，不是可执行订阅销量预测。', '',
  table(['条件', 'M1供给必要检查', '净收入', '经营成本含附加', '所得税', '税后经营净利', '经营净利率', '历史回收后余量', '余量率', '经营＋税＋历史'], main.map(c => { const t = c.result.total, supply = supplyDiagnostics.find(s => s.scenarioId === c.result.id && s.annualShare === mainShare); return [c.result.label, supply.necessaryConditionsPass ? '未发现不足；非充分证明' : '未通过', wan(t.netRevenue), wan(t.operatingCostIncludingSurcharge), wan(t.incomeTax), wan(t.operatingNetProfit), pct(t.operatingNetMargin), wan(t.afterRecovery), pct(t.afterRecoveryMargin), wan(t.operatingCostIncludingSurcharge + t.incomeTax + t.historicalRecovery)]; })), '',
  table(['条件', '规划年度', '净收入', '经营成本含附加', '所得税', '税后经营净利', '历史回收后余量'], main.flatMap(c => ['year1', 'year2'].map((key, i) => { const t = c.result[key]; return [c.result.label, i + 1, wan(t.netRevenue), wan(t.operatingCostIncludingSurcharge), wan(t.incomeTax), wan(t.operatingNetProfit), wan(t.afterRecovery)]; }))), '',
  '管理余量＝税后经营净利−历史回收，不能称为法定会计净利润；经营净利也不是现金流。经营累计转正不等于投资现金回本，收款、预收余额、现金缺口及回本月份仍未知。', '',
  '## 4. 动态成本及预算衔接', '',
  '任务资源代理为6.67万元÷56,598.84项＝' + baseline.unitEconomics.resourceUnitCostProxy.toFixed(6) + '元/任务；支持代理为23.87万元÷8,079.78活跃人月＝' + baseline.unitEconomics.supportUnitCostProxy.toFixed(6) + '元/活跃人月。两者来自旧预算，不是DeepSeek实测token成本，也不证明每类任务成本相同。用户提供的“更新募集书成本几元”是经验参考，不能代替本表逐SKU测量。', '',
  '各场景按实际假设任务量／活跃人月重新计算需求，分别先占资源和支持容量，再与手续费、附加税及额外全面复核共同占13.53万元机动池，超额才列预算外成本。未用容量按全支出压力保留，原5%准备不再加一遍。', '',
  table(['条件', '任务量等价', '活跃人月', '资源需求', '支持需求', '手续费代理', '税金附加', '超经营预算'], main.map(c => { const r = c.result, t = r.total; return [r.label, n2(t.originalTaskEquivalents), n2(t.activePayerMonths), wan(t.resourceRequirement), wan(t.supportRequirement), wan(t.paymentFee), wan(t.taxSurcharge), wan(r.costBridge.excessBeyondEnvelope)]; })), '',
  table(['条件', '资源和支持单价倍率', '经营成本', '税后经营净利', '净利率', '历史回收后余量'], costSensitivity.map(c => [cfg.scenarios.find(s => s.id === c.scenarioId).label, c.resourceAndSupportMultiplier, wan(c.result.operatingCostIncludingSurcharge), wan(c.result.operatingNetProfit), pct(c.result.operatingNetMargin), wan(c.result.afterRecovery)])), '',
  '倍率只压资源和增量支持单价，不增加客户；仍可能低估重任务、免费帮助、返工和安全交付成本。后续需按任务类型记录输入/输出/缓存token、模型费率、工具、失败重试和真正增量工时，替换代理数值后再判断任务毛利。', '',
  '## 5. 年付与独立全面复核敏感性', '',
  table(['条件', '年付占订阅消费积分', '净收入', '税后经营净利', '净利率', '历史回收后余量'], cases.map(c => { const t = c.result.total; return [c.result.label, pct(c.annualShareOfConsumedSubscriptionPoints), wan(t.netRevenue), wan(t.operatingNetProfit), pct(t.operatingNetMargin), wan(t.afterRecovery)]; })), '',
  '年付占比上升只改变已履约积分的原对价；本表不假定折扣带来留存、销量或转化改善。零年付结果逐字段等于原results.json。年付鼓励承诺用量可能有商业价值，但没有数据时不把该价值写成收入。', '',
  '### 来源供给审计与收入边界', '',
  '原消费来源权重并未由套餐购买日历推导。M1没有期初付费积分：每个首次付费者最多持有一批某档月付额度；月付消费后转同档年付可再发首月额度，因此月／年分别作必要上界，不能把两者误合成一批。已付年期不能中途反复改档，年付各档所需合同等价合计也不能超过首次付费人数。下表仅是必要条件，未发现缺口不等于已经排出了可执行的逐客户、逐批次计划。', '',
  table(['条件', '年付份额', 'M1首次付费', '轻量月付需求积分', '轻量月付供给上界', '轻量月付缺口', '年付合同等价需求/人数上界', '必要条件'], supplyDiagnostics.map(s => { const light = s.rows.find(r => r.planId === 'light'); return [cfg.scenarios.find(c => c.id === s.scenarioId).label, pct(s.annualShare), n2(s.firstPayers), n2(light.monthlyRequestedPoints), n2(light.perCadenceMaximumPoints), n2(light.monthlyShortagePoints), n2(s.minimumAnnualContractEquivalents) + '/' + n2(s.firstPayers), s.necessaryConditionsPass ? '未发现不足' : '未通过']; })), '',
  '例如乐观50%年付行虽没有轻量月付缺口，但需要至少31.71份年付合同等价，超过M1的30位首次付费者，仍未通过；不能只检查月积分总量。', '',
  '为保留可解释边界，以下不增用户或任务，只改变折算对价：全部按需充值按1:1提供积分，供给上可满足需求，但不是用户愿意如此购买的预测；全部付费消费按最低现行年付对价（密集年付，每积分' + lowestAnnualRatio.toFixed(6) + '分）只是最大让利数学压力，**不声称全部可以发行**。两端都沿用赠额、售后、税率和成本规则。', '',
  table(['条件', '消费对价边界', '净收入', '所得税', '税后经营净利', '经营净利率', '历史回收后余量'], fundingBounds.map(b => { const t = b.result.total; return [b.result.label, b.label, wan(t.netRevenue), wan(t.incomeTax), wan(t.operatingNetProfit), pct(t.operatingNetMargin), wan(t.afterRecovery)]; })), '',
  '以上价目表对价边界不包含数量未知的转换舍入让利：每次转换不足1分的差额归平台承担，实际总额需交易记录。要得到可执行订阅销量预测，还需要首次购买档位、月／年选择、续费、升级／转年付时间、逐月发额、90天到期、期初余额及任务消费的同账号批次数据。不能用固定消费比例代替这些条件，也不能把当前审计缺口隐藏为“乐观增长”。', '',
  table(['基准额外复核/活跃人月', '复核任务等价', '净收入', '额外复核规划成本', '税后经营净利', '净利率'], fullReviewSensitivity.map(c => { const r = c.result; return [r.options.fullReviewFrequency, n2(r.total.fullReviewEquivalents), wan(r.total.netRevenue), wan(r.total.fullReviewCostRequirement), wan(r.total.operatingNetProfit), pct(r.total.operatingNetMargin)]; })), '',
  '全面复核271.95元/轮，规划标准成本7.5454800512元，包含其资源／服务假设；该成本单列，不再按普通任务资源代理加一遍。频次0.05/0.1/0.2是原条件敏感性，不是新销售目标或实测需求。', '',
  '## 6. 基准保本与60%要求', '',
  '以下固定300位累计首次付费、原项目数及任务量，只求收入或成本的数学边界，**不是建议按这些倍率提价，也不是客户数预测**。提价后的需求下降、退款、渠道和支付来源变化均未被假装为零风险。', '',
  table(['目标', '所需24月净收入', '该收入下经营成本', '票面倍率诊断', '每项目票面诊断元'], thresholds.map(r => [r.label, wan(r.requiredNetRevenueCny), wan(r.requiredOperatingCostCny), r.faceMultiplier.toFixed(3), n2(r.projectFaceCny)])), '',
  '若维持基准净收入' + wan(currentBase.total.netRevenue) + '万元，允许的总经营成本上限为：', '',
  table(['目标', '总经营成本上限万元', '较200.23万需减少万元'], costCaps.map(r => [r.label, r.possibleAtFixedRevenue ? wan(r.maximumOperatingCostCny) : '即使经营成本为0也不可达', r.possibleAtFixedRevenue ? wan(r.reductionFromCurrentOperatingBudgetCny) : '不适用'])), '',
  '基准当前收入下，60%税后经营净利要求经营成本不超过' + wan(costCaps.find(r => r.id === 'operating_margin_60').maximumOperatingCostCny) + '万元；仅用户原基础运行预算（技术维护、内容运营、记账财税和基础云）就有79.44万元，已经超过该上限。即使不花其他扩张费用，按原基础投入水平也不能在当前收入下实现60%。', '',
  '若60%还要求完成45.62万元历史回收，当前收入下即使经营成本为零，税后回收后余量率也最多' + pct(costCaps.find(r => r.id === 'recovery_margin_60').zeroOperatingCostMargin) + '，仍不足60%。', '',
  'costScale成本上限只是按原月成本形状同比缩放后重算税的数学诊断；不能假装支付手续费和附加税也可任意同比削掉，不是可执行减支清单。应优先验证项目篮子和付费复购，并按实际贡献分批启用尚未承诺的扩张费用；不能把13.53万元未花机动额度、年付预收或隐藏取消当作保证盈利的手段。', '',
  '## 7. 逐月主表', '',
  '金额单位万元。人数与任务是等价期望量，可为小数；真实订单和用户必须是整数。未列现金收款列是因为没有购买时点数据。', '',
  ...main.flatMap(c => ['### ' + c.result.label, '', table(['月', '首次付费', '留存付费', '活跃付费', '任务等价', '净收入', '经营成本', '所得税', '经营净利', '回收后余量', '累计余量'], c.result.monthly.map(r => [r.month, n2(r.firstPayers), n2(r.retainedPayerMonths), n2(r.activePayerMonths), n2(r.originalTaskEquivalents + r.fullReviewEquivalents), wan(r.netRevenue), wan(r.operatingCostIncludingSurcharge), wan(r.incomeTax), wan(r.operatingNetProfit), wan(r.afterRecovery), wan(r.cumulativeAfterRecovery)])), '']),
  '## 8. 复算与仍需验证的数据', '',
  '运行：`node docs/finance/subscription-20261030/final-projection.mjs`。只读取原模型与已落地规则，生成final-projection-results.json及本文；不会修改原inputs.json、calculate.mjs、results.json或应用代码。JSON包含完整来源与生成器SHA-256、12种年付／需求组合、逐月损益和敏感性。', '',
  '本次' + checks.length + '项校验通过、0失败：现行价表与套餐、零年付对原模型全字段一致、1000注册仅获取一次、三情景首付人数、24月／年度合计、来源对价、预算与历史回收不双计、年度亏损结转、月损益及诊断目标残差。', '',
  '仍缺：实际激活与首次付费率、按项目／主体去重后的付费任务数、免费帮助和失败资源成本、真实DeepSeek用量、各订阅档及年付采用率、月续费／年续约、同题修复率、充值/消费时滞、退款、支出日历和企业税务身份。主流产品页面参考与功能测试不能证明这些参数。本模型不输出实际收款、订阅人数、现金峰值或盈利承诺。', ''
];
fs.writeFileSync(path.join(dir, 'final-projection-results.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '最终计费规则下的24个月利润.md'), lines.join('\n'));
console.log(JSON.stringify({ checks: checks.length, failures: 0, main: main.map(c => ({
  scenario: c.result.id, netRevenueWan: c.result.total.netRevenue / 10000,
  operatingNetProfitWan: c.result.total.operatingNetProfit / 10000, margin: c.result.total.operatingNetMargin,
  recoverySurplusWan: c.result.total.afterRecovery / 10000
})), thresholds, costCaps }, null, 2));
