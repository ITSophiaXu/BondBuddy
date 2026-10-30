import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Conditional finance model only. Does not import or change product pricing.
const dir = path.dirname(fileURLToPath(import.meta.url));
const inputBytes = fs.readFileSync(path.join(dir, 'inputs.json'));
const cfg = JSON.parse(inputBytes.toString('utf8'));
const sum = values => values.reduce((a, b) => a + b, 0);
const checks = [];
const near = (name, actual, expected, tolerance = 0.00001) => {
  assert(Math.abs(actual - expected) <= tolerance, `${name}: ${actual} != ${expected}`);
  checks.push(name);
};
const normalize = (values, target) => values.map(x => x / sum(values) * target);
const reconcileMoney = (values, target) => {
  const raw = values.map(x => x * 10000);
  const adjustment = (target - sum(raw)) / raw.length;
  assert(Math.abs(adjustment) <= 50 + 1e-8, 'Source rounding adjustment exceeds 50 CNY');
  return raw.map(x => x + adjustment);
};
const people = normalize(cfg.monthlySource.billedPersonMonths, cfg.sourceTotals.billedPersonMonths);
const tasks = normalize(cfg.monthlySource.tasks, cfg.sourceTotals.tasks);
const bonuses = normalize(cfg.monthlySource.bonusFace, cfg.bonusPolicy.facePlanTotalCny);
const pools = Object.fromEntries(Object.entries(cfg.budgetPools).map(([k, total]) =>
  [k, reconcileMoney(cfg.monthlySource.poolShapes[k], total)]));
const frequency = sum(cfg.tariff.tasks.map(t => t.frequencyPerBilledPersonMonth));
const basket = sum(cfg.tariff.tasks.map(t => t.frequencyPerBilledPersonMonth * t.points / 100));
const plans = Object.fromEntries(cfg.funding.plans.map(p => [p.id, p]));
const ratios = { topup: 1, ...Object.fromEntries(cfg.funding.plans.map(p => [p.id, p.paidFen / p.points])) };
const fundingRatio = weights => {
  near('funding weights sum to one', sum(Object.values(weights)), 1, 1e-12);
  assert(Object.entries(weights).every(([id, weight]) => id in ratios && weight >= 0));
  return sum(Object.entries(weights).map(([id, weight]) => ratios[id] * weight));
};
const fields = ['personMonths', 'originalTaskEquivalents', 'fullReviewEquivalents', 'grossFace',
  'bonusPlan', 'bonusUsed', 'paidFace', 'consumedPaidConsideration', 'refunds', 'netRevenue',
  ...Object.keys(cfg.budgetPools).filter(k => k !== 'historicalRecovery'),
  'fullReviewCostBudget', 'paymentFeeBudget', 'operatingCosts', 'taxSurcharge',
  'operatingProfitBeforeTax', 'incomeTax', 'operatingNetProfit', 'historicalRecovery', 'afterRecovery'];
const summarize = rows => {
  const output = Object.fromEntries(fields.map(k => [k, sum(rows.map(r => r[k]))]));
  output.operatingNetMargin = output.netRevenue ? output.operatingNetProfit / output.netRevenue : null;
  output.afterRecoveryMargin = output.netRevenue ? output.afterRecovery / output.netRevenue : null;
  return output;
};

