# M4 收集恢复与模型容量续租确认（2026-11-18）

开发范围：#1592、#1540，以及回归发现的 [#1624](https://github.com/ITSophiaXu/BondBuddy/issues/1624) 受限预约权限。最初基于 develop `933844bbb39bc62dc21380e6fd863bd6d8b7e551`，已同步 `303ea69aa90bda75ef8f06354b0b1440c115fe84`（新增部分仅网页文案，不改变本次后端源码），与先前池启动修复 PR #1622 分开交付。本记录不代表生产部署或用户验收。

## 为什么发生：可复核证据

### #1592

原收集链路为 `m4-document-stage.ts` → `collectDirectWorkpaper`：先读取 `output/workpaper-result.json`（1 MiB）及 `workpaper-coverage.json`（32 MiB），再检查 `WorkpaperDecisionSchema`、`item_id` 与全部非空来源片段覆盖。旧代码将缺文件、无效 JSON、不安全文件都折叠为 `workpaper_result_missing_or_invalid`，适配器又统一记录 `MODEL_OUTPUT_SCHEMA_INVALID`，最后无条件删除 attempt 工作目录。M4 采用文本返回模式，没有 JSON 模式的 schema reask；“turn_completed”只证明模型回合结束，不能证明所需文件存在。

Issue #1592 保存了四个原任务的完整日志哈希、时间与观察记录；最新复测 `c8fafd2f-6e57-4db7-9337-2e22f6087313` / `call-cbc18269-1f0c-4849-bacc-e6c176275ed2` 在已上线 #1550 后仍于 14:52:08.282 收集失败。该次模型运行约 2.084 秒、tool_count=0。旧快照没有保存，不能把这些证据进一步说成已唯一证明某个历史文件或字段错误，也不能声称找回被清理的文件。此修复保存实际字节及具体收集规则，补上这个证据缺口。

### #1540

Issue #1540 的本地真实 Copilot 运行 `083a4e2e-4fe7-4ad3-8e37-e8f16192fa84`、attempt `call-2295a03f-eb9f-4aab-bc15-6373aff629cf` 约运行 19 分 29 秒、79 个工具动作，未到 90 分钟截止、没有 OOM 或 worker 重启。WAL 显示 16:45:56.277500 COMMIT，客户端 16:46:01.291779 报 `pg_query_timeout`；其后 capacity_signal → SIGTERM → MODEL_CANCELLED，确认退出后工作目录被删除。此前三次真实 PG 延迟回包实验都复现“UPDATE 已提交、holder 仍在，却约 5 秒后取消”。这证明客户端确认超时不能当作数据库更新失败；不能唯一推断最初网络/数据库延迟的底层来源，也不能归因腾讯 CVM 独有故障。

## 为什么旧测试没有发现

- 续租旧用例用触发器在 UPDATE 提交前抛出 `08006`，验证失败后停止，却未覆盖提交成功后仅确认回包丢失。新用例使用真实 TCP 代理，只扣住 PG → 客户端回包，并用独立连接确认提交。
- M4 旧集成用例生成成功文件，重点测试 Word 推广后的崩溃重放；未在收集前中断、未验证坏 JSON/具体缺失文件的诊断和工作区保全。旧单测还缺少后续新增的活动计费查询夹具。
- 本轮额外发现受限角色没有 `0192` 预约触发器依赖表的 INSERT 权限；只用管理员数据库运行的用例无法暴露此问题。新增最小授权及启动前检查，并复验受限角色的实际成功/失败账务路径。

## 修复后的行为

1. 正常续租和新连接确认都核对 holder、原任务 lease token/有效期、取消状态，以及节点 epoch、session、运行状态。超时连接销毁；仅允许一次包含连接时间在内的 5 秒独立确认。确认成功继续原进程；真失权、取消或确认仍不可用则停止。holder 无 TTL，不提前释放未知存活进程的 slot。显式 renew 与定时 renew 共用同一进行中的 Promise。
2. 记录原连接/确认连接 backend PID、两阶段耗时、上次成功确认时间、event-loop lag、故障类别与确认结果，不记录 SQL、凭据或原文。真实断连回归还修复了已借出 pg client 的 error 事件无人接收导致的未捕获异常。
3. M4 文档、共享规划、逐项规划与分组规划统一在模型确认退出后、收集和目录清理前保存 input.json、scratch、output。复用现有防路径逃逸、symlink/hardlink、文件身份变化及容量上限检查；每个私有 Blob 回读核验 hash，完整清单写入私有 Blob 和不可修改、删除的 PG 证据表。上限 4096 文件、单文件 100 MiB、总计 512 MiB。快照失败不授权恢复，且保留本机最后副本；本机副本不能被声称为跨 VM 销毁的持久备份。30 秒取消信号在 I/O 边界检查，不声称每个存储调用都有硬墙钟超时。若 Blob 清单成功而 PG 记录失败，确定的私有路径仍可用于人工核对；没有完整 PG 证据时不自动授权恢复。
4. 具体错误保留文件、schema 字段或覆盖规则，不把用户数据写入诊断文本。测量用量明确、快照完整时，最多一次基于原 scratch/output 的定向补救；独立记录两次供应商用量，保持原任务报价。补救仍失败则正常终结、释放积分，不把坏文件交付为成功。
5. Word Blob 存储错误先只重试收集；模型已结束、尚未保存最终结果的中断可排队恢复收集。此路径必须复用原 attempt，原收集结果尚未持久确认时 DB 禁止新增模型 intent。恢复成功后，分组格式降级可按原流程进入另一项规划阶段；原调用始终不得重发。归属、输入 hash、最新 attempt、退出证据、私有文件 hash 都复核；并发 sweep 仅排队一次，最多两次收集恢复。崩溃早于 runtime 落库时，只补写缺失的原运行记录，不覆盖原记录。分组规划原有的条目降级规则保持，保存共享快照不重新生成已接受的条目。
6. 用户暂停/取消、积分隔离、项目归档和已终结任务不能被恢复覆盖。unknown usage 保持 unknown，不自动重投。#1621 的 reconciliation 终结器会给可恢复快照留出窗口；到达恢复上限或无法恢复时仍可正确终结，不无限堵住队列。
7. 募集书文件任务因容量取消时也保全确认退出后的工作文件。保存证据不等于给新模型请求授权。

