# 2026-10-12 第一批本地集成环境

> 2026-10-13 12:53：PR #697 增量修复更新说明右侧大片留白，取消内层固定宽度。产品源码 `e21fb81`，来源 `31e97120`；5178 刷新即可看到。1920/1440/390 成果回归 30/30、真实旧成果验证 1/1，两个 Word 原文件不变；API/worker 和所有数据保留。详见 [宽度验证](validation-summary-width-20261013.md)。用户尚未验收，尚未部署。

> 2026-10-13 12:44：已纳入 [PR #698](https://github.com/ITSophiaXu/BondBuddy/pull/698) 批注来源区分，worker 产品源码 `f9ea165` / 镜像 `85e2a227…`。前端保留 #697 成果可读说明、清洁版优先、自动定位下载（`f13c8c6`），API 为 `0556ca5a`。入口 http://localhost:5178 可用；原数据和成果保留，仅空闲 worker 更换。Python Windows/Linux 各 30/30、worker 交付 4/4、真实原稿离线再生成通过，没有新模型调用或扣费。详见 [验证记录](validation-comments-20261013.md)。用户尚未验收，尚未部署。以下版本记录为历史。

> 2026-10-13 11:09 最新版本已纳入 [PR #696](https://github.com/ITSophiaXu/BondBuddy/pull/696)：复核标题对齐、直接开始、实时过程与动态积分。运行产品源码 `0556ca5a673460ea73f4bd9805c54df180384c5a`，新镜像 `e6fe1694`；网页/API/worker 已一起切换。原用户复核成功结束后才切换，账号、材料、成果保留。真实本地 2/2（含实际一积分扣除/自动暂停/刷新）、新镜像最小模型探针通过。入口和账号不变，详见 [本次验证](validation-review-20261013.md)。下方为较早批次的历史记录，当前版本以本段为准；用户尚未验收，尚未部署。

> 2026-10-13 局部更新：按用户要求纳入 [PR #694](https://github.com/ITSophiaXu/BondBuddy/pull/694) 操作栏随内容滚动，以及 [PR #695](https://github.com/ITSophiaXu/BondBuddy/pull/695) 助手图标居中、复核材料重复标题删除。已验证源码快照 `c4e8006b0b744c4dc8c675005814e77678f3d2a2`（保留原生成链路与工具提交 `facae54d`）；真实网页仍为 http://localhost:5178，刷新即可验收。仅网页布局和对应原型更新，API、数据库、存储与 Linux worker 沿用下述基线和镜像，未重启。当前来源及证据见 [2026-10-13 验证记录](validation-20261013.md)；用户尚未验收，尚未部署。

本目录固定产品基线 `6cd5d2cb254a25963b79f44313440a64c6c38660`（develop，PR #692）。提供 Windows 本地启动、测试和证据脚本，并补齐 worker 入口测试失败时的子进程清理与错误诊断；没有改动产品运行逻辑，没有生产部署功能。

**可验收范围：** 真实注册/登录、项目创建、名称与来源信息保存、DOCX/PDF 上传到本地 Azurite、补充说明/复核要求保存恢复、助手未发送草稿、桌面/手机布局。2026-10-12 21:19 最终镜像已通过真实模型最小生成自测：网页上传合成原稿、提交任务、持久化成功、下载修订版和清洁版。大篇幅募集书质量、真实余额用完后的续跑仍需另行验收。

## 本机依赖

- Node 22（本机实际使用 22.14.0）；在仓库根执行 `npm.cmd ci --no-audit --no-fund` 和 `npm.cmd run build`。
- PostgreSQL 16.14 与 Azurite 3.35 的可执行文件从相邻 `../work/local-ux-runtime/node_modules/` 只读复用。具体路径见 `config.mjs`；不使用该旧环境的数据目录。
- Python 路径见 `config.mjs`。原生 Windows 不支持产品 Linux 解析隔离；`diagnose-parser.mjs` 会明确报告失败。
- 浏览器回归使用 Playwright 1.63 对应的 Chromium 1243，位于 `../work/playwright-browsers`。
- 真实生成使用 Docker Desktop、Git 自带 GNU tar 和本地 `bondbuddy-local-worker:20261012` 镜像；模型为产品已固定的 `gpt-6-sol`，复用本机已有 Copilot Enterprise 认证。Linux 合成测试仍不挂载凭据、不调用模型。

## 启动、状态与停止

在此独立仓库根目录执行：

```powershell
node scripts/local-integration/start.mjs
node scripts/local-integration/seed.mjs
node scripts/local-integration/create-samples.mjs
node scripts/local-integration/status.mjs
```

入口为 http://localhost:5178。API `127.0.0.1:3018`、Postgres `127.0.0.1:55438`、Blob `127.0.0.1:10018` 仅供本地测试。脚本移除继承的数据库/云存储/模型配置；数据库名与端口固定。端口被其他服务占用时拒绝覆盖。`ready` 表示基础服务已启动；状态另报 `modelGeneration.verified`（同一镜像的真实模型探针）与 `endToEndVerified`（同一镜像的网页生成及下载）。健康检查本身不等于生成验证。

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

## 真实生成配置与验收

```powershell
# 构建 Linux 依赖与当前固定产品构建快照；不包含任何运行数据或凭据
node scripts/local-integration/build-linux-worker.mjs
# 包含一次真实模型调用。探针通过后只替换本批空闲 worker，不重启网页/API/数据库
node scripts/local-integration/configure-generation.mjs
node scripts/local-integration/status.mjs
```

Codex 0.154.0 从 OpenAI 官方 GitHub Release 下载，与产品固定的 SHA512 一致。由于本地网络对 npm/files.pythonhosted.org 的 TLS 握手失败，Python 包经清华 PyPI 镜像获取，逐包对照官方 PyPI 发布的 SHA256。没有关闭 TLS 校验。Linux 镜像包含固定版本 Tesseract 与中文/英文/方向检测数据、Python 文档依赖和冻结的产品编译结果；详细依赖版本保存在镜像 `/opt/venv/install-report.json`。M3/M4 共 10 份运行资源通过产品 manifest/hash 校验；当前固定镜像为 `sha256:bf8a9d10635a910532912abf1579f152bb4e1bdd8c25eb02587d344c92634487`。

模型认证从已有 `gh auth token --hostname github.com` 获取，经本机已配置的 `https://api.enterprise.githubcopilot.com` 直接认证。它与生产的 OAuth 交换 helper 不同，替换仅存在于本地镜像。令牌存于 `%LOCALAPPDATA%/BondBuddy/local-integration-20261012/model-token`，只允许当前用户和 SYSTEM 读取；不进入 OneDrive、仓库、镜像层或日志。worker 启动时刷新该文件，以只读方式挂载到容器。没有继承或访问生产数据库/存储。

容器保持非 root、只读根目录、cap-drop ALL、no-new-privileges、固定 seccomp、独立暂存卷与进程/内存限额。Docker Desktop 不提供 AppArmor。CLI 0.154 会在应用 deny mask 后挂载新 procfs；本地 seccomp 额外禁止 bundled bwrap 的 proc 挂载标志 `14`，使 CLI 走官方 no-proc 分支并保留 `/proc` 拒绝规则。规则只收紧生产 seccomp，不启用 privileged/unconfined，不修改产品沙箱检查或官方二进制。实际正反向检查验证输入可读、scratch/output 可写，输入及任务根不可写，邻目录、凭据、`/proc/1/environ`、`/proc/self/environ` 和 mountinfo 不可读，命令网络被拒绝。

Windows 启动器仍管理同一 worker 监督进程；其内部管理带工作区及启动 UUID 标签的唯一 Linux 容器。停止本实例时有序停止该容器，数据卷保留。发现未知或仍在运行的旧容器时拒绝接管，防止重复 worker；先检查运行记录，不按名称批量停止其他容器。21:21 只重启空闲 worker 的验证已通过，25 个项目、25 份材料、4 个任务数量保持不变，网页/API/数据库/存储进程均未重启。

真实浏览器测试需要显式 opt-in，默认不会调用模型：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH=(Resolve-Path '../work/playwright-browsers').Path
$env:BB_E2E_BASE_URL='http://localhost:5178'
$env:BB_E2E_REAL_MODEL='1'
Push-Location apps/web
node ../../node_modules/@playwright/test/cli.js test tests/local-generation-live.spec.ts --reporter=line
Pop-Location
```

本次样例：http://localhost:5178/#/projects/3f0162c9-c46f-48d3-9881-5fc73e32123f 。仅使用合成原稿，最小修订报告期。最终镜像任务 `9d4da8ad-94e8-4123-b3f8-7d8f704b5cfa` 在 21:15:44–21:19:35 成功；一次真实模型调用，227,650 ms、usage measured、exit 0、14 次工具执行，浏览器测试 1/1 通过（4.1 分钟）。两个文件实际经浏览器下载并校验 hash：修订版 1,601 字节，含 1 处删除及 1 处插入；清洁版 1,498 字节，无修订标记。两者均可由 python-docx 打开，含目标报告期及合成测试声明。凭据使用实际模型权益；应用积分为本地合成测试账，不是真实支付。

证据位于运行目录：`model-preflight.log`、`file-sandbox-proof.json`、`generation-e2e.json`、`generation-durable-proof.json`、`generation-word-proof.json`、`generation-browser.log`、`linux-worker-restart-proof.json`、`evidence/real-generation-success.png` 和两个 Word。21:07 首轮成功证据以 `initial-` 前缀另存。原始 Windows 和首轮依赖下载失败日志保留，不再是当前运行方式。

## 仍未完成

用户尚未验收真实募集书内容质量、复杂 PDF/OCR 场景和完整暂停/充值续跑。成功的最小合成原稿不替代这些验收。当前代码和环境只用于本地测试，没有生产部署。

用户验收与上线授权均待完成。完整功能与测试记录见共享交接 `../work/local-integration-handoff.md`（相对本仓库根）。

## 2026-10-13 成果页可读性更新

PR #697 已纳入同一 localhost:5178：清洁版优先、两版说明、编制说明分节、内部编号与复核固定输入区移除、标题统一及完成项目定位下载。真实既有 Word 下载与手机/桌面验收脚本通过，服务未重启；无新增任务或扣费。详见 validation-results-20261013.md。用户尚未验收，尚未部署。