function simulate({ id = 'base', label = '基准条件', demandScale = 1, taskScale = 1,
  priceMultiplier = 1, fullReviewFrequency = 0, weights = cfg.funding.mainConsumedPointsWeights } = {}) {
  const ratio = fundingRatio(weights);
  const monthly = [];
  let bonusCarry = 0, yearLossOpening = 0, yearPbt = 0, yearTax = 0, cumulative = 0;
  for (let i = 0; i < 24; i++) {
    if (i && i % 12 === 0) {
      yearLossOpening = Math.max(0, yearLossOpening - yearPbt);
      yearPbt = 0; yearTax = 0;
    }
    const personMonths = people[i] * demandScale;
    const originalTaskEquivalents = tasks[i] * demandScale * taskScale;
    const fullReviewEquivalents = personMonths * fullReviewFrequency;
    const grossFace = (originalTaskEquivalents / frequency * basket
      + fullReviewEquivalents * cfg.fullReview.points / 100) * priceMultiplier;
    bonusCarry += bonuses[i];
    const bonusUsed = Math.min(bonusCarry, grossFace);
    bonusCarry -= bonusUsed;
    const paidFace = grossFace - bonusUsed;
    const consumedPaidConsideration = paidFace * ratio;
    const refunds = consumedPaidConsideration * cfg.refundRate;
    const netRevenue = (consumedPaidConsideration - refunds) / (1 + cfg.tax.vat);
    const budget = Object.fromEntries(Object.keys(cfg.budgetPools).map(k => [k, pools[k][i]]));
    const paidPoolScale = Math.max(1, demandScale * taskScale);
    budget.paidResources *= paidPoolScale;
    budget.paidServices *= paidPoolScale;
    const fullReviewCostBudget = fullReviewEquivalents * Number(cfg.fullReview.CPlanCny);
    const paymentFeeBudget = consumedPaidConsideration * cfg.tax.payment * (1 + cfg.reserveRate);
    const operatingCosts = sum(Object.entries(budget).filter(([k]) => k !== 'historicalRecovery').map(([, v]) => v))
      + fullReviewCostBudget + paymentFeeBudget;
    const taxSurcharge = netRevenue * cfg.tax.vat * cfg.tax.surchargeOnVat;
    const operatingProfitBeforeTax = netRevenue - operatingCosts - taxSurcharge;
    yearPbt += operatingProfitBeforeTax;
    const taxYtd = Math.max(0, yearPbt - yearLossOpening) * cfg.tax.income;
    const incomeTax = taxYtd - yearTax;
    yearTax = taxYtd;
    const operatingNetProfit = operatingProfitBeforeTax - incomeTax;
    const afterRecovery = operatingNetProfit - budget.historicalRecovery;
    cumulative += afterRecovery;
    monthly.push({ month: i + 1, personMonths, originalTaskEquivalents, fullReviewEquivalents,
      grossFace, bonusPlan: bonuses[i], bonusUsed, bonusCarry, paidFace, consumedPaidConsideration,
      refunds, netRevenue, ...budget, fullReviewCostBudget, paymentFeeBudget, operatingCosts,
      taxSurcharge, operatingProfitBeforeTax, incomeTax, operatingNetProfit, afterRecovery,
      cumulativeAfterRecovery: cumulative, actualNetProfit: null, cashReceipts: null,
      subscriberCount: null, unusedPaidBalance: null });
  }
  const result = { id, label, demandScale, taskScale, priceMultiplier, fullReviewFrequency, weights,
    paidPointConsiderationRatio: ratio, monthly, year1: summarize(monthly.slice(0, 12)),
    year2: summarize(monthly.slice(12)), total: summarize(monthly),
    endingUnusedBonusFace: bonusCarry, firstOperatingProfitMonth: monthly.find(r => r.operatingNetProfit > 0)?.month ?? null,
    firstCumulativeRecoveryMonth: monthly.find(r => r.cumulativeAfterRecovery >= 0)?.month ?? null };
  return result;
}

const main = cfg.scenarios.map(s => simulate(s));
const base = main.find(s => s.id === 'base');
const fundingSensitivity = [];
for (const mix of ['light', 'professional', 'intensive', 'blend']) {
  for (const share of cfg.funding.consumedSubscriptionShares) {
    const weights = { topup: 1 - share };
    if (mix === 'blend') {
      for (const [id, weight] of Object.entries(cfg.funding.withinSubscriptionBlend)) weights[id] = share * weight;
    } else weights[mix] = share;
    const r = simulate({ id: `${mix}-${share}`, weights });
    fundingSensitivity.push({ mix, consumedSubscriptionShare: share, weights,
      considerationRatio: r.paidPointConsiderationRatio, total: r.total });
  }
}
const fullReviewSensitivity = cfg.fullReview.sensitivityFrequencies.map(fullReviewFrequency => {
  const r = simulate({ id: `full-review-${fullReviewFrequency}`, fullReviewFrequency });
  return { frequencyPerPersonMonth: fullReviewFrequency, total: r.total,
    addedGrossFace: r.total.grossFace - base.total.grossFace,
    addedCostBudget: r.total.fullReviewCostBudget,
    addedAfterRecovery: r.total.afterRecovery - base.total.afterRecovery };
});

const objectives = [
  { id: 'operating_break_even', label: '税后经营保本', metric: r => r.total.operatingNetProfit },
  { id: 'recovery_break_even', label: '完成历史回收后保本', metric: r => r.total.afterRecovery },
  { id: 'operating_margin_60', label: '税后经营净利率60%', metric: r => r.total.operatingNetProfit - .6 * r.total.netRevenue },
  { id: 'recovery_margin_60', label: '历史回收后余量率60%', metric: r => r.total.afterRecovery - .6 * r.total.netRevenue },
];
const solve = (variable, objective) => {
  let lo = 1, hi = 2;
  while (objective.metric(simulate({ [variable]: hi })) < 0 && hi < 1024) hi *= 2;
  if (objective.metric(simulate({ [variable]: hi })) < 0) return null;
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    if (objective.metric(simulate({ [variable]: mid })) < 0) lo = mid; else hi = mid;
  }
  const r = simulate({ [variable]: hi });
  return { factor: hi, referenceBasketCny: basket * hi, total: r.total,
    interpretation: variable === 'priceMultiplier' ? 'Continuous future price diagnostic, not a new tariff'
      : 'Same people; proportional NEW independent tasks, with paid delivery costs scaled; not more internal steps' };
};
const thresholds = objectives.map(o => ({ id: o.id, label: o.label,
  price: solve('priceMultiplier', o), tasks: solve('taskScale', o) }));

