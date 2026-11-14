# 文件编制 HTTP 413 自动恢复（2026-11-13）

状态：开发验证；代码完成，尚未部署，待统一发布。Refs #994。范围为 update 的文件编制及其篇幅修复调用，不代表整个 #994 已解决。

后续本地真实回放发现独立的累计输出上限与旧任务恢复缺口。本文保留首轮历史验证值；当前输出预算、完整指令初始化和扩展恢复范围以[输出恢复补修记录](file-authoring-output-recovery-20261113.md)为准。

## 原因与诊断边界

生产只读证据确认 DeepSeek `/responses` 返回 HTTP 413 Payload Too Large；CLI 重连五次后失败，旧适配器记为 MODEL_TURN_FAILED / usage unknown，停在 provider_reconcile，没有可自动恢复的快照。没有结果引用，用户没有请求暂停。本次没有修改生产任务、账务或服务。

不能把日志中约百万字符的 command_execution.aggregated_output 直接等同于请求体。真实 CLI 0.167.0 合成探针显示：输出 1,000,000 字符时，默认实际入历史约 10,211 字符、下一请求 53,022 bytes；显式预算 1024 时约 4,307 字符。旧请求体未留存，无法确定具体超限内容。

同一 CLI 原生读入 1800×1800 合成 PNG（9,724,833 bytes）后，请求达到 13,465,049 bytes，图片绕过文字回显预算；exec JSONL 没有 image item，不能以旧日志缺少读图事件排除图片。此结果证明风险机制，不证明生产事故必然由这张或某张图片造成。

## 行为

