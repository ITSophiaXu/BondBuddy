# 支付边界与新旧计费兼容补充验收

2026-11-05，用户要求继续覆盖模拟支付、充值到账、扣款、余额不足后恢复、退款、防重复扣费，并补测新旧计费规则冲突导致任务失败的情况。用户暂时没有具体失败任务；本轮主动构造兼容案例，不将其宣称为原线上故障的复现。

本轮仍使用隔离本地实例、真实 Web/API/PostgreSQL、随机合成账号。支付渠道结果、worker 里程碑和 Word 内容为 synthetic，真实商户与模型调用均为零。以下结果独立于初轮验收；不把重复执行相加为更多场景。

新旧规则以当前代码的不同计费配置与已持久化旧 policy 构造，并非运行旧二进制、旧 schema 的滚动升级测试。最终兼容专项每次领取均执行真实 worker `inputLockStage`，M4 另执行 `loadM4WorkerInput`；再分别运行一次真实 `runPipelineOnce`，保留输入、材料准备、调度、成果登记和结算，仅模型及 Word 产出使用合成阶段。这证明这些生产步骤接受旧任务，仍不等同于真实模型生成或内容质量通过。

## 已复现并修复

1. **续费派发断点无法继续。** 数据库已提交 `payment_dispatch_started_at`，进程在渠道保存请求前中断，后续只查询会一直待付。现在先只读查单，只有明确支持原订单与原授权幂等恢复的适配器才能调用可选 `recoverSameRequest`；不新建续扣订单。无此能力、渠道已存 pending、错订单回执均分别验证。[修复前](followup/renewal-dispatch-red.json)、[修复后](followup/renewal-dispatch-green.json)。
2. **换账号后收银台残留旧订单，迟到响应可能回填。** 接入产品既有会话广播并在重新聚焦时核实身份；先清旧视图，以请求代次和 AbortSignal 拒绝迟到响应。同账号重新核实保留已填退款金额和未确认请求 ID。
3. **旧账号迟到 401 可能在新账号下重放操作。** 客户端拒绝身份或 cookie 已变化时刷新／重放；本地控制服务同时绑定原 `owner_user_id`，即使使用有效新账号 Cookie/CSRF 直接重放，也在业务执行前拒绝。案例 11 验证真实旧请求 401 与主动取消；案例 12 绕过客户端保护直接检验服务端，返回 403，两个账号订单、测试时钟与积分来源均不变。
4. **固定测试提示条遮住退出按钮。** 按实际提示条高度为桌面侧栏及浮动入口留出空间，真实 Edge 点击退出通过。
5. **不同计费配置的 API 共用 Pool 时互相覆盖。** 先建立自动计费 API，再建立旧规则 API，会把前者目录改为旧模式、将可执行报价变成 `pending_scope`。现在将 API 配置放入请求异步上下文，事务显式 pin 优先于请求、请求优先于独立 worker 的 Pool 默认值；四轮强制重叠请求及事务验证隔离，历史价格 pin 正常恢复。[修复前](followup/billing-policy-conflict-red.json)、[修复后](followup/billing-policy-conflict-green.json)。此条件不等同于常规单实例线上部署，尚不能用于归因用户原故障。
6. **多标签对旧事件点击可能多续扣一期。** 两个独立浏览器存储的真实 Edge 标签持相同已展示事件、各生成不同请求 ID，原实现确实多扣一期，见[真实浏览器首红](followup/subscription-two-tab-red.json)。服务端现在在账号事务锁内核对期望事件，过期请求只返回当前状态，不能推进另一月。同原 ID 的迟到成功不再误报失败，短时 Web Locks 保护持久记录，保留后继未知请求。[共享成功确认首红](followup/shared-storage-red.tap)、[锁等待换号首红](followup/storage-session-red.tap)。
7. **旧版本未知续费请求失去恢复入口。** 新事件绑定不能直接拒绝已有 `{id}` 记录；[首红](followup/subscription-legacy-pending-red.json)保留了这一前置兼容问题。旧记录现在只核对原已存在事件，找不到原事件不新建、不推进；当前没有下一事件时仍可核对原请求。另保留[原始旧标签请求绕过页面保护的首红](followup/subscription-legacy-raw-red.json)，服务端强制所有无期望事件的 HTTP 请求仅核对旧 ID，不能依赖新版页面补标志。

收银问题保留[首轮失败](followup/cashier-edges-red.json)和[最终结果](followup/cashier-edges-green.json)。错误响应不是伪造：先完成真实服务端处理，再在浏览器侧丢弃或延迟响应。聚焦保留输入一项使用显式 focus 事件注入，未当作 headless 原生窗口聚焦验证。

## 实际执行结果

