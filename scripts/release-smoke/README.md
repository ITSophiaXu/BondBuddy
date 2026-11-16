# 本地发布前基础流程检查

`npm run test:release` 在独立的本地 Docker Compose 项目运行待发布版本，使用一个新建的 `release_test` 账号验证任丘九月募集书更新、东营复核、东营七题问答。先按顺序提交三个独立项目，再核验各自的持久任务和下载，后台可使用现有 worker 并发槽位。真实材料、网页、API、PostgreSQL、Azurite、worker、模型调用和浏览器下载都参与执行。不会修改生产环境或发送真实支付请求；初始测试积分明确为 synthetic。

本地 worker 启用异步上传确认消费者，在自身 parse 卷内使用独立、有界的暂存目录。上传检查等待同一原文件声明的最终 HTTP 200 并核对 material/upload ID、版本、持久时间、原文件名、字节数和 SHA-256；HTTP 202 仅表示已排队，不能当作材料已保存。等待预算与网页现有的十分钟确认预算一致。Windows 上传使用 Playwright 原始字节、文件名和 MIME，避免长路径在 Edge 中变成空文件；报告明确记录这项浏览器传输适配，不改样本字节。

## 运行

需要 Node 22+、Git、Docker（Linux containers）、Compose、Buildx、Playwright 浏览器，以及可用于现有适配器的 Copilot 授权。Mac 可用 Docker Desktop / Colima，Windows 在 PowerShell 使用 Docker Desktop 的 WSL 2 Linux 后端；业务容器始终是 Linux。

Docker context 按环境变量 `BB_RELEASE_DOCKER_CONTEXT`、本机配置 `dockerContext`、恢复报告中记录的 context、`docker context show` 的顺序选择。接受本机 Unix socket 和 Windows 本机 named pipe，拒绝 SSH/TCP 远程 Docker 以及远程 named pipe。仅网页端口5288绑定在本机回环地址，数据库与存储不发布端口。

Mac 的一次性安装及运行：

```sh
npm ci
npx playwright install chromium
npm run test:release -- --ref HEAD
# 本机已有 Edge 时也可使用：
BB_RELEASE_BROWSER_CHANNEL=msedge npm run test:release -- --ref HEAD
```

Windows PowerShell 对应命令（先进入本机仓库目录）：

```powershell
npm.cmd ci
npx.cmd playwright install chromium
docker info --format '{{.OSType}}'  # 应为 linux
npm.cmd run test:release -- --ref HEAD
```

Windows 通过系统 `tar.exe` 展开源码和样本，保留启动进程所需的 Windows 系统环境变量；不会继承业务数据库/支付/模型或远程 Docker 连接变量。挂载使用 Compose 的长格式，支持盘符、空格及中文路径。本次私有运行目录与 OAuth 副本使用 Windows ACL 限定为当前用户和 SYSTEM；Mac 使用原有文件权限。脚本不修改原凭据文件权限。

使用仓库 `deploy/m1/Dockerfile` 的正式 api/worker/web targets，从固定 Git commit 的 archive 构建，不包含工作区未提交的产品代码。报告记录 SHA、tree、镜像 ID、样本 hash、任务 ID 和下载文件 hash；发布时应使用本次验证过的镜像。改动产品代码后先提交，再验证新的提交。

不带 `--ref` 时要求工作区干净，避免用旧提交的通过结果误认未提交修改已通过。显式 `--ref` 表示只验证指定提交；报告始终写出解析后的完整 SHA。

默认构建本地 Docker 引擎的原生架构；本机 Apple Silicon 为 `linux/arm64`，常见 Windows x64 机器为 `linux/amd64`。需要指定架构时用本机 JSON 配置 `"platform": "linux/amd64"`，或设置 `BB_RELEASE_PLATFORM`；非原生架构需要引擎提供对应仿真。报告记录实际镜像架构，不把一种架构的结果冒充另一种架构已经验证。

默认模型沿用现有适配器 `copilot_enterprise / gpt-6-sol / max`，凭据默认读取当前用户的 `~/.local/share/copilot-api/github_token`，可用 `copilotOAuthFile` 或 `BB_RELEASE_COPILOT_OAUTH_FILE` 指定已有 OAuth 文件。Windows 推荐明确配置实际文件路径，例如 `C:/Users/your-name/.bondbuddy-test/copilot-oauth`。这是 Copilot OAuth 文件，不是任意厂商 API key；测试人员应由项目负责人按现有安全方式取得可用凭据，不在聊天或命令行粘贴令牌。

通过正式 credential helper 交换短期令牌，不要求安装本机 Copilot API 代理、不修改代理配置、不静默切换模型。凭据不进入镜像或 Git，运行目录受本机文件权限保护。模型调用会使用该账号的额度。

