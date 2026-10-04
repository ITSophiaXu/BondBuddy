import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const out = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(out, '../..');
const files = fs.readdirSync(out).filter(n => /^\d{2}-.*\.md$/.test(n)).sort();
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const read = n => fs.readFileSync(path.join(out, n), 'utf8');
const errors = [];
if (files.length !== 19) errors.push('Expected 19 numbered chapters.');
files.forEach((f, i) => {
  if (Number(f.slice(0, 2)) !== i) errors.push('Missing chapter: ' + i);
});
const moduleData = files.map(file => {
  const content = read(file);
  const title = content.split(/\r?\n/)[0].replace(/^# /, '');
  return { file, title, content };
});
const combinedName = 'BondBuddy产品开发说明书.md';
const combined = [
  '# BondBuddy 产品开发说明书',
  '',
  '版本 1.6｜范围修订 2026-10-04｜面向产品、设计、开发、行业审核、测试与运营',
  '',
  '本合订版由同目录 19 个模块汇编。按最新要求先 Web、最后 Windows，依五个里程碑逐步上线；M3 本次为无用户收费的募集书复核、结果修订、桌面常驻项目助手与统一任务时间线，#537/#538 负责安全任务事件及明确提议/执行来源，与既有 M3 任务联动；由 Codex CLI 统一业务执行，平台保留权限、任务、版本及成果校验；募集书库和商业接口不是 M3 前置。M1 统一编制，原稿可不上传，上传后必填原发行人、市场、品种、企业关系和最新报告期；目标信息独立，原对话区改补充要求，材料及知识 MD 直接交 worker；M2 取消余额退款/消费记录页。目标与现有实现状态在第 17、18 章明确区分，认领任务见 [开发任务清单](delivery-plan/README.md)。',
  '',
  '已确认首发包含大公募、PPN/MTN/CP/SCP 及 DFI 储架发行；启信宝、Wind、企业预警通为后续可选接入。上传券商模板默认仅本人复用。已启用收费的阶段采用用户指定 v1.1 方案，本次 M3 不包含用户收费。',
  '',
  '需要按模块使用时，请打开 [阅读目录](README.md)。本文件描述目标规格，不表示已完成开发、生产接入或专业验收。',
  '',
  '## 目录',
  '',
  ...moduleData.map((m, i) => '- [' + m.title + '](#part-' + String(i).padStart(2, '0') + ')'),
  '',
  ...moduleData.flatMap((m, i) => [
    '---',
    '',
    '<a id="part-' + String(i).padStart(2, '0') + '"></a>',
    '',
    m.content.replace(/^(#{1,5}) /gm, '$1# ').trim(),
    ''
  ])
].join('\n');
fs.writeFileSync(path.join(out, combinedName), combined, 'utf8');

const pricingMd = path.join(out, 'references/BondBuddy详细积分方案-v1.1-来源快照.md');
const pricingJson = path.join(out, 'references/积分参数-v1.1-来源快照.json');
const pricing = JSON.parse(fs.readFileSync(pricingJson, 'utf8').replace(/^\uFEFF/, ''));
if (pricing.version !== 'proposal-2026-09-22-v1.1') errors.push('Pricing source version changed.');
if (pricing.execution?.user_quote_screen !== false) errors.push('Pricing source no longer one-click.');
if (pricing.execution?.reward_and_paid_credits_same_task_spending_scope !== true) errors.push('Credit scope changed.');
if (pricing.execution?.overrun_payer !== 'platform') errors.push('Overrun payer changed.');
const expectedPacks = [[50,5000],[500,52500],[2000,220000],[10000,1150000]];
if (JSON.stringify(pricing.recharge.map(p=>[p.cny,p.paid_credits])) !== JSON.stringify(expectedPacks)) errors.push('Recharge packs changed.');
fs.mkdirSync(path.join(out, 'references'), { recursive: true });
// Pricing sources are versioned alongside the specification.

let linkCount = 0;
let tableCount = 0;
let jsonExamples = 0;
const allTexts = ['README.md', ...files, combinedName];
for (const file of allTexts) {
  const content = read(file);
  let fenced = false;
  let columns = null;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/^~~~/.test(line)) { fenced = !fenced; columns = null; continue; }
    if (fenced) continue;
    if (/^\|/.test(line)) {
      const width = line.split(/(?<!\\)\|/).length - 2;
      if (columns === null) { columns = width; tableCount++; }
      else if (columns !== width) errors.push(file + ':' + (index + 1) + ' table width differs');
    } else columns = null;
  }
  if (fenced) errors.push(file + ': unclosed code fence');
  for (const m of content.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    const target = m[1].replace(/^<|>$/g, '');
    if (/^https?:\/\//.test(target)) continue;
    if (target.startsWith('#')) {
      if (!content.includes('id="' + target.slice(1) + '"')) errors.push(file + ': missing anchor ' + target);
      continue;
    }
    const fileTarget = decodeURIComponent(target.split('#')[0]);
    linkCount++;
    if (!fs.existsSync(path.resolve(out, fileTarget))) errors.push(file + ': missing file ' + fileTarget);
  }
  for (const m of content.matchAll(/~~~json\s*\n([\s\S]*?)\n~~~[ \t]*/g)) {
    try { JSON.parse(m[1]); jsonExamples++; }
    catch { errors.push(file + ': invalid JSON example'); }
  }
}
const allModuleText = moduleData.map(m=>m.content).join('\n');
const acceptanceIds = [...new Set(allModuleText.match(/\b(?:[A-Z]+(?:-[A-Z]+)*-A\d+|E2E-\d+)\b/g) || [])];
const hanCount = [...allModuleText.matchAll(/\p{Script=Han}/gu)].length;
const sourcePaths = [
  'product-prototype/product-specs/references/BondBuddy详细积分方案-v1.1-来源快照.md',
  'product-prototype/product-specs/references/积分参数-v1.1-来源快照.json',
  'product-prototype/product-specs/references/本地规格来源指纹-v1.1.json',
  'product-prototype/package.json',
  'product-prototype/server.mjs',
  'product-prototype/docs/PROJECT-WORKSPACE.md',
  'product-prototype/lib/credit-pricing.mjs',
  'product-prototype/public/markets.js',
  'product-prototype/lib/credit-wallet.mjs',
  'product-prototype/public/credit-account.js'
];
const sources = sourcePaths.map(relative => {
  const absolute = path.join(root, relative);
  const data = fs.readFileSync(absolute);
  return { relative_path: relative, sha256: sha256(data), observed_mtime: fs.statSync(absolute).mtime.toISOString() };
});
const manifest = {
  spec_version: '1.6',
  requirements_date: '2026-09-22',
  scope_revision_date: '2026-10-04',
  assembled_at: new Date().toISOString(),
  scope: 'Web-first staged delivery, Windows last; current BondBuddy plus commercial launch requirements',
  pricing_version: pricing.version,
  modules: moduleData.map(m=>({file:m.file,title:m.title,sha256:sha256(m.content)})),
  sources,
  acceptance_ids: acceptanceIds,
  validation: {module_count: files.length, han_characters: hanCount, local_links_checked: linkCount, tables_checked: tableCount, json_examples_checked: jsonExamples, errors},
  limitations: [
    'Document builder checks structure and links only; chapter 18 records local-source DFI regressions, not tests of this documentation-only repository commit.',
    'Regulatory rules and supplier access require the release evidence specified in chapters 15 and 17.',
    'Combined document is generated from numbered modules; edit modules first and regenerate.'
  ]
};
fs.writeFileSync(path.join(out, 'spec-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const report = [
  '# 文档校验记录', '',
  '规格版本：1.6；范围修订：2026-10-04。', '',
  '| 检查 | 结果 |', '|---|---|',
  '| 连续模块 | ' + files.length + ' 个，00–18 |',
  '| 模块正文中文字符 | ' + hanCount.toLocaleString('en-US') + ' |',
  '| 独立验收用例标识 | ' + acceptanceIds.length + ' |',
  '| 本地链接检查（含合订版重复引用） | ' + linkCount + ' |',
  '| 表格结构检查（含合订版） | ' + tableCount + ' |',
  '| JSON 示例解析（含合订版） | ' + jsonExamples + ' |',
  '| 定价源版本与关键规则 | ' + pricing.version + ' |',
  '| 错误 | ' + errors.length + ' |', '',
  '此前记录的人工交叉检查覆盖：首发大公募、四类银行间品种及 DFI 储架安排、三家数据源、私有模板、展开表单、固定材料分区、全文更新、对话路由、计价流程、收费与失败状态的一致性。本轮只同步当前 M3 交互与联动需求，不重新验收其他阶段；第 18 章历史运行记录未改。', '',
  '本次记录 M3 文档结构、链接及官方汇编生成验证。synthetic CUA 的桌面/窄屏、提议确认、同一任务时间线及历史保持结果另见 product-prototype/docs/m3-review-workspace-design.md；这些原型结果不是实际 AI/CLI/API、后台持久化、专业复核、Word 或生产 runtime 验收。', '',
  '本记录仅证明文档结构与交叉检查结果，不证明应用功能、真实支付、模型接口、供应商授权或行业准确率已验收。文件指纹及验收标识见 spec-manifest.json。', '',
  ...(errors.length ? ['## 待修复', '', ...errors.map(e=>'- '+e)] : [])
].join('\n');
fs.writeFileSync(path.join(out, '校验记录.md'), report, 'utf8');
console.log(JSON.stringify(manifest.validation, null, 2));
console.log('Acceptance cases: ' + acceptanceIds.length);
if (errors.length) process.exitCode = 1;
