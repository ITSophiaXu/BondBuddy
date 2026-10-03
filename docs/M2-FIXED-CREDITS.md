# M2 固定积分实现与运营

产品规则见[当前决定](product-decisions/2026-10-03-m2-fixed-credits.md)。本切片提供账本、报价、执行结算、前端与充值订单服务接缝；生产商户适配器及真实支付证据尚未完成，默认不启用收费。不能把注入测试渠道的合成验签测试视为真实支付接入。

## 代码与契约

- 唯一公开契约：`packages/contracts/src/billing.ts`、`index.ts`。余额、报价、当前任务收费、充值配置／创建／查询／刷新接口均在 `/api/v1`。
- `billing-classification.ts` 从不可变 M1 输入选择唯一套餐；无法分类的源信息按已批准例外保留免费。
- 迁移 `0087_m2_fixed_credits.sql` 只新增；价格／报价／账务事件不可覆盖。账户行锁串行冻结、发分及释放；交易、队列和 outbox 同事务。失败时无半个 reservation 或孤立任务。
- `billing.ts` 负责冻结和可信积分发放；run 终态触发器统一处理 worker、取消及其他既有终态路径。只按已锁定 P 结算，既有免费 run 默认为 platform_trial。
- `provider-results.ts` 仅对固定价任务把已验证持久化结果与内部 usage 对账分开。未知执行结果、多个结果、归属／hash 错误仍不能复用。原始 usage 不改写成 measured 或零。
- `payments.ts` 的 PaymentProvider 必须由正式渠道适配器实现验签／解密及鉴权查询。生产入口没有模拟支付、任意发分或接收用户自报付款金额的接口。当前服务不加载生产适配器，所以充值配置返回不可用。

## 调价和审计

可信运营环境使用 `node apps/api/dist/billing-ops.js prices price.json`。文件包含 id、八个 prices、effectiveAt、actor、reason。价格 ID 与生效时刻不可重用；更正配置发布新版本。首发值见产品决定，迁移不自动插入或激活价格。

`node apps/api/dist/billing-ops.js audit` 只读核对批次／冻结分配、任务报价／终态事件、支付发分及超过 24 小时的冻结。超时报告不自动认定失败或释放，运营先核实任务和供应商状态。

`correct-settlement correction.json` 仅对已有已结算 run 全额退分一次，文件含 runId、actor、reason；按原分配批次追加补偿，保留原账本及原期限，已过期的赠分适用故障补偿期限。不调用现金退款。

`import-verified-right right.json` 仅限经过核实的原积分权益凭证：owner、source（purchase/existing_grant）、source_receipt、points、expiresAt、actor、reason。原付费权益不能凭演示余额或活动草案推定；非积分旧权益需单独核实转换依据，不能任意换算。重复导入按凭证防重，不追补 M1 试用成本。

## 开启与回滚

1. 正常 PR 评审合入 develop，发版从经过评审的 master 提交部署；不直接推送保护分支。
2. 在目标环境备份并应用新增迁移，核实真实旧权益，导入生效价格。
3. 完成实际商户接入（安全配置、真实回调／查询、金额核对、发分恢复）与生产支付验收；当前缺此步骤，不能宣布 M2 已上线。
4. 通过目标环境报价／P−1／P／并发／双 Word／失败取消验收后，才开启 `BB_PAID_AUTHORING_ENABLED=1`。
5. 回滚只停止新收费／新充值，已冻结任务继续按原模式终态结算，已付款订单仍可对账到账。不得用回滚删除历史账务或永久关闭已付款回调。

测试范围、命令和原型对照在本 PR 验收记录登记；合成测试、真实商户支付、上线版本、用户项目验收分别记录。
