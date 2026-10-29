import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Decision bounds only. Reads the frozen main model; never executes its writer
// or changes the approved tariff, budgets, customer counts or demand forecast.
const dir = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceNames = ['inputs.json', 'results.json', 'calculate.mjs', '24个月条件估算.md'];
const sourceBytes = Object.fromEntries(sourceNames.map(name => [name, fs.readFileSync(path.join(dir, name))]));
const sourceHashes = Object.fromEntries(sourceNames.map(name => [name, hash(sourceBytes[name])]));
const cfg = JSON.parse(sourceBytes['inputs.json'].toString('utf8'));
const model = JSON.parse(sourceBytes['results.json'].toString('utf8'));
const base = model.main.find(row => row.id === 'base');
assert(base && base.monthly.length === 24, 'A complete base scenario is required');
assert.equal(model.inputSha256, sourceHashes['inputs.json'], 'Main results do not match frozen inputs');
const sum = values => values.reduce((a, b) => a + b, 0);
const checks = [];
const near = (name, actual, expected, tolerance = 0.00001) => {
  assert(Math.abs(actual - expected) <= tolerance, name + ': ' + actual + ' != ' + expected);
  checks.push(name);
};
const poolKeys = Object.keys(cfg.budgetPools).filter(key => key !== 'historicalRecovery');
const F = sum(poolKeys.map(key => cfg.budgetPools[key]));
const H = cfg.budgetPools.historicalRecovery;
const R = base.total.netRevenue;
const k = base.paidPointConsiderationRatio;
const a = (1 - cfg.refundRate) / (1 + cfg.tax.vat);
const taxKeep = 1 - cfg.tax.income;
const paymentRateOnRevenue = cfg.tax.payment * (1 + cfg.reserveRate) / a;
const surchargeRateOnRevenue = cfg.tax.vat * cfg.tax.surchargeOnVat;
const revenueLeak = paymentRateOnRevenue + surchargeRateOnRevenue;

// Annual tax calculation independent of the main model's monthly YTD loop.
// No backwards carry-back: a later loss does not recover an earlier year's tax.
function counterfactual({ id, label, removedPools = [], removeBonusFace = false, costScale = 1 }) {
  assert(removedPools.every(key => poolKeys.includes(key)));
  assert(costScale >= 0);
  const rows = base.monthly.map(row => {
    const bonusUsed = removeBonusFace ? 0 : row.bonusUsed;
    const paidConsideration = (row.grossFace - bonusUsed) * k;
    const netRevenue = paidConsideration * a;
    const operatingPool = sum(poolKeys.map(key => removedPools.includes(key) ? 0 : row[key] * costScale));
    const paymentFee = paidConsideration * cfg.tax.payment * (1 + cfg.reserveRate);
    const surcharge = netRevenue * surchargeRateOnRevenue;
    return { netRevenue, operatingPool, paymentFee, surcharge,
      pretax: netRevenue - operatingPool - paymentFee - surcharge };
  });
  const yearPretax = [sum(rows.slice(0, 12).map(row => row.pretax)),
    sum(rows.slice(12).map(row => row.pretax))];
  const incomeTax = Math.max(0, yearPretax[0]) * cfg.tax.income
    + Math.max(0, yearPretax[1] - Math.max(0, -yearPretax[0])) * cfg.tax.income;
  const netRevenue = sum(rows.map(row => row.netRevenue));
  const operatingPool = sum(rows.map(row => row.operatingPool));
  const operatingNetProfit = sum(yearPretax) - incomeTax;
  return { id, label, removedPools, removeBonusFace, costScale, netRevenue, operatingPool,
    paymentFee: sum(rows.map(row => row.paymentFee)), surcharge: sum(rows.map(row => row.surcharge)),
    yearPretax, incomeTax, operatingNetProfit, afterRecovery: operatingNetProfit - H,
    operatingNetMargin: operatingNetProfit / netRevenue,
    afterRecoveryMargin: (operatingNetProfit - H) / netRevenue };
}
const baseline = counterfactual({ id: 'base', label: '原基准，不改预算' });
near('base revenue unchanged', baseline.netRevenue, R);
near('base operating net unchanged', baseline.operatingNetProfit, base.total.operatingNetProfit);
near('base recovery unchanged', baseline.afterRecovery, base.total.afterRecovery);
near('approved total including recovery', F + H, 3044600);
near('source nonhistorical pools', base.total.operatingCosts - base.total.paymentFeeBudget, F);

