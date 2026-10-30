import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Offline conditional finance model. Does not modify old models or product code.
const dir = path.dirname(fileURLToPath(import.meta.url));
const hash = x => createHash('sha256').update(x).digest('hex');
const bytes = fs.readFileSync(path.join(dir, 'inputs.json'));
const cfg = JSON.parse(bytes);
const oldBytes = fs.readFileSync(path.resolve(dir, cfg.sources.priorInputs));
const old = JSON.parse(oldBytes);
const priorResultsBytes = fs.readFileSync(path.resolve(dir, cfg.sources.priorResults));
const priorResults = JSON.parse(priorResultsBytes);
assert.equal(priorResults.inputSha256, hash(oldBytes), 'Prior model must match its frozen inputs');
const sourceHashes = Object.fromEntries(Object.entries(cfg.sources).map(([key, p]) =>
  [key, { path: p, sha256: hash(fs.readFileSync(path.resolve(dir, p))) }]));
const sum = xs => xs.reduce((a, b) => a + b, 0);
const checks = [];
const near = (label, a, b, tolerance = 1e-6) => {
  assert(Math.abs(a - b) <= tolerance, label + ': ' + a + ' != ' + b);
  checks.push(label);
};
const historical = cfg.budget.historicalRecoveryCny;
const operatingEnvelope = cfg.userConfirmed.managementBudget24MonthsCny - historical;
const pools = cfg.budget.proposedOperatingBreakdownCny;
const contingency = pools.paymentSurchargeAndContingency;
const fixedOther = operatingEnvelope - pools.paidResources - pools.paidSupport - contingency;
const resourceUnit = cfg.budget.dynamicSensitivity.legacyPaidResourceBudgetCny
  / cfg.budget.dynamicSensitivity.legacyCapacityTasks;
const supportUnit = cfg.budget.dynamicSensitivity.legacyPaidSupportBudgetCny
  / cfg.budget.dynamicSensitivity.legacyCapacityPaidPersonMonths;
const tasks = old.tariff.tasks;
const taskById = Object.fromEntries(tasks.map(t => [t.id, t]));
const majorIds = ['quarter', 'annual', 'two_year', 'three_year', 'migration', 'new'];
const majorFrequency = sum(majorIds.map(id => taskById[id].frequencyPerBilledPersonMonth));
const projectVector = Object.fromEntries(tasks.map(t => [t.id, majorIds.includes(t.id)
  ? t.frequencyPerBilledPersonMonth / majorFrequency * cfg.projectWorkloadSensitivity.majorDocumentOperationsPerProject
  : cfg.projectWorkloadSensitivity.independentTasksPerProject[t.id] ?? 0]));
const projectTaskCount = sum(Object.values(projectVector));
const projectFace = sum(tasks.map(t => projectVector[t.id] * t.points / 100));
const legacyTaskCount = sum(tasks.map(t => t.frequencyPerBilledPersonMonth));
const legacyFace = sum(tasks.map(t => t.frequencyPerBilledPersonMonth * t.points / 100));
const planRatios = { topup: 1, ...Object.fromEntries(old.funding.plans.map(p => [p.id, p.paidFen / p.points])) };
const considerationRatio = sum(Object.entries(old.funding.mainConsumedPointsWeights).map(([id, weight]) =>
  weight * planRatios[id]));
const revenueRatio = considerationRatio * (1 - old.refundRate) / (1 + old.tax.vat);
const sumFields = ['newRegistrations', 'firstPayers', 'retainedPayerMonths', 'activePayerMonths',
  'projectEquivalents', 'originalTaskEquivalents', 'fullReviewEquivalents', 'grossFace',
  'bonusReleased', 'bonusUsed', 'consumedPaidConsideration', 'refundProvision', 'netRevenue',
  'resourceRequirement', 'supportRequirement', 'resourceUnusedBudgetPressure', 'supportUnusedBudgetPressure',
  'paymentFee', 'taxSurcharge', 'fullReviewCostRequirement', 'contingencyUnusedBudgetPressure',
  'fixedOtherBudgetPressure', 'operatingCostIncludingSurcharge', 'profitBeforeIncomeTax', 'incomeTax',
  'operatingNetProfit', 'historicalRecovery', 'afterRecovery'];
const aggregate = rows => {
  const r = Object.fromEntries(sumFields.map(key => [key, sum(rows.map(x => x[key]))]));
  r.operatingNetMargin = r.netRevenue ? r.operatingNetProfit / r.netRevenue : null;
  r.afterRecoveryMargin = r.netRevenue ? r.afterRecovery / r.netRevenue : null;
  r.netRevenuePerRetainedPayerMonth = r.retainedPayerMonths ? r.netRevenue / r.retainedPayerMonths : null;
  return r;
};

