# M2工作流关联用例补验

2026-10-29。GitHub Actions在启动前受账户账单/支出限制阻断，因此按现有M2工作流清单补验本地可执行的契约和API用例。Windows、Node v26.13.0、本地隔离PostgreSQL v3模板（迁移至0155）与Azurite；没有支付渠道或模型供应商调用。本记录不冒充Ubuntu工作流整套通过。

## 初轮与修复

`completion/m2-remaining-api-final.log`包含55次测试执行：46通过、9失败、0跳过。9个失败全部保留在日志中，分为：

- 4个旧计费测试仍期待number形式的HTTP金额，且在HTTP返回值上进行数字加法。对应`authoring-progress.pg`、`authoring-dynamic-balance.pg`、`review-billing.pg`、`review-price-activation.pg`。按当前int64字符串协议修改断言，并用BigInt进行跨HTTP金额计算；内部目录、SQL `::int`及兼容领域函数的数字语义保留。没有更改生产协议、启用旧协议写入或降低业务断言。
- 5个上传检查/原稿上传测试缺少稀疏检出中的既有仓库样本。只恢复原先不存在的已授权样本，逐一核对原manifest的SHA-256；没有生成替代文件或修改样本。测试执行在本机与本地Azurite中，未把材料发送给模型供应商。

## 定向复验

|修复后的范围|结果|日志|
|---|---|---|
|上述4个计费测试文件|7/7，0失败/跳过|`completion/m2-int64-four-fixtures.log`|
|原稿上传测试文件|3/3，0失败/跳过|`completion/m2-original-fixtures-final.log`|
|上传检查中原先缺样本的3个测试|3/3，0失败/跳过；用测试名过滤仅运行这些已失败项|`completion/m2-restored-inspection-fixtures.log`|

这些复验与初轮有重叠，不相加成独立场景总数；也没有宣称一次55/55全绿。最初通过的未受影响用例保持原证据，失败项修复后全部定向复验通过。

`billing.pg`、`credit-history`及`payments.pg`已在上一轮计费回归中验证，本轮未重复。M2工作流另有4个worker用例以及Linux运行时条件，须以相应独立日志为证；上述Windows结果不替代这些项目。GitHub执行环境恢复后仍应运行原有工作流，不删除或跳过难测场景。

## Linux worker补验

原Dockerfile的API目标镜像固定于`279f13a0f086ca1048b38058fcc94703763f8b5a`，镜像ID与构建来源见[构建记录](RELEASE-API-LOCAL-VALIDATION.md)。该镜像按既有Dockerfile包含worker JavaScript dist；本次没有另建完整worker/OCR镜像。

在Node v22.23.4及独立Docker内部网络中，临时PostgreSQL空库执行156个迁移至0155，使用临时Azurite及经哈希核实的只读合成CLI夹具。`m2-paid-worker`、`authoring-action-progress`、`authoring-pause.pg`、`provider-reconciliation`四个文件共4/4通过，0失败/跳过。无宿主端口、无真实供应商调用。另启动该镜像的实际API入口，`/health`返回200，仅证明进程与路由启动，不证明外部依赖或商户就绪。

[原始日志](completion/m2-worker-isolated.log)保留测试、镜像、迁移及精确ID清理结果；[执行脚本](completion/m2-worker-isolated.sh)使用本轮专用标签及ID清理临时资源。`FINAL_EXIT=0`、`cleanup_failed=0`。原Windows测试、Linux补验与GitHub工作流是不同证据，不合并宣称整套远端CI通过。

资源清理清单、历史baseline证据边界和复算步骤另见[worker镜像专项](M2-WORKER-IMAGE-VALIDATION.md)。
