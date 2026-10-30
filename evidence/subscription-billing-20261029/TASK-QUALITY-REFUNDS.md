# 任务质量售后：部分退积分与独立审批

2026-10-29。本记录为本地开发与合成数据验证，不代表真实客户质量认定、真实退款或生产上线。

## 已交付

- 客户在任务消耗记录选择“申请任务售后／查看进度”，按原已结算条目申请并填写原因；请求中没有最终金额。
- 独立售后管理页 `#/billing/task-refunds` 可读取申请、核实原因、批准全部或所选部分条目，或拒绝申请。未选择的申请条目随本次决定拒绝；客户有补充证据时可重新申请未返还条目。
- 审批需要 `task_refund_approve` 权限，按原权限授予记录在同一事务内加锁复核；不能审核自己的申请。无权限不能读取客户申请或执行审批。
- 审批决定、原片段返还、新积分 lot、correction 事件在同一事务完成。重复原请求只读原结果，重复或并发不同请求不能超过原实扣。
- 这是任务退积分，未调用支付渠道发起现金退款。返还积分继承原 lot 的现金 A/Q、原支付单及订阅属性；永久充值保持永久，有限期 lot 的平台质量返还至少有 7 天可用期。
- 用户端与管理端都保存结果未知的原请求；刷新或重试核对原申请，不生成替代金额或新的扣返记录。

## 部分范围与账本证据

`0147_task_quality_refunds.sql` 在新增 `bb_credit_allocations` 的同一受理事务提交前执行 deferred constraint trigger。原 scope 条目顺序与原 lot 冻结顺序共同确定 unit→lot 分片，并持久保存算法版本、原报价和条目。售后申请读取这份原始分片，不在申请时重新推测新任务的资金来源。

QA 还校验原成功交付的逐题结果；文件检查校验逐 file_version 结果。底稿独立检查本身已按每份独立 run 处理。无原独立分配的历史任务明确显示为历史整项成果，仅允许该整项售后，不伪造原本不存在的独立分配。

`0149_task_refund_legacy_coverage.sql` 使历史整项返还撤销该任务全部后续权益；新部分返还只撤销相应源 item key。`commerce-coverage.ts`、`project-qa.ts` 与价格模块的文件检查权益校验采用同一 helper。

原 `correctSettlement` 仍可处理整项修复，但只退尚未返还的原 lot 分片，并与部分售后共用账户锁。两条路径并发也不会超退。

## 验证

| 证据 | 结果 | 内容 |
|---|---:|---|
| `completion/task-refunds/pg-final.log` | 6/6 | 5 个业务子测与父测试；真实 PostgreSQL 隔离克隆、冻结事务提交、合成 Word 交付证据和真实 finish；跨 lot 原 A/Q、活动非现金来源、订阅期限、部分审批、幂等、并发整项修复、交付不完整、历史整项、HTTP owner 隔离、独立权限及撤权 |
| `completion/task-refunds/browser-int64-final.log` | 25/25 | 22 个订阅/充值页面用例与 3 个任务售后用例；新增原解约状态刷新、12 个任务各自范围及包含内容、零积分任务仍可读；新客户端 mock 均按明确 DTO family 输出十进制整数字符串 |
| `completion/task-refunds/browser-order-detail-final.log` | 31/31 | 在上述用例上新增 6 个历史订单明确分类与读取失败恢复场景；不再从最近 50 期列表推断订单类型 |
| `completion/task-refunds/pg-order-detail-final.log` | 4/4 | 3 个子测与父测；第 51 期订单、跨用户/未知订单、明确充值 null、缺周期和不一致金额失败关闭；详情金额原生十进制整数字符串 |
| `completion/task-refunds/checkout-int64-final.log` | 9/9 | 新 version 2 字符串意图；旧 number-v1 原数字请求与 request id 不变；高于 JS 安全整数的 order 记录仍精确；未知结果、跨页并发与终态观察 |
| `apps/api/src/automatic-file-billing.pg.test.ts` 的新增部分退款用例 | 由价格模块代理验证通过 | 两文件实际检查交付后，仅退一份；未退文件及其原零价续做报价保留，已退文件旧续做报价失效，新一轮只对已退文件收费 |

API 测试使用 `isolatedTestDatabase` 克隆至 0149 的本地模板；没有直接在模板跑业务测试。测试迭代对新 TypeScript 文件作隔离转译并引用父任务统一构建的其余 API；最终完整类型检查、构建和发布由父任务统一进行。

## 截图

- `completion/task-refunds/task-quality-customer-1440.png`：客户原条目选择与审核通过进度。
- `completion/task-refunds/task-quality-customer-390.png`：390px 页面及任务售后，无横向溢出。
- `completion/task-refunds/task-quality-reviewer-1440.png`：独立售后管理中的部分返还结论。
- `completion/task-refunds/subscription-cancellation-pending-1440.png`：解约待确认时只保留原解约刷新入口。
- `completion/task-refunds/subscription-all-task-scopes-1440.png` / `subscription-all-task-scopes-390.png`：全部 12 个任务的独立计费范围与已包含工作。
- `completion/task-refunds/subscription-original-period-outside-50-1440.png`：所选原订单不在最近 50 期，仍显示原订阅有效期和整期退款；`subscription-original-period-card-1440.png` 是上方支付卡片区域裁切，便于查看。

这些截图使用合成用户、合成问题与 mock HTTP 回执；不含客户材料或真实支付信息。
