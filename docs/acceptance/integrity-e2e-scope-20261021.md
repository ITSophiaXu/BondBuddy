# 诚信核查 E2E 与统一项目选择

2026-10-22 更新：[行内名单与执行检查点修复](integrity-inline-roster-20261022/README.md)已按用户纠正取消对象添加/编辑弹框，并覆盖真实模型前的快照/检查点路径。下文是原交付历史记录；其中对象弹窗差异已由本次修复取代。

依据用户 2026-10-21 确认：每轮 5,000 积分，同轮补证与重新导出免费。开发交付，尚未部署。

范围：项目选择与新建、企业/人员名单、20 个网站、注册地匹配当地证监局/税务局、真实公开搜索记录、人工证据、核查底稿、4.3 归档、历史版本、暂停/续跑和固定费用结算。文件生成/复核/诚信核查共用 ProjectEntry。

原型：BondBuddy-project-overview-design-20261020，commit 35da7b8c9bc649abea4aadd66ab59a624be7e7b4，apps/web/src/project-design/integrity-view.ts、workflows.ts、integrity.ts、region-portals.ts。项目选择以现有复核界面为统一基准（用户明确要求）。

公开搜索不代替网站登录后完整数据库查询。只有真实工具的查询事件能记录执行；来源 URL、主体名称、逐字引文必须匹配工具返回正文及指定官网。无命中、登录/验证码、身份歧义等保持待人工核实。不会生成虚构截图。用户可附真实查询截图、PDF 或 Word，标明用户提交，重新导出底稿免费。按原型分别交付企业与人员诚信核查底稿，均归档至 4.3。

不可变输入、原始工具日志、证据附件和底稿版本按用户/项目隔离。每轮开始冻结 5,000，实际搜索与 Word 回读交付成功才结算；取消或失败释放全部。没有有效搜索不可扣费。导出不调用模型或扣费。

迁移：0113_integrity_rounds.sql、0114_integrity_workpapers.sql。依赖 #713 / #715 / #717 / #719 的更新、复核、全部项目及文件工作流。只向 develop 提交开发 PR，不部署、不修改生产数据库。

## 开发与验证状态

- 开发与合成 E2E 自测完成；本功能的独立本地测试入口已启动。
- 真实网站搜索：未验证。点击真实核查确认时被自动审批拒绝，理由是实际认证模型/搜索用量尚无明确授权；未换用 API 或命令绕过。
- 之前模型/文件沙箱 preflight 成功，仅证明该旧镜像的模型文件能力，不能当作官网搜索证据。最新 worker 镜像的 preflight 标记为 `not_run`，保留旧 preflight 收据，不伪造验证。
- 用户尚未验收；未部署，待统一集成与发布。PR 保持 draft，不自动合并。

### 自动化证据

2026-10-21，Node 22、隔离 PostgreSQL/Azurite、实际 API/worker 阶段和 Python Word 生成，搜索供应商为 synthetic。

`BB_LOCAL_INSTANCE=integrity-20261021 node scripts/local-integration/test-integrity.mjs`：13 + 1 = **14 passed，0 failed，0 skipped**。

覆盖名单版本冲突、重复开始幂等、余额冻结、固定 5,000 结算、同轮免费补证导出、跨用户隔离、官网 URL 验证、企业/人员独立 Word、个人标识遮蔽、授权下载的 SHA-256、旧版本字节保持不变、4.3 归档、任务摘要、积分记录、取消释放、取消后免费导出、没有实际查询记录时失败并释放。

contracts/domain/rule packages/API/worker TypeScript build、web typecheck 和 Vite build 通过；契约样例 171 synthetic + 12 internal、生命周期 4 项及 OCR/issuer-binding 40 项通过。Vite 保留既有的大文件体积警告。

合成 Word 四份（企业/人员 × 初版/补证版）均通过授权下载验证，使用 documents renderer + LibreOffice 在断网容器中渲染，逐页检查中文、换行、页码、签字与缺证说明。没有把合成查询或附件称为真实官网证据。日志与产物仅存于本地 runtime 的 `evidence/synthetic-workpapers/`，不提交业务仓库。