function cohort(scenario, { laterRegistrations = 0, firstThousandArePaid = false } = {}) {
  const registrations = Array.from({ length: 24 }, (_, i) =>
    i < 6 ? cfg.acquisition.first6Months[i] : laterRegistrations);
  let previous = 0;
  const rows = registrations.map((newRegistrations, i) => {
    let firstPayers = 0;
    for (let lag = 0; lag < cfg.acquisition.conversionLagShares.length; lag++) {
      const j = i - lag;
      if (j < 0 || (firstThousandArePaid && j < 6)) continue;
      firstPayers += registrations[j] * scenario.registeredToFirstPaid * cfg.acquisition.conversionLagShares[lag];
    }
    if (firstThousandArePaid && i < 6) firstPayers += newRegistrations;
    const returningRetained = previous * scenario.monthlyPaidRelationshipRetention;
    const retainedPayerMonths = returningRetained + firstPayers;
    const activePayerMonths = firstPayers + returningRetained * scenario.taskActiveShareOfRetainedPaid;
    previous = retainedPayerMonths;
    return { month: i + 1, newRegistrations, firstPayers, returningRetained,
      retainedPayerMonths, activePayerMonths };
  });
  return rows;
}

function simulate(scenario, options = {}) {
  const {
    workload = 'project', annualProjects = scenario.annualProjectsPerRetainedPayer,
    laterRegistrations = 0, firstThousandArePaid = false, priceMultiplier = 1,
    resourceRateMultiplier = 1, supportRateMultiplier = 1, fullReviewFrequency = 0,
    includeChecksPerProject = projectVector.check, retainUnusedBudget = true
  } = options;
  const vector = { ...projectVector, check: includeChecksPerProject };
  const facePerProject = sum(tasks.map(t => vector[t.id] * t.points / 100));
  const tasksPerProject = sum(Object.values(vector));
  const rows = cohort(scenario, { laterRegistrations, firstThousandArePaid });
  let bonusCarry = 0;
  for (const row of rows) {
    row.projectEquivalents = workload === 'project' ? row.retainedPayerMonths * annualProjects / 12 : 0;
    row.originalTaskEquivalents = workload === 'project'
      ? row.projectEquivalents * tasksPerProject : row.activePayerMonths * legacyTaskCount;
    row.fullReviewEquivalents = row.activePayerMonths * fullReviewFrequency;
    row.grossFace = ((workload === 'project'
      ? row.projectEquivalents * facePerProject : row.activePayerMonths * legacyFace)
      + row.fullReviewEquivalents * old.fullReview.points / 100) * priceMultiplier;
    row.bonusReleased = cfg.revenue.bonusFaceBudgetCny / 24;
    bonusCarry += row.bonusReleased;
    row.bonusUsed = Math.min(bonusCarry, row.grossFace);
    bonusCarry -= row.bonusUsed;
    row.bonusCarry = bonusCarry;
    row.consumedPaidConsideration = (row.grossFace - row.bonusUsed) * considerationRatio;
    row.refundProvision = row.consumedPaidConsideration * old.refundRate;
    row.netRevenue = (row.consumedPaidConsideration - row.refundProvision) / (1 + old.tax.vat);
    row.resourceRequirement = row.originalTaskEquivalents * resourceUnit * resourceRateMultiplier;
    row.supportRequirement = row.activePayerMonths * supportUnit * supportRateMultiplier;
    // Full-review C_plan includes resource/support assumptions: do not charge it in both proxies above.
    row.fullReviewCostRequirement = row.fullReviewEquivalents * Number(old.fullReview.CPlanCny);
    row.paymentFee = row.consumedPaidConsideration * old.tax.payment;
    row.taxSurcharge = row.netRevenue * old.tax.vat * old.tax.surchargeOnVat;
  }
  const resourceRequirement = sum(rows.map(r => r.resourceRequirement));
  const supportRequirement = sum(rows.map(r => r.supportRequirement));
  const resourceExtra = Math.max(0, resourceRequirement - pools.paidResources);
  const supportExtra = Math.max(0, supportRequirement - pools.paidSupport);
  const paymentAndSurcharge = sum(rows.map(r => r.paymentFee + r.taxSurcharge));
  const addedFullReview = sum(rows.map(r => r.fullReviewCostRequirement));
  const contingencyClaims = resourceExtra + supportExtra + paymentAndSurcharge + addedFullReview;
  const unusedResource = retainUnusedBudget ? Math.max(0, pools.paidResources - resourceRequirement) : 0;
  const unusedSupport = retainUnusedBudget ? Math.max(0, pools.paidSupport - supportRequirement) : 0;
  const unusedContingency = retainUnusedBudget ? Math.max(0, contingency - contingencyClaims) : 0;
  let yearLossOpening = 0, yearPretax = 0, yearTax = 0, cumulative = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    r.resourceUnusedBudgetPressure = unusedResource / 24;
    r.supportUnusedBudgetPressure = unusedSupport / 24;
    r.contingencyUnusedBudgetPressure = unusedContingency / 24;
    r.fixedOtherBudgetPressure = fixedOther / 24;
    r.operatingCostIncludingSurcharge = r.fixedOtherBudgetPressure
      + r.resourceRequirement + r.supportRequirement + r.fullReviewCostRequirement
      + r.resourceUnusedBudgetPressure + r.supportUnusedBudgetPressure
      + r.paymentFee + r.taxSurcharge + r.contingencyUnusedBudgetPressure;
    r.profitBeforeIncomeTax = r.netRevenue - r.operatingCostIncludingSurcharge;
    if (i && i % 12 === 0) {
      yearLossOpening = Math.max(0, yearLossOpening - yearPretax);
      yearPretax = 0; yearTax = 0;
    }
    yearPretax += r.profitBeforeIncomeTax;
    const nextTax = Math.max(0, yearPretax - yearLossOpening) * old.tax.income;
    r.incomeTax = nextTax - yearTax;
    yearTax = nextTax;
    r.operatingNetProfit = r.profitBeforeIncomeTax - r.incomeTax;
    r.historicalRecovery = historical / 24;
    r.afterRecovery = r.operatingNetProfit - r.historicalRecovery;
    cumulative += r.afterRecovery;
    r.cumulativeAfterRecovery = cumulative;
    r.actualCashReceipts = null;
    r.actualProfit = null;
    r.subscriptionCount = null;
  }
  const total = aggregate(rows);
  return { id: scenario.id, label: scenario.label, scenario, options: { workload, annualProjects,
    laterRegistrations, firstThousandArePaid, priceMultiplier, resourceRateMultiplier, supportRateMultiplier,
    fullReviewFrequency, includeChecksPerProject, retainUnusedBudget }, monthly: rows,
    year1: aggregate(rows.slice(0, 12)), year2: aggregate(rows.slice(12)), total,
    cohortSummary: { registrations: total.newRegistrations, firstPayers: total.firstPayers,
      retainedPayersAtM6: rows[5].retainedPayerMonths, retainedPayersAtM12: rows[11].retainedPayerMonths,
      retainedPayersAtM24: rows[23].retainedPayerMonths, activePayersAtM24: rows[23].activePayerMonths,
      twelveMonthPaidRelationshipRetention: scenario.monthlyPaidRelationshipRetention ** 12 },
    costBridge: { operatingEnvelope, resourceRequirement, supportRequirement, resourceExtra, supportExtra,
      paymentAndSurcharge, addedFullReview, contingency, contingencyClaims,
      contingencyUnused: Math.max(0, contingency - contingencyClaims),
      excessBeyondEnvelope: retainUnusedBudget ? Math.max(0, contingencyClaims - contingency) : null,
      omittedUnspentCapacityCny: retainUnusedBudget ? 0
        : Math.max(0, pools.paidResources - resourceRequirement)
          + Math.max(0, pools.paidSupport - supportRequirement) + Math.max(0, contingency - contingencyClaims) },
    endingBonusFace: bonusCarry, cashFundingPeak: null, cashPaybackMonth: null };
}