// Independent aggregate identities. These do not reuse the monthly tax loop.
near('new basket', basket, 345.1492, 1e-9);
near('original frequency', frequency, 7.005, 1e-12);
near('normalized source people', sum(people), 8079.78);
near('normalized source tasks', sum(tasks), 56598.84);
near('approved media includes reserve exactly once', sum(pools.media), 1323000);
near('approved promotion cost retained', sum(pools.promoFulfillment), 222600);
near('approved historic recovery retained', sum(pools.historicalRecovery), 456200);
for (const result of main) {
  near(`${result.id}: gross from whole task vector`, result.total.grossFace,
    cfg.sourceTotals.tasks * result.demandScale * basket / frequency);
  near(`${result.id}: bonus conservation`, result.total.bonusUsed + result.endingUnusedBonusFace, 98500);
  near(`${result.id}: recognized revenue bridge`, result.total.netRevenue,
    (result.total.grossFace - result.total.bonusUsed) * result.paidPointConsiderationRatio * .97 / 1.06);
  const nonHistory = sum(Object.entries(cfg.budgetPools).filter(([k]) => k !== 'historicalRecovery')
    .map(([k, v]) => ['paidResources', 'paidServices'].includes(k) ? v * Math.max(1, result.demandScale) : v));
  near(`${result.id}: full budget preservation`, result.total.operatingCosts - result.total.paymentFeeBudget, nonHistory);
  const y1pbt = result.year1.operatingProfitBeforeTax;
  const y2pbt = result.year2.operatingProfitBeforeTax;
  const taxIndependent = Math.max(0, y1pbt) * cfg.tax.income
    + Math.max(0, y2pbt - Math.max(0, -y1pbt)) * cfg.tax.income;
  near(`${result.id}: independent annual loss carryforward`, result.total.incomeTax, taxIndependent);
  near(`${result.id}: full management bridge`, result.total.afterRecovery,
    result.total.netRevenue - nonHistory - result.total.paymentFeeBudget
      - result.total.taxSurcharge - taxIndependent - cfg.budgetPools.historicalRecovery);
  for (const key of fields) near(`${result.id}: years sum ${key}`, result.total[key], result.year1[key] + result.year2[key]);
  for (const row of result.monthly) {
    near(`${result.id}: month ${row.month} P&L`, row.netRevenue - row.operatingCosts - row.taxSurcharge
      - row.incomeTax - row.historicalRecovery, row.afterRecovery);
    assert(row.bonusUsed >= 0 && row.bonusUsed <= row.grossFace + 1e-9);
    assert(row.actualNetProfit === null && row.cashReceipts === null && row.subscriberCount === null);
  }
}
const a = (1 - cfg.refundRate) / (1 + cfg.tax.vat);
const revenueLeak = cfg.tax.payment * (1 + cfg.reserveRate) / a + cfg.tax.vat * cfg.tax.surchargeOnVat;
const companyCosts = sum(Object.entries(cfg.budgetPools).filter(([k]) => k !== 'historicalRecovery').map(([, v]) => v));
const hist = cfg.budgetPools.historicalRecovery;
const taxKeep = 1 - cfg.tax.income;
const requiredRevenue = [companyCosts / (1 - revenueLeak),
  (companyCosts + hist / taxKeep) / (1 - revenueLeak),
  taxKeep * companyCosts / (taxKeep * (1 - revenueLeak) - .6),
  (taxKeep * companyCosts + hist) / (taxKeep * (1 - revenueLeak) - .6)];
thresholds.forEach((t, i) => {
  const closedFactor = (requiredRevenue[i] / a / base.paidPointConsiderationRatio + 98500) / base.total.grossFace;
  near(`closed-form price threshold ${t.id}`, t.price.factor, closedFactor, 1e-8);
  near(`threshold residual ${t.id}`, objectives[i].metric({ total: t.price.total }), 0, .00001);
});

// Exact rational lot accounting for independent deterministic wallet examples.
const gcd = (a, b) => b ? gcd(b, a % b) : a < 0n ? -a : a;
const R = (n, d = 1n) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (x, y) => R(x.n * y.d + y.n * x.d, x.d * y.d);
const sub = (x, y) => R(x.n * y.d - y.n * x.d, x.d * y.d);
const displayFen = x => ({ exactFen: `${x.n}/${x.d}`, cny: Number(x.n) / Number(x.d) / 100 });
const eq = (label, x, y) => { assert(x.n * y.d === y.n * x.d, label); checks.push(label); };
const dayMs = 24 * 60 * 60 * 1000;