## 验证

开发和自测完成；尚未准备统一本地用户验收版，未获用户验收，未部署。

- 196 个迁移在隔离 PostgreSQL 16 全部执行成功；四个共享包、API、worker 从当前源码重新编译通过；`git diff --check` 通过。
- 完整轮 92 项：90 通过、2 失败（新增多任务夹具重复使用 prompt version=1；旧覆盖文件断言仍期待旧错误）。之后修正夹具/精确诊断断言，并补上审查发现的“分组收集恢复成功后正常进入下一阶段”授权。最终对全部受影响 M4 用例定向复验 28/28 通过、0 fail/skip/cancel；其余 64 项在完整轮通过，未修改对应逻辑后重复空跑。不能把两轮合称一次 92/92 运行。
- 真实 PG TCP 注入：已提交但丢回包/断连均通过新 backend 继续原许可；holder/lease/节点失权或取消停止；确认不可用约 10 秒结束且实际退出前不删除 holder。共享容量、公平性、drain、活进程/Stop fencing 均通过。
- 实际 PG + Azurite + Word + API 下载/账务：收集前中断、快照恢复、三类共享规划、缺失 runtime 补写、原调用禁止重发、成功后正常下一阶段、并发恢复去重、用户暂停、跨账号/hash、唯一结算均通过。
- 原生 Codex 0.169.0 沙箱预检为真实；模型行为和云回执为 synthetic。没有调用真实供应商，没有重新执行生产任务或修改生产账务。不能据此称真实模型输出质量或腾讯 CVM 线上全链路已验收。
- 完整 TAP 保存在 `work/stage-recovery/full-regression.tap`，最终定向 TAP 在 `work/stage-recovery/stage-recovery.tap`；SHA-256 与准确计数见本报告旁的 validation JSON。

可复现入口（项目根目录，已安装锁定 npm 依赖）：

```powershell
docker build --target stage-recovery-test -f deploy/m1/Dockerfile -t bb-stage-recovery-test:20261118 .
node deploy/tencent-elasticity/test-stage-recovery-local.mjs
```

测试目标继承正式 worker 的 Codex、Python 和 bwrap 限制，不改生产启动目标。`BB_STAGE_RECOVERY_TEST_IMAGE` 可指向同一固定运行时镜像；指定测试文件 basename 可定向复验。本次为离线依赖基底加固定 Codex 0.169.0 / Python 3.11.2 和仓库 bwrap 脚本的测试镜像，镜像摘要 `sha256:2d9ad1ca772bb85bce8554e0ce2ff46c232df5fcb901f362971f2d77fbe8a691`。源码每次从本分支复制并重编译；未把旧镜像应用代码作为本次修复结果。正式 Dockerfile 完整镜像目标未在本轮重新构建，不把这个边界称作已验证。

测试拒绝空跑、skip、cancel；仅创建/清理本次随机命名容器与 internal 网络。测试源码从当前工作区打包，Linux 运行时重新编译，未复用旧应用代码。

## 集成与发布依赖

- API、worker 必须同批集成；新增 `0193_model_workspace_evidence.sql`，发布前需核对迁移编号与同时开发分支冲突。
- 受限执行角色需应用 `deploy/m1/security/managed-workspace-evidence-grants.sql`。它只授予证据 SELECT/INSERT，以及 0192 预约触发器所需的三列 INSERT；无 UPDATE/DELETE、所有权或角色成员扩大。API/ops 的读取身份也需具备新证据表读取权限。已有热节点和未来冷启动镜像都需使用这一版本；发布时不能只覆盖旧的 adapter/budget 两个文件而遗漏新增依赖模块。
- #1622 尚未合并时，此分支带入其 M4 集成夹具修正；没有带入或重做池启动代码。
- 无新增公开 API、界面面板或计费规则。沿用既有失败、排队、暂停、成果下载和结算流程；内部增加恢复证据。
- 本轮未重新调用真实 Copilot/DeepSeek，也未重投生产客户任务；#1540 原固定业务输入的真实完整生成、内容和页面验收，以及 #1592 新版本真实收集效果仍属于后续集成/验收。Issue 保持关联，不把代码通过等同于原任务已经成功交付。
- 最终统一验收待办：指定集成 chat 合并本批固定版本，启动统一测试环境；用户验收后由发布 chat 统一上线，核验现存及新建执行节点。历史被删除的工作文件不能由这次修复补造。
