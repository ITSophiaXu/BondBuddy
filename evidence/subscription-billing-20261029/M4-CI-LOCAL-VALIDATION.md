# M4核心API补验

2026-10-29。沿现有M4工作流检查本次金额协议迁移涉及的七个API文件，使用Windows、Node v26.13.0、隔离PostgreSQL v3模板（迁移至0155）、本地Azurite及已配置的Word Python。模型和支付均为合成输入；不冒充Ubuntu/Node22工作流完整通过。

范围为`m4-knowledge`、`m4-workspace.pg`、`m4-fixed-billing.pg`、`m4-dynamic-balance.pg`、`authoring-task-kind.pg`、`workpaper-task-routing.pg`、`project-assistant.pg`。既有`billing.pg`与`review-billing.pg`已验证，本次未重复。

- 初轮17项：13通过、4失败、0跳过，见`completion/m4-seven-fixtures-initial.log`。
- 4项失败均为HTTP金额字符串与旧number断言不一致，分布在`m4-dynamic-balance.pg.test.ts`、`m4-workspace.pg.test.ts`、`project-assistant.pg.test.ts`。
- 仅将这些HTTP预期和相关金额运算改为字符串/BigInt；直接领域函数、价格配置及SQL数值断言保留原语义。没有改生产协议、生产逻辑或启用旧协议写入。
- 三个修改文件定向转译后复验10/10、0失败/跳过，见`completion/m4-int64-three-fixtures-final.log`。其余四个文件的7项在初轮通过，未改动、未重复运行。

17个独立测试最终都有通过证据；不把13＋10表述为23个独立场景。覆盖原任务身份及项目互斥、报价锁定、钱包封顶计费、QA结算、Word交付、失败释放、用户隔离及原请求恢复。M4工作流中的worker/Python/容器条件仍须分别核验，本记录不代替这些范围或真实商户验收。
