# 第一批验证记录（2026-10-12）

产品基线：`6cd5d2cb254a25963b79f44313440a64c6c38660`。集成分支：`integration/local-20261012-batch1`。本分支新增测试工具、3 项常规真实浏览器回归、1 项显式开启的真实模型浏览器回归及入口测试子进程清理；不修改产品运行逻辑，不新增迁移。

## 已完成

| 检查 | 结果 |
|---|---|
| 全量构建 | 通过（Vite 大 chunk 提示保留） |
| contracts/schema | 11 通过 |
| web 单元测试 | 91 通过 |
| API 计费/进度/历史/复核 | 9 通过，0 跳过 |
| 动态余额专项 | 2 通过，0 跳过；含与其他组重复的 meter 单元测试 |
| Python 原稿批注测试 | 12 通过 |
| 既有模拟 API 浏览器测试 | 70 通过，7 跳过 |
| 真实注册流程 | 1 通过 |
| 新增真实 HTTP/数据库/存储浏览器测试 | 更新、助手草稿 2 通过；复核上传与要求 1 通过 |
| 本地服务停止重启后真实浏览器复验 | 注册、更新、助手、复核共 4 通过 |
| Windows worker 合成回归 | 6 通过，3 失败；POSIX 解析隔离不可用 |
| Linux worker 合成回归 | 9 通过，0 失败，0 跳过（tests-worker-linux.log） |
| Windows 控制台连接专项 | 两轮各 50 次真实 PostgreSQL 连接；每批 10 条连接存活时核对 PID，始终 1 个共享隐藏控制台、0 个可见窗口 |
| 启停与失败恢复专项 | 10 项通过：并发互斥、父进程崩溃释放锁、端口占用保留、PID 创建时间拒绝、部分失败回退、死进程记录、重复启动、全部服务窗口检查、重复停止、重启保留数据 |
| 启动回执恢复 | 通过：模拟 native 启动后状态写回前中断，全部 5 个进程身份保持不变 |
| 弹窗修复后真实浏览器复验 | 注册、更新上传/保存、助手、复核共 4 通过（11.9s） |
| 既有示例数据 | 两个测试账号保留，示例 DOCX/PDF 实际下载字节数和 SHA256 均与数据库一致 |

真实浏览器回归检查自动命名、原稿年份/品种、DOCX/PDF 上传、保存后的刷新恢复、助手草稿恢复和桌面/手机布局。没有 API mock，没有模型调用。保存断言等待真实回执，避免提前刷新产生误报。

15:11 控制台专项及浏览器复验完成。旧启动器 `detached:true` 让 PostgreSQL 的后端创建路径无法继承控制台；现在使用从创建时就隐藏的可继承控制台，配合进程创建时间指纹、持久回执和互斥锁。API/worker 的有序退出请求绑定启动 UUID。原 15 个项目/15 份材料/0 个任务在启停专项中保持不变；浏览器回归新增合成样本后为 21 个项目/19 份材料/0 个任务。

第一次浏览器复验为 3 通过/1 失败：`setInputFiles` 在材料输入仍被恢复流程禁用时提前设置文件。增加输入可用性断言后 4/4 通过，未扩大超时或放宽业务断言；原失败日志保留。同时将截图路径改为相对于测试模块解析，避免从仓库根调用时写入错误目录。

运行目录保留 `console-postgres-proof.json`、`lifecycle-console-proof.json`、`receipt-recovery-proof.json`、`saved-sample-console-recovery.json`。数据库启动前的离线副本保存在 `backups/postgres-before-console-fix-20261012`，原数据目录未删除或替换。PostgreSQL 完成自动恢复，两个样本文件哈希验证通过；未停止或修改其他项目数据库。Docker 引擎另行只读确认 29.2.1 可访问，没有再次启动 GUI。

## 运行边界

本地入口 `http://localhost:5178` 使用独立 Postgres 与 Azurite；测试账号及启停命令见 README。API readiness 200 说明基础服务可用，不代表模型生成已就绪。

早前正式 Linux worker 镜像构建的官方 npm 请求报 `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`。21:07 已解决本地构建与真实生成：CLI 改从官方 GitHub 固定发布包取回并校验，Python 包经可信镜像下载后逐包核对官方 PyPI SHA256；没有降低 TLS 校验。原始失败日志保留。

Windows 原始失败与 Linux 回归分开保留。合成 worker 测试里的模型/解析夹具不能作为真实模型效果证明。Linux 测试脚本把只读本地源码和依赖复制进容器临时文件系统，并重建 npm workspace 软链接，避免 Windows junction 和跨系统挂载导致的启动问题。

本机完整日志及截图在相邻 `../work/local-integration-runtime-20261012`，共享交接在相邻 `../work/local-integration-handoff.md`（相对仓库根）。

## 21:21 最终镜像真实生成补充验证

| 检查 | 结果 |
|---|---|
| Codex CLI 0.154.0、Python 文档依赖 | 官方 SHA512 / SHA256 校验通过，Linux 依赖导入通过 |
| 文件和网络沙箱 | 原件可读、scratch/output 可写；原件/任务根写入、邻目录/凭据/proc读取及命令网络均被拒绝 |
| M3/M4 固定运行资源 | 10 份资源通过产品 manifest/hash 校验 |
| 真实模型最小探针 | gpt-6-sol；12,768 ms；measured usage；两份实际 Word |
| 真实网页生成与两份授权下载 | **1/1 通过，4.1 分钟**；合成原稿，未模拟 API 或模型 |
| 持久化调用证据 | 任务 succeeded；1 次模型调用、227,650 ms、exit 0、usage measured、14 次工具执行 |
| 下载文件核验 | ZIP/Word 可打开；目标报告期及合成声明保留；修订版 1,601 字节、1 删除 + 1 插入；清洁版 1,498 字节、无修订 |
| Linux worker 单独重启 | 配置自动恢复；25 项目、25 材料、4 任务保持不变，其他服务未重启 |
| 新增脚本语法与 web TypeScript | 通过 |

最终 Linux 镜像 ID：`sha256:bf8a9d10635a910532912abf1579f152bb4e1bdd8c25eb02587d344c92634487`。真实任务 `9d4da8ad-94e8-4123-b3f8-7d8f704b5cfa` 在 21:15:44–21:19:35 成功；项目 `3f0162c9-c46f-48d3-9881-5fc73e32123f`。新证据为 `file-sandbox-proof.json`、`model-preflight.log`、`generation-e2e.json`、`generation-durable-proof.json`、`generation-word-proof.json`、`generation-browser.log`、`linux-worker-restart-proof.json` 和 `evidence/real-generation-success.png`。21:07 首轮真实生成及重启也通过，证据以 `initial-` 前缀单独保留；最终镜像补齐运行资源后重新完成模型探针、网页生成和重启恢复，没有沿用旧镜像的成功结论。

Docker Desktop 不提供 AppArmor。固定 CLI 的新 procfs 挂载覆盖了 `/proc` deny mask；本地 seccomp 进一步限制该挂载，使 CLI 使用官方 no-proc 分支。没有放宽产品安全检查、修改官方二进制或启用 privileged/unconfined。具体实现与认证隔离见 README。

**开发和自测完成，本地最小真实生成可验收；完整文书质量、复杂 PDF/OCR 与暂停/充值续跑仍需验收；用户尚未验收；尚未部署。**