function walletExample(example) {
  const start = new Date(`${cfg.walletExamples.startDate}T00:00:00.000Z`);
  const lots = [], monthly = [];
  let cashFen = 0n, consumedCash = R(0n), expiredCash = R(0n), consumedPoints = 0, expiredPoints = 0;
  let subscriptionCashFen = 0n, topupCashFen = 0n, issuedPoints = 0, subscriptionUsed = 0, subscriptionIssued = 0;
  const addLot = (points, paidFen, now, kind) => {
    const lot = { id: lots.length + 1, kind, originalPoints: points, remainingPoints: points,
      paidFen, issuedAt: now, expiresAt: kind === 'subscription' ? now + 90 * dayMs : null };
    lots.push(lot); issuedPoints += points; cashFen += BigInt(paidFen);
    if (kind === 'subscription') { subscriptionCashFen += BigInt(paidFen); subscriptionIssued += points; }
    else topupCashFen += BigInt(paidFen);
  };
  const expire = now => {
    for (const lot of lots) {
      if (lot.remainingPoints && lot.expiresAt !== null && lot.expiresAt <= now) {
        expiredCash = add(expiredCash, R(BigInt(lot.paidFen) * BigInt(lot.remainingPoints), BigInt(lot.originalPoints)));
        expiredPoints += lot.remainingPoints; lot.remainingPoints = 0;
      }
    }
  };
  for (let i = 0; i < 24; i++) {
    const monthStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1);
    const spendAt = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, cfg.walletExamples.spendDay);
    const monthEnd = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1) - 1;
    const beforeCash = cashFen, beforeConsumed = consumedCash, beforeExpired = expiredPoints;
    expire(monthStart);
    if (example.planId && i < example.subscriptionMonths) {
      const p = plans[example.planId]; addLot(p.points, p.paidFen, monthStart, 'subscription');
    }
    expire(spendAt);
    const demand = (i + 1) % example.spendEveryMonths === 0 ? example.monthlyDemandPoints : 0;
    const available = sum(lots.map(l => l.remainingPoints));
    if (demand > available) addLot(demand - available, demand - available, spendAt, 'topup');
    let needed = demand;
    const allocations = [];
    for (const lot of [...lots].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)
      || a.issuedAt - b.issuedAt || a.id - b.id)) {
      const used = Math.min(needed, lot.remainingPoints);
      if (!used) continue;
      const consideration = R(BigInt(lot.paidFen) * BigInt(used), BigInt(lot.originalPoints));
      consumedCash = add(consumedCash, consideration);
      lot.remainingPoints -= used; needed -= used; consumedPoints += used;
      if (lot.kind === 'subscription') subscriptionUsed += used;
      allocations.push({ lotId: lot.id, source: lot.kind, points: used, consideration: displayFen(consideration) });
    }
    assert(needed === 0, 'Topup covers only this synthetic demand');
    expire(monthEnd);
    const activeCash = lots.reduce((value, lot) => add(value,
      R(BigInt(lot.paidFen) * BigInt(lot.remainingPoints), BigInt(lot.originalPoints))), R(0n));
    const unrecognized = add(activeCash, expiredCash);
    eq(`${example.id} M${i + 1}: cash conservation`, R(cashFen), add(consumedCash, unrecognized));
    assert(issuedPoints === consumedPoints + expiredPoints + sum(lots.map(l => l.remainingPoints)));
    monthly.push({ month: i + 1, calendarMonth: new Date(monthStart).toISOString().slice(0, 7),
      cashReceiptsCny: Number(cashFen - beforeCash) / 100, consumedPoints: demand,
      consumedConsideration: displayFen(sub(consumedCash, beforeConsumed)),
      expiredPoints: expiredPoints - beforeExpired, activeUnusedPoints: sum(lots.map(l => l.remainingPoints)),
      activeUnusedConsideration: displayFen(activeCash), expiredUnrecognizedConsideration: displayFen(expiredCash),
      totalUnrecognizedConsideration: displayFen(unrecognized), allocations });
  }
  const last = monthly.at(-1);
  const fullRedemption = ['payg_full', 'light_full', 'professional_full', 'intensive_full', 'light_quarterly'].includes(example.id);
  if (fullRedemption) {
    eq(`${example.id}: 100% redemption has no residual consideration`, R(cashFen), consumedCash);
    assert(expiredPoints === 0 && last.activeUnusedPoints === 0);
  }
  return { ...example, monthly, total: { cashReceiptsCny: Number(cashFen) / 100,
    subscriptionCashCny: Number(subscriptionCashFen) / 100, topupCashCny: Number(topupCashFen) / 100,
    issuedPoints, consumedPoints, expiredPoints, subscriptionIssued, subscriptionUsed,
    subscriptionRedemptionRate: subscriptionIssued ? subscriptionUsed / subscriptionIssued : null,
    consumedConsideration: displayFen(consumedCash), activeUnusedPoints: last.activeUnusedPoints,
    activeUnusedConsideration: last.activeUnusedConsideration,
    expiredUnrecognizedConsideration: displayFen(expiredCash),
    totalUnrecognizedConsideration: last.totalUnrecognizedConsideration,
    illustrativePaymentFeeOnReceiptsCny: Number(cashFen) / 100 * cfg.tax.payment,
    incrementalExecutionCostCny: null, expiredPointsProfitCny: 0 },
    lots: lots.map(l => ({ ...l, issuedAt: new Date(l.issuedAt).toISOString(),
      expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt).toISOString() })) };
}
const wallets = cfg.walletExamples.cases.map(walletExample);

