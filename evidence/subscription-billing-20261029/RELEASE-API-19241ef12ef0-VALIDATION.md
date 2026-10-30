# API 镜像增量构建与来源核对：19241ef12ef0

2026-10-29。本轮验证包含 `QaWorkspaceSchema`、`IntegrityWorkspaceSchema` 浏览器金额 wire 修复的固定提交，使用现有 Dockerfile 的 `api` target。构建及身份核对均成功；未部署应用。

## 固定产物

|项目|结果|
|---|---|
|源码提交|`19241ef12ef0289468ec1cb9c72b653b014160ec`|
|Dockerfile / target|提交中的 `deploy/m1/Dockerfile` / `api`，未改写|
|本地镜像 tag|`bondbuddy-billing-api-local:19241ef12ef0-20261029`|
|镜像 ID|`sha256:854478de05dc26f5c91c51470dbe76ac129e87d0579f0e3700c325c1dd326cda`|
|运行时 `BB_RELEASE_SHA`|`19241ef12ef0289468ec1cb9c72b653b014160ec`|
|OCI revision 标签|`19241ef12ef0289468ec1cb9c72b653b014160ec`|
|镜像内 Node|`v22.23.4`|
|镜像用户 / 工作目录|`node` / `/app`|
|基础镜像|`node:22-bookworm-slim`，构建日志记录本地 image `4b150b48b411`|
|执行环境|WSL `BondBuddyM3`，既有本地 Unix Docker daemon / legacy builder；宿主 Node `v24.14.0`|
|构建结果|exit 0；2026-10-29 14:38:03.243Z 至 14:45:07.338Z，约 7 分 04 秒；无超时|
|身份核对|exit 0，Node 主版本、运行时源码 SHA、OCI revision 均匹配|

## 构建证据

构建上下文来自固定 Git 提交的原始 blob，包含 **1,746 个文件、30,529,721 字节**。白名单只包括 Dockerfile 所需代码、配置、公共知识与产品模板；排除 `.env`、私钥、客户/样本/上传/附件目录、运行状态、依赖目录和本机输出。每个文件的 Git blob ID、字节数和 SHA-256 均保存在本轮 manifest。

构建上下文经 WSL drvfs 收集后正常进入 69 个 Dockerfile 步骤。未改依赖安装与公共包层命中缓存；完整 workspace TypeScript 编译、Web 的 `tsc --noEmit` 和生产构建均通过。Web 构建转换 531 个模块；现有 large-chunk 提示没有导致失败。SSE candidate 资产完整性核对通过，但输出仍为 `candidate_only` 且保留原覆盖阻碍，不构成业务能力启用或专业验收。

legacy builder 按原 Dockerfile经过 Codex intermediate stage，本轮使用其既有已验证缓存。构建止于 `api` target，未构建独立 worker/OCR/browser/LibreOffice 运行时镜像。API target 按既有设计包含 worker JavaScript dist；这不等于本轮重新执行 worker 测试。

## 身份核对与清理

以不可变镜像 ID 创建一个临时容器，使用 `--network none`、只读根文件系统、清除 capabilities、禁止权限提升、256 MiB 内存、0.5 CPU、64 进程限制。没有宿主端口、没有挂载，不加载实际 `.env`。容器只执行 Node 版本与 `BB_RELEASE_SHA` 输出；镜像检查独立核对 OCI revision。

临时容器 `fc36ad2bf5d96c53b70a9e0a07553dd3fdc1583aecb39ddebb2123504fd26156` 已在核实本轮标签后按精确 ID 删除，`cleanupSucceeded: true`。身份核对前后的完整容器 ID/名称/状态、卷名均已持久化且逐项一致：12 个既有容器均为 `exited`，8 个既有卷。没有本轮遗留容器或运行服务，未 prune、删除或替换既有资源。

## 与后续提交及历史验收的关系

本镜像的来源始终为 `19241ef12ef0289468ec1cb9c72b653b014160ec`，不改记为后续 HEAD。在本报告核对时，HEAD 为 `685a27ba4db450b903ce88c139b7dad0f0ae39c0`；对 `apps`、`packages`、`db`、`deploy`、`product-prototype`、`scripts/local-integration` 的差异核对仅发现 `apps/web/tests/automatic-task-billing.spec.ts` 的测试变更，没有运行时生产代码、迁移或 Dockerfile 变更。该后续测试版本不包含在本镜像的固定构建上下文中。

此前 `279f13a` 的 [API 构建与代理记录](RELEASE-API-LOCAL-VALIDATION.md)、构建日志/result/context manifest、proxy probe 文件均保持原内容。本轮所有新增原始证据采用独立 `19241ef12ef0` 后缀，脚本拒绝覆盖。

此前四个 M2 worker 用例与 API `/health` 的证据仍对应 [279f13a 固定镜像](M2-WORKER-IMAGE-VALIDATION.md)。本轮按变更范围只重新构建并检查身份，没有复跑这些未受影响用例、代理矩阵或 `/health`。身份核对不代表本轮启动了 API 服务，也不代表真实模型、支付、回调、自动续费或生产部署验收。GitHub Actions 的账单/支出限制仍须单独解除，本机结果不冒充远端 CI 通过。

## 本轮文件

- [构建上下文清单](RELEASE-API-CONTEXT-MANIFEST-19241ef12ef0.json)
- [完整构建日志](RELEASE-API-BUILD-19241ef12ef0.log)
- [构建结果与镜像 ID](RELEASE-API-BUILD-RESULT-19241ef12ef0.json)
- [身份核对与完整前后资源清单](RELEASE-API-IDENTITY-PROBE-19241ef12ef0.json)

本机执行脚本分别为 `.tmp/billing-deployment-validation/create-context-19241ef12ef0.mjs`、`build-api-19241ef12ef0.mjs`、`probe-api-image-19241ef12ef0.mjs`，均固定该提交；未修改原脚本或生产源码。
