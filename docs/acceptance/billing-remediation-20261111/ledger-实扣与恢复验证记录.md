# 实扣、退款与钱包恢复验证记录

工作区：`C:\Users\lezhai\Downloads\Bondbuddy\billing-remediation-20261111`。本记录覆盖本轮账本修复和最终验证；没有访问生产钱包、真实支付渠道或模型接口，没有发布。

## 修复范围

- 新的 M4 按量结算持久化每个原批次的真实实扣，避免将预留 100、实扣 7 错判成账务漂移。
- 历史 NULL allocation 不改写原财务事件；`bb_credit_allocation_charge()` 只在原预留、追加结算事件和可信计量总额一致时推导原批次实扣。证据不足保持 unknown，并阻挡不可靠退款。
- 任务质量返还、整笔修复及数据库 guard 都以原实际扣费为上限。旧申请保留原请求上限，结果如实显示最终返还金额；原申请 100、实际批准 7 记为部分批准。
- 钱包审计覆盖各业务报价族和历史实际扣费。已存在的历史超额返还保持原账不可变并继续隔离，要求独立核查，不自动再返还或追扣。
- 月度事实报表和单任务经济性报表读取相同实扣证据，保留原批次现金对价；历史满额扣费与跨批次部分扣费都能只读汇总，报表不更改钱包。
- 已受理任务遇钱包隔离时保存明确的计费暂停、可用成果和终态意图，不继续消耗失败重试；取消先持久化控制意图，账务独立修复和解除隔离后再释放原预留。provider 待核实仍须单独处理。
- 付费历史超时维修拒绝直接恢复已结算／已释放的旧合同，保留原失败、补偿和输入；不会将旧预留误认为余额不足或重新收费。

## 最终构建与测试

使用已经迁移到 0174 的模板 `postgresql://bondbuddy@127.0.0.1:55439/bb_billing_remediation_final_20261111`；所有写入由 `isolatedTestDatabase()` 创建隔离克隆完成，没有写模板。

1. `npm run build -w @bondbuddy/api`：exit 0。
2. 九个 API 回归文件：**49 passed，0 failed，0 skipped，268.4 秒，exit 0**。
   - 文件：`billing-actual-charge.pg`、`task-refunds.pg`、`payment-refunds.pg`、`billing-safety.pg`、`billing-safety-integration.pg`、`subscription-facts-report.pg`、`commerce-economics.pg`、`commerce.pg`、`payment-refund-dates.pg`。
   - 输出：`ledger-actual-charge-final.log`。
   - Node 计数含嵌套父 test；日志为 38 个顶层 test，总计 49 个 test。
3. 订阅与 worker 超时维修回归：**14 passed，0 failed，0 skipped，38.1 秒，exit 0**。
   - 文件：`subscriptions.pg.test.js`、`unified-timeout-recovery.test.js`。
   - 输出：`ledger-recovery-subscription-final.log`。
   - Node 计数含订阅父 test；订阅 12 个业务子案例和父 test，加 worker 一个 test。
4. `commerce-economics.pg.test.js` 单独补跑：1/1 pass，exit 0；同案例随后包含在九文件最终回归中，不重复计数。
5. 报表和 fixture 自有文件 `git diff --check`：通过。

49 项精确命令（PowerShell，cwd 为上述工作区）：

```powershell
$env:BB_TEST_DATABASE_URL='postgresql://bondbuddy@127.0.0.1:55439/bb_billing_remediation_final_20261111'
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/billing-actual-charge.pg.test.js apps/api/dist/task-refunds.pg.test.js apps/api/dist/payment-refunds.pg.test.js apps/api/dist/billing-safety.pg.test.js apps/api/dist/billing-safety-integration.pg.test.js apps/api/dist/subscription-facts-report.pg.test.js apps/api/dist/commerce-economics.pg.test.js apps/api/dist/commerce.pg.test.js apps/api/dist/payment-refund-dates.pg.test.js
```

14 项精确命令（同一模板）：

```powershell
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/subscriptions.pg.test.js apps/worker/dist/unified-timeout-recovery.test.js
```

两个日志绝对位置：

- `C:\Users\lezhai\Downloads\Bondbuddy\outputs\billing-remediation-20261111\ledger-actual-charge-final.log`
- `C:\Users\lezhai\Downloads\Bondbuddy\outputs\billing-remediation-20261111\ledger-recovery-subscription-final.log`

root 最终回归原有的唯一失败是 economics 测试使用了已不合规的无参考稿旧 fixture。本轮仅补上该用户、该项目持有的合成参考稿版本与原稿信息，保留所有原成本断言；产品必填参考稿门禁未修改。

## 已验证的关键边界

- 新部分结算写入 7 实扣，100 预留余额正常释放，审计健康；并发重复审批最多返还 7。
- 两个历史批次的 NULL 投影按原结算顺序分配总计 7；整笔修复后余额恢复原值，原结算事件完全不变。
- 该场景调用真实 `readSubscriptionFacts()`，逐个原批次断言 `redeemed_points` 等于实扣 slice，合计 7；旧 `COALESCE(a.charged_points,a.points)` 会按预留合计 100，无法通过。断言见 `apps/api/src/billing-actual-charge.pg.test.ts:81`。
- 历史满额扣费三个批次的 NULL 投影，月报与单任务报表保留精确现金对价，读取前后余额相同。
- 该场景同时调用真实 `readRunEconomics()`，断言实际扣费 25,000、`consideration_complete=true`、精确对价 23,400；旧 `a.charged_points>0` 会丢掉全部 NULL slice，无法通过。断言见 `apps/api/src/task-refunds.pg.test.ts:184`。
- 已有历史 100 超额返还、真实仅扣 7：继续识别漂移，禁止追加返还，余额和历史事件不改写。
- 计费隔离后交付、取消与 provider 三种恢复路径都复用原任务；成果不重复生成，结算或释放只有一次。
- 退款消费竞态、未知渠道状态、原付款来源、累计一分取整、Shanghai 退款月份和不可改写的渠道证据均通过。
- 订阅未消费 7 天内可原渠道整期退款；消费、冻结、超时窗口、未知扣款和自动续费授权三态保留原保护。

真实官网、模型、商户支付以及用户验收仍属于统一发布验收；本记录不声明已经上线或已修改客户历史账。