const main = cfg.scenarios.map(s => simulate(s));
const baseScenario = cfg.scenarios.find(s => s.id === 'base');
const base = main.find(r => r.id === 'base');
const legacy = cfg.scenarios.map(s => simulate(s, { workload: 'legacy' }));
const growth = cfg.acquisition.newRegistrationSensitivityPerMonth.map(laterRegistrations =>
  simulate(baseScenario, { laterRegistrations }));
const projectSensitivity = cfg.projectWorkloadSensitivity.annualProjectsPerRetainedPayer.map(annualProjects =>
  simulate(baseScenario, { annualProjects }));
const dynamicSensitivity = cfg.budget.dynamicSensitivity.costRateMultipliers.flatMap(multiplier => [
  { changed: 'resources_only', multiplier, result: simulate(baseScenario, { resourceRateMultiplier: multiplier }) },
  { changed: 'support_only', multiplier, result: simulate(baseScenario, { supportRateMultiplier: multiplier }) },
  { changed: 'both', multiplier, result: simulate(baseScenario,
    { resourceRateMultiplier: multiplier, supportRateMultiplier: multiplier }) }
]);
const fullReviewSensitivity = cfg.fullReviewSensitivityFrequenciesPerActivePayerMonth.map(fullReviewFrequency =>
  simulate(baseScenario, { fullReviewFrequency }));
