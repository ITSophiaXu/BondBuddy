# 批量生成底稿按钮 UX · 2026-10-28

用户反馈检查阶段看不到“确认并生成底稿”，并要求优化关键按钮。基线为 develop `d3c92304`，实现与原型版本为包含本文件的同一提交。关联前端验收 #361；本次不关闭其余验收项。

## 最终行为

1. 目录准备完成后，主操作“批量生成底稿”常驻；点击先检查可生成文件，附近说明随后还需核对清单和费用。
2. 排队、运行、暂停、失败、完成各有状态。运行期间显示实际条数和下一步，生成按钮保留可见；暂停有任务入口，失败可重新检查。
3. 检查完成后，同一主按钮显示“确认并生成底稿”。未勾选确认时禁用，附近解释原因；勾选后才提交原生成接口。
4. 检查/生成请求结果不确定时复用原请求，活动批次期间禁止重复提交，提供“查看生成进度”。无选中项等前置缺项在按钮附近解释。
5. 确认清单未变化时轮询不重建 DOM，保留核对时的滚动位置、展开帮助与确认状态。

## 原型与实际页面对照

实际代码为 `apps/web/src/workpaper-panel.ts`；原型为 `product-prototype/public/workpaper-batch.html`；共用 `product-prototype/public/workpaper-entry.css`。影响已迁移的文件生成 → 批量生成底稿页面。

视口均为 1440×960 或 390×960，以下为全页截图，`*-card-*` 为实际操作区细节。

|状态|实际页面|原型|
|---|---|---|
|准备|preparation-1440.png / preparation-390.png|prototype-preparation-1440.png / prototype-preparation-390.png|
|检查中|checking-1440.png / checking-390.png|prototype-checking-1440.png / prototype-checking-390.png|
|核对|assessment-1440.png / assessment-390.png|prototype-assessment-1440.png / prototype-assessment-390.png|
|提交后|progress-1440.png / progress-390.png|prototype-progress-1440.png / prototype-progress-390.png|

可见主操作、相邻提示、费用、检查状态和手机按钮布局一致。差异：实际页面保留项目侧栏、积分、来源和持久化任务上下文；原型为合成演示。检查中截图实际为 248 条合成项，原型为 350 条；提交后原型演示运行，实际模拟接口返回排队。已检查关键操作区的桌面/手机截图，无水平溢出或按钮裁切。用户授权 UX 修改，最终视觉验收尚未完成。

## 验证

- Edge / Playwright：`workpaper-batch.spec.ts` 最终 15/15 通过，无跳过。覆盖 350 项选择与报价、248 项检查状态切换、确认前不提交生成、零生成费用、输入变化重检、网络不确定恢复、刷新、防重复、核对位置保留、桌面/手机及原型。
- TypeScript：先构建 contracts/domain/rule-pack-registry/rule-applicability-context/API 前置产物，再执行 web `tsc --noEmit -p tsconfig.json` 通过。初次检查因新工作区缺少前置包产物失败，补齐后通过。
- Vite production build 通过，保留既有超过 500 kB chunk 提示。
- contracts `check-examples.js`：171 个合成例及 12 个内部资料例通过；`check-data-lifecycle.js`：4 例通过。
- 首轮 15/15 通过；随后新增“清单滚动位置不受轮询影响”的断言，发现单纯恢复 scrollTop 仍会被浏览器重排重置（桌面/手机 2 项失败）。改为未变化时保留确认清单 DOM，最终整组 15/15 通过。

本机复现使用独立 Vite 端口 5228，命令为 `BB_E2E_BASE_URL=http://127.0.0.1:5228 BB_E2E_BROWSER_CHANNEL=msedge playwright test tests/workpaper-batch.spec.ts`。Windows 本次直接运行 Node 包入口，未安装新依赖。

## 集成交接

- 无 API、worker、契约、价格、依赖或数据库迁移变更。仅更新 web 与配套原型。
- 浏览器验证使用合成目录和模拟 HTTP；没有操作生产项目、调用真实模型或扣取真实积分，不代表后端生成链路验收。
- 本次没有启动完整本地集成环境；由指定集成 chat 纳入固定版本后，用户在统一本地版验收。
- 验收路径：打开底稿页 → 点击“批量生成底稿” → 查看检查进度/暂停提示 → 核对清单和费用 → 勾选确认 → 点击“确认并生成底稿” → 查看生成进度。
- 开发和自测完成。用户尚未验收。代码完成，尚未部署，待统一发布。
