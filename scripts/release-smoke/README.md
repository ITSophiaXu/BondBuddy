# 本地发布前基础流程检查

`npm run test:release` 在独立的本地 Docker Compose 项目运行待发布版本，使用一个新建的 `release_test` 账号验证任丘九月募集书更新、东营复核、东营七题问答。先按顺序提交三个独立项目，再核验各自的持久任务和下载，后台可使用现有 worker 并发槽位。真实材料、网页、API、PostgreSQL、Azurite、worker、模型调用和浏览器下载都参与执行。不会修改生产环境或发送真实支付请求；初始测试积分明确为 synthetic。

## 运行

需要 Node 22+、Docker、Compose、Playwright 浏览器，以及本人的可用 Copilot 授权。默认使用 `colima-bondbuddy-release` 本地 context，可以用 `BB_RELEASE_DOCKER_CONTEXT` 选择其他本地 context；拒绝远程 Docker。仅网页端口 5288 绑定在本机回环地址，数据库与存储不发布端口。

```sh
npm ci
npx playwright install chromium
npm run test:release -- --ref HEAD
# 本机已有 Edge 时也可使用：
BB_RELEASE_BROWSER_CHANNEL=msedge npm run test:release -- --ref HEAD
```

使用仓库 `deploy/m1/Dockerfile` 的正式 api/worker/web targets，从固定 Git commit 的 archive 构建，不包含工作区未提交的产品代码。报告记录 SHA、tree、镜像 ID、样本 hash、任务 ID 和下载文件 hash；发布时应使用本次验证过的镜像。改动产品代码后先提交，再验证新的提交。

不带 `--ref` 时要求工作区干净，避免用旧提交的通过结果误认未提交修改已通过。显式 `--ref` 表示只验证指定提交；报告始终写出解析后的完整 SHA。

默认构建本地 Docker 引擎的原生架构；本机 Apple Silicon 为 `linux/arm64`。需要与 amd64 发布镜像完全一致时使用 `BB_RELEASE_PLATFORM=linux/amd64`，并确认引擎已启用对应仿真。报告记录实际镜像架构；arm64 的本地流程结果不能冒充 amd64 镜像已经验证。

默认模型沿用现有适配器 `copilot_enterprise / gpt-6-sol / max`，凭据默认读取 `~/.local/share/copilot-api/github_token`，可用 `BB_RELEASE_COPILOT_OAUTH_FILE` 指定已有 OAuth 文件。通过正式 credential helper 交换短期令牌，不修改本机代理配置，不静默切换模型。凭据不进入镜像或 Git；本次私有运行目录权限为 0700。模型调用会使用该账号的额度。

网络需要本地代理时，显式设置容器内可访问的 `BB_RELEASE_HTTP_PROXY`（例如 Colima 的宿主地址 `http://192.168.5.2:10808`）。它用于依赖下载及模型请求，数据库/存储走内部网络。不要填写带用户名或密码的代理 URL。必须安装并启用 Docker Buildx，旧 builder 不支持此仓库的 Dockerfile 专属忽略规则，脚本会提前拒绝。

本机固定设置可保存到已忽略的 `scripts/release-smoke/.local.json`，之后直接运行 npm 命令。可用字段为 `dockerContext`、`httpProxy`、`platform`、`copilotOAuthFile`；环境变量优先。不把令牌内容写入此文件。例如本机 Colima 配置：

```json
{"dockerContext":"colima-bondbuddy-release","httpProxy":"http://192.168.5.2:10808"}
```

重启电脑后，如此专用 VM 未运行，先执行 `colima start --profile bondbuddy-release --activate=false`。不需要更改其他项目的 Docker context。

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
