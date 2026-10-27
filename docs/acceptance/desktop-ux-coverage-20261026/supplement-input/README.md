# 补料候选输入与准确执行读取

2026-10-26；基于 `4386a62e` 的本地增量，未推送或部署。完整 UX goal / G03 保持 **active、未完成**。

## 当前行为和边界

保存补料后，真实 `GET/PUT /runs/{run_id}/supplement-draft` 从该任务冻结输入和准确保存回执生成候选 manifest。普通补料保留原目标、知识、要求、规则和成果来源，只同步明确变更的材料路径；普通 M3 同时生成独立候选业务快照，M4 保留准确跨项目来源。响应增加 contracts 唯一定义的 `input_preview`。页面用材料名称显示核对结果和完整材料清单；保存未确认或本机选择改变时不显示旧“已核对”结果。

`prepared` 只表示候选材料关联能够完整编译。候选 manifest/快照没有持久化，也没有新的 input revision、采用回执、任务、永久保留 pin、报价、扣款或执行授权。hash 不是独立的采用或费用凭证。旧准备回执的 changes 不变；读取时重新核验材料登记状态、归属和 hash，登记材料被删除或登记校验不符时不返回候选 hash。预览不读取 Blob，元数据完整但物理字节丢失的情况仍由实际执行的字节读取门验证。原任务的其他业务门仍保留。

以下情况保存草稿后显示限制，不能伪报为完整可用候选：新历史/参考原稿尚无新版本声明；已确认的复核范围、报告续改或 finding revision；被原问题引用的证据替换；修订导出任务；非 DOCX/PDF 的复核原稿替换；M4 主文档或模板替换。原声明、accepted proposal、源报告、editor 决策和模板 pin 不被改写来凑合法输入。

共享 `readRunExecutionInput()` 已被补料准备、M1 `loadUnifiedInput`、M3 `loadReviewInput` **及主要文件路径 `loadReviewFileInput`**、M4 `loadM4WorkerInput` 实际使用。reader 验证准确 V1/revision/hash，再读取同归属的输入与不可变业务快照；M3/M4 loader 将准确快照交给原 gate，显式缺失拒绝而不回退查询。独立 gate 调用保留原数据库检查。新迁移为零，数据库仍禁止 V2；这不是后继执行协议。

## 最终验证

最终采用轮次见 [verification-summary.json](records/verification-summary.json)。重复轮次不累计为新旅程或覆盖率。

| 检查 | 最终结果 | 范围 |
| --- | --- | --- |
| contracts/API/worker 构建、web TypeScript、web 生产构建 | 均退出 0 | 公共契约和真实页面构建 |
| contracts examples | 177 个合成示例及 12 个内部 library 示例通过 | 原契约恢复、冲突和用量约束继续保留 |
| API 定向 | **80 pass / 0 fail / 0 skip** | 14 个候选编译用例；真实 PG/HTTP/session/CSRF、准确回执/CAS、输入/账本不变、材料失效和原身份保护 |
| worker 定向 | **64 pass / 0 fail / 3 skip** | 四条实际 loader、既有来源/快照门、调用身份、文件交付和邻近回归 |
| 真实 PG loader 子集 | **4/4**，已包含在 worker 最终轮中 | 真实 claim，M1、legacy/file M3、跨项目 M4；24 次错误身份拒绝；21 类历史/账务表、拒绝时访问审计及合成本地字节保持 |
| 真实完整 main | **7/7** | 页面→真实 API/CSRF→PG→私有本地原字节→补料保存/核对→刷新→明确按原材料恢复；另含原稿声明缺项、失落回执及双 context CAS |
| 合成 HTTP 桌面组件 | **17/17** | 三入口、完整清单、问题提示、旧预览隐藏、上传恢复、冲突、准确回执和迟到读取 |
| 在途 adapter 原输入恢复 | **1/1** | 受控本地 Node subprocess，真实 worker journal、私有结果、暂停保存和原结果只调用一次；不代表业务生成 |
| 最终源文件一致性 | **2,008 文件完全相同** | 最终 source-before / source-after 覆盖源、构建、测试和迁移 |