const targets = [
  { id: 'operating_break_even', label: '税后经营保本', margin: 0, recovery: 0 },
  { id: 'recovery_break_even', label: '完成历史回收后保本', margin: 0, recovery: H },
  { id: 'operating_margin_60', label: '税后经营净利率60%', margin: 0.6, recovery: 0 },
  { id: 'recovery_margin_60', label: '历史回收后余量率60%', margin: 0.6, recovery: H }
].map(target => {
  const denominator = 1 - revenueLeak - target.margin / taxKeep;
  assert(denominator > 0);
  const requiredRevenue = (F + target.recovery / taxKeep) / denominator;
  const factor = (requiredRevenue / a / k + base.total.bonusUsed) / base.total.grossFace;
  const existing = model.thresholds.find(row => row.id === target.id);
  near(target.id + ' existing price threshold', factor, existing.price.factor, 1e-8);
  near(target.id + ' existing revenue threshold', requiredRevenue, existing.price.total.netRevenue);
  const costCeiling = denominator * R - target.recovery / taxKeep;
  if (costCeiling >= 0) {
    const check = counterfactual({ id: target.id, label: target.label, costScale: costCeiling / F });
    near(target.id + ' cost ceiling reaches target', check.operatingNetProfit - target.recovery,
      target.margin * R);
  }
  return { ...target, requiredRevenue, revenueMultiple: requiredRevenue / R, priceMultiple: factor,
    referenceBasketCny: existing.price.referenceBasketCny, operatingCostPoolCeiling: costCeiling,
    cutRequired: F - costCeiling, cutShare: (F - costCeiling) / F,
    feasibleWithNonnegativeCosts: costCeiling >= 0 };
});

const cuts = [
  baseline,
  counterfactual({ id: 'no_media', label: '仅取消媒体费用', removedPools: ['media'] }),
  counterfactual({ id: 'no_promo_fulfillment', label: '仅取消赠额履约池，保留赠额抵扣', removedPools: ['promoFulfillment'] }),
  counterfactual({ id: 'no_bonus_face', label: '仅取消赠额票面，保留履约预算', removeBonusFace: true }),
  counterfactual({ id: 'no_promo', label: '赠额计划全取消：履约池＋票面', removedPools: ['promoFulfillment'], removeBonusFace: true }),
  counterfactual({ id: 'no_media_no_promo', label: '媒体及赠额计划全部取消', removedPools: ['media', 'promoFulfillment'], removeBonusFace: true })
];
for (const row of cuts) {
  near(row.id + ' full profit bridge', row.netRevenue - row.operatingPool - row.paymentFee
    - row.surcharge - row.incomeTax - H, row.afterRecovery);
  assert(row.operatingNetMargin < 0.6 && row.afterRecoveryMargin < 0.6,
    'Update decision narrative if a counterfactual reaches 60%');
  checks.push(row.id + ' remains below 60%');
}
const zeroCost = counterfactual({ id: 'zero_cost_bound', label: '全部经营池为零的理论上界', costScale: 0 });
near('zero cost recovery margin formula', zeroCost.afterRecoveryMargin,
  taxKeep * (1 - revenueLeak) - H / R);
