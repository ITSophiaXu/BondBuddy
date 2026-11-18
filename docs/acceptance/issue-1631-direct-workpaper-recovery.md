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
