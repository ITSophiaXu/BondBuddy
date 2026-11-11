# FIX05 / FIX06 实现与验证记录

工作区：`C:\Users\lezhai\Downloads\Bondbuddy\billing-remediation-20261111`
基线：`f0b88179`，分支 `fix/billing-retirement-20261111`。本记录覆盖前端计费恢复子任务；验证时未提交、未发布、未访问生产或真实支付渠道。后续提交与合并以主执行记录和 PR 为准。

## 已实现

- 退款现金输入采用精确 int64 分解析，金额限额由原订单服务端资格决定，支持 ¥10,789.20 年度整期退款；积分输入的原有限额保持独立。
- 原订单锁内先查退款收据、再核验资格。消费、任务冻结、退款进度或累计现金预览变化导致的未受理请求，提交持久拒绝收据后才返回 `BILLING_REQUEST_REJECTED`。
- 到期后自动续费授权为 `pending` / `active` / `cancel_pending` 时，手动续费复用原有持久订阅拒绝收据，不产生订单；原已受理订单仍先返回。
- 旧 numeric-v1 诚信核查／退款请求在业务接受锁内确认没有原收据，提交不可变拒绝收据。当前协议的旧 5000 诚信请求同样先查原收据，随后记录确定拒绝。
- 新增 `0170_billing_request_rejections.sql`：拒绝收据不可修改或删除；数据库双向触发器防止已受理请求被拒绝，以及拒绝之后延迟旧进程再次插入 run／refund。
- 前端退款和收费诚信核查只对专门持久拒绝码解除原 pending。通用 `PAYMENT_INVALID` / `QUOTE_CHANGED` / `INPUT_REVISION_CONFLICT` / `CREDITS_INSUFFICIENT` / `BILLING_PROTOCOL_REPLAY_ONLY`、断连、5xx、回执不一致继续保留原键及原金额。刷新不会自动另建收费任务。

## 已完成验证

所有资料及供应商响应均为 synthetic。PG 使用 `isolatedTestDatabase()` 克隆 `postgresql://bondbuddy@127.0.0.1:55439/bb_billing_remediation_20261111`；没有写入审计原模板。

### 构建与单元测试

- API `tsc -p apps/api/tsconfig.json --pretty false`：通过（后续其他 agent 修改公共价格版本后，由 root 统一重建）。
- Web 单测编译 `tsc -p apps/web/tsconfig.test.json --pretty false`：通过。
- `node --test apps/web/dist-test/refund-input.test.js apps/web/dist-test/checkout-intent.test.js apps/web/dist-test/billing-recovery-wire.test.js apps/web/dist-test/integrity-recovery.test.js`：**58 passed，0 failed，0 skipped**。
- 自有文件 `git diff --check`：通过。

### 浏览器（Windows / Microsoft Edge / Vite 5173）

环境：`BB_E2E_BROWSER_CHANNEL=msedge`，`BB_E2E_BASE_URL=http://127.0.0.1:5173`。

1. `node node_modules/@playwright/test/cli.js test apps/web/tests/billing-pending-recovery.spec.ts apps/web/tests/commerce-lifecycle.spec.ts --config apps/web/playwright.config.ts`：**18 passed（48.8 秒）**。当轮新增文件包含 numeric/string 两项旧 5000 恢复、通用 replay-only 与断连保留、年度整期退款四项；commerce 文件包含 14 项。
2. 随后新增另外三种非持久诚信错误控制，运行 `node node_modules/@playwright/test/cli.js test apps/web/tests/billing-pending-recovery.spec.ts apps/web/tests/integrity-continuation.spec.ts --grep "unconfirmed|durable BILLING_REQUEST_REJECTED" --config apps/web/playwright.config.ts`：**5 passed（18.6 秒）**，覆盖普通 replay-only、quote changed、input revision conflict、credits insufficient 与专门持久拒绝后的重新确认。与上一轮有一项重叠，共 **22 个不同浏览器案例** 已通过。

