# 材料案例模板验证

基线：`207d0b7`。本批原型、实现、模板和测试均在 `feat/material-case-templates-20261015` 同一交付 commit；精确 commit 以该 PR head 为准。产品依据为用户 2026-10-15 本次要求。

## 页面对照

原型：`product-prototype/public/material-case-templates.html`，复用既有 `styles.css`、`project-workspace.css` 与材料页样式，补充六种材料、市场品种及案例版式选择。实现：`apps/web/src/material-workspace.ts`；原导航及来源/补充资料/要求/提交流程保持在原材料页面。

- `prototype-{application,recommendation}-{1440,390}.png` 与 `implementation-{application,recommendation}-{1440,390}.png`：相同 1440×960、390×960 视口；六卡布局、选中状态、申请书交易所选择、推荐函协会与 PPN/MTN 品种选择逐项检查。
- `{application,recommendation}-{1440,390}.png`：实际页面全长截图，检查版式变体、章节展示与材料/要求区。申请书已选择深交所参考版二，推荐函已由 MTN 切换为 PPN，旧版式被清空。
- 原型是独立静态交互补充页，省略账号导航、历史成果和真实上传。其章节为概要，实际页面展示所选模板的通用标题。该原型覆盖本次新增交互；不能代表原有账号/上传/成果功能已经重新设计。
- 既有页面尺寸、导航和成果区沿用基线。当前只是开发复核，用户尚未验收；本 PR 不合并未经用户确认的页面偏离或进行生产部署。

## 自动化结果

- 全工作区 build 和 contracts 在补充上交所模板后重新通过。
- contracts：171 个合成样例、12 个内部参考库样例、4 个数据生命周期样例及 40 项 OCR/主体绑定测试通过。
- API/worker 定向测试：34 项，33 通过、1 个既有 Windows symlink 测试跳过。覆盖目录 11 个变体、防错选/篡改、旧快照兼容、六种默认范围真实 PostgreSQL/API/worker/Word/账务交付、材料生命周期及权限。
- Python：3 项通过，内部逐一填充检查 11 个模板，确认非正文部件字节、分节和页边距保留；上交所补充检查自动编号标题、30 项发行条款、22 张表、完整签署角色与横向分节。
- 上交所原件 94 页与最终模板 26 页已通过 Word 只读导出和逐页视觉复核。模板标题设置同页约束，签署页独立分页；最终分页调整后的知识/目录/六范围交付链路另复验 5 项通过。
- 浏览器 `m4-workspace.spec.ts` + `project-assistant.spec.ts`：66 通过、2 项原有可选截图测试跳过；包含原型对照、新类型桌面/手机交互以及上交所核查意见模板的标题展示和提交检查。

本地 PostgreSQL 使用独立容器和数据库，迁移全新执行至 0106。API 和 worker 的生成链路测试使用 synthetic 材料、模拟模型响应与内存 Blob 适配器，但生成和检查真实 DOCX。浏览器使用模拟 API。没有真实模型调用，没有接触生产数据，没有用户验收。

## 可复跑命令

```powershell
npm run build
npm run check:contracts
$env:PYTHONPATH='python'
python -m unittest python.tests.test_m4_case_templates -v
$env:BB_TEST_DATABASE_URL='<独立测试 PostgreSQL URL>'
$env:BONDBUDDY_TEST_PYTHON='<Python 绝对路径>'
$env:BONDBUDDY_WORD_PYTHON=$env:BONDBUDDY_TEST_PYTHON
node --test --test-concurrency=1 apps/api/dist/m4-case-templates.test.js apps/api/dist/m4-knowledge.test.js apps/api/dist/m4-workspace.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js apps/worker/dist/m4-case-templates.pg.test.js apps/worker/dist/m4-stages.test.js
# apps/web 目录中，指向独立 Vite 页面
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npx playwright test tests/m4-workspace.spec.ts tests/project-assistant.spec.ts
```

版本迁移、模板缺口、真实生成验收和统一发布步骤见知识目录 README。测试端口不作为用户可验收的统一本地入口。
