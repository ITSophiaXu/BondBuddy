# 历史云费用责任输入

Refs #1361, #1418。切换数据库时，原库的真实云操作和节点费用历史必须继续进入当前日预算。现有 `produceExpenseSnapshot` 保持同一计价规则、固定责任、unknown、排空预留及硬 48 元日上限；此补丁只合并受控历史输入，不写入数据库或制造运行记录。

在受保护的池配置中加入唯一输入：

```json
{
  "external_expense_history": {
    "file": "<历史原件的绝对路径>",
    "sha256": "<完整历史 JSON canonical SHA256>",
    "source_ledger_sha256": "<原始完整 ledger canonical SHA256>",
    "source_system_identifier": "<来源 PostgreSQL system_identifier>",
    "source_evidence_sha256": "<来源完整账本导出及核对证据 SHA256>"
  }
}
```

文件使用 `0600`，归属执行控制服务的 UID；目录仅 root 或该 UID 拥有，禁止组/其他用户写入，禁止路径中任何软链接。两个控制入口 `ops-handler.mjs` 和 `reconcile-entry.mjs` 在每次实际 cost snapshot 中读取它。缺失、篡改、来源/时间不符、历史与当前行冲突都会关闭准入。

历史原件结构（金额 0 仅示意字段，必须据真实责任计算）：

```json
{
  "version": "execution-cloud-history-v1",
  "account_id": "<同一账户>",
  "region": "ap-beijing",
  "expense_policy_sha256": "<当前已审费用政策 SHA256>",
  "expense_policy_revision": 1,
  "currency": "CNY",
  "time_zone": "Asia/Shanghai",
  "period_key": "<原始 ledger.captured_at 的 civil day key>",
  "period_start": "<原始 ledger civil day UTC 起点>",
  "period_end": "<原始 ledger civil day UTC 终点>",
  "ledger_sha256": "<原始完整 ledger canonical SHA256>",
  "fixed_obligation_dedup_receipt_sha256": "<已核固定责任和预留去重材料 SHA256>",
  "external_liabilities": [{
    "liability_id": "<唯一具名责任>",
    "kind": "manual_compute",
    "scope": "outside_source_ledger_and_current_quote",
    "source_ref": "<真实原责任材料索引>",
    "source_sha256": "<原责任材料准确字节 SHA256>",
    "coverage_end": "<当日输入等于 period_end；跨日输入至少覆盖已审 valid_until>",
    "resource_ids": ["<账本外资源 ID>"],
    "spent_upper_bound_cny": 0,
    "unknown_carry_upper_bound_cny": 0,
    "remaining_period_upper_bound_cny": 0
  }],
  "source_system_identifier": "<来源库标识>",
  "source_evidence_sha256": "<来源证据 SHA256>",
  "valid_from": "<审核生效时间 ISO8601>",
  "valid_until": "<审核失效时间 ISO8601>",
  "ledger": {
    "captured_at": "<来源完整账本实际采集时间 ISO8601>",
    "nodes": [],
    "operations": []
  }
}
```

`ledger` 必须完整保留来源 `executionCloudExpenseLedger` 的原始 rows，不因更换业务源码、数据库或 civil day 丢弃记录；上例空数组只是结构示意，不是零费用声明。原件与来源证据的真实性/完整性由发布步骤核对并锁入配置。只包装已有实际记录，禁止伪造 `destroyed_at`、Run、Start、Stop、ACK 或费用。尚存活的旧资源仍需当前完整 cloud inventory；未结束资源或未决操作要求来源采集距当前账本不超过五分钟。只有所有资源已真实退役且没有未决操作的原件才能在审核有效期内复用。

同 instance ID 或 operation ID 的完全相同行只计一次；任何不同字节语义的冲突拒绝合并，不能选择性覆盖旧账。没有 node 的绑定 operation 拒绝，不会作为零费用略过。重复读取无累计副作用。账本外责任单独进入 `external_liability_upper_bound_cny`，准入将其计入日上限；不伪装成 compute 运行或 secret/snapshot 固定项。每个责任 ID 唯一，资源不能与合并账本重叠，kind 仅支持 manual_compute、management_calls、surviving_disk、independent_other。固定责任去重材料必须明确排除已由当前 quote 计入的固定项和新池 prospective/drain/resident 预留；不能将旧 preflight 的全部字段重复相加。原始责任材料不含这些字段时，必须先取得真实来源、完整 cutoff 或保守存续上界，不能仅换 version 包装签发。

需要持续跨日复用时，完整原件显式包含以下已审策略，仍使用同一个内容 pin：

```json
{
  "rollover_policy": {
    "mode": "closed_archive_conservative_carry_v1",
    "review_sha256": "<真实闭合来源、覆盖期间及逐责任保守上界审核 SHA256>"
  }
}
```

该模式要求来源所有节点已真实退役（`destroyed_at <= ledger.captured_at`），且无 intent/submitted/unknown 操作。`period_key/start/end` 始终锁定原始 ledger 采集日，不由每次 tick 改写；`valid_from/valid_until` 是一次已经批准的覆盖范围，可以跨日。范围内不可变 archive 自动复用，现有 producer 仍按当前日计算真实原始历史，旧闭合运行不会在新日重新产生当日 compute。代码不会改 hash、延长有效期、刷新审核或伪造 closure。当前仍存活或未决的来源不能声明该模式。

每一条独立外部责任必须增加 `carry_policy: "retain_and_accrue_daily_upper_bound"` 和非负 `daily_upper_bound_cny`，且原 `coverage_end` 至少覆盖上述已审 `valid_until`。审核须据真实 unknown、存续磁盘、管理调用限制等证明此每日上界；无法可靠界定就不能签发跨日输入。确已闭合且无继续耗费的独立责任只有在证据充分时才能填每日 0，不能把未知或存续当零。

整个原始 spent/unknown/remaining 三项上界在后续日仍完整保留，另加从原采集日到当前日的每个后续日已审上界。公式为 `original_total + carry_days * daily_upper_bound`；进入新日的第一个瞬间即预留完整新日上界，夏令时只会向上保守取整。该计算纯粹从不可变来源和当前 producer 时钟派生，重复 tick 不累加，也不会在午夜抹除责任。它可能因保守未决责任耗尽预算而停止新增支出；只有真实后续对账证据才能更新输入，不能自动推定已结算。

没有显式跨日策略的旧当日输入维持原有效期和校验，不被自动延长。任何输入超出原已审有效范围、不可信或没有完整跨日上界仍关闭准入。输出始终绑定 `external_history_sha256`；准入校验拒绝不同历史 hash 的结果。

发布仅更新控制侧 `expense-history.mjs`、`costcap.mjs`、`ops-handler.mjs`、`reconcile-entry.mjs`，并应用经过核对的受保护输入。既有两份节点 OCI 和所有业务生成/收费/node runtime 不变；控制文件即使在旧 OCI 内携带，也不因此更改节点镜像的身份。发布 manifest 分别列控制文件与节点镜像的准确 hash。若撤回补丁，必须先关闭支出准入；源历史未安全计入其他既有入口前，不得靠删除输入重新开放预算。

必要验证：`node --test deploy/tencent-elasticity/expense-history.test.mjs`。同一 suite 覆盖原库责任使预算超过 48 拒绝、恰好 48 边界、重复不叠加、冲突/缺失/篡改/时间/路径及权限拒绝，并验证同一可信闭合 archive 在北京时间午夜及下一日继续准入、外部未知/存续责任仍计入和未审/过期输入拒绝。使用合成记录，没有真实云操作。
