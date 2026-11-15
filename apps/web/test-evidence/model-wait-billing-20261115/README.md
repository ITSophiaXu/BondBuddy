# 等待模型名额时的任务及积分提示

关联 #1385、#361。原型来源为 develop `1c35cc257163ce0f822966a00d36cf2840e78751` 的 `product-prototype/public/authoring-live-progress.html`，本次仅新增合成 `model_waiting` 状态及原型切换按钮。实现为 `apps/web/src/authoring-progress.ts`，不新增页面、按钮或任务状态流转。

2026-11-15 本轮用户明确要求修复旧动态计费任务等待共享模型名额期间仍扣积分的问题。根代理据此采纳并授权在既有任务状态卡和积分卡提供准确等待说明，作为本次最小文案补充依据；用户实际验收仍待完成。

## 行为

- 服务端 `model_waiting=true` 且任务运行中时，显示“正在等待模型处理名额”“可用后会自动继续”“等待期间积分不增加，无需重复提交”。积分卡保留原金额、可用余额及有效处理时间，说明等待不增加积分。
- 暂停、积分耗尽、账务核对及终态优先；服务端恢复活动或旧响应没有此可选字段时，沿用实际进度／原有恢复提示。并行还有活动调用时由服务端返回 false，不将整项任务误标为纯等待。
- 不改 run state/stage、不清除历史进度、不重新提交任务、不在浏览器计算或改写扣费金额。

## 同尺寸对照

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型](model-wait-prototype-viewport-1440.png) | [实现](model-wait-implementation-viewport-1440.png) |
| 390×844 | [原型](model-wait-prototype-viewport-390.png) | [实现](model-wait-implementation-viewport-390.png) |

手机完整进度面板：[原型](model-wait-prototype-panel-390.png)、[实现](model-wait-implementation-panel-390.png)。

逐屏核对：等待标题、说明及积分冻结语义一致；没有新增裁切、遮挡或横向溢出。实现保留既有导航、活动时间、步骤圆点、页面续跑说明、动态余额行及原生滚动条；原型保留独立合成状态切换栏、较大字号与简化活动记录。布局差异为既有容器与动态账务内容，本次没有扩大结构偏离。

## 验证

- `node ../../node_modules/typescript/bin/tsc -p tsconfig.test.json`：通过。
- `node --test --test-reporter=tap dist-test/authoring-progress.test.js`：11/11 通过，0 跳过（新增3项：等待与恢复区分、控制／终态优先、动态账单保持原额）。
- Chromium／Playwright，独立 Vite `127.0.0.1:5396`；`project-execution.spec.ts` 的新增模型等待、既有排队暂停结算、余额耗尽及恢复各覆盖1440/390，共6/6通过，0重试、0跳过。新增用例核对刷新后等待状态与原金额、恢复活动、暂停及终态优先、仅一次执行请求和无额外控制请求。
- `git diff --check`：通过。全工作区构建由根代理独立记录。

全部 API、任务、账号和积分为合成夹具；本记录验证页面与交互，不验证数据库实际扣费或真实模型输出。后端计费回归另行记录。完整报告、运行配置和截图位于共享工作目录 `work/model-wait-billing-20261115/frontend`；运行数据不进入仓库。

代码完成，尚未部署，待统一发布；本记录不代表用户已验收。
