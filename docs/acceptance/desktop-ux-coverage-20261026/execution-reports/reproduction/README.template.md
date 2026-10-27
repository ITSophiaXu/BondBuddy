# 准确执行版本的结构化复核报告验收（本地，未发布）

2026-10-27，起点 `{{BASE_COMMIT}}`，分支 `codex/desktop-ux-coverage-20261026`。测试用户、项目、报告和材料均为 synthetic；采用真实 PostgreSQL 16、应用读写路径与租约。没有真实模型/供应商、支付、Azure 或客户材料验收。本轮未新增 Word 内容/交付或桌面浏览器验收；相关回归集合的既有执行不升级为这些能力的新验收。

## 实现与校验边界

0128 新增 canonical `bb_review_execution_reports`，主键 `(run_id,execution_version)`、全局唯一报告 ID、完整 owner/project/run/execution/input revision/hash 双 FK，分别绑定不可变执行与复核业务快照。旧表保留；V1 bridge 和 trusted writer 的镜像均原子核对完整身份、业务版本、正文、hash 和 PostgreSQL 微秒时间。canonical-only 读取与关系 view 不依赖 legacy mirror；显式报告在 Word final 交付前仍可读。

SQL 验证 hash 格式、基础 envelope、存储身份、冻结 input/source pin 与 legacy exact copy。报告 evidence locator 允许 JSON 数字和 Unicode key，不能复用 editor 的 SQL canonicalizer；SQL 不重算或声称证明 JavaScript canonical 摘要。可信 writer 与每个正文 reader 使用唯一 contracts `isReviewReport` 和 `inputManifestHash`，并核对冻结 manifest 的 source/scope/version/operation 和 follow-up 来源 ID/hash。格式正确但错误的历史摘要在应用读写路径拒绝，不将 SQL 的精确复制当作摘要真实性证明。

登记事务按 project→run→job 锁定、重新验证 live lease 与固定执行输入。滚动旧 writer 的 40P01 仅重试完整幂等登记事务；不重复模型或 Word 工作。新插入后复验失败抛错回滚，`ON CONFLICT` 未写入时保留原不可变报告。源报告按持久身份解析，不借消费任务 lease 或 current run input，不回退旧报告。

## 采用结果

{{ADOPTED_TABLE}}

{{RAW_DETAILS}}

skip 按原 Node summary 保留，不计作通过。每个采用集合必须有一个完整 summary，tests/pass/fail/cancelled/skipped/todo 可核对，fail/cancelled/todo 均为 0；不将不同集合或失败重试的计数累加为覆盖率。collector 按约定自动选择各 mode 最新成功记录；如果它之后还有同 mode 失败，另见该采用记录的 `later_same_mode_failures` 及下面完整失败清单，不把较早成功称为较新失败已通过。

构建记录：

{{BUILD_DETAILS}}

{{MIGRATION_DETAILS}}

## 冻结与失败记录

{{FREEZE_DETAILS}}

最终 source/build inventory 再次与当前树逐字节核对。范围包括 API/Worker 源码与构建、web 源码/测试与 unit 构建、contracts 源码/构建/examples、迁移、包配置、当前 verifier/config，以及 **Python 源码**。只跳过目录名为 `__pycache__` 的缓存；其他文件仍纳入。外部 Node/Python/PostgreSQL runtime 二进制未冻结。原始 verifier 的所有使用版本按 SHA 保留，当前 config 仅作为 reproduction provenance 保存，本轮没有采用浏览器结果。

所有失败与重试原始记录：

{{FAILURE_DETAILS}}

轮次间准确差异见 `summary.json.source_transitions`。未配成成功 before/after 的 baseline 单列保留，不将其称为成功冻结。

## 本地清理与重现

{{CLEANUP_DETAILS}}

本目录的 collector 只读本地记录和源码，不连接数据库、不启动进程、不运行测试。所有校验完成后才创建全新 acceptance 目录，所有输出均 `wx` 禁止覆盖，最后写 manifest。原始 command/start/result/run.log 完整保留；准确命令、环境白名单、时间和退出码见各 receipt。重现需已有仓库依赖、父目录 embedded PostgreSQL 与记录的 Python，使用 `reproduction/verify.mjs`；本次未启动生产服务，也没有 push、PR 或部署。

## Goal 状态与限制

G03 / UX-A03 与完整 UX goal 保持 **active、未完成**。全局 V1 gate、current-input integrity view 和 immutable run origin 未开放新输入采用；storage key 可表示执行版本不等于可以执行 V2。本轮没有补料采用、同 run successor、定价或新增 ledger 授权。

用户已选 B：必要重做另行报价，确认追加金额后继续；B1/B2 计算规则尚未确定，本轮不自行定价或新增扣费。真实旧工作复用与增量处理、同 run 补料后继续、新 Word 桌面完整旅程、M4/其他消费者迁移与 retention/cleanup 后续边界仍需分别完成。本档案不重算整体旅程覆盖率，旧 sealed archives 保持不变。
