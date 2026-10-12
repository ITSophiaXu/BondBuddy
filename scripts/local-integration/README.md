# 2026-10-12 第一批本地集成环境

本目录固定产品基线 `6cd5d2cb254a25963b79f44313440a64c6c38660`（develop，PR #692）。提供 Windows 本地启动、测试和证据脚本，并补齐 worker 入口测试失败时的子进程清理与错误诊断；没有改动产品运行逻辑，没有生产部署功能。

**可验收范围：** 真实注册/登录、项目创建、名称与来源信息保存、DOCX/PDF 上传到本地 Azurite、补充说明/复核要求保存恢复、助手未发送草稿、桌面/手机布局。模型生成未配置；不能将健康检查或上传成功理解为生成链路已通过。

## 本机依赖

- Node 22（本机实际使用 22.14.0）；在仓库根执行 `npm.cmd ci --no-audit --no-fund` 和 `npm.cmd run build`。
- PostgreSQL 16.14 与 Azurite 3.35 的可执行文件从相邻 `../work/local-ux-runtime/node_modules/` 只读复用。具体路径见 `config.mjs`；不使用该旧环境的数据目录。
- Python 路径见 `config.mjs`。原生 Windows 不支持产品 Linux 解析隔离；`diagnose-parser.mjs` 会明确报告失败。
- 浏览器回归使用 Playwright 1.63 对应的 Chromium 1243，位于 `../work/playwright-browsers`。
- 可选 Linux 合成测试使用本机 Docker Desktop、Git 自带 GNU tar 和已有 `node:22-bookworm-slim` 镜像，独立临时容器不挂载凭据，不调用模型。

## 启动、状态与停止

在此独立仓库根目录执行：

```powershell
node scripts/local-integration/start.mjs
node scripts/local-integration/seed.mjs
node scripts/local-integration/create-samples.mjs
node scripts/local-integration/status.mjs
```

入口为 http://localhost:5178。API `127.0.0.1:3018`、Postgres `127.0.0.1:55438`、Blob `127.0.0.1:10018` 仅供本地测试。脚本移除继承的数据库/云存储/模型配置；数据库名与端口固定。端口被其他服务占用时拒绝覆盖。`ready` 表示基础服务已启动，`modelReady:false` 表示未配置真实模型。

本机 Windows PostgreSQL 建立新连接较慢；本地 wrapper 在监听前建立连接并保持连接池至关闭，避免空闲回收后冷连接超出产品未修改的 2 秒 readiness 超时。

测试账号 `integration_user`（初始 1,000,000 个合成积分）、`integration_low`（初始 1 个合成积分），密码均为 `Local-Test-2026!`。仅用于隔离的本地环境。积分是幂等测试赠送，不是购买；重复 seed 不补回已消费积分。价格读取仓库已提交的 `deploy/m1/config/review-prices-20261009.json`。

```powershell
node scripts/local-integration/stop.mjs
# 数据保留，重新启动仍执行 start.mjs；不要在后端测试运行时停止数据库。
node scripts/local-integration/start.mjs
```

停止脚本只处理 `services.json` 中本实例记录的进程，核对启动回执、可执行文件、参数、工作目录以及 PID 和创建时间。API/worker 用本次启动 UUID 请求有序退出，PostgreSQL 核对数据目录后使用 pg_ctl 停止。若有活动任务或连接中的后端回归库，拒绝停止。不会停止 Docker Desktop 或其他项目容器。

Windows 服务通过 Python 标准库调用 CreateProcess，以 `CREATE_NEW_CONSOLE` 和 `SW_HIDE` 创建可继承的隐藏控制台。PostgreSQL 新连接的后端进程共用这个控制台，避免旧 `detached:true` 启动方式导致的逐连接弹窗。启动器使用命名互斥锁；回执在进程恢复执行前落盘，状态原子保存。重复启动实时核对进程和端口后复用服务；启动失败仅回退本次新启动的服务。旧版状态只有已记录停止时才迁移，无法核实的 PID 不会被盲目接管或终止。

`status.mjs` 重新检查进程创建时间、网页和 API readiness；不要单独用历史 `services.json.ready` 判断可用性。诊断时可用 `start.mjs --database-only` 只恢复数据库。启动和停止请使用同一 Node 安装路径。

所有数据、账号信息、日志和截图在 `../work/local-integration-runtime-20261012/`。不要将该目录当成产品输出提交。数据库从仓库迁移到 `0104_authoring_dynamic_balance.sql`，含两个独立的 `0103_*` 迁移；没有新增迁移。

## 回归命令

启动器专项（只管理本批环境，不要在用户正在验收时运行启停测试）：

```powershell
node scripts/local-integration/test-hidden-process.mjs
node scripts/local-integration/stop.mjs
node scripts/local-integration/start.mjs --database-only
node scripts/local-integration/test-postgres-console.mjs
node scripts/local-integration/test-lifecycle.mjs
node scripts/local-integration/test-receipt-recovery.mjs
```

连接专项创建并删除自己的临时库，检查 50 次真实连接存活期间的后端 PID 和窗口；启停专项验证并发拒绝、崩溃释放锁、端口冲突、创建时间不匹配、部分失败清理、失效回执、重复启动、停止及数据保留，最后恢复五项服务。证据保存在运行目录的 `console-postgres-proof.json`、`lifecycle-console-proof.json` 和 `receipt-recovery-proof.json`。不调用模型。

```powershell
node scripts/local-integration/test-backend.mjs api
node scripts/local-integration/test-backend.mjs worker
node scripts/local-integration/test-linux.mjs
```

API 和 worker 测试从独立空模板库创建临时数据库；不会写验收用户数据库。worker 测试原有的模型/解析夹具是合成结果。Windows worker 组有 3 个解析相关失败，原始日志保留；同组 Linux 回归 9/9 通过，另存 `tests-worker-linux.log`。合成回归不能冒充真实模型效果。

真实浏览器测试（没有 API route mock、没有模型调用）：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH=(Resolve-Path '../work/playwright-browsers').Path
$env:BB_E2E_BASE_URL='http://localhost:5178'
$env:BB_E2E_LIVE='1'
$env:BB_E2E_TERMS_VERSION='local-integration-20261012'
$env:BB_E2E_LOCAL_INTEGRATION='1'
Push-Location apps/web
node ../../node_modules/@playwright/test/cli.js test tests/register-live.spec.ts tests/local-integration-live.spec.ts --reporter=line
Pop-Location
```

真实浏览器测试创建一次性本地用户及合成材料，等待实际保存回执后刷新。截图写入运行目录的 `evidence/`。现有模拟 UI 回归的结果应单独报告。

## 仍未完成

Windows 原生 worker 的 Linux 文件隔离检查失败；本地正式 Linux worker 镜像构建在官方 npm 的 TLS 握手处失败。未降低 TLS 校验或解析安全检查。真实模型凭据未配置，因此尚未验证真实解析到生成、实际任务暂停续跑、模型扣费或成果下载链路，也未验证实际生成文书质量。

用户验收与上线授权均待完成。完整功能与测试记录见共享交接 `../work/local-integration-handoff.md`（相对本仓库根）。