const result = { asOf: cfg.asOf, status: cfg.status,
  inputSha256: createHash('sha256').update(inputBytes).digest('hex'),
  sourcePrecision: 'Rounded source tables normalized to published totals; not recovery of original exact data.',
  fundingRatios: ratios, basket: { frequency, faceCnyPerPersonMonth: basket,
    taskContributions: cfg.tariff.tasks.map(t => ({ ...t, contributionCny: t.frequencyPerBilledPersonMonth * t.points / 100 })) },
  main, fundingSensitivity, fullReviewSensitivity, thresholds, walletExamples: wallets,
  notForecast: ['subscriber counts', 'renewal cohorts', 'cash receipts in main demand tables',
    'real retention/conversion', 'actual costs/tax status', 'expired-credit profit'],
  checks: { count: checks.length, failures: 0, names: checks } };

const money = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wan = n => (n / 10000).toFixed(2);
const pct = n => `${(n * 100).toFixed(2)}%`;
const fmt = n => n.toFixed(2);
const planLabel = id => ({ topup: '充值', light: '轻量', professional: '专业', intensive: '密集', blend: '60%轻量/30%专业/10%密集' })[id];
const lines = [
  '# BondBuddy 订阅＋充值：24个月条件估算', '',
  '2026-10-29。全部经营数字为预算条件估算，非真实成交、留存、成本、税务或盈利承诺。没有修改产品价表。M1为未来计划启动月；三个需求情景都从M1采用当前11项价格。', '',
  `**当前新价篮子为${money(basket)}元/计收人月，完整精度${basket.toFixed(5)}。基准24个月税后经营净利${wan(base.total.operatingNetProfit)}万元，完成历史回收后余量${wan(base.total.afterRecovery)}万元。** 不能用旧801.41元篮子再乘1.7，也不能从每项任务有毛利推出公司盈利。`, '',
  '## 1. 可复算依据和新增假设', '',
  '- 同目录inputs.json冻结来源路径、SHA-256、原展示月表、认可预算和新价。calculate.mjs同时生成results.json及本文；无需网络或外部依赖。',
  '- 原月表人月合计8079.77，公布8079.78；任务合计56598.84；赠额月表98400元、公布98500元。人月/任务/赠额按比例归一；各费用池尾差均分到24个月，调整保持每格±50元范围。它是预算重建，不是原精确JSON恢复。',
  '- 原R71的获客、转化、留存cohort及2026-10-29成本源配置仍缺失。1575首次付费和7113.81新价人月只保留为旧原稿背景，不据此制造订阅人数或继续套用旧M4发布进度。',
  '- 保守/基准/乐观仅原需求70%/100%/130%兑现，均为条件范围，没有概率或市场预测含义。低需求保留全部认可预算；高需求仅付费资源/服务按max(1,需求倍数)增加，其他池固定。',
  '- 主表新增假设：已消费付费积分中，充值50%、轻量30%、专业15%、密集5%。这是积分消费来源权重，不是订阅采用率或人数。三需求情景采用相同权重，不假定订阅提高任务频次或留存。',
  '- 原11项不含全面复核；主情景全面复核销量为0（未知，而非没有需求）。额外0.05/0.1/0.2次每人月另列，不能从维护、必要自检或父任务修复中重复计收。', '',
  '## 2. 保留预算、收入和税务口径', '',
  '|成本池|24个月万元|准备处理|', '|---|---:|---|',
  ...Object.entries(cfg.budgetPools).map(([k, v]) => `|${({ paidResources:'付费资源及正常损耗',paidServices:'付费支持/服务/存储',promoFulfillment:'赠额独立履约预算',media:'媒体获客',technical:'技术维护及开发/计费改造',operations:'运营/负责人/待命支持/抽样QA',cloudAdminSafety:'固定云/行政/安全',historicalRecovery:'历史投入管理回收' })[k]}|${wan(v)}|${k === 'historicalRecovery' ? '无5%上浮，税后单列' : '已含5%，不再叠加'}|`),
  `|合计，不含支付费/税|${wan(sum(Object.values(cfg.budgetPools)))}|保留认可总额|`, '',
  '媒体132.30万元＝126万元×1.05；赠额履约22.26万元已含准备；历史回收45.62万元无准备。主表假设全部准备实际发生且可税前扣除，不是实际会计结论；未发生准备应保留管理占用并按真实税法调整，不能直接当可扣除费用。', '',
  '赠额票面参考计划合计9.85万元，按月加入可使用余额、以当月任务标价为上限抵扣，未使用结转。本模型不授权发赠额，不套旧10%抵扣帽，也不追加4%折让。22.26万元是另列活动履约预算占用：同一任务若已进入付费任务成本，实际账务不能再列入赠额池；活动归属仍待验证，尚未支出不自动增加本表利润。', '',
  `主表已消费积分的含税对价系数为${base.paidPointConsiderationRatio.toFixed(10)}。公式：已消费付费对价＝(标价消费−实际使用赠额)×来源加权系数；净收入＝对价×97%÷1.06。订阅费不在这份履约收入之上再加一次。`, '',
  '这里的97%＝1−3%。3%沿用用户原稿的售后退款/返还预算，对应inputs.json的refundRate:0.03：按已消费付费对价预留3%的售后收入冲减，再按6%预算税系数换算净收入。它不是新增商业折扣、不是已观测退款率，也不表示系统自动退还3%。实际返还按原任务、原积分批次及原购入对价核算；未开始或失败任务释放冻结、本来就未确认的收入不能再重复冲减。该预算扣减属于本次利润测算条件，不能藏在“净收入”名称中。', '',
  '支付手续费预算以已消费对价按0.6%及既有5%准备归属，是经营预算代理，不是对未知充值现金的测量；未消费预付款的手续费及收款时点无法由这份需求数据得出。独立钱包例按实际模拟收款列示0.6%手续费，不能与主表相加。', '',
  '税率沿原预算：增值税6%、附加为增值税的12%、所得税25%，进项抵扣暂取0；均未经真实税务身份核定。M1—M12与M13—M24作为两个规划纳税年度，年度亏损向后结转；不把月内税额回冲说成现金退税。历史研发按已在以前费用化假设，在税后另扣管理回收，不二次减少税基。', '',
  '主表不生成订阅续订人数、充值到账、未使用付费余额或真实净利，这些字段在JSON中为null。历史真实合同由产品代码保护，与本次未来启动预算没有冲突。', '',
  '## 3. 三种需求条件：年度和24个月结果', '',
  '单位万元。税后经营净利已扣全部经营预算、支付费和预算税；历史回收后余量再扣45.62万元。', '',
  '|情景|期间|净收入|税后经营净利|历史回收后余量|经营净利率|回收后余量率|', '|---|---|---:|---:|---:|---:|---:|',
  ...main.flatMap(r => [['year1','前12月'],['year2','后12月'],['total','24月']].map(([key,label]) => {
    const v=r[key]; return `|${r.label}|${label}|${wan(v.netRevenue)}|${wan(v.operatingNetProfit)}|${wan(v.afterRecovery)}|${pct(v.operatingNetMargin)}|${pct(v.afterRecoveryMargin)}|`;
  })), '',
];
for (const r of main) {
  lines.push(`### ${r.label}逐月表（需求${pct(r.demandScale)}）`, '',
    '金额万元；人月、任务为等价量，不是实际人数/订单。累计列为完成历史回收后的余量。', '',
    '|月|计收人月|任务等价|标价消费|赠额使用|净收入|经营成本含准备|税附加＋所得税|税后经营净利|回收后余量|累计余量|',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...r.monthly.map(m => `|${m.month}|${fmt(m.personMonths)}|${fmt(m.originalTaskEquivalents)}|${wan(m.grossFace)}|${wan(m.bonusUsed)}|${wan(m.netRevenue)}|${wan(m.operatingCosts)}|${wan(m.taxSurcharge+m.incomeTax)}|${wan(m.operatingNetProfit)}|${wan(m.afterRecovery)}|${wan(m.cumulativeAfterRecovery)}|`),
    `|合计|${fmt(r.total.personMonths)}|${fmt(r.total.originalTaskEquivalents)}|${wan(r.total.grossFace)}|${wan(r.total.bonusUsed)}|${wan(r.total.netRevenue)}|${wan(r.total.operatingCosts)}|${wan(r.total.taxSurcharge+r.total.incomeTax)}|${wan(r.total.operatingNetProfit)}|${wan(r.total.afterRecovery)}|${wan(r.total.afterRecovery)}|`, '',
    `首次单月经营盈利：${r.firstOperatingProfitMonth ? `M${r.firstOperatingProfitMonth}` : '24月内未出现'}；完成历史回收后累计转正：${r.firstCumulativeRecoveryMonth ? `M${r.firstCumulativeRecoveryMonth}` : '24月内未出现'}。未兑赠额结转${money(r.endingUnusedBonusFace)}元。`, '');
}
lines.push('## 4. 消费积分来源敏感性', '',
  '固定基准需求和成本，只改变已消费积分来源。0%/25%/50%/75%/100%是消费积分中来自订阅的份额；用户开通订阅不意味着其所有消费都来自订阅，差额充值仍按充值对价。各纯档或混合档独立比较。', '',
  '|订阅来源|订阅消费份额|付费对价系数|24月净收入/万元|税后经营净利/万元|回收后余量/万元|', '|---|---:|---:|---:|---:|---:|',
  ...fundingSensitivity.map(s => `|${planLabel(s.mix)}|${pct(s.consumedSubscriptionShare)}|${s.considerationRatio.toFixed(6)}|${wan(s.total.netRevenue)}|${wan(s.total.operatingNetProfit)}|${wan(s.total.afterRecovery)}|`), '',
  '轻量、专业、密集全部兑完的对价比例分别为199/210、499/550、999/1140。例：345.1492元标价需求使用199元轻量订阅后，210元额度全部用完，再充值135.1492元，合计对价334.1492元；不能把整个篮子都按199/210打折。消费来源比例模型只是一组条件边界，真实购买和90天结转见下方独立钱包例。', '',
  '## 5. 新增全面复核：独立销量敏感性', '',
  '27195积分及C_plan7.5454800512元来自本次另存的规划成本记录，非DeepSeek实测。下表新增频次均无历史证据；完整增量C_plan作预算压力，不暗扣原支持池，实际发生时仍应核对支持归属避免重复成本。', '',
  '|额外次/人月|24月新增任务等价|新增标价收入/万元|新增C_plan预算/万元|24月税后经营净利/万元|回收后余量/万元|', '|---|---:|---:|---:|---:|---:|',
  ...fullReviewSensitivity.map(s => `|${s.frequencyPerPersonMonth}|${fmt(s.total.fullReviewEquivalents)}|${wan(s.addedGrossFace)}|${wan(s.addedCostBudget)}|${wan(s.total.operatingNetProfit)}|${wan(s.total.afterRecovery)}|`), '',
  '## 6. 保本与60%门槛：诊断，不是新的价表或用户预测', '',
  '固定基准人数、人月、原任务组合、优惠来源和认可公司预算。价格列仅连续放大未来任务单价，保持任务量不变；任务列保持原单价和人数，将独立新增任务频次同比增加，并同步增加付费资源/服务预算。两者不能互相当作同一件事，也不能将内部重试、澄清或维护权益计成新增销量。', '',
  '|目标|价格倍数|相应参考篮子/元|独立任务量倍数（付费交付成本同步增）|', '|---|---:|---:|---:|',
  ...thresholds.map(t => `|${t.label}|${t.price.factor.toFixed(4)}|${money(t.price.referenceBasketCny)}|${t.tasks ? t.tasks.factor.toFixed(4) : '给定上限内无法达到'}|`), '',
  `不改变人数和任务量、把所有消费改成无订阅优惠的充值，24月税后经营净利为${wan(fundingSensitivity[0].total.operatingNetProfit)}万元，回收后余量${wan(fundingSensitivity[0].total.afterRecovery)}万元。该比较说明仅取消折扣能改善多少，并不把它推荐为已经验证的定价。`, '',
  '价格杠杆需要验证个人愿付与任务价值；任务杠杆需要真实独立业务机会及复用频次；折扣杠杆影响对价但不能替代需求。媒体获客预算占八池总额43.45%，应同时验证获客产出；本模型没有通过删减认可媒体费用或倒推客户数制造利润。任何门槛成立都依赖本页条件，不能承诺60%。', '',
  '## 7. 六个24个月单用户钱包例：现金、兑换、到期分开', '',
  '这些例子独立于主需求模型，不能相加。例子采用2026-11至2028-10的UTC日历，每月1日购买、15日消费，严格按发放后90×24小时到期、先到期先消费；停止续订不提前删除尚有效的额度。积分额度全兑例是账本层的100%履约压力，不是假装某一真实SKU组合一定逐分用尽。', '',
  '本金在消费时按该lot原现金/原积分比例归属含税对价；充值只补当时缺口，不加赠。到期积分从可用余额移出，其未履约对价单列“到期待会计处理”，本估算不把它确认为利润或可自由支配现金，也不据此承诺可提现。例子没有退款；其未使用余额应与实际合同义务和已确认会计政策对账。', '',
  '|钱包例|24月现金到账/元|已履约含税对价/元|期末有效未用对价/元|到期待处理对价/元|订阅积分兑换率|收款手续费示意/元|', '|---|---:|---:|---:|---:|---:|---:|',
  ...wallets.map(w => `|${w.label}|${money(w.total.cashReceiptsCny)}|${money(w.total.consumedConsideration.cny)}|${money(w.total.activeUnusedConsideration.cny)}|${money(w.total.expiredUnrecognizedConsideration.cny)}|${w.total.subscriptionRedemptionRate === null ? '不适用' : pct(w.total.subscriptionRedemptionRate)}|${money(w.total.illustrativePaymentFeeOnReceiptsCny)}|`), '',
  '全兑情况下，平台必须按完整积分额度履约，不能再以低兑换率减少成本。这里没有经过验证的SKU成本组合，因此单用户实际执行成本保持null；公司任务交付成本已在主预算中保留。这些例子证明积分/对价守恒，不证明长期续订、业务质量或公司盈利。', '');