首次 15 项浏览器案例全部通过后，Windows 自动 webServer 清理没有退出；后续改为复用已有 Vite，以上两条命令均正常 exit 0。

### PG / 完整 HTTP wire

命令：`node --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 apps/api/dist/integrity-pending-recovery.pg.test.js apps/api/dist/subscriptions.pg.test.js apps/api/dist/payment-refunds.pg.test.js apps/api/dist/billing-wire.test.js`。

第二轮已通过：

- wire 单测：**6/6**。
- 完整 server + wire 诚信旧 pending：**1/1**。同时验证旧数字协议和当前字符串协议；无收据请求持久拒绝；已有 5000 收据返回同一 run；修改原金额冲突；原预留仍为 5000；数据库阻挡延迟旧 run 插入。
- 退款 PG：**8/8**。含新增消费／冻结资格竞态与持久拒绝、完整旧 wire 未受理／已受理区分，以及原有消费／退款并发、未知渠道保留冻结、原渠道回执、历史赠送积分现金对价、修复返还和累计分位取整。

该轮订阅文件在加载阶段受共享构建时序影响：API dist 已引用 `PREVIOUS_AUTOMATIC_PRICE_VERSION`，contracts dist 尚未导出，出现 ESM 导入失败，**没有执行订阅案例，不计为通过**。首轮新增到期授权三态 HTTP 案例已通过；首轮原订阅续费案例因新增测试改变共享计数而失败，已将该断言改为相对基线计数。已在下列最终补跑中确认通过。

退款竞态测试随后新增“全部余额被任务冻结”的分支，已在最终补跑中通过。

## 文件范围

API：`billing-wire.ts`、新增 `billing-request-rejections.ts`、`payment-refunds.ts`、`subscriptions.ts` 及相应测试；新增 `integrity-pending-recovery.pg.test.ts`。诚信业务 handler 的持久拒绝集成由 pricing agent 完成。

Web：`refund-input.ts`、`commerce-refunds.ts`、`integrity-workspace.ts` 的 pending 拒绝分支；新增 `billing-pending-recovery.spec.ts`，更新退款与诚信回归夹具。诚信 round_id 与范围限制由 pricing agent 完成。

迁移：新增 `0170_billing_request_rejections.sql`，原已部署迁移未改写。

## 最终 PG 补跑与 UI 核对

root 的统一 build-v4 exit 0 后，使用含迁移 0174 的全新模板 `postgresql://bondbuddy@127.0.0.1:55439/bb_billing_remediation_final_20261111`，由 `isolatedTestDatabase()` 克隆隔离库，执行：

`node --test apps/api/dist/subscriptions.pg.test.js apps/api/dist/payment-refunds.pg.test.js`

结果：**21 tests passed，0 failed，0 skipped，85.9 秒，exit 0**。计数为退款 8 项 + 订阅 12 个子案例和父 test；实际独立业务案例为 20 项。到期授权 pending / active / cancel_pending 三态包含在同一订阅案例中。退款消费部分冻结及全部冻结竞态、原键持久拒绝、数据库阻止旧进程迟到插入都通过。上述结论使用当时的 build-v4；账本 agent 随后将另行加强历史 NULL 实扣现金资格证据，该新增补丁需其独立回归。

完整输出：[FIX05-FIX06-pg-final.log](./FIX05-FIX06-pg-final.log)。先前共享构建时序造成的订阅加载失败已由本轮补跑解决。

同尺寸 UI 证据已完成，共 10 张 1440 × 960 PNG；包含年度 ¥10,789.20、五主体及超限反馈、旧 pending 明确重试／持久拒绝解锁、账务核对暂停。均使用合成夹具和真实生产组件，未修改产品布局。原型不包含这些完整异常状态，最接近页面、已核验提交和实际差异均记录在 [UI-原型核对记录](./README.md)，没有宣称像素匹配或生产验收。
