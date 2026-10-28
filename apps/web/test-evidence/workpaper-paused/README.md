# 底稿检查暂停恢复 · 2026-10-28

本文件记录较早的排查和验证。用户随后要求取消独立检查；当前流程和验证见 [直接批量生成](../workpaper-direct/README.md)。此处检查恢复界面已被替换，后端诊断修复和历史证据仍保留；原先缺少数据库的限制已在新验证中补齐。

用户报告生成按钮持续禁用。基线为 develop `5d24d5d85a0c9fb7551354b437d832f9a475867e`；原型与实现为包含本文件的同一提交，关联前端验收 #361。

## 原因与处理

只读生产证据显示两个匹配检查任务均在首组结果保存前暂停：`provider_reconcile`、进程退出码 0、正常结束、用量已记录、`MODEL_RESULT_STORE_FAILED`、没有持久化结果引用，未请求用户暂停或积分暂停。旧日志合并了文件收集、校验和存储异常，临时文件已清理，因此不能证明某个具体字段是历史任务失败的唯一原因。

代码存在可复现缺陷：大文件工作区没有提供严格输出 schema；缺失/格式不合格/全文覆盖不足的结果，被标为等待供应商结果核对。前端又隐藏暂停原因，并禁用主按钮，仅提供通用任务页链接。

本次提供完整只读 schema，保留原件哈希、准确条目和全文覆盖检查；已知无效文件输出与存储失败分别处理。API 返回当前任务暂停元数据，web 使用固定文案解释原因，并提供原任务继续或只刷新入口。计费与生成确认规则保持现状。

## 同尺寸原型对照

源码：`apps/web/src/workpaper-panel.ts`、`workpaper-assessment-state.ts`。原型：`product-prototype/public/workpaper-batch.html?check=paused`，待核对状态加 `&reason=provider`。共用既有 `workpaper-entry.css`，影响已迁移文件生成 → 批量生成底稿页面。

|状态|实际页面 1440/390|原型 1440/390|
|---|---|---|
|可恢复暂停|resume-1440.png / resume-390.png|prototype-resume-1440.png / prototype-resume-390.png|
|结果待核对|provider-1440.png / provider-390.png|prototype-provider-1440.png / prototype-provider-390.png|

全部 8 张操作区截图已查看，按钮/说明/进度无裁切或水平溢出。差异为合成数据：实际 248 项（可恢复时完成 12 项），原型 350 项（完成 0 项）；实际可恢复截图保留已展开帮助，原型初始关闭。关键操作与文案一致。用户最终视觉验收尚未完成。

## 实测

- Edge / Playwright `workpaper-batch.spec.ts`：23/23 通过、无跳过。覆盖桌面/手机、只刷新不重发、原 run 恢复、网络响应丢失、额度错误相邻提示、旧 API 兼容、生成前确认和原型。
- 补充“轮询已恢复时清除过期错误”后，相关恢复场景定向复验 1/1 通过。
- contracts、API、worker、web TypeScript 全部通过；Vite 生产构建通过，存在既有大于 500 kB chunk 提示。
- contracts：171 个合成例及 12 个内部资料例、4 个数据生命周期例通过。
- 定向 Node 测试：18 通过、0 失败、5 跳过。包括新的大文件收集校验、引用校验、目录回归、私有结果持久化及供应商事件测试。
- 跳过项：4 个 Linux 文件执行测试（包含新增的“格式错误与真实存储故障分别处理”回归）及 1 个 PostgreSQL 集成测试（包含原任务暂停/恢复、越权拒绝、过期暂停信息清除）。本机仅有 Docker WSL 发行版；Docker Desktop 启动日志异常且限时探测无响应，没有可用的隔离数据库。未删除或重置 Docker 数据，不把跳过项记为通过。集成环境仍需补跑。
- CI 接入：M4 core 增加两个 assessment 测试文件；文件执行回归沿用 M3 CLI workflow 的既有 worker 容器测试入口（使用固定 Codex sandbox 和合成模型）。

浏览器采用合成目录和模拟 HTTP；文件收集测试使用合成原件，没有调用真实模型或扣取真实积分。数据库集成、完整后端链路及真实内容效果未验收。

复现：先构建 contracts/API/worker，运行上述 Node 测试；Vite 在独立端口 5237 启动后设置 `BB_E2E_BASE_URL=http://127.0.0.1:5237`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `playwright test tests/workpaper-batch.spec.ts`。临时网页服务在交付前停止，不宣称完整本地集成版已启动。

## 集成交接

- contracts 响应新增可选 `pause`，旧 API 缺少字段时 web 仅允许刷新。API/worker/web 均有变更，无数据库迁移及新依赖。
- 待补：Linux 文件执行回归、隔离 PostgreSQL 集成测试、用户在统一本地版验收。GitHub CI 的结果见 PR，不在此预先认定。
- 历史生产任务仍暂停；新代码不能找回已删除的旧临时输出。后续经核对后处理原任务，不通过直接点击刷新重复执行或宣称旧任务已恢复。
- 本次开发修复和可执行的本地测试完成；未纳入统一本地集成版，用户未验收。代码完成，尚未部署，待统一发布。