| 专项 | 结果 | 关键断言 |
| --- | --- | --- |
| [真实 HTTP 并发／退款来源](followup/payment-concurrency.json) | 12/12 | 8 次同键充值、6 次同键启动、独立任务竞争、退款竞争和重放、冻结不能被任务消费、跨来源消费与逐源退回；6 账号 audit 一致、无遗留活跃任务 |
| [续费断点](followup/renewal-dispatch-green.json) | 10 checks，5 branches | 原订单恢复只形成一条渠道扣款和一批积分；无恢复能力不重扣；已知 pending 不变 paid；错回执拒绝 |
| [真实进程停启](followup/process-restart.json) | 8/8 | 实际两次不同进程启动；待到账、退款冻结、预签回调、余额不足任务及检查点持久恢复；终态重放不重复入账、退款或扣费 |
| [真实 Edge 收银边界](followup/cashier-edges-green.json) | 12/12 | 最终 async／Web Locks 版本：到账／退款丢响应、刷新恢复原请求、双标签同 UUID 退款与成功响应错序、换号及迟到响应隔离、无效金额不发请求、退出可点击；16 账号 audit 一致，页面异常及外网请求均为零 |
| [真实 Edge 多标签续费及旧请求恢复](followup/subscription-two-tab-green.json) | 4/4 | 同旧事件不同 UUID 只推进一期；同 UUID 成功响应错序；处理后丢响应沿原键恢复；旧 ID 已存在／未受理／失败后无下一事件三分支均不多扣 |
| [续费最终回归](followup/subscription-renewal-final.json)／[套餐变更最终回归](followup/subscription-change-final.json) | 12/12、10/10 | 服务端强制旧 HTTP 仅核对后再次执行；新事件带核实快照，重放复用同一请求 ID 和原快照，无跳过 |
| [旧 review 任务交给新版 API／worker](followup/billing-policy-compatibility.json) | 10/10 | 同库同账号，旧 v2 报价以 1 积分启动、补款仍沿原检查点与规则；旧 on_delivery 成功／失败／取消；旧赠分包与新充值混合消费及按原对价退款；真实 pipeline 交付三份合成文件按旧 27195 结算 |
| [旧 M4 文档任务交给新版 API／worker](followup/m4-billing-policy-compatibility.json) | 10/10 | 实际上传合成 DOCX、保存 draft、旧 4500 v2／历史固定价、部分补款恢复、尾款结算；双文件 artifact 和哈希不变，下载字节一致；另用真实 pipeline 接管历史 on_delivery 并按旧 4500 结算 |
| [同 Pool 多配置并发](followup/billing-policy-conflict-green.json) | 15/15 | 原四项失败转绿；请求和事务并发隔离，显式历史合同价格 pin 优先且恢复；独占随机空库执行全部迁移后自动清理 |
| [自动与成果计费 PostgreSQL 回归](followup/billing-policy-regression-final.tap) | 24/24 | 自动计费、按文件计费、价格版本、复核、成果计费；补齐旧测试缺少的参考材料，保留原业务断言 |
| [渠道与客户端单测](followup/mock-unit-tests.tap) | 29/29 | 原请求身份绑定、401 单次恢复、换号拒绝重放、签名与渠道事实约束、金额和未知请求键；共享成功确认、后继记录保护、锁等待换号及退款记录并发 |
| [原核心订阅 PostgreSQL 测试](followup/core-subscriptions.tap) | 19/19（含 2 个父测试） | 原核心订阅及年付账务回归；不再重复累计内部 17 项 |
| [会话过期](followup/panel-session.tap) | TAP 1/1，内部 7 项 | 真过期仅一次刷新；403／500／未知网络结果不自动重放 |
| [完整 workspace build](followup/workspace-build.log) | exit 0 | 原 bundle-size warning 保留 |

本轮还重新执行原生命周期 15/15、续费 12/12、桌面收银 7/7、原任务补款恢复 9/9。停启及这些原回归在本轮后续配置隔离改动之前执行；最终配置修复由上列定向 PG、兼容 pipeline 及完整构建验证，不冒充所有旧报告均来自最终代码。

最后一次服务端事件防线改动后再次定向执行上列续费 12/12、套餐变更 10/10、多标签 4/4；此前结果先归档于 `.runtime/subscription-event-guard-20261105-e40d6a/previous/`。最终服务保持就绪，专用数据库与合成测试记录保留以便继续验收。

## 新旧规则覆盖边界

旧 review 测试通过真实旧充值配置与订单接口购买 50,000 分现金对价、52,500 积分的旧包，再通过新版 API 查询和重放；没有直接写余额。与新版 1:1 充值混合后核对实际消费来源。平台失败返还的旧包积分按原对价退款，不能将赠分当作等额现金。

同库不同进程配置没有复现规则冲突，旧任务依靠持久化报价、reservation policy、input lock 和 checkpoint 继续执行。同一 Pool 被多个配置实例覆盖的真实失败已修复并定向验证；该触发条件仍必须与一般单 API 线上部署区分。

历史 M4 固定报价目前没有重新生成的公开入口，专项仅追加三条明确标注的历史报价 snapshot fixture，未修改既有 quote、reservation、run 或余额；之后的启动、预留、接管、交付、失败和取消都走产品真实实现。M4 合成正文及编制说明不作为内容质量验收。

定向 PG 首轮 6 项因新的参考募集书必填规则在前置条件处失败，见[原失败说明](followup/billing-policy-regression-source-prerequisite.json)。测试补齐 owned synthetic reference、原稿声明和材料版本后 24 项全绿，未放宽计费断言。

桌面状态对照：[退出后仍残留旧订单（修复前）](followup/account-after-logout-before.png)、[退出后清空旧内容（修复后）](followup/account-after-logout-after.png)、[退出按钮可点击](followup/logout-reachable-after.png)。

## 复现及限制

命令见[本地测试说明](../../scripts/billing-functional/README.md)。涉及任务队列的脚本顺序执行；进程停启脚本独占实例。原始失败及后续结果仍保留在忽略的 `.runtime/` 和 `.local/`，此目录复制可审阅结果，不包含 Cookie、CSRF、会话或渠道签名密钥。

这些结果证明本地模拟支付和实际产品账务链路，不证明真实商户收退款、线上部署或真实生成内容质量已验收。GitHub Actions 因仓库账户付款／支出限制未启动，不能标为通过。原全站桌面体验与文件生成质量目标仍需继续完成。