const checkScopeSensitivity = [0, 1, 2, 4].map(includeChecksPerProject => simulate(baseScenario, { includeChecksPerProject }));
const unusedCapacitySensitivity = main.map(r => simulate(r.scenario, { retainUnusedBudget: false }));
// The user confirmed registrations, so this is only a contrastive theoretical bound, not a forecast.
const alreadyPaidUpperBound = simulate(baseScenario, { firstThousandArePaid: true });
const objectives = [
  { id: 'operating_break_even', label: '税后经营保本', margin: 0, recovery: false },
  { id: 'recovery_break_even', label: '完成历史回收后保本', margin: 0, recovery: true },
  { id: 'operating_margin_60', label: '税后经营净利率60%', margin: 0.6, recovery: false },
  { id: 'recovery_margin_60', label: '历史回收后余量率60%', margin: 0.6, recovery: true }
];
function solvePrice(scenario, objective) {
  const metric = r => (objective.recovery ? r.total.afterRecovery : r.total.operatingNetProfit)
    - objective.margin * r.total.netRevenue;
  let lo = 0, hi = 1;
  while (metric(simulate(scenario, { priceMultiplier: hi })) < 0 && hi < 1024) hi *= 2;
  assert(hi < 1024, 'Target not reached inside diagnostic range');
  for (let i = 0; i < 75; i++) {
    const mid = (lo + hi) / 2;
    if (metric(simulate(scenario, { priceMultiplier: mid })) < 0) lo = mid; else hi = mid;
  }
  const r = simulate(scenario, { priceMultiplier: hi });
  near(scenario.id + ' target residual ' + objective.id, metric(r), 0, 0.0001);
  return { scenarioId: scenario.id, ...objective, priceMultiplier: hi,
    projectFaceCnyAtThreshold: projectFace * hi, requiredNetRevenueCny: r.total.netRevenue,
    requiredOperatingCostCny: r.total.operatingCostIncludingSurcharge,
    heldDemand: { firstPayers: r.total.firstPayers, projectEquivalents: r.total.projectEquivalents },
    note: 'Hold actual project volume and conversions fixed only for a mathematical boundary; not a price change or demand forecast.' };
}
const thresholds = cfg.scenarios.flatMap(s => objectives.map(o => solvePrice(s, o)));

near('confirmed first six months sum', sum(cfg.acquisition.first6Months), 1000);
near('confirmed budget operating bridge', operatingEnvelope, 2002300);
near('proposed pools sum to envelope', sum(Object.values(pools)), operatingEnvelope);
near('conversion lag sums to one', sum(cfg.acquisition.conversionLagShares), 1);
near('legacy exact basket', legacyFace, 345.1492);
near('legacy major document annual rate', majorFrequency * 12, 2.46);
near('mutually exclusive major SKUs sum to one', sum(majorIds.map(id => projectVector[id])), 1);
near('project task count', projectTaskCount, 16.5);
const allResults = [...main, ...legacy, ...growth, ...projectSensitivity, ...fullReviewSensitivity,
  ...checkScopeSensitivity, ...unusedCapacitySensitivity, alreadyPaidUpperBound, ...dynamicSensitivity.map(x => x.result)];
for (const [index, r] of allResults.entries()) {
  const label = 'case' + index;
  near(label + ' revenue recognition', r.total.netRevenue,
    (r.total.grossFace - r.total.bonusUsed) * revenueRatio);
  near(label + ' gift conservation', r.total.bonusUsed + r.endingBonusFace, cfg.revenue.bonusFaceBudgetCny);
  near(label + ' management bridge', r.total.afterRecovery, r.total.operatingNetProfit - historical);
  if (r.options.retainUnusedBudget) near(label + ' contingency and capacity counted once',
    r.total.operatingCostIncludingSurcharge,
    operatingEnvelope + Math.max(0, r.costBridge.contingencyClaims - contingency));
  near(label + ' independent annual tax', r.total.incomeTax,
    Math.max(0, r.year1.profitBeforeIncomeTax) * old.tax.income
    + Math.max(0, r.year2.profitBeforeIncomeTax - Math.max(0, -r.year1.profitBeforeIncomeTax)) * old.tax.income);
  for (const k of sumFields) near(label + ' yearly sum ' + k, r.total[k], r.year1[k] + r.year2[k]);
  for (const row of r.monthly) {
    assert(row.activePayerMonths <= row.retainedPayerMonths + 1e-9);
    assert(row.activePayerMonths + 1e-9 >= row.firstPayers);
    near(label + ' monthly pnl ' + row.month, row.netRevenue - row.operatingCostIncludingSurcharge
      - row.incomeTax - row.historicalRecovery, row.afterRecovery);
    assert(row.actualCashReceipts === null && row.subscriptionCount === null);
  }
  if (!r.options.laterRegistrations) near(label + ' one acquisition of 1000',
    r.total.firstPayers, r.options.firstThousandArePaid ? 1000 : 1000 * r.scenario.registeredToFirstPaid);
}
for (const r of main) {
  near(r.id + ' all project coverage without extra activity haircut',
    r.total.projectEquivalents, r.total.retainedPayerMonths * r.scenario.annualProjectsPerRetainedPayer / 12);
  near(r.id + ' full vector gross', r.total.grossFace, r.total.projectEquivalents * projectFace);
}
const snapshot = {
  asOf: cfg.asOf, status: cfg.status, inputSha256: hash(bytes), sourceHashes,
  budget: { managementEnvelope: cfg.userConfirmed.managementBudget24MonthsCny,
    operatingEnvelope, historicalRecovery: historical, proposedPools: pools },
  unitEconomics: { considerationRatio, revenueRatio, legacyFace, legacyTaskCount, majorFrequency,
    projectVector, projectTaskCount, projectFace, resourceUnitCostProxy: resourceUnit,
    supportUnitCostProxy: supportUnit, actualDeepSeekCost: null },
  main, legacy, growth, projectSensitivity, dynamicSensitivity, fullReviewSensitivity,
  checkScopeSensitivity, unusedCapacitySensitivity, alreadyPaidUpperBound, thresholds,
  checks: { count: checks.length, failures: 0, names: checks }
};
const wan = n => (n / 10000).toFixed(2);
const num = n => n.toFixed(2);
const pct = n => (n * 100).toFixed(2) + '%';
const money = n => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const table = (headers, rows) => ['|' + headers.join('|') + '|',
  '|' + headers.map(() => '---').join('|') + '|', ...rows.map(r => '|' + r.join('|') + '|')].join('\n');