网络需要本地代理时，显式设置容器内可访问的 `BB_RELEASE_HTTP_PROXY`（例如 Colima 的宿主地址 `http://192.168.5.2:10808`）。它用于依赖下载及模型请求，数据库/存储走内部网络。不要填写带用户名或密码的代理 URL。必须安装并启用 Docker Buildx，旧 builder 不支持此仓库的 Dockerfile 专属忽略规则，脚本会提前拒绝。

本机固定设置可保存到已忽略的 `scripts/release-smoke/.local.json`，之后直接运行 npm 命令。可用字段为 `dockerContext`、`httpProxy`、`platform`、`copilotOAuthFile`；环境变量优先。不把令牌内容写入此文件。例如本机 Colima 配置：

```json
{"dockerContext":"colima-bondbuddy-release","httpProxy":"http://192.168.5.2:10808"}
```

上面的 `192.168.5.2` 是这台 Mac 的 Colima 宿主地址，不是通用 Windows 地址。Windows 示例可只写：

```json
{"copilotOAuthFile":"C:/Users/your-name/.bondbuddy-test/copilot-oauth"}
```

脚本接受 Windows PowerShell 生成的 UTF-8 BOM 配置文件。除明确设置的配置外，不会复制其他人的网络、用户目录或凭据位置。

Mac 使用专用 Colima 时，重启后如 VM 未运行，先执行 `colima start --profile bondbuddy-release --activate=false`。Docker Desktop 用户打开应用并确认 Linux 引擎已启动即可。不需要在 Windows 安装 Colima。

启用 AppArmor 的 Colima 实例会加载该候选版本的 `bondbuddy-codex-v1` 配置；其他 Linux 引擎须预先按仓库脚本安装该配置。缺少配置时拒绝启动 worker，不改用 privileged/unconfined。所有平台保留只读根目录、cap_drop ALL 和 Codex 文件权限，并沿用本地集成测试对 proc mount 的额外限制。

样本来自既有授权批次：9 月任丘九月，以及 PR #903 的固定数据提交 `6480f7c1bda41e3d49dc757e1b305de21de4edfa` 中的东营原件。后者无需合并产品代码；本地需要已有该 Git object（缺少时先 `git fetch origin codex/regression-samples-20261105`）。每次复制后校验 SHA-256，原件不裁剪、不改写，源生产 ID 不重放。

这是使用真实原件新建的基础流程：任丘目标为 2023、2024 年度及 2025 年 1–9 月，原稿截至 2025 年 6 月；东营复核走当前默认完整复核，问答使用原七题。没有恢复原账号的历史报价、暂停状态或补充要求，不宣称精确重放旧任务。

## 判定与证据

- 三条流程全部完成，并能从页面下载相应 Word，才返回 0。
- 任一失败、暂停、超时或未执行均返回非零；`report.json` 保留每项状态和原因。
- 更新检查双 Word；复核检查报告；问答检查七个问题都有可见内容和回答 Word。刷新后再次读取成果。
- 这是基础功能冒烟检查，不声称验证了全部财务数字、专业结论、全部排版、收费渠道、跨账号权限或浏览器兼容性。
- `.runtime/<时间>/` 内保存报告、截图、trace、日志和成果，均为本地私有数据，不提交 Git。trace 会包含这个测试账号的会话，只在受控本机查看。

任务已提交后不自动重建或重试模型。保留独立容器供诊断，可以按报告目录继续检查原任务：

```sh
npm run test:release -- --resume /absolute/path/to/scripts/release-smoke/.runtime/<run>
```

`--resume` 跳过已经通过的用例，已记录 run ID 的用例只读取原任务并重试成果检查。首次提交前失败的用例可能新建测试项目。继续检查前自动保存报告副本，每次尝试使用独立证据目录，保留原始失败和 trace。

全部通过后自动清理本次容器和测试卷，保留本机报告、trace、下载成果和镜像缓存，释放 5288 端口供下次执行。需要手动查看测试账号时加 `--keep`。清理失败会返回非零，报告仍保留各业务流程已通过的事实。

失败或未完成时保留环境，不自动停止业务任务。此时先用 `--resume` 继续检查原任务；不要直接另开一次测试抢占相同端口。确认无需保留后，使用报告中的准确 project 和该次 Compose 文件清理：

```sh
DOCKER_CONTEXT=colima-bondbuddy-release docker-compose -p <report.project> -f <run>/compose.json down --volumes
```

不要使用全局 prune。当前脚本只提供发布前检查及退出码，不自动发布或更改生产部署规则。

## 验证状态

此前 Mac/Colima 的三个真实业务用例3/3通过，见[2026-11-08记录](../../docs/testing/local-release-smoke-2026-11-08.md)。本次只补跨平台启动路径和操作说明；按用户要求，没有重跑业务测试、模型调用或其他测试。Windows 实机端到端结果尚未记录，不能把此前 Mac 结果写成 Windows 已通过。