### 浏览器验证与原型对照

实际浏览器已验证：登录、三个共用项目选择入口、新建项目、选择已有项目、名单增删/批量添加、人员类型、保存并恢复名单、广东深圳属地链接、网站范围和联系帮助、5,000 积分确认页。真实搜索确认被阻止后没有创建真实查询任务；结果页与补证链路由实际 API/worker 的合成 E2E 覆盖，尚待真实浏览器查询验收。

截图均为 1265 × 712。原型 commit `35da7b8c9bc649abea4aadd66ab59a624be7e7b4`；实现截图对应 `b6d24a1e` 的共享选择组件和 `7ab282bb` 的名单页。

| 页面 | 原型/基准 | 实现 |
| --- | --- | --- |
| 项目选择 | [原型](integrity-ui-20261021/prototype-project-selector.jpg) / [复核基准](integrity-ui-20261021/review-project-selector.jpg) | [文件生成](integrity-ui-20261021/file-project-selector.jpg) / [诚信核查](integrity-ui-20261021/integrity-project-selector.jpg) |
| 名单与网站范围 | [原型](integrity-ui-20261021/prototype-roster.jpg) | [实现](integrity-ui-20261021/implementation-roster.jpg) |

与原型的差异待用户验收：单个对象在弹窗中填写后加入名单，原型为行内输入；提供显式保存并在路由离开前保存，原型仅在本地自动保存。结果采用真实公开来源、待人工核实、上传证据和免费导出替代演示记录；网站和企业/人员两份文件与原型一致。项目选择统一到现有复核组件是用户明确要求。没有将这些差异自行标记为用户批准。

窄屏视口覆盖请求未在当前内置浏览器实际生效（DOM 仍为 1265 px），已恢复默认；未声称手机布局验证通过。

## 本地访问与复现

这是本功能独立开发环境，不替代指定集成测试 chat 维护的统一本批验收版。

- 网页：`http://localhost:5195/#integrity`，API `3025`，PostgreSQL `15445`，Azurite `10025`。
- 测试账号：`integration_user`；登录口令通过当前交付消息提供，不写入本文。积分为隔离测试账本。
- 测试项目：`诚信核查本地验收 · 公开企业样例`，已保存 1 家公开企业和信用中国网站范围；仅保存名单，尚未执行真实查询。
- 工作区：`BondBuddy-integrity-e2e-20261021`；runtime：父目录 `work/local-integration-runtime-integrity-20261021`。保留其他 5193 / 5194 环境。

在此工作区运行（Node 22）：

```powershell
$env:BB_LOCAL_INSTANCE='integrity-20261021'
node scripts/local-integration/start.mjs
# 停止此实例，保留数据；若有活动任务会拒绝停止。
node scripts/local-integration/stop.mjs
# 合成回归，不调用真实模型或查询网站。
node scripts/local-integration/test-integrity.mjs
```

界面验收顺序：分别打开文件生成/复核/诚信核查确认选择器一致 → 新建或选择项目 → 核对名单与网站、注册地链接 → 保存后刷新 → 核对费用确认。真实搜索获得授权后，再验证开始/暂停续跑/底稿下载 → 补证并免费导出 → 项目文件 4.3 与旧版下载 → 检查每轮仅扣 5,000。

## 集成与迁移

新增迁移 `0113`、`0114` 仅应用到本地隔离数据库。没有修改已应用的迁移；没有新增 npm 或生产 Python 依赖。LibreOffice QA 镜像仅用于本地检查，不属于生产 worker。

PR 以 develop 为目标，前置 #713 → #715 → #717 → #719 尚需按顺序集成；本功能相对父版本 `09cf95f3`。集成负责人应检查迁移编号和共享账务 finalizer 的最新定义，固定版本复验后再交用户验收。本开发 chat 不修改共享交接文件、不向其他 chat 自动发消息、不发起生产变更。
