# 募集书实时进度与累计积分验收

本目录全部为 synthetic 页面和数据；不代表真实模型调用或生产账本验证。

- 原型：`product-prototype/public/authoring-live-progress.html`。
- 实现：`apps/web/src/project-execution.ts`、`apps/web/src/authoring-progress.ts`。
- 桌面 1440×960、手机 390×844，保存完整页面。原型仅展示变更的运行卡，应用保留项目外框和材料区；同尺寸对照状态标题、事件记录、累计数字、说明与暂停/结束按钮。
- 新交互直接依据当前用户要求设计；未记录额外人工签认。原型/实现源码 commit：f9e18ea08d667e1021a0d0da5ffc9025dbf4c272（基于 develop 117e401f）。截图是该源码的最终集成状态。

验证覆盖排队零消耗、真实模型活动类别、金额更新、暂停冻结、刷新恢复、继续同一任务、部分结束结算。计费说明展开状态和键盘焦点在自动更新时保留。

服务端使用独立本地 PostgreSQL 和全部迁移，合成模型和私有存储替身。已验证暂停与交付竞争、并发结束仅扣一次、失败释放、旧规则兼容、账本审计及按实际扣费更正。依赖 Azurite 的原有完整队列测试未运行；其余定向数据库/worker 测试已通过。

最终集成验证（Windows、本地 PostgreSQL、Edge，2026-10-11）：

- `npm run build`：通过；仅保留 Vite 已有大包体提示。
- `npm run check:contracts`：171 + 12 个例子、4 个数据生命周期例子及 40 个契约测试通过。
- `playwright test project-execution.spec.ts`：63/63 通过，0 skip。包括手机/桌面实时进度以及自动更新期间的说明展开/焦点保留。
- Node 定向数据库/worker 集成：14 pass、0 fail、1 skip（仅原有 Azurite 全链路队列测试）。包含 authoring-progress、billing、review-billing、queue、run-event-dto、authoring-action-progress、authoring-pause 和 worker-runtime-pipeline-seams。
- 交互原型：1440/390 渲染、状态切换和无脚本异常检查通过。
- 新数据库和 worker 回归已加入 M2 Linux CI，完整队列测试将在 PostgreSQL + Azurite 环境执行。

生产限制：当前只提交了只读队列检查，Azure Managed RunCommand 仍待执行；标准 RunCommand 返回 HTTP 409：已有远程命令正在执行。未修改真实任务、生产账本或服务，未声称上线。
