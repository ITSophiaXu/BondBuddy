# 项目问答开发验证

状态：开发和自测完成；本功能独立本地环境可检查。真实模型效果、设计偏离确认、跨 PR 统一集成及用户验收尚未完成；尚未部署。

基线 `9b274d0a600b155dc1de397260d36b598e9b8d83`，实现提交 `5fe3207af8dcc955b5fb9ead3bc30687dedae1e7`，分支 `feat/project-qa-e2e-20261021`。依赖 PR #713 → #715 → #717 → #719 → #721。原型工作区 `BondBuddy-project-overview-design-20261020`，commit `35da7b8c9bc649abea4aadd66ab59a624be7e7b4`，源码 `apps/web/src/project-design/qa-view.ts`、`qa-model.ts`。

## 自动化证据

- API/worker/contracts TypeScript 构建、web TypeScript + Vite 构建通过。Vite 仍有既有单包超过 500 KB 提示。
- `BB_LOCAL_INSTANCE=qa-20261021 node scripts/local-integration/test-qa.mjs`：1 个完整 E2E 场景通过，实际 PostgreSQL、API、私有 Azurite、队列、Word 和下载；模型适配器为 synthetic。
- E2E 覆盖免费解析、原文定位核对、CAS、幂等、问题数报价变化、每题 60 冻结/交付结算、第一题后暂停/恢复不重复调用、伪造引用降级、案例审核权限/撤回/固定快照/outbox、历史 Word 不变、4.2 文件版本、任务与账单、异账号隔离、失败与取消释放。
- 共享回归共 7 个场景通过：原始上传 3、既有固定计费 3、项目文件聚合 1。项目聚合测试须使用其原 fixture 配置 `BB_PAID_AUTHORING_ENABLED=0`、`BB_PAID_REVIEW_ENABLED=0`；初次错误地继承付费开关得到 QUOTE_REQUIRED，按现有脚本配置重跑通过。
- 契约：171 个 synthetic 样例、12 个内部 library 样例、4 个生命周期样例通过。
- 无网络 Linux Python 文档测试 3/3：DOC 转换、保留表格/页脚/样式和就地回填、Excel sheet/row 与缓存值边界。
- 两轮合成回填 Word 各渲染 1 页，全部页面已查看：无裁切、重叠；待补材料紧随对应问题，页脚保留。原模板标题/样式按原件保留。

日志保存在独立 runtime 的 `qa-tests.log`、`qa-regressions.log`（6 pass + 一次 fixture 配置错误）、`qa-projects-regression.log`（修正配置后 1 pass）。生成 Word、样本、数据库、凭据不提交仓库。

## 浏览器与原型对照

实际浏览器验证：统一项目选择、新建项目后对话锁定当前项目、Word 真实上传与 Linux worker 免费解析、合并连续段落后从 3 题变 2 题、参考材料上传、保存与刷新恢复、确认框 2 × 60 = 120、历史成果恢复、实际 Word 下载、空知识库。未点击真实模型付费确认。

同尺寸 1265 × 712 原型/成果对照、1440 × 1000 入口及 390 像素响应式证据位于 `apps/web/test-evidence/project-qa-20261021/`。390 像素实测 document clientWidth/scrollWidth 都为 390；嵌入对话不遮蔽主页面。

| 原型位置 | 实现及差异 | 确认状态 |
| --- | --- | --- |
| 导航诚信核查下方项目问答 | 同位置；先用全站共用 ProjectEntry 选择项目 | 用户已明确要求统一 UI |
| 顶部项目下拉框 | 改为共用选择入口、项目条及更换项目链接 | 按后续统一入口要求实现 |
| 左侧上传/对话、右侧问题/Word | 保持左右分区；复用真实 BondBuddy 组件，上传卡放对话上方 | 具体版式待用户验收 |
| 示例问题及可编辑草稿 | 免费解析原稿；用原段落范围核对，不能任意篡改原问题；结果可在下载 Word 中编辑 | 为真实定位与计费新增，待用户验收 |
| 对话框兼具要求录入 | 对话使用原普通问答计费；Word 回填要求在右侧独立保存并说明 | 待用户验收 |
| 直接生成示例 | 增加按题数确认费用、真实后台状态、暂停恢复/取消 | 费率已确认，具体交互待验收 |
| 待补材料卡和成果文件 | 结果右侧逐题列出依据/缺口；同内容写回 Word，4.2 保留版本 | 待用户验收 |
| 合成知识库示例 | 默认空库；公开来源正文、人工审核/撤回、关键词检索 | 用户确认真实案例后补 |

不因功能测试通过而把上述界面偏离视为用户确认，因此 PR 保持 draft，不自行合并。

## 独立本地检查

入口：<http://localhost:5197/#qa>。已实际启动并验证可访问，API 3027、PG 15447、Azurite 10027、Linux worker 独立实例 `qa-20261021`；不连接生产。

账号 `integration_user`，密码 `Local-Test-2026!`，积分为隔离合成赠送。项目“合成项目问答验收 · 模拟回答”是通过真实 API/队列/Word 写入的合成模型成果；“合成上传验证 · 项目问答”是在浏览器新建上传并免费解析的准备稿。

1. 选择合成成果项目，历史版本中查看回答、依据和待补材料，下载 Word，在项目文件 4.2 找到成果。
2. 选择合成上传项目，检查两题、参考材料及要求；刷新应保留。点击生成到费用确认页可核对 120 积分。
3. 公募问答知识库默认为空，录入后须由运营授予的审核员批准。不能把 synthetic 案例当作真实公开库。

真实模型回答未在本轮调用验证，`modelReady=false` 表示未运行本镜像真实模型探针；不表示网页/API/worker 未启动。不要把合成成果称为真实模型结果。用户实际开始普通对话或 Word 回填将使用已配置的真实服务并产生用量，需要按真实测试授权执行。

在本分支根目录用同一 Node 22 运行：

```powershell
$env:BB_LOCAL_INSTANCE='qa-20261021'
node scripts/local-integration/status.mjs
node scripts/local-integration/stop.mjs
node scripts/local-integration/start.mjs
```

停止保留数据，活动任务会阻止不安全停机。迁移/依赖/审核员运营说明见 [架构](../../PROJECT-QA-ARCHITECTURE.md)。统一集成与发布 chat 需固定本 PR 和全部前置版本再进行整体验收，本文件不代替共享交接文件或用户验收结论。
