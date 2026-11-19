# Direct 底稿批次共享失败恢复（#1631）

开发和定向自测完成；代码尚未部署，待统一发布。原任务的真实模型交付验证仍在独立固定版本 ae58454f8b880ead02730299fb286fc8b021ee42 上进行；该运行没有包含本修复，不能作为本修复的真实验收。

## 原因与已有测试缺口

原失败任务回放的 direct 批次 c27711d9-a681-49e4-b558-263126537fbc 中，两项启动失败后暂停，另两项 queued。公开 resume 使 revision 从 4 到 6，又回到暂停。workpapers.ts 的 resume 检查和 paused/shared_blocked 重试入口仅覆盖 progressive；direct 返回还省略 pause_reason。旧 PG 用例覆盖分章节渐进恢复，缺少 direct 同状态与未知用量边界。

修复使 direct 暴露已有 pause_reason，提供既有 retry_failed 动作，保留成功项、不可变 manifest 和未启动项。活动 run/job/lease、等待输入及 pending_reconcile 阻止重复调用；无失败项不重试。已暂停或取消的 direct 批次仍收集已终止子任务状态。历史 dynamic 和按交付扣费 on_delivery 分别验账。

## 验证与边界

- Windows 宿主；隔离 Linux Node 22、PostgreSQL 16，195 个迁移的独立数据库；无生产连接或账务修改。所有本报告的任务和供应商结果均 synthetic。
- API 与共享包独立编译；网页 `tsc --noEmit -p apps/web/tsconfig.json` 通过；`git diff --check` 通过。
- 完整 `workpaper-progressive.pg.test.js`：14 pass / 0 fail / 0 skip / 0 cancel。包含公开 HTTP actions、真实 PG、真实 Word 字节及 Blob/ZIP 下载，跨账号隔离、成功项保留、并发动作去重、活动 lease/未知用量阻断、两种计费的唯一结算与零冻结。旧最小角色测试夹具补上 0192 预约触发器三列 INSERT，生产权限仍由 #1624/#1628 提供。
- 浏览器定向 7/7：新增桌面/手机 direct 共享失败、四种活动/待处理子状态，以及原充值后恢复路径。真实网页和 Edge，mock HTTP；不证明真实模型或供应商交付。
- 扩展旧浏览器整文件曾得到 9 pass / 18 fail：旧准备页用例路由已跳转统一 file-generation，夹具缺接口而返回 500；改用 legacy 诊断后又确认旧断言查找逐文件复选框，现页已为章节选择。诊断适配已撤除，未修改产品准备页或削弱旧断言，未宣称整文件通过。随后只重跑本次变更及相邻充值恢复 7 项。旧用例更新不纳入本PR。

运行命令（相应独立依赖和数据库已准备）：

```text
BB_TEST_DATABASE_URL=<isolated PostgreSQL> node --test apps/api/dist/workpaper-progressive.pg.test.js
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
# apps/web 中，BB_E2E_BASE_URL 指向本分支 Vite，BB_E2E_BROWSER_CHANNEL=msedge
node ../../node_modules/@playwright/test/cli.js test tests/workpaper-batch.spec.ts --grep "direct shared|direct blocked|asynchronous batch shortage" --timeout=30000
```

日志、SHA-256、两种屏宽原型和实现截图在 [evidence/direct-workpaper-recovery-1631](evidence/direct-workpaper-recovery-1631)。不提交客户原件或模型输出。

## 原型与交付

原型为 product-prototype/public/workpaper-batch.html，commit 73f3cb60c362b1ed77329f1c0e5124415c9ba791；对应迁移页 apps/web/src/workpaper-panel.ts。复用原卡片、操作区和逐份列表；手动暂停仍显示“继续文件包”。shared_blocked 的“重试受阻文件并继续”和“查看任务”复用现有 progressive 用语。旧原型没有该共享失败状态，截图展示同尺寸手动暂停基线与失败实现；不冒充精确同状态原型或用户已验收。视觉检查通过，无横向溢出。

无公共枚举语义、新接口、数据库迁移或运行时依赖。API/web 同批集成；#1624 的受限执行角色授权修复需另行纳入统一发布。PR 未合并，未取得用户验收，未部署。最终统一验收待办：固定集成版中原失败任务真实生成、成果下载与内容/全页检查，以及用户实际操作。

## 2026-11-19：已终结超时显式重试（Refs #1650）

真实原输入回放发现，旧 M4 经 codex_no_lookup 正式终结、释放预留后，unknown 调用仍永久挡住 retry_failed。补丁 ac27e204 仅在显式新执行时允许已确认 MODEL_TIMEOUT/timeout/SIGTERM或SIGKILL、无活动 lease、无冲突或结果、终结审计精确绑定 attempt、fixed_credits/on_delivery 预留已 released 且有 release 无 settle 的 m4_document_v1 codex_exec 调用。缺失或不匹配审计、未证明退出及其他类型继续阻止。旧调用、unknown 用量、观察、失败终态和释放记录保持不变，不复活旧 run。

固定集成候选 865c8037d40067834b74a475c4806e71ba112ce9，隔离 PG16 API 集成 17 tests / 17 pass / 0 fail / 0 skip / 0 cancel。新增用例通过正式持久调用/运行时/观察/对账路径生成旧失败，验证缺少/错审计仍拒绝、并发仅一次成功、新四项完成及唯一结算、旧未知用量和观察不变。供应商输出 synthetic；TAP SHA256 0afd90f8676c1d25fc2dc368dc4f556d1025007127b8bfad1e8f7d1f2e55ed0f。

15:29 本地正式 retry_failed API 已 HTTP 200，三条新 run running，第四项 queued；旧三项 failed/unknown/released 均保留。真实模型 Copilot Enterprise / gpt-6-sol / max / yingx_microsoft，独立数据库和存储。worker 源码在本次 API 补丁前后完全未变，活动 worker 容器未重启。最终 Word 正式下载、内容和全部页面、归属与最终结算仍待完成；不能以自动化成果代替真实验收。

无新增迁移或依赖。代码完成，尚未部署，待统一发布；用户尚未验收。