- 只根据明确 HTTP 状态识别 MODEL_PROVIDER_PAYLOAD_TOO_LARGE；正文中的偶然数字、其他显式状态及一般失败不能触发恢复。首次 413 即终止同体重连。
- 进程退出后、释放租约和清理临时目录前，持久保存 input.json、scratch/**、output/**，读回校验后发布 checkpoint。原材料、知识和可信工具从锁定输入重建。恢复保留原 revision_date，其他输入逐项相等。
- 仅对已退出的 codex-file-authoring-2、未知用量、无结果/冲突/新 attempt、有效同任务快照授权。继续使用同一 run、job、logical call 和积分预留；历史未知用量不改成零。
- 恢复使用新上下文，先检查已保存的工作记录和操作日志再续写。文字回显预算为正常 1024 / 恢复 512；压缩阈值为 32,000 / 12,000，模型上下文能力窗口不变。
- 禁用原生读图，使用 bb_images.view_image。只读本任务普通图片文件，拒绝链接、路径逃逸、特殊文件；原件不变。每次输出 JPEG ≤128 KiB、最长边 ≤1600、质量 ≥80，不满足则要求更小裁剪。提示要求逐区域读取财务小字和所有相关明细。
- 每个 logical call 最多自动恢复两次，每任务最多六次。保存失败或次数用完给出明确失败原因。用户暂停、取消、积分暂停、账务隔离及未退出的进程均不被强行恢复。
- 专用 413 候选扫描按 job ID 轮转，不被旧 unknown 或最前面的 20 个无退出证据候选永久堵住。用户暂停请求恰好落在系统暂停之后时也记录意图。
- 页面分别显示正在自动恢复、已安排续跑、无法保存进度和重试耗尽；刷新不重复提交。普通 unknown 不再承诺尚未实现的自动恢复或内部进度保留。

快照上限：1024 个文件、单个 100 MiB、总计 256 MiB。任何不合规文件或越限均不能发布部分恢复快照。图片输入 ≤32 MiB、≤40M 像素。单图限制与自动压缩不是累计 HTTP 请求体硬上限，有限重试仍可能结束为失败。

## 验证

全部使用独立本地环境、合成输入和合成供应商响应；未调用真实 DeepSeek，不代表内容质量或用户验收通过。

| 项目 | 结果 | 边界 |
| --- | --- | --- |
| contracts/domain/registry/context/API/worker 编译 | 通过 | 固定 develop 基线 92bbba8fe04ef7f367c8ecba814ff834bea2a677 |
| Linux 模型适配器 | 44 pass / 0 fail / 0 skip | 状态识别、立即停止、未知用量、权限、取消、超时 |
| Linux 文件编制进程 | 6 pass / 0 fail / 0 skip | 真进程/沙箱，合成模型；413 保存先于清理，attempt 2 读取已存工作 |
| 文件恢复与 stage 接线 | 5 pass / 0 fail / 0 skip | Blob 合成存储；输入、快照哈希、链接、上限、恢复授权 |
| API 元数据与供应商事件 | 5 pass / 0 fail / 0 skip | 不同错误和恢复元数据边界 |
| 图片 Python/Linux | 5 pass / 0 fail / 0 skip | Pillow 12.3；裁剪、体积、可读性下限、损坏文件 |
| 图片 Node 路径边界 | 3 pass / 0 fail / 0 skip | 路径、原件、链接及文件身份；另连续五轮通过 |
| 网页状态单测 | 22 pass / 0 fail / 0 skip | 恢复状态、旧任务链接、分页及用户暂停优先 |
| 浏览器 | 2 pass / 0 fail / 0 skip（分别运行） | 新 413 与既有 timeout；刷新无重复提交、原 input hash |
| Web typecheck / Vite build | 通过 | 保留既有 >500KB chunk 提示 |

PostgreSQL 16 独立临时实例：413 恢复套件 1 pass / 0 fail / 0 skip（47.6 秒），既有 unified-timeout 套件 1 pass / 0 fail / 0 skip（38 秒）。覆盖并发幂等、事务回滚、21 个旧 unknown、20 个缺退出证据的 413 前置任务、runKinds、真实 action pause 竞争、用户继续、积分暂停、原预留和余额不变。首次新增 fixture 试图更新不可变 runtime，被触发器拒绝；改为创建时写入正确证据，最终通过，未修改产品数据库约束。独立测试 clone 已清理。

真实 CLI + 正式 buildCodexArgs/filePermissionArgs + MCP 验证通过：原生 view_image 不在工具列表，四次 256×256 原像素裁剪成功；实际请求依次 33,346 → 178,340 → 323,470 → 468,480 → 613,554 bytes。使用无外网容器、cap-drop ALL、no-new-privileges 和仓库 seccomp；供应商仅监听容器内回环。四个区域不等于整张图已读，图片大小验证不等于财务识别质量验收。

测试初始失败均保留在本地证据：新增浏览器测试曾未等待异步创建任务，现等待真实 run；Linux 适配器首轮缺只读 model-catalog 挂载，补齐后 44 项通过；Windows 原 300ms 超时用例在高负载下有一次启动竞态，最终 Linux 原断言通过；Pillow 高熵编码所需缓冲已固定为有界 MAXBLOCK。未修改断言掩盖产品问题。

可复跑：先按依赖编译 API/worker；设置独立 BB_TEST_DATABASE_URL，运行 `node --test apps/worker/dist/file-authoring-payload-recovery.pg.test.js` 及 `unified-timeout-recovery.pg.test.js`。Linux 运行 `codex-adapter.test.js`、`codex-file-authoring.test.js`；快照与图像测试分别为 `file-authoring-recovery.test.js`、`authoring-image-tools.test.js` 和 `python/tests/test_bounded_image.py`。网页在独立 Vite 回环地址运行 Playwright `project-execution.spec.ts` 的 `payload recovery` / `provider timeout explains service recovery` 用例。

本地诊断和合成 wire 探针保存在 work/payload-bound-probe 与 work/payload-recovery-tests；客户原件、私有执行日志、凭据均不进入此 PR。

## 同尺寸界面对照

截图使用合成项目和合成状态。实现示例是试用账户，原型是积分显示示例；该差异为既有计费分支，不代表本次新增计费规则。阶段文案与操作一致。

| 尺寸 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [原型桌面](file-authoring-payload-recovery-20261113/prototype-desktop.png) | [实现桌面](file-authoring-payload-recovery-20261113/implementation-desktop.png) |
| 390×844 | [原型手机](file-authoring-payload-recovery-20261113/prototype-mobile.png) | [实现手机](file-authoring-payload-recovery-20261113/implementation-mobile.png) |

## 集成、发布与旧任务

- 无 SQL 迁移、无新 npm/pip 依赖。契约新增错误码，运行时新增内部快照/审计字段；受控读图使用现有 Node 和 Pillow。
- API 与普通编制 worker 必须协调更新，不能让旧 worker 领取新恢复任务：旧版本不恢复该快照，可能从头开始。部署前固定版本并按项目统一发布规范验证。
- 生产旧任务只有 MODEL_TURN_FAILED 且临时目录已删除，没有新快照；本改动不能凭空恢复那些内部工作。不能批量改 unknown 为失败/零用量，不能把本次开发验证称为旧任务已恢复。
- #994 的 review/qa/generation 专门恢复、历史积压处置及累计请求硬上限不在本次完整覆盖范围，Issue 保持打开。
- 最终统一验收：在固定本地集成版本确认真实网页/API/数据库/存储/worker 的暂停续跑、取消、积分和成果交付；核验全量材料及表格未因分段读取省略。真实模型内容质量、用户验收及生产发布另行记录。
