# 精确计费与经营事实验证

2026-10-29，本机合成 PostgreSQL 克隆 + Azurite；无真实模型调用或支付商户扣款。

| 日志 | 结果 | 主要覆盖 |
|---|---|---|
| `api-pg-azurite-52.log` | 52/52，0 skip | 钱包 >2^53、并发任务、int64 上界、旧请求重放、支付回调、原对价现金退款、订阅、任务质量返还、trial 使用量与成本账、月度事实报告 |
| `monthly-facts-and-quality-refunds-12.log` | 12/12，0 skip | 报告只读、成熟 cohort、退款重开、缺证与重复/缺失原分配、实际原 lot 返还冲正 |
| `monthly-facts-unit-latest-4.log` | 4/4，0 skip | 最后调整后的报告时间截止与最近有效周期判定；其余报告逻辑未改 |
| `browser-recovery-11.log` | 11/11，0 skip | 新旧恢复信封、原 body/digest、跨任务隔离、原生字符串批量检查和 retry、余额不足后恢复、未知结果不另建任务 |

这些测试集合有交集，不能把通过数相加当作独立测试数量。其后其他 agent 的 batch、安全管理及 UI 修改由根任务的最终构建/回归负责，本目录不宣称覆盖未来改动。

本次最后验证中，`tsc -p apps/api/tsconfig.json --noEmit` 和 `tsc -p apps/web/tsconfig.json --noEmit` 均以退出码 0 完成，未输出诊断。`git diff --check` 没有空白错误，只有仓库现有 CRLF 转换提示。

运行入口为 `apps/api/src/billing-{wire,int64,int64.pg}.test.ts`、`payment-refunds.pg.test.ts`、`payments.pg.test.ts`、`subscriptions.pg.test.ts`、`task-refunds.pg.test.ts`、`payment-refund-calculation.test.ts`、`zz_trial_guard.test.ts`、`subscription-facts-report{,.pg}.test.ts`，以及 `apps/web/src/billing-task-recovery.test.ts`。编译后使用 `node --test`。数据库变量为 `BB_TEST_DATABASE_URL`，Azurite 变量为 `BB_TEST_AZURITE_CONNECTION_STRING`；测试 helper 为每个文件/商户日用例克隆并清理数据库，不连接生产库。

## 独立费用归属复查

- 订阅及充值已付款订单统计为预收订单；认证实付单列。没有将充值、未消费积分或到期积分当作任务收入。
- 兑付使用原 lot `A×p/Q`，未转成现价或一积分一分钱。返回积分沿用同一原对价，已加入实际任务售后的月度归属断言。
- 现金退款只冲现金流；质量返积分冲兑付对价，二者没有对同一收入重复扣减。再次使用返还积分时重新兑付，与此前质量冲正相抵后仍保持原对价。
- 赠额的已核验零对价可以为零；原对价缺证、结算与分配不一致均为 unknown/null，不能以积分面额或零替代。
- 报告不含模型/云费用、支付手续费、获客费用、固定运营支出或税额。因此只报告经营事实和兑付对价，不计算净利润或以此声称达到 60%。供应商 token×费率也不当作已支付供应商账单。
- 跨月订阅复购只使用完整观察窗口；没有 cohort 则没有比率。退款重开、同月重叠单和周期序号不会制造续期。此指标不等于用户活跃留存。

实现口径及 CLI 使用见上级目录 `../../INT64-PROTOCOL-AND-MONTHLY-FACTS.md`。
