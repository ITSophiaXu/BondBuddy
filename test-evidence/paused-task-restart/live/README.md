# 本地真实恢复链路验证（2026-11-19）

被测源码：`f8f10dff33ed3ceb1b64fcdc32f3e3bdd6f0717f`，PR #1648。此次只增加测试证据，没有修改产品实现。

真实 Vite 网页 → 正常密码登录/Cookie/CSRF → Fastify API → 独立 PostgreSQL 16 → WorkerRuntime 的 claim/租约/检查点 → Azurite 私有存储 → 授权下载。没有浏览器 HTTP mock，也没有给浏览器服务注入 principal。任务准备使用 node --test 限定的历史计费 fixture 创建合成材料与旧任务，浏览器测试使用正常 API 服务。实际任务政策为 authoring_balance_v2，恢复前后保持原 reservation；不代表新建订阅订单或支付渠道验收。

输入锁定、材料准备和模型阶段为可控的 synthetic stages；真实队列负责调度、暂停和恢复。Word 字节明确为合成测试内容，成果通过实际存储和下载链路。未调用真实模型，不代表模型生成质量或其他业务流程的完整验收。未连接生产数据库，未修改生产任务或账务。

## 最终复跑结果

12 项检查通过、0 项失败；机器记录见 [results.json](./results.json)。

1. 正常业务页面显示重新启动入口。
2. 390px 窄屏入口可见，无页面横向溢出。
3. 两个独立页面同时点击，仅一次恢复状态转换；原项目 run 数量、run ID、input_hash、预留 ID 保持不变。
4. 另一个真实 worker 任务占满唯一槽位，目标进入 queued，attempts=0，原预留及已扣积分保持不变。
5. 暂停占位任务释放槽后，worker 实际接单并保存阶段检查点。
6. 在页面中暂停正在运行的任务，刷新后暂停状态、恢复入口和检查点保留。
7. 清除 Cookie 后重新密码登录，恢复同一 run；input_lock、materials_ready 各仅执行一次。model_generation 没有完成检查点，恢复后重新进入该尚未完成的合成阶段。
8. 恢复后 succeeded，真实存储/授权下载返回 HTTP 200、1344 字节 DOCX（PK 签名）。
9. 同一 reservation 从 held 转 settled，合计159900合成积分；按增量记账存在25条 settle事件，合计等于 charged_points，event_key 无重复。不能把逐笔增量结算误当成重复扣款。
10. 账号账本审计 consistent=true；lot/reservation/payment/refund drift 均为空。
11. 另一个真实注册账号请求恢复返回404。
12. 全程没有 /runs/execute 请求，没有页面脚本错误。

测试过程曾修正测试脚本的下载 grant、增量结算断言和外账号请求 reason 字段，随后使用全新任务完整复跑得到上述12/0；没有修改产品实现以适配测试。

## 可手动操作的本功能测试入口

已实际启动并用浏览器登录检查：

- 网页：http://localhost:5549
- 用户名：restart_tester
- 密码：RestartLocal2026!
- 登录后打开：http://localhost:5549/#/projects/ab8d3228-3188-4594-94ee-de2006b5e5d7?step=materials&run=118015b6-a55b-4065-9ad7-4cc1018033e1
- 项目名称：用户操作测试（合成）。交付时该 run 为 paused。

点击“重新启动”，观察原任务进入排队/处理中。当前worker空闲时排队很短；合成模型阶段约15秒后放行生成合成Word。期间可以点击“暂停任务”，待暂停落地后刷新，再点“重新启动”。此环境只包含本PR功能，未作为其他PR的统一本地集成版，用户尚未验收。

API绑定127.0.0.1:3049；网页绑定127.0.0.1:5549；独立PG映射55619、Azurite映射10049。Docker容器分别为 bb-paused-restart-pg-20261119 与 bb-paused-restart-azurite-20261119。没有模型凭据。

本机启动/停止脚本位于本工作区的忽略目录 docs/acceptance/paused-task-restart-live-20261119/start.ps1 和 stop.ps1。停止后在工作区根目录运行 start.ps1 可重启原数据；任务已完成时不会伪造新的暂停状态。脚本与运行目录只在本机保留，不提交本业务仓库。

## 证据

- [暂停桌面](./paused-full-page.png)、[390px窄屏](./paused-mobile.png)、[真实排队](./queued-full-page.png)、[完成页面](./completed-full-page.png)、[手动测试准备就绪](./manual-test-ready.png)
- [数据库检查点与原预留](./db-evidence.json)、[worker阶段调用](./worker-stages.ndjson)

开发和自测完成；代码完成，尚未部署，待统一发布。原有17项组件浏览器测试和PG专项的覆盖边界仍见上级README；本次完整业务页面端到端只覆盖更新任务恢复，其他业务模块没有冒充完成真实模型验收。