assert(zeroCost.afterRecoveryMargin < 0.6);
checks.push('even zero operating pool cannot reach recovery-adjusted 60% at current revenue');
const paidDelivery = cfg.budgetPools.paidResources + cfg.budgetPools.paidServices;
const op60 = targets.find(row => row.id === 'operating_margin_60');
const allPromoCut = cuts.find(row => row.id === 'no_media_no_promo');
const mediaCut = cuts.find(row => row.id === 'no_media');
const promoCostCut = cuts.find(row => row.id === 'no_promo_fulfillment');
const noPromo = cuts.find(row => row.id === 'no_promo');
const wan = value => (value / 10000).toFixed(2);
const pct = value => (value * 100).toFixed(2) + '%';
const money = value => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rows = [
  '# BondBuddy 盈利决策门槛补充', '',
  '2026-10-29。只补充决策边界；不修改现行价表、已认可预算、用户数、需求或主预测。以下均为24个月条件计算，金额表使用万元。', '',
  '**结论：现价与基准需求下，取消媒体或赠额仍不足以达到60%税后经营净利率；若同时要求收回45.62万元历史投入，即使其他经营成本为零也达不到60%。订阅与自动扣费改善付款体验，不能单独填平经营缺口。**', '',
  '原主表已给出价格及任务倍率；本附件仅补充相应收入门槛、可承受成本上限和删减费用的压力边界。原基准净收入' + wan(R) + '万元，税后经营净利' + wan(base.total.operatingNetProfit) + '万元，历史回收后' + wan(base.total.afterRecovery) + '万元。', '',
  '## 1. 固定现有需求和预算：要有多少收入', '',
  '任务数量、任务组合、8079.78计收人月、订阅积分来源与赠额票面都保持主模型条件。价格倍率是未来所有任务价格连续同比调整的数学等价量；没有实施提价，也不能证明提价后需求仍保持不变。', '',
  '|目标|所需净收入|相对当前净收入|等价任务价格倍率|参考篮子：元/计收人月|',
  '|---|---:|---:|---:|---:|',
  ...targets.map(row => '|' + [row.label, wan(row.requiredRevenue), row.revenueMultiple.toFixed(4) + '倍',
    row.priceMultiple.toFixed(4) + '倍', money(row.referenceBasketCny)].join('|') + '|'), '',
  '净收入已扣订阅对价差异、赠额使用、3%售后收入冲减及增值税；它不是充值现金到账。赠额抵扣额保持固定，因此收入倍率与价格倍率不完全相等。历史回收属于税后管理目标，不再作为当期税前费用扣除。', '',
  '## 2. 固定现价和需求：最多能支出多少', '',
  '成本池F＝付费资源、支持服务、赠额履约、媒体、技术、运营、云行政安全，现合计' + wan(F) + '万元。以下上限**不含**支付手续费、税及历史回收；这些项目已在计算上限时另行扣除。它不是建议把预算删到这个数。', '',
  '|目标|经营成本池F上限|相对现预算须减少|判断|',
  '|---|---:|---:|---|',
  ...targets.map(row => '|' + [row.label, wan(row.operatingCostPoolCeiling), wan(row.cutRequired),
    row.feasibleWithNonnegativeCosts ? '需压缩' + pct(row.cutShare) : '负上限，不可能仅靠削减非负费用达到'].join('|') + '|'), '',
  '税后经营净利率60%仅允许F为' + wan(op60.operatingCostPoolCeiling) + '万元。既有付费资源及服务预算已占'
    + wan(paidDelivery) + '万元，留给媒体、赠额履约、技术、运营及云行政安全合计仅'
    + wan(op60.operatingCostPoolCeiling - paidDelivery) + '万元。该余额未证明足以维护产品及取得现有需求。', '',
  '在F=0的不可运营理论上界下，经营净利率为' + pct(zeroCost.operatingNetMargin)
    + '，完成历史回收后仅' + pct(zeroCost.afterRecoveryMargin)
    + '。因此“现收入＋保留历史回收＋回收后60%”在数学上已不可行，不能用砍费用或积分到期认收入解决。', '',
  '## 3. 取消媒体或赠额能解决多少', '',
  '**以下是需求完全不受影响的乐观压力上界，不是可执行预算或新预测。** 假设所有取消均发生在支出、赠额承诺之前；不撤销已发积分、已签义务或已发生费用。实际停投可能减少新用户，停赠可能降低转化和留存，这里没有为这种损失编造系数。', '',
  '|独立压力|净收入|税后经营净利|历史回收后|经营净利率|回收后余量率|',
  '|---|---:|---:|---:|---:|---:|',
  ...cuts.map(row => '|' + [row.label, wan(row.netRevenue), wan(row.operatingNetProfit), wan(row.afterRecovery),
    pct(row.operatingNetMargin), pct(row.afterRecoveryMargin)].join('|') + '|'), '',
  '- 媒体原预算126万元加上既有5%准备后为132.30万元；若全部省下且需求不变，可以经营盈利并完成历史回收，但经营净利率仅'
    + pct(mediaCut.operatingNetMargin) + '。不能据此认定停投后仍有同样客户。',
  '- 赠额履约22.26万元与赠额票面9.85万元是不同对象：只取消履约预算后仍亏'
    + wan(-promoCostCut.operatingNetProfit) + '万元；连票面也假设取消且原任务全部改付费，才有'
    + wan(noPromo.operatingNetProfit) + '万元经营净利，仍未回收历史投入。赠额票面不能再当作费用节省重复相加。',
  '- 媒体与赠额计划全部取消，在该乐观上界下经营净利率也仅'
    + pct(allPromoCut.operatingNetMargin) + '，回收后仅' + pct(allPromoCut.afterRecoveryMargin)
    + '。盈利后节省成本仍需扣所得税；取消赠额形成的新增付费对价还受支付费和其他税额影响，并非省一元就多一元税后利润。', '',
  '## 4. 决策含义及复算', '',
  '现价可用于验证真实购买与交付，但不能同时称为已满足60%目标的经营方案。先以已完成付费任务核实独立任务量、实收对价、可归属支持和渠道贡献；预算调整需明确替代获客路径及服务能力。可先验证经营保本，再决定历史投入回收期限；缩短回收期限会增加目标收入，延后回收也不会自动使当期经营净利达到60%。本附件不替用户批准涨价、砍预算或改目标。', '',
  '统一公式：R为不含增值税的净收入；F为上述经营成本池；H＝45.62万元；t＝25%；支付费与附加合计占R的比例λ＝'
    + revenueLeak.toFixed(10) + '。给定净利率目标m、需税后回收金额h（0或H）：', '',
  '    所需净收入 R_min = (F + h/(1-t)) / (1 - λ - m/(1-t))',
  '    现收入可承受 F_max = (1 - λ - m/(1-t)) × R - h/(1-t)', '',
  'λ＝0.6%×1.05×1.06/0.97＋6%×12%。沿主模型6%增值税、附加按增值税12%、所得税25%、进项暂取0；准备假设实际发生且可税前扣除。脚本按两个12月规划年度独立计算亏损结转，没有将历史回收再次减税，也没有将月度税额回冲当现金退税。以上闭式门槛以该年度路径验证；其他收支时点或税务身份不能直接套用。', '',
  '复算：在仓库目录运行 node docs/finance/subscription-20261029/profit-decision.mjs。脚本只读inputs.json、results.json、calculate.mjs及主报告；仅生成本附件和profit-decision.json，不重跑或覆盖主模型。源文件SHA-256、完整精度及断言结果保存在profit-decision.json。', ''
];
for (const name of sourceNames) {
  assert.equal(hash(fs.readFileSync(path.join(dir, name))), sourceHashes[name], name + ' changed during calculation');
  checks.push(name + ' unchanged');
}
const output = { asOf: '2026-10-29', status: 'Conditional decision bounds; not a new budget, tariff or forecast',
  sourceHashes, definitions: { currentNetRevenue: R, operatingCostPool: F, historicalRecovery: H,
    revenueLeak, tax: cfg.tax, refundRate: cfg.refundRate, fundingRatio: k },
  targets, cuts, zeroCost, checks: { count: checks.length, failures: 0, items: checks } };
rows.push('本次脚本检查' + checks.length + '项、0失败：对齐主模型收入/利润/价格门槛、成本上限与年度税桥、压力损益和源文件未改变。计算通过只说明条件算术一致，不证明需求、真实税务、成本可削减或盈利能够实现。', '');
fs.writeFileSync(path.join(dir, 'profit-decision.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(dir, '盈利决策门槛.md'), rows.join('\n'));
console.log(JSON.stringify({ checks: output.checks.count, failures: 0, targets: targets.map(row => ({
  id: row.id, revenue: row.requiredRevenue, factor: row.priceMultiple, costCeiling: row.operatingCostPoolCeiling })),
  output: ['profit-decision.json', '盈利决策门槛.md'] }, null, 2));
