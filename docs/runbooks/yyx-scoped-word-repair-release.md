# #1529 空章节纠错发布交接

本改动由开发 chat 交付，尚未部署。统一发布 chat 在固定集成版通过相关验收并获本批上线授权后执行。没有新数据库迁移、模型切换、并发上限调整或网络/IAM 变更。

## 修复行为及边界

预检只有空章节失败时提示保存日志并结束初次编制。宿主独立重放原稿和持久化日志，校验结构，从空章节中找出每一个原本非空、现在为空的普通正文位置。模型仅返回 `issue_id + text`，不提交段落地址。宿主重新计算快照并构造操作，忽略本轮模型另写的通用操作日志和 Word。

一个章节可以有多个补写位置，不能只填第一段。原本空白的排版段落、标题、表格和文本框不自动补写；无法可靠定位时暂停。跨主体标题措辞仍可按现有规则更新。补写没有模型事实核验保证，最终仍需内容和视觉验收。

同 run 共用既有最多两轮纠错预算；其中范围受限的正文修复只产生一个候选稿。失败保存补写前草稿、候选稿、范围、答案和检查报告，暂停后恢复不能重置预算。成功必须经过宿主完整 Word 检查并实际生成双稿。渲染基础设施故障仍重试检查，不买新模型回合。

初次编制采用预检交接指令；本 PR 没有强制切断尚未结束的初次模型调用，也不提供任意超时工作区恢复。90 分钟配置不变。关联 PR #1302 的能力和交付证据须独立核对，不用此修复替代。yyx 原失败 run 尚未因本 PR 被恢复或交付。

## 发布范围

| 部分 | 本批动作 |
| --- | --- |
| 弹性编制、复核服务 | 使用新版严格覆盖包；两个服务各自核对实际挂载文件 hash |
| 已存在的运行/停止 CVM | 根据实际实例清单排空后更新本机 loader、adapter 绑定、业务包 pin 和服务挂载；仅更新控制端模板不会修改磁盘 |
| 保留节点热启动 | 核对 `/etc/bondbuddy/elastic-node.json`、`elastic-bootstrap.json`、已安装 helper 和启动后的挂载；原始 `retained_warm_bootstraps` 只证明当初创建，不得改写成新代码已安装的证据 |
| 后续新建 CVM | 控制端使用本 PR 的 `bootstrap.mjs` 与 `business-overlay.mjs`，为两个角色槽生成新 UserData；实际配置必须仍小于 16384 字节 |
| 控制端与独立 authority | 本批受控发布中协调 pool 的 `business_overlay_sha256`、两角色 service template 的完整 descriptor/私有下载地址及 authority 的对应 pool 配置；以实时配置为准 |
| 网页 | 发布两项暂停原因文案，继续使用现有暂停面板和操作 |

服务角色槽不是固定服务器身份。每次发布重新查询该池所有实例及注册服务，覆盖当前、保留和未来创建路径；不能只更新诊断时看到的实例。服务启动成功、镜像存在和注册表的 source/image hash 都不足以证明业务覆盖代码已生效。

## 固定版本打包

在已完成 build/contracts/相关回归的干净固定 checkout 中，下载并核对当时正在使用的旧 overlay。当前打包器仅接受 `shared-business-eight-permissions-encrypted-v1`（78 条目）；若线上已经升级到另一版本，先审查并调整适配，禁止用旧包覆盖其他新修复。

```sh
npm ci
npm run build
npm run check:contracts
node deploy/tencent-elasticity/chapter-repair-overlay.mjs \
  /private/base-descriptor.json /private/base-overlay.tar.gz \
  /fixed/checkout /private/new-repair-package
```

输出 `overlay.tar.gz`、不含私有 URL 的 `descriptor.json`、含源码 commit/tree、旧包 hash、改变/保留条目的 `receipt.json`。CLI 重新编译 worker，避免陈旧 dist。包版本为 `shared-business-eight-chapter-repair-v1`，118 个服务路径，24 个修复相关文件同时覆盖两个服务。其余 70 条旧服务路径保留原始字节，包括角色特定的 runtime、queue、模型适配器与并发配置实现。

Python 编辑器、预检、质量检查及其内部依赖整体进入白名单闭包；不依赖旧镜像恰好含有新版辅助模块。既有 SQL 原始 hash 保持不变，不运行迁移。把两服务相同路径相邻放入 archive，提高 gzip 压缩率；512KiB 压缩包、4MiB 解压包、单文件 256KiB、严格成员/路径/hash/只读挂载检查保持原值。冷启动把公开清单和安装程序一起压缩，解码后先保存清单，再按原顺序安装、校验和注册；没有私有访问能力进入 UserData。

## 上线核验与回滚

1. 在发布锁内重新核对活动任务、实际池清单、组件版本和回滚前像；逐节点排空后执行既有受控发布流程。不得在用户任务运行中直接覆盖已加载模块。
2. 记录候选包源码 commit/tree、archive hash、loader/bootstrap/adapter/compose hash、两个角色模板及 authority/pool pin；私有 URL 不写入公开回执。
3. 从每个实际 authoring/review 容器读取 descriptor 所列 `/app/...` 文件并逐项比对 SHA-256。确认 `repair_scope.py`、`preflight.py`、`chapter-repair.md`、`file-authoring-scoped-repair.js` 和入口模块实际可加载。
4. 分别验证现有节点更新后运行、停止再热启动、两个角色槽新建冷启动；验证原始创建证明仍匹配，业务版本另有新回执。失败节点保持不接任务，不能用准备好的模板替代真实启动证据。
5. 在独立测试任务中验证：正常更新、空章节多正文补写、错误目标/答案拒绝、暂停续跑不重买模型、完整质量拒绝、合格双 Word 下载。用 yyx 固定输入验证原失败业务结果，并独立审查事实、表格、格式和视觉质量；不改生产原失败 run 的状态来冒充验收。
6. 按实际结果分别登记代码完成、本地可验收、用户验收、已部署并核验。回滚时同步恢复业务包 pin、loader/bootstrap、两角色模板、authority/pool 及现存节点配置；保留新旧草稿和诊断，避免旧部署覆盖并行改动。
