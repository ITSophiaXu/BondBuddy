# 已付全面复核组装恢复的结算修复

2026-10-30。问题：全面复核组装失败后，原任务积分已释放；私有 `reassemble-review` 入口只写入 `review_assembly_recovery`，旧结算约束仅识别 Word 双稿恢复标记，导致原任务恢复成功时仍报 `Credit reservation already finalized`。

新增迁移 `0161_paid_review_assembly_recovery.sql`，不修改已部署的 0160。SHA-256：`2694E715EA6ABB05E2AF519E5AB8B4965F7E24E3B84A7459981447D649E9FDCA`。

新约束只允许同一用户、同一全面复核、原 `on_delivery` 预留已全额释放且未扣费的任务恢复。必须核对不可变输入、原失败事件及诊断、已完成且用量明确的模型调用、唯一结果与提示词快照、私有恢复事件和对应标记；原结果哈希、调用身份或恢复证据不匹配则拒绝。正常交付检查仍然执行，裸标记不构成授权。

私有恢复入口在写入事件后再次核对该约束。成功恢复保留原 `released` 记录，不重新冻结、不补扣，也不新增 `settle` 事件；原有禁止重新发起模型调用的控制保持生效。这属于原失败任务的平台修复，不产生新的免费独立复核入口。

验证使用 `bb_review_repair_20261030_a1` 独立模板（从已冻结 b3 复制后仅追加 0161），测试本身再使用私有克隆。未修改功能服务、已有用户或生产数据，未调用真实支付和模型。

命令：`node --test apps/api/dist/paid-review-assembly-recovery.pg.test.js`。

结果：**3 / 3 通过，0 失败，0 跳过**（2 个子测试和 1 个父测试）。原始日志：[paid-review-assembly-recovery-a1-20261030.log](paid-review-assembly-recovery-a1-20261030.log)。

- 可信原结果经真实 Word 交付流程成功完成；与失败释放后相比，积分批次、预留、积分事件、模型尝试和原结果记录逐行一致。
- 缺少交付成果时拒绝完成，重放成功完成时拒绝再次结算，新增模型调用被 `reuse-only` 规则拒绝。
- 裸恢复标记、错误结果哈希和其他任务类型不能启用该恢复例外。
- 已授权恢复再次失败时仍保持原释放记录，不重复释放或结算；账本审计一致。

现有 worker 恢复测试 `apps/worker/dist/review-reassembly.test.js` 在 a1 私有克隆上通过 **19 / 19，0 失败，0 跳过**。其中真实 journal 路径只复用已存储的原结果；测试将新调用入口设为 `MUST_NOT_SPAWN`，改变工具快照或增加逻辑调用均被拒绝。原始日志：[task-billing-review-reassembly-20261030.log](task-billing-review-reassembly-20261030.log)。

主任务统一升级本地服务至 0161 后，`scripts/billing-functional/review-settlement-smoke.mjs` 经真实 HTTP 和 PostgreSQL 完成 **6 / 6，0 失败，0 跳过**：新建随机账号使用模拟已验证充值；27,195 积分全面复核失败全额释放且扣费为 0；重放失败提交及完成不重复冻结或释放；模拟 Word 成功交付只结算一次；成功任务暴露准确的质量退款单元；账号独立账本审计一致。只新增测试账号，没有修改已有账号，真实模型调用及支付调用均为 0。结果：[review-settlement-smoke-20261030.json](review-settlement-smoke-20261030.json)。

私有恢复命令没有被扩展为公开 HTTP 接口；精确证据恢复由上述 PG 与 worker 测试验证，HTTP 测试覆盖受影响的正常公共结算流程。
