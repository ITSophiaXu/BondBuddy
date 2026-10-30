# 资金不变量异常隔离与受控投影修复

2026-10-29。开发实现与本地合成验证；不代表已经部署、真实付款验证或执行真实修复。

发现已提交的余额、预留、充值入账或退款账差后，隔离相关钱包；充值或退款关联的渠道账差同时隔离该支付服务商下的该商户号。正常查询余额、查看原订单和读取已交付成果不依赖写入许可。网络超时、渠道未知、审计查询失败和超时未完成任务本身不构成资金不变量破坏。

## 一致快照与持久隔离

- `billing-audit.ts` 是唯一审计 SQL 来源；`billing-ops.ts` 保留旧导出。`auditCredits(pool, owner?)` 使用只读可重复读事务做已提交状态扫描。
- `assertWalletWritable(c, owner)` 与 `assertChannelWritable(c, provider, merchantId)` 必须在资金写事务中、原钱包锁之前取得共享 safety 锁。实际原订单查询不取得写许可。
- `inspectAndIsolateBillingScope` 必须使用独立事务，绝不能在持有该 scope 共享锁的业务事务内等待调用。隔离取得同一 key 的独占锁，等待原 writer 结束，然后在 `READ COMMITTED` 下复核。仅复核仍有差异才写入 incident、audit 和 active block。
- 初次扫描和独占复核之间已修好的差异不会误隔离。写事务中间态不可见。隔离事务单独提交后，原业务事务回滚不会撤销隔离。
- 原 incident 和所有审计事件不可更新、不可删除。active block 只能引用同一 incident 的已授权 `resumed` 事件释放。

## 操作权限与修复

只授予独立 `billing_repair` 权限的有效账号可以调用恢复和投影修复接口。普通账号、价格发布权限和既有其他 operator 权限均不能取得该能力。权限校验和操作在同一事务，权限撤销等待已经获准的事务。

`repairWalletProjection(pool, {requestId, actor, reason, owner, expectedAuditHash})` 仅处理：已隔离、当前只有 `lotDrift`、调用人审阅的审计 hash 与复核相同的情况。目标 `remaining`/`frozen` 来自统一审计 SQL 的账本推导，按非负 int64 校验 `0 <= frozen <= remaining <= original_points`。不接受目标余额或任意 SQL；不改变原分录、原始积分、来源、有效期或原始对价。修复前后证据追加到审计。同一 requestId 重试返回原结果，换内容冲突。

预留、充值或退款事实差异不能使用投影修复掩盖。过期 hash、非投影差异及推导越界拒绝并留审计。成功修复仍处于隔离状态，必须另行调用 `resumeBillingScope`，取得独立权限、独占锁并重新核验后恢复。

渠道恢复还要求注入 `ChannelSafetyVerifier`：明确返回已验证证据 IDs 和按当前已提交状态复算的差异；缺证据、未知、异常均不能恢复。历史账单的旧“无差异”结论不能替代当前复算。已知本地 payment/refund 差异优先阻断，远端 clean 不能覆盖。

## 调度与接线

`scanAndIsolateBilling(pool, {limit, channels, verifyChannel})` 不安装计时器、不请求模型或支付服务。由既有后台资金恢复 tick 在新资金恢复写入之前调用。默认每批处理 100 个未隔离候选，已隔离 scope 不占批次配额或重复制造事件。错误以 `AUDIT_UNAVAILABLE` 返回，调用方记录运维失败；未知错误不能伪装为账差。

所有新充值、订阅续期、退款创建/派发、入账及任务预留/结算写路径均须按相同顺序接入 guard。worker 或 SQL 触发器直接结算的路径也需要覆盖；仅在 HTTP 接口检查不足以形成隔离。读取或向渠道查询既有订单不受 guard 阻断；查询得来的新入账变更仍须取得许可。

`0151` 在普通/编制与 M4 两个终态结算函数、任务退费、退费分摊和退款相关 SQL 函数的原钱包锁之前插入同一 safety 锁。迁移读取已安装函数定义，精确匹配锁位置，保留历次业务及交付规则。`0154` 允许隔离退款更新调度次数、下次检查时间和更新时间，防止一个已隔离退款拖住整个健康退款批次；状态、资金和其他字段的变化仍须通过隔离检查。

外部 `create`、`charge` 和同请求恢复由 `withBillingDispatch` 在原意图已提交后持有共享 channel → wallet safety 锁，锁覆盖外部请求。回执入账放在该函数返回后；回调内部不能再开启同 scope 的资金事务。停止续费/关闭订单用 `lockWalletSafetyForControl`，仅取得共享锁，不能据此修改资金。

本地验收覆盖隔离跨业务回滚持久化、并发 writer 等待与重读、超过 JS 安全整数范围的投影修复、权限和 requestId 重放、不可变审计、未知渠道不误隔离、缺证据不能恢复、本地支付/积分差异定位及非投影拒修。生产接线与迁移完成前不能宣称隔离已启用。
