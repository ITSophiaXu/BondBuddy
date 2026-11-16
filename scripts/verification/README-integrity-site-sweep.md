# 诚信核查逐站实测

`integrity-site-sweep.mjs` 使用固定版本的真实官网采集器；没有 API 服务、数据库、用户账号或模型调用。它不是模拟网站测试，也不声称完成模型判定或生产验收。

1. 准备 `BB_SITE_SWEEP_OUTPUT/plan.json`（`integrity-site-sweep-v1`），包含 `inventory_source`、`collector_source`、`network` 与 `jobs`。每项有唯一 `key`、0–7 的 `lane`、完整 `site`、`subject`、`category`，属地项另记 `region`。一个含多个链接的历史项需拆成多个入口，全部通过才允许新选。
2. 在包含对应已编译代码、Playwright 浏览器、字体与原生桌面的专用开发镜像中运行脚本。沿用 `deploy/m1/security/integrity-browser-seccomp.json`、浏览器 sandbox、受控代理与域名限制，不关闭证书或安全检查。挂载脚本到 `/app/scripts/verification/integrity-site-sweep.mjs`，挂载独立输出目录到 `/out`，设置 `BB_SITE_SWEEP_OUTPUT=/out` 和指定 `BB_SITE_SWEEP_LANE`。当前证据使用 `bondbuddy-cdp-1449-test:8209b347`。
3. 每个入口执行产品原本的有界重试。结果逐条写入 `results/`，截图写入 `captures/`；正常结果不会重复执行。`pending` 记录仅是明确的任务预留，不能当作完成证据。每个测试默认有 420 秒独立总时限；可用 `BB_SITE_SWEEP_TIMEOUT_MS` 明确指定 240000–900000 毫秒，后续诊断复验使用 600000 毫秒；触及时记录测试异常，单独复验，不直接认定源站故障。
4. 逐项查看所有通过项的真实查询/结果截图，将 key、首张截图路径、SHA256 及 `query_and_result_visible` 结论记入 `visual-review.json`。全部完成后，从仓库根目录设置同一输出目录，运行 `node scripts/verification/summarize-integrity-site-sweep.mjs`。该脚本拒绝缺项、测试/运行时异常和截图哈希不符；生成公共契约中的可用入口表及完整审核清单。
5. 逐项核对通过项的查询词、结果页面和适用事项，执行 API/页面范围及历史兼容回归。地区不能相互代替；本机公网出口结果不能冒充生产执行节点测试。

2026-11-16 批次的本地计划、原始结果和截图位于 `outputs/20261116-integrity-full-site-verification`（项目主目录），固定的脱敏摘要由 `docs/acceptance/integrity-site-sweep-20261116.json` 保存。代码交付到 develop PR，未自动部署。