for (const w of wallets) {
  lines.push(`### 钱包例：${w.label}`, '', '金额元；“待履约/待处理”＝有效未用对价＋到期待会计处理对价。', '',
    '|月|日历月|现金到账|消费积分|已履约含税对价|到期积分|有效积分余额|待履约/待处理对价|', '|---|---|---:|---:|---:|---:|---:|---:|',
    ...w.monthly.map(m => `|${m.month}|${m.calendarMonth}|${money(m.cashReceiptsCny)}|${m.consumedPoints}|${money(m.consumedConsideration.cny)}|${m.expiredPoints}|${m.activeUnusedPoints}|${money(m.totalUnrecognizedConsideration.cny)}|`), '');
}
lines.push('## 8. 复算与验证边界', '',
  '在本目录或任何位置运行：', '', '```sh', 'node docs/finance/subscription-20261029/calculate.mjs', '```', '',
  `脚本执行${checks.length}项记录检查，0失败：核对认可池与归一总数、逐月损益、年度独立亏损结转、总量闭式收入、价格门槛闭式解，以及六例每月BigInt有理数对价与积分守恒。每次重跑覆盖本目录results.json和本文；不修改inputs.json、旧模型或产品配置。`, '',
  '显示值取两位小数；JSON保留模型计算精度，钱包对价另存精确分数。预算的统计精度来自原展示月表，更多小数不是更强证据。实际支付渠道、未用余额收入政策、税务身份、费用归属、真实任务复杂度及用户需求仍需验证。', '');