const lines = [
  '# BondBuddy：245.85万元预算与首批1,000用户的24个月重算', '',
  '2026-10-30｜条件测算，非成交、留存、成本实测或盈利承诺。M1是计划启动月；当前12项价表、订阅和产品代码均未修改。旧20261029模型原样保留。', '',
  '**用户已确认：前6个月获得1,000位注册/激活用户，付费率另算；24个月245.85万元包含45.62万元历史研发回收，经营预算为200.23万元。** 不再把1,000位用户全部视为付费，也不继续沿用原304.46万元总预算。', '',
  '在下面可审阅的项目工作量假设下，24个月保守/基准/乐观税后经营净利分别为'
    + main.map(r => wan(r.total.operatingNetProfit)).join('／') + '万元，经营净利率分别为'
    + main.map(r => pct(r.total.operatingNetMargin)).join('／') + '；历史回收后余量分别为'
    + main.map(r => wan(r.total.afterRecovery)).join('／') + '万元。**基准情景是否盈利与60%目标分别判断；没有从目标倒推用户数。**', '',
  '## 1. 已知条件与模型假设分开', '',
  table(['项目', '本轮采用', '证据'], [
    ['前6月新增用户', '1,000注册/激活，分月100/150/150/200/200/200', '总数用户确认；月形状为展示假设'],
    ['M7—M24新增', '主表0', '不把未给出的持续增长编入主表'],
    ['24月完整管理预算', '245.85万元，含历史45.62万元', '用户确认'],
    ['经营预算分项', '200.23万元内重新分池', '建议额度；见同目录《预算拆分与执行约束》'],
    ['每年项目量', '5／10／20', '来自用户5—20项目范围；与三情景的组合是新增条件'],
    ['项目使用覆盖', '100%', '按用户工作定位；只对已留存付费用户的项目计入'],
    ['每项目任务', '16.5项等价，标价' + money(projectFace) + '元', '下文逐项给出可审阅假设，尚无真实订单证据'],
    ['付费/留存/活跃', '三情景显式参数', '无实证，不称行业基准或预测概率'],
    ['DeepSeek成本', '没有新增实测', '本轮不调用API；动态成本沿预算容量作压力']
  ]), '',
  '预算拆分见[预算拆分与执行约束](预算拆分与执行约束.md)。245.85万元是允许支出的经营/管理预算；未启用、未实际发生的额度不是实际费用。主表为“预算全部发生”的压力视角，假设保留额度都用于可扣除经营支出；不能将一笔未花准备金直接作税前扣除。', '',
  '## 2. 从日常项目任务构造收入', '',
  '一份项目主文档作业在六类SKU中只选择一种；本次用旧任务组合归一作为群体分布，平均'
    + money(sum(majorIds.map(id => projectVector[id] * taskById[id].points / 100)))
    + '元/项目。两年补更、三年补更、迁移和首稿的真实占比尚未验证；不能同一个主文档同时收六项费用。', '',
  table(['任务', '单项标价元', '每项目等价次数', '每项目标价贡献元', '旧每活跃月次数'],
    tasks.map(t => [t.label, money(t.points / 100), projectVector[t.id].toFixed(4),
      money(projectVector[t.id] * t.points / 100), t.frequencyPerBilledPersonMonth.toString()])), '',
  '正常项目示例：1份主文档＋2份关联文件＋1份独立说明性底稿＋平均0.5次诚信核查＋10道独立问题回复＋2次独立一致性检查。10题可理解为两轮各5题，0.5次核查表示主体信息跨项目复用后的平均新需求。额外两次检查必须来自用户单独委托的新版本或独立范围；父任务自检、失败重跑、同范围修复、已经包含的维护权益均不新增收费。', '',
  '全面复核不强行加入销量；其27,195积分价格已保留，另列0.05／0.10／0.20次每活跃付费人月敏感性。是否需要逐份人工签认不是本模型的免费隐含承诺。', '',
  '当前旧篮子345.1492元、7.005项/活跃月，其中六类主文档作业只有0.205次/月，即全年每月都活跃也仅2.46次；这不能无解释代表一年5—20个项目全部使用。新主表以项目为起点：5／10／20项目对应每年'
    + cfg.projectWorkloadSensitivity.annualProjectsPerRetainedPayer.map(n => money(n * projectFace)).join('／')
    + '元标价需求。其余扣减来自订阅对价、实际赠额和售后准备，不能把标价需求等同于实际年付费承诺。', '',
  '年项目量按“留存付费人月×年项目量÷12”折算；有任务月份的比例只影响集中度与支持用量，**不再乘一次活跃率减少全年项目数**。这是100%项目覆盖；不会恢复35%的项目采纳折扣。', '',
  '## 3. 三种付费与使用条件', '',
  table(['条件', '注册→首次付费', '月付费关系留存', '对应12月留存', '返访用户有任务月份比例', '年项目'],
    cfg.scenarios.map(s => [s.label, pct(s.registeredToFirstPaid), pct(s.monthlyPaidRelationshipRetention),
      pct(s.monthlyPaidRelationshipRetention ** 12), pct(s.taskActiveShareOfRetainedPaid), s.annualProjectsPerRetainedPayer])), '',
  '这些数值是参数范围，不是已核验的行业付费率。首付在注册当月/次月/再次月按60%/30%/10%分布，只转化一次；首次付费当月计为活跃，后续留存用户才乘有任务月份比例。留存指仍可复购的关系，并非自动续订、每月都付费或订阅账户数。停用后不凭空增加复活用户。', '',
  table(['条件', '24月首付用户等价', 'M6留存付费', 'M12留存付费', 'M24留存付费', '24月留存人月', '24月活跃人月', '24月项目等价'],
    main.map(r => [r.label, num(r.total.firstPayers), num(r.cohortSummary.retainedPayersAtM6),
      num(r.cohortSummary.retainedPayersAtM12), num(r.cohortSummary.retainedPayersAtM24),
      num(r.total.retainedPayerMonths), num(r.total.activePayerMonths), num(r.total.projectEquivalents)])), '',
  'M7后没有新增注册，存量逐步流失，第二年收入可能低于第一年。这是用户本轮只确认前6个月获客的结果，不是认定后续无法获客；后续增长另列条件。', '',
  '## 4. 动态成本、机动池与税务口径', '',
  table(['预算内容', '24月万元', '用途'], [
    ['固定基础＋开发＋额外运营/QA/安全＋获客＋推荐', wan(fixedOther), '均建议预算额度，未替用户承诺花满'],
    ['付费资源容量', wan(pools.paidResources), '按任务数量估算资源需求，旧单位参照' + num(resourceUnit) + '元/任务'],
    ['付费支持容量', wan(pools.paidSupport), '按活跃付费人月估算，旧单位参照' + num(supportUnit) + '元/人月'],
    ['共享机动池', wan(contingency), '同时覆盖资源/支持超原容量、支付费、附加税和新增复核成本；只占用一次'],
    ['经营总预算', wan(operatingEnvelope), '支付及附加税在内；不足部分如实列超预算'],
    ['历史研发管理回收', wan(historical), '税后另列，不重复作当期税前费用'],
    ['完整管理预算', wan(operatingEnvelope + historical), '所得税另算']
  ]), '',
  '动态资源参照＝旧6.67万元÷56,598.84任务；支持参照＝旧23.87万元÷8,079.78人月。两者是旧分配预算，不是DeepSeek实际token账单，也不是所有SKU成本相同的证据。项目组合变化后实际资源单位成本可能不同，因此另列资源/支持1.5倍、2倍压力。不能把“更新募集成本几元”的用户经验直接套作全部任务真实成本。', '',
  '主表公式：资源增量=max(0,任务量×资源单位预算−6.67万)；支持增量=max(0,活跃人月×支持单位预算−23.87万)。机动需求＝两项增量＋支付费＋附加税＋独立新增复核成本。完整经营开支＝200.23万＋max(0,机动需求−13.53万)。所有容量及机动池均只计一次，不把资源/支持增量直接加在满额机动池之外。', '',
  '支付费按已履约付费对价×0.6%估算，作为未知现金收款的预算代理；不再乘额外5%。税率沿旧假设：VAT6%、附加=VAT的12%、所得税25%，进项暂0。净收入=(标价消费−已用赠额)×'
    + considerationRatio.toFixed(10) + '×97%÷1.06；97%沿用3%售后收入冲减准备，非新增商业折扣或已观测退款率。赠额票面9.85万元保留，不同时再扣旧赠额履约池；新预算的推荐/机动等费用池承担具体活动支出，需落实归属。', '',
  '前后12个月为两个规划税年，年度亏损向后结转；月所得税列是年度累计应计差额，负值不表示现金退税。实际税务资格与费用可扣除性需按真实账户确定。充值预收、未用积分、过期积分不增加本表收入。', '',
  table(['条件', '资源需求', '支持需求', '资源超容量', '支持超容量', '支付＋附加税', '机动需求', '超完整经营预算', '完整经营开支'],
    main.map(r => [r.label, wan(r.costBridge.resourceRequirement), wan(r.costBridge.supportRequirement),
      wan(r.costBridge.resourceExtra), wan(r.costBridge.supportExtra), wan(r.costBridge.paymentAndSurcharge),
      wan(r.costBridge.contingencyClaims), wan(r.costBridge.excessBeyondEnvelope),
      wan(r.total.operatingCostIncludingSurcharge)])), '',
  '## 5. 年度与24个月利润', '',
  '金额万元；经营净利扣满额经营预算、超预算动态需求与所得税；历史回收后余量再扣45.62万元。此处完整经营开支已经含支付费、附加税，不重复相加。', '',
  table(['条件', '期间', '净收入', '完整经营开支', '所得税', '税后经营净利', '经营净利率', '历史回收后余量'],
    main.flatMap(r => [['year1', '前12月'], ['year2', '后12月'], ['total', '24月']].map(([key, label]) => {
      const v = r[key]; return [r.label, label, wan(v.netRevenue), wan(v.operatingCostIncludingSurcharge),
        wan(v.incomeTax), wan(v.operatingNetProfit), pct(v.operatingNetMargin), wan(v.afterRecovery)];
    }))), ''
];
for (const r of main) {
  lines.push('### ' + r.label + '逐月', '',
    '金额万元；人数、项目及任务为等价量。固定额度及未用容量均分月份；资源和支持需求随模型工作量发生。该分配不能用于推出收款或资金峰值。', '',
    table(['月', '新增注册', '首次付费', '留存付费', '活跃付费', '项目', '任务', '净收入', '完整经营开支', '所得税', '税后经营净利', '回收后累计余量'],
      r.monthly.map(m => [m.month, m.newRegistrations, num(m.firstPayers), num(m.retainedPayerMonths),
        num(m.activePayerMonths), num(m.projectEquivalents), num(m.originalTaskEquivalents),
        wan(m.netRevenue), wan(m.operatingCostIncludingSurcharge), wan(m.incomeTax),
        wan(m.operatingNetProfit), wan(m.cumulativeAfterRecovery)])), '');
}
lines.push('## 6. 同一首批用户，哪些因素真正改变结论', '',
  '### A. 旧篮子与完整项目工作量', '',
  '保持各情景相同付费与留存，旧篮子按活跃月7.005项；新篮子按5／10／20项目年率。两者是不同工作量假设，不是提价。', '',
  table(['条件', '旧篮子净收入', '旧篮子税后经营净利', '新项目模型净收入', '新项目模型税后经营净利'],
    main.map((r, i) => [r.label, wan(legacy[i].total.netRevenue), wan(legacy[i].total.operatingNetProfit),
      wan(r.total.netRevenue), wan(r.total.operatingNetProfit)])), '',
  '### B. 固定基准30%付费、97%月留存，只改变项目量', '',
  table(['年项目', '24月净收入', '完整经营开支', '经营净利', '经营净利率', '历史回收后'],
    projectSensitivity.map(r => [r.options.annualProjects, wan(r.total.netRevenue),
      wan(r.total.operatingCostIncludingSurcharge), wan(r.total.operatingNetProfit),
      pct(r.total.operatingNetMargin), wan(r.total.afterRecovery)])), '',
  '### C. M7以后继续获客的单独条件', '',
  '额外注册不是本轮已确认事实。新增用户仍按基准转化/留存及10项目年率；不新增主表之外的媒体预算，意味着必须在建议40万元获客池及其他已分配运营资源内取得这些注册。若做不到，应增加成本或降低增长。', '',
  table(['M7起月新增注册', '24月总注册', '24月首付', '净收入', '经营开支', '税后经营净利', '净利率', '历史回收后'],
    [base, ...growth].map(r => [r.options.laterRegistrations, num(r.total.newRegistrations),
      num(r.total.firstPayers), wan(r.total.netRevenue), wan(r.total.operatingCostIncludingSurcharge),
      wan(r.total.operatingNetProfit), pct(r.total.operatingNetMargin), wan(r.total.afterRecovery)])), '',
  '### D. 动态单位成本压力', '',
  '固定基准用户、10项目和现价。资源按任务；支持按活跃付费人月分别变化。预算机动余额不足才增加整体成本。', '',
  table(['变化项', '单位预算倍数', '资源需求', '支持需求', '超预算', '税后经营净利', '净利率'],
    dynamicSensitivity.map(s => [({ resources_only: '只变资源', support_only: '只变支持', both: '两项都变' })[s.changed],
      s.multiplier, wan(s.result.costBridge.resourceRequirement), wan(s.result.costBridge.supportRequirement),
      wan(s.result.costBridge.excessBeyondEnvelope), wan(s.result.total.operatingNetProfit),
      pct(s.result.total.operatingNetMargin)])), '',
  '### E. 不把已包含检查重收，全面复核单独加量', '',
  table(['每项目独立检查数', '净收入', '税后经营净利', '历史回收后'],
    checkScopeSensitivity.map(r => [r.options.includeChecksPerProject, wan(r.total.netRevenue),
      wan(r.total.operatingNetProfit), wan(r.total.afterRecovery)])), '',
  '上表0次表示全部必要检查已在其他任务内，2次是主假设，4次只代表额外独立委托需求；不能为了收入把同范围检查改成收费。', '',
  table(['全面复核次/活跃人月', '新增复核等价', '新增规划成本', '24月净收入', '税后经营净利', '历史回收后'],
    fullReviewSensitivity.map(r => [r.options.fullReviewFrequency, num(r.total.fullReviewEquivalents),
      wan(r.total.fullReviewCostRequirement), wan(r.total.netRevenue), wan(r.total.operatingNetProfit),
      wan(r.total.afterRecovery)])), '',
  '全面复核7.5454800512元/次沿本仓库标准成本规划，非实际DeepSeek测量；完整增量成本先占机动。原资源代理没有再按这些复核次数收一次。此压力假定本项支持属于新增工时；若实际已在固定工资或人月支持池覆盖，应重分类并去重，不能重复入账。', '',
  '### F. 未用容量不花掉的比较', '',
  '以下仅不支出资源、支持及共享机动池的未使用额度，其他固定/获客/运营预算仍全额保留；不是实际利润，也没有假设取消获客不影响需求。可用于区分“费用上限”与“实际会发生支出”。', '',
  table(['条件', '未支出的容量/机动', '经营开支', '税后经营净利', '历史回收后'],
    unusedCapacitySensitivity.map(r => [r.label, wan(r.costBridge.omittedUnspentCapacityCny),
      wan(r.total.operatingCostIncludingSurcharge), wan(r.total.operatingNetProfit), wan(r.total.afterRecovery)])), '',
  '## 7. 60%目标边界，不改用户数', '',
  '下表保持基准30%转化、97%月留存、10项目/年及具体项目量不变，仅求未来任务价格同比变化的数学门槛。支付费/附加税随着收入上升，超过机动池后继续计支出。它不证明提价后用户、任务量或成交率保持不变，也不是建议直接改价。', '',
  table(['目标', '所需24月净收入', '对应完整经营开支', '诊断价格倍数', '每项目标价篮子元'],
    thresholds.filter(t => t.scenarioId === 'base').map(t => [t.label, wan(t.requiredNetRevenueCny),
      wan(t.requiredOperatingCostCny), t.priceMultiplier.toFixed(4), money(t.projectFaceCnyAtThreshold)])), '',
  '完整JSON还列出保守、乐观在各自已明示需求条件下的门槛。主表的用户数来自首批1,000注册和付费假设；门槛计算绝不反过来修改首付率、留存或任务量。', '',
  '基准的不足应同时检查：真实首付是否达到30%；每位仍在使用的付费人员一年是否真的完成10个项目；每项目约808.81元的独立交付是否被需要且愿意支付；单次回复/检查是否超出或重复父任务权益；支持工时和资源消耗是否在容量内；建议获客和运营额度是否需要启动。若用户拒绝价格或任务量较少，应承认收入条件未成立，不能靠积分过期、自动扣费或重复计收补齐。', '',
  '## 8. 复算及边界', '',
  '运行 node docs/finance/subscription-20261030/calculate.mjs，只读取冻结来源并生成同目录results.json和本文。输入与旧文件SHA-256保存在结果中。'
    + '本次完成' + checks.length + '项校验、0失败：首批只获客一次、首付不重复、项目量不额外打活跃折扣、预算/机动只计一次、积分对价及赠额守恒、月/年/累计损益、年度亏损结转与门槛残差。', '',
  '模型输出小数表示期望量，不是半个人或半笔实际订单。缺少真实收款、续订、税務身份、token账单和支出节奏，因此现金收入、订阅人数、现金峰值、现金回本月份与实际净利润均未制造。首批1,000已付费的理论对照只留在JSON中，用户已确认注册口径，不能把该上界用于主结论。', ''
);
fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(snapshot, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '24个月项目驱动测算.md'), lines.join('\n'));
console.log(JSON.stringify({
  projectFace, projectTaskCount, operatingEnvelope, resourceUnit, supportUnit,
  main: main.map(r => ({ id: r.id, firstPayers: r.total.firstPayers, retainedPersonMonths: r.total.retainedPayerMonths,
    activePersonMonths: r.total.activePayerMonths, projects: r.total.projectEquivalents,
    revenueWan: r.total.netRevenue / 10000, operatingCostWan: r.total.operatingCostIncludingSurcharge / 10000,
    netProfitWan: r.total.operatingNetProfit / 10000, netMargin: r.total.operatingNetMargin,
    afterRecoveryWan: r.total.afterRecovery / 10000, costBridge: r.costBridge })),
  baseThresholds: thresholds.filter(t => t.scenarioId === 'base'), checks: checks.length
}, null, 2));
