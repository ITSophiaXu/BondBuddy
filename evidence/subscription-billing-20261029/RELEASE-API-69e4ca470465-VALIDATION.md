# 退款日期增量发布镜像验证

2026-10-29。源码提交 `69e4ca470465049700c03ee3290bae2d7ea90f23`；仅本机隔离构建与合成测试，未部署。

原发布Dockerfile的API目标构建成功，镜像为 `sha256:8ccd8ced06c79305e65786430de60adabb9cf3f51a70254eab155fce33c19176`，标签 `bondbuddy-billing-api-local:69e4ca470465-20261029`。运行时Node `v22.23.4`，OCI源码标识及 `BB_RELEASE_SHA` 均匹配。构建完成contracts/domain/rule包/API/worker/Web全部编译和既有候选资产检查；候选规则不因此变为正式批准规则。

上下文来自该提交1,758个Git白名单文件，共30,645,676字节。不含客户样本、真实密钥、`.env`、宿主运行数据、依赖或已有构建产物。原字节和Git blob/SHA256见[清单](RELEASE-API-CONTEXT-MANIFEST-69e4ca470465.json)；[构建日志](RELEASE-API-BUILD-69e4ca470465.log)、[构建结果](RELEASE-API-BUILD-RESULT-69e4ca470465.json)、[版本探针](RELEASE-API-IDENTITY-PROBE-69e4ca470465.json)独立保存。

该镜像内8个测试文件 **56/56通过，0失败、0跳过**：微信退款日期/认证/同号恢复、整数金额、支付宝账单ZIP与签名下载、支付宝支付退款、渠道配置、微信CSV和签名账单下载。见[测试日志](RELEASE-STATEMENT-RUNTIME-69e4ca470465.log)及[结果](RELEASE-STATEMENT-RUNTIME-69e4ca470465.json)。测试使用合成签名密钥和注入响应，未调用商户或模型。

探针和测试容器均无外部网络、无宿主端口和文件挂载、只读根目录；测试额外提供32MiB内存临时目录。仅清理本次核对标签后的精确容器ID。前后清单一致，原12个停止容器及8个卷均未改变。

0157空库/升级、退款日期PG集成及首次失败夹具的修复记录见[增量验证](WECHAT-REFUND-DATES-INTEGRATION.md)。本镜像测试没有连接数据库、启动业务API或复跑旧镜像的代理/worker/OCR验收，不将历史结果转记到当前镜像。商户联调、支付宝CSV语义、真实自动续费及60%经营利润约束仍未完成验证。
