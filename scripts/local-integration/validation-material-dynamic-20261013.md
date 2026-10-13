# 2026-10-13 材料生成动态积分与过程页

状态：开发和自测完成；**本地集成版可验收**；用户尚未验收；代码完成，尚未部署，待统一发布。

来源 [PR #699](https://github.com/ITSophiaXu/BondBuddy/pull/699)：产品/原型 `c9fecb55836a4c751978488496ece622011f2f75`，证据 `42566be517d41b278d63b6bc0e6811b8d5998b94`。集成对应 `de494b8bcff1f00a77ea9b05af3f14455bf0a0c5` / `f73e102f04aece9a01ca138c1bf8dccae5a6b2a3`；实际 web/API/worker 产品版本固定为 `de494b8`，保留之前 #694–#698。

入口 **http://localhost:5178**；账号 `integration_user`，密码 `Local-Test-2026!`，沿用原账号和数据。

- 新材料任务有积分即可开始，按有效处理时间和完成的工作动态扣分；排队与暂停不扣。余额归零保存后暂停，充值后继续。完整交付仍共 4,500 积分；主动结束保留已扣，平台失败退回已扣。
- 当前已消耗、可用余额、过程记录随后台事件更新；支持暂停/继续/结束。删除内部“来源与版本”及任务/成果标签的 ×。旧任务与问答保持原计费。
- 修复材料事件 DTO 取错层级、材料正文+编制说明被募集书双版本校验误拒的问题。双文件保存但尾款不足时暂不开放新下载；到账后复用文件和模型结果。
- 新增迁移 `0105_m4_dynamic_balance.sql`，无新依赖。API、worker、web 需要协调更新；旧 worker 不应执行新版动态任务。生产发布交统一发布 chat。

## 本地服务与验证

13:42 在原材料任务已经结束且没有活动任务后切换。先用 PostgreSQL 16 客户端备份独立本地数据库，再用原 stop/start 生命周期脚本启动新版本并执行迁移。未取消用户任务、未重新生成用户材料，数据库、Azurite、账号、parse volume 和文件保留。

当前镜像 `sha256:ac24565c1ed37291c6b618b64e667630230fcbf5413b9eb1e917dc697b6eb91f`，tag `bondbuddy-local-material-dynamic:20261013`，启动 tag `bondbuddy-local-worker:20261012` 同指该版本。基于旧镜像 `85e2a227…` 保留已验证的 Python/CLI/批注来源修复，覆盖集成版本编译出的 API/worker/contracts；七个关键文件的运行中 SHA-256 与磁盘版本逐项匹配。固定候选镜像的真实账务和双 Word 合成链路额外 **2/2** 通过。

- 来源回归：隔离 PostgreSQL **13/13**，Linux worker **24/24**。包括旧报价、QA、1 积分启动、并发幂等、真实动态扣款、手动暂停优先、尾款暂停、充值复用同一模型结果/文件、崩溃恢复、主动结束、失败退款、归属和账本审计。模型为合成，不调用供应商。
- 页面：38 项最终通过，1 项旧可选取证跳过；首次一条旧阶段文案断言修正后相关 5/5，最后状态/对照 4/4。1440×960、390×844 同尺寸原型/实现截图及 320 px 溢出验证，证据 `apps/web/test-evidence/material-dynamic-20261013/`。
- contracts/API/worker/web 类型检查、Vite 构建通过。171+12 契约示例、4 生命周期示例、40 契约测试通过。构建保留既有大包提示。当前前端 `index-BGRnR-zq.css` / `index-DjNRbBx6.js`。
- **真实本地浏览器 2/2**：独立合成账号真实注册/登录/上传 DOCX/保存要求，一次开始由真实 Linux worker 在输入检查点实际扣 **1** 积分并暂停，页面显示过程、充值入口和余额 0；刷新保留同一 run 和检查点；主动结束后仍扣 1 积分。API 未拦截，模型调用 **0**。新测试没有修改用户积分。
- 原材料任务在本次切换前已于 13:14 失败，历史失败状态和 4,500 积分释放记录不改。两份已保存文件仍可下载：正文 **52,311** 字节、编制说明 **46,922** 字节，两者 SHA-256 匹配。此次只读核对，不重跑或补扣旧任务。
- 新镜像未重新调用真实模型探针或完整材料生成；`modelGeneration.verified=false`、`endToEndVerified=false` 保持诚实记录。独立合成模型验证证明执行/成果/账务恢复，不代表真实文稿专业质量验收。

详细本地记录：共享运行目录 `material-switch-20261013.json`、`evidence/material-dynamic-20261013/verification.json` / `legacy-files.json`、前后状态快照。真实用户截图和文件不提交 GitHub。测试源码 `apps/web/tests/local-material-dynamic.spec.ts`，需显式设置 `BB_E2E_LOCAL_INTEGRATION=1`。

## 用户验收与启停

刷新 5178 → 材料生成 → 选择材料类型并上传材料 → 点击生成。检查动态积分、生成过程、暂停/继续和刷新恢复；余额归零显示充值入口。旧任务可直接打开已有正文和编制说明，不需要重跑。

启动 `node scripts/local-integration/start.mjs`；状态 `node scripts/local-integration/status.mjs`；停止 `node scripts/local-integration/stop.mjs`。本机仍使用 Node 22 路径及 README 的依赖；有活动任务时停止脚本会拒绝执行。

本地备份 `before-material-dynamic-20261013.dump` 与旧服务/镜像配置保存在共享运行目录。回退前先确认没有动态任务执行中；不得将旧 worker 接到尚未结束的新动态任务。迁移只新增，不回写旧积分流水。
