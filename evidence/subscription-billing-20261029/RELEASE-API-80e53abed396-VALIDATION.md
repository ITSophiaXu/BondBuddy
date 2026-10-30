# 账单增量发布镜像验证

2026-10-29。源码提交 `80e53abed396299dda33f63041c1c5f8a46780f8`；仅本机隔离构建与合成测试，未部署。

原发布Dockerfile的API目标构建成功，镜像为 `sha256:c1cc516ce0bac1928a1cb6bcc835ca1294e630538a6c2c665c0bfebe218478cc`，标签 `bondbuddy-billing-api-local:80e53abed396-20261029`。运行时 Node `v22.23.4`，OCI源码标识与 `BB_RELEASE_SHA` 均匹配上述提交。构建过程完成contracts/domain/rule包/API/worker/Web全部编译及既有候选规则资产检查；候选规则并未因此成为正式批准规则。

构建上下文来自该提交的1,756个Git白名单文件，共30,608,078字节；不含客户样本、真实密钥、`.env`、宿主运行数据、依赖目录或已有构建产物。原始字节及Git blob/SHA256列于[清单](RELEASE-API-CONTEXT-MANIFEST-80e53abed396.json)。[构建日志](RELEASE-API-BUILD-80e53abed396.log)、[构建结果](RELEASE-API-BUILD-RESULT-80e53abed396.json)与[版本探针](RELEASE-API-IDENTITY-PROBE-80e53abed396.json)独立保存，不覆盖历史镜像证据。

在该精确镜像内执行七个测试文件，**46/46通过，0失败、0跳过**：int64边界、ZIP/编码及换行资源限制、支付宝验签下载、既有支付宝支付/退款、运行时渠道配置、微信CSV和签名账单下载。使用合成签名密钥、ZIP/CSV及注入网络响应；Linux条件配置分支在容器内执行。详见[测试日志](RELEASE-STATEMENT-RUNTIME-80e53abed396.log)与[结果](RELEASE-STATEMENT-RUNTIME-80e53abed396.json)。

版本探针和测试容器均无网络、无宿主端口和文件挂载、根文件系统只读；测试仅额外提供32MiB内存`/tmp`。仅清理本次创建并核对标签的精确容器ID。每次前后完整容器/卷清单一致：原12个停止容器及8个卷均未改变。没有商户或模型请求。

0156空库/升级及业务PG回归由本机隔离PostgreSQL执行，见[增量验证](ALIPAY-STATEMENT-INTEGRATION.md)；本次成品镜像测试未连接数据库、未启动API业务服务、未复跑旧镜像的代理探针或worker/OCR镜像验收，不将这些历史结果转记到当前镜像。支付宝CSV仍未核实，正式日对账和真实商户验收仍未完成。
