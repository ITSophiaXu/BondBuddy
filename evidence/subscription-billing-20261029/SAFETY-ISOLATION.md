# 资金异常隔离与受控恢复验收

2026-10-29，本地合成 PostgreSQL 验证。未部署、未调用真实支付/模型、未对真实钱包执行隔离或修复。

## 交付范围

- `apps/api/src/billing-audit.ts`：唯一审计 SQL，按 owner 可选筛选；`billing-ops.ts` 保留原审计导出，保留原精确整数结算修正。
- `billing-safety.ts`：钱包/渠道共享写许可；独立事务、独占锁、等待后重新核验的持久隔离；独立 `billing_repair` 权限的投影修复和另行恢复；原 requestId 幂等；渠道核验无默认成功。
- `0150_billing_safety_isolation.sql`：不可变 incident 和 audit，受审计恢复事件约束的 active block。
- `0151_billing_safety_sql_writers.sql`：两个任务终态函数及四个退款相关函数在原 wallet 锁前获得相同 safety 锁，保留已安装业务定义。
- `0154_billing_safety_refund_schedule.sql`：调度元数据可更新；退款状态和资金变化仍受隔离限制。
- `withBillingDispatch`：原意图已提交后，持 channel → wallet 共享 safety 锁覆盖外部 create/charge/同请求恢复；回执资金变更在释放该锁后另行处理。
- `lockWalletSafetyForControl`：停止续费、关闭原单等不涉及资金的退出操作可用，不据此授予资金修改权。

## 最终合成结果

`billing-safety.pg.test.ts`：**8/8 通过，0 跳过**。使用已从空库完整迁移至 `0154` 的 `bb_billing_complete_20261029_v2` 的独立 clone，测试后自动清理。日志见 [SAFETY-ISOLATION-TESTS.log](SAFETY-ISOLATION-TESTS.log)。

本次子代理避免竞争修改共享 dist，使用 TypeScript `transpileModule` 将当前 safety/audit/test 源文件编译至 `.tmp/billing-safety-current/`，其余依赖使用 root 管理的 API dist。标准构建后的等价测试入口为 `node --test apps/api/dist/billing-safety.pg.test.js`。集成路径另由 root 的 `billing-safety-integration.pg.test.ts` 和 `payment-reconciliation.pg.test.ts` 验证。

| 场景 | 已验证的结果 |
|---|---|
| 隔离事务与业务回滚 | 独立隔离提交后原业务回滚，block 仍存在；余额查询可用，健康钱包可写 |
| 精确整数与修复权限 | 大于 `2^53` 的 remaining 精确恢复；无 `billing_repair` 的价格发布者被拒；旧 hash 拒绝；同键重试不重复修复 |
| 修复与恢复分离 | 修复只更新推导 remaining/frozen，原始积分/分录/来源/对价不变；修复后仍阻断，另行复核恢复才释放 |
| 并发合法中间态 | 未提交余额变化不进入审计；独占核验等待 writer；等待后的新提交状态被重读，过期候选不会误隔离 |
| 渠道证据 | 缺核验器、超时、空证据均不能恢复；远端 clean 不掩盖本地支付账差；未知查询异常不生成不变量事故 |
| 直接 SQL 终态 | 普通/QA 与 M4 的原 `UPDATE bb_runs` 在隔离时被拒；等待 safety 时探针仍可取得 wallet 行锁，验证锁顺序；恢复后原任务继续正确释放 |
| 已提交支付派发 | 外部工作持共享 safety，隔离等待其完成；后续派发被拒，取消类 control 锁仍能取得 |
| 退款调度和总额边界 | 一个隔离退款不拖住同批健康退款调度；credit 修改仍被拒；每个 lot 合法但修复后账户总量超过 int64 时拒修，原状态不变 |

## 接线审阅

已审阅充值、订阅、退款、后台恢复及动态编制扣费入口。发现并交由 root 修复：无资金变化的付款关闭/原单查询不应使用资金写许可；已派发退款的认证查询可返回原储存状态，不能把隔离中的未入账事实宣称已入账。0154 修复了 SQL refund guard 误挡纯调度元数据的问题。

Root 的新资金写路径取得 safety 后再取 wallet；外部 dispatch 的回调未嵌套同 scope 资金事务；编制进度扣费复用 `lockCreditAccount`，worker 直接终态由 0151 覆盖。已发现问题均有对应修正和合成回归。未验证真实渠道故障恢复、生产连接池负载或真实用户支付。

渠道恢复必须由受信代码提供认证证据和当前复算；CLI 输入不能把普通 JSON 当作认证渠道核验。尚无核验器时渠道继续隔离。该限制明确保留，不能宣称已经取得真实远端对账通过证据。