三个 skip 是既有 M4 Azurite pipeline、legacy unified Azurite pipeline，以及 Windows 下不适用的 Linux symlink 案例。新增 reader、候选、真实 PG loader 和桌面断言均已执行；不把这些 skip 说成通过。Vite 保留现有大 chunk 提示，没有借本切片修改打包策略。

隔离 PostgreSQL 16.14 使用既有专用 `127.0.0.1:15526` 集群，空模板保持迁移 0119、0 run、0 execution，测试 clone 已清理，集群已停止。真实 main 使用 5198；组件测试使用本轮独立 Vite 5199，并关闭自身进程；没有操作共享 5173。原始字节来自合成文件，私有字节目录及生成 Word 没有提交。浏览器截图为 1440×960，已目视核对新材料提示和已有布局，没有水平溢出；它们不是用户原账号或最终专业视觉验收。操作提案仍见 [暂停补料原型](../../../ux/prototypes/pause-supplement-resume.html)，本次只在现有准备区追加核对披露，不声称提案中的采用步骤已经实现。

## 失败记录和纠正

首轮记录保留，未覆盖或改写为通过：

- API 构建遇到 `Value.Check(M4DocumentManifestSchema, ...)` 的控制流类型收窄；保留完整运行时验证，通过 boolean 验证边界修复 TypeScript 分支类型。
- web 首轮缺少旧合成 fixture 的新必填 `input_preview`，且 API 新模块尚未成功产出声明；补齐 fixture 并完成依赖构建。
- worker 首轮三处测试将字符串当 M4 requirement；改为合法 requirement 对象，保留差异断言。
- UI 首轮 **16/17**：旧失落请求测试在 pending 按钮出现时立即断言 HTTP 已发出，实际请求尚未 dispatch。测试改为等待真实请求记录；继续要求仅一次原请求、原回执核对后才重试、重试 payload 完全相同。生产恢复逻辑没有因此放宽。两次后续完整组件轮均 **17/17**。

独立审查还在最终执行前发现并修复 M3 的悬空 evidence link、非 Word/PDF 主源和 correction export 被误标候选的问题；对应正反例已进入最终 80 个 API 测试。最后的真实 PG 四路径回归明确覆盖主要文件复核 loader，不能只凭 legacy review 的 query-double 推导它已经接线。

## 复现和剩余工作

原始命令、时间、退出码、首轮/最终日志及 Playwright JSON 在 `records/`；截图和合成断言在 `browser/`，hash 清单在 [manifest.json](manifest.json)。将 `reproduce/verify.mjs` 放回工作区 `.local/supplement-input/`，从仓库根执行其 modes：`contracts-build` → `api-build` → `worker-build`，另有 `web-tsc`、`web-build`、`contracts-check`、`api-test`、`worker-test`、`browser-real`、`browser-ui`、`inflight-test`、`source-before/after` 和 `database-final`。驱动清理继承的 BB_/数据库/Azure/OpenAI/DeepSeek 配置，只用上述隔离模板和已登记本机 Python。运行 main 与 inflight 必须分为两个 Playwright 进程，避免复用已经关闭的隔离 clone。模板/集群须先由操作者按本机路径启动，不连接真实用户数据库。

用户已选 **B：必要重做单独报价，确认追加金额后继续**；B1/B2 计算基准仍未选择。本轮未猜费率。价格以外仍缺采用 CAS/幂等回执、后继业务快照、版本化 checkpoint/模型工作单元、精确旧工作引用和增量处理、成果/下载来源绑定、历史材料保留、新输入授权及累计账务闭环。没有新材料进入业务 worker、正确新版 Word、真实供应商或 Azure 的验收证据。因此 G03 / UX-A03 不关闭，也不据本轮测试数宣称整体 ≥90% 或主要功能 100%。