lines.push('## 9. 经营决策建议', '',
  '保留现价作为收费验证基线，60%净利仍是待验证目标。原需求与预算不变时，参考篮子需达到380.46元才经营保本、467.00元才覆盖历史回收；60%经营净利的条件门槛约1965.12元，不能据此直接涨价或补造用户。先记录每个项目真实独立任务数、购买与拒绝、成功交付、售后返还及支持用时，核验345.15元篮子是否漏掉真实可收费需求或包含重复任务。价格验证比较代表任务的真实购买和复购，不以token便宜代替愿付证据。获客按渠道跟踪投入、首次付费和后续贡献；在保留认可预算的前提下，将后续投放节奏与已实现贡献挂钩。仅取消订阅优惠仍不能保本，应共同验证任务量、价格及获客效率，再调整经营方案。', '');

fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '24个月条件估算.md'), lines.join('\n'));
console.log(JSON.stringify({ basket: result.basket.faceCnyPerPersonMonth,
  fundingRatio: base.paidPointConsiderationRatio,
  scenarios: main.map(r => ({ id: r.id, revenue: r.total.netRevenue, operatingNet: r.total.operatingNetProfit,
    afterRecovery: r.total.afterRecovery, firstOperatingProfitMonth: r.firstOperatingProfitMonth,
    firstCumulativeRecoveryMonth: r.firstCumulativeRecoveryMonth })),
  thresholds: thresholds.map(t => ({ id: t.id, priceFactor: t.price.factor,
    basket: t.price.referenceBasketCny, taskFactor: t.tasks?.factor })),
  wallets: wallets.map(w => ({ id: w.id, cash: w.total.cashReceiptsCny,
    consumed: w.total.consumedConsideration.cny, unrecognized: w.total.totalUnrecognizedConsideration.cny })),
  checks: checks.length }, null, 2));
