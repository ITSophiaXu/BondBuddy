# 2026-10-30 UX 修复与旧问题复验

用户要求修复本次审查及此前记录的 UX 问题；明确排除 #832（by design）。全局侧栏开启独立业务并重新选项目，项目内入口携带项目上下文，两者保持原设计。

开发基线 `c6cc55c8521f31323d806744cf559351f3ad35fd`；本批核心修复 `143dd1d1`，本地整合提交 `e8afad19` 纳入既有 PR #831（`2b2868f0` / `bd994cec`）。后续提交补充精确当前稿次判断、回归夹具及本证据。此目录所在 PR/commit 为完整交付版本。没有部署、迁移或重启服务，没有真实模型调用、充值或余额调整。

最终交付 PR **#837** 已 rebase 到最新 develop `1c6fc9fd332ecc011cb9ab61ba086f26cb7cdd76`，核心修复对应 `9452bca2`、完整代码及回归对应 `355868bc`。#831 已在上游，PR 差异不重复包含其改动。新基线各 workspace 编译、Web 类型检查和生产构建通过，受影响浏览器用例 **77/77**、契约 **72/72** 及 171+12+4 样例通过；6 个同尺寸修改后场景重新截图，比较测试 **3/3**。前面的 146+20 浏览器结果属于 rebase 前完整复验，两组范围有重复，不累加。

GitHub CI 的 5 个任务全部显示失败但 **0 steps、未启动**；API annotation 均为账户付款失败或 spending limit 需调整（[desktop-ux 记录](https://github.com/ITSophiaXu/BondBuddy/actions/runs/41024797095/job/123960243920)）。不将云端 CI 写成通过，不改变账单或绕过保护规则；本地证据与该平台阻碍分别记录。

## 修复清单

| Issue | 结果与验收重点 | 源码 |
|---|---|---|
| #828 | 目录识别保存后立即解锁范围、全选/清空、要求和换目录；无需先前进再返回。不重绘正在编辑的输入。直接选 1 项，确认页为 1 份、4,500 积分；刷新保留，未创建生成任务。 | `workpaper-panel.ts` |
| #829 | 确定不支持、空文件、超限、加密及无法核验的结构提示换文件；检查服务暂时失败仍可重试原文件。替换在移除旧本地待处理记录成功后才开始，不重复发送已保存材料；待处理按钮改为“请先处理材料状态”。 | `upload-error.ts`、`main.ts`、`project-execution.ts` |
| #830 | 复用 PR #831，移除误导性的选填细分类与重复原稿上传。财务主入口及期间说明保留，已有细分类文件、来源声明与任务引用保留。 | `main.ts`；既有材料页面验收见相邻 `prospectus-material-ux-20261030` |
| #833 | 文件行和版本记录分别标识“文件版本 V1”和“当前募集书 V2”。稿次由项目、ID、版本和 SHA 精确唯一匹配；当前身份采用稿次状态的 current_version_id，无法核实时不猜测稿次。 | `project-files.ts` |
| #822 | 登录失败和找回服务不可用时仍能访问“忘记密码？查看找回方式”。未开放时说明原账号资料保留、可检查已保存密码、新账号不能恢复原项目；读取失败可重试。已开放时继续既有身份核验流程。 | `main.ts`、`recovery.ts` |
| #817 | 点击诚信底稿下载立即显示准备状态，传输显示实际接收字节；只有可靠总长度时显示百分比。同一进行中的操作不能重复提交，120 秒超时及网络失败恢复操作。授权、任务/版本/哈希检查保留；提示浏览器接管，不宣称本地保存成功。 | `integrity-workspace.ts`、`download-progress.ts`、`api.ts` |
| #818 | 筛选框和下一项按钮统一为 40px 高、相同字体与垂直对齐；窄屏换行后不重叠。筛选和跳转仍正常。 | `integrity-workspace.css` |

## 原型及同尺寸对照

所有新截图为实际本地前端渲染、synthetic HTTP/资料/余额，**不是线上、真实模型或完整本地 API 的验收**。截图未替换产品文字，全部为合成项目和账号，无客户内容。

- 1366×768 固定场景的修改前画面由 Vite load 插件读取基线 `c6cc55c8` 的 9 个受改模块（main、project-execution、project-files、recovery、workpaper-panel、integrity-workspace ts/css、api、upload-error）；其余依赖复用本地构建。它是基线源码对照，不是旧产品截图冒充当前版本。
- 修改后来自本分支实际页面。`ux-review-comparison.spec.ts` 使用相同合成场景和尺寸；分别执行 3/3 通过。登录/找回、版本历史和工具栏已经人工查看图片。
- `workpaper-batch.html` 与 `workpaper-import-preview.js` 原型及实现 1440/390 对照由现有 `workpaper-upload.spec.ts` 覆盖；此次仅修正 busy 结束后的禁用状态，不改变步骤。
- 募集书与文件沿 `prospectus-panel.html`、`project-workspace.*` 和已迁移 `project-files.ts`；此次补充明确的版本命名，不改变版本生成或选用规则。
- 登录/找回与诚信核查沿基线已迁移页面，不新增业务页面或导航。本次偏离仅为用户授权修复 Issue 所述的入口、状态文字及控件对齐。没有声称用户已验收截图。
- 材料简化的用户要求、原型关联和 1440/390 前后图已由 #831 保存在 [材料页面验收](../prospectus-material-ux-20261030/README.md)。

| 场景（1366×768） | 修改前 | 修改后 |
|---|---|---|
| 下载等待反馈 | [前](before/integrity-download.png) | [后](after/integrity-download.png) |
| 结果工具栏 | [前](before/integrity-toolbar.png) | [后](after/integrity-toolbar.png) |
| 文件行稿次 | [前](before/file-version-row.png) | [后](after/file-version-row.png) |
| 文件历史稿次 | [前](before/file-version-history.png) | [后](after/file-version-history.png) |
| 登录入口 | [前](before/login.png) | [后](after/login.png) |
| 找回未开放 | [前](before/recovery-disabled.png) | [后](after/recovery-disabled.png) |

补充：[错误文件替换](after/upload-replacement.png)、[下载失败可重试](after/integrity-download-error.png)、[390px 工具栏](after/integrity-toolbar-390.png)、[目录直接选范围](after/workpaper-editable.png)、[所选一项确认](after/workpaper-selected-confirmation.png)。

## 测试与边界

Windows / Node 22+ / Edge / Playwright；前端 Vite 5188，合成接口由浏览器测试拦截。无生产 API、数据库或模型调用。

- `upload.spec.ts project-execution.spec.ts authoring-source-guide.spec.ts ux-recovery-entry.spec.ts ux-review-fixes.spec.ts project-entry-layout.spec.ts`（文件名匹配亦包含 workpaper-upload）：**146 通过、1 条 opt-in 跳过**。排除下面 2 条已有夹具失败；并非全仓测试全绿。
- 原 `project-execution.spec.ts` 的充值返回与 preflight 期间编辑两条测试，在修复前模块基线也同样失败：旧测试匹配“充值 ¥200”，当前按钮为“充值 ¥200.00”；另一条仍断言“尚未保存”，而自动保存夹具未实现保存消息接口。这两条未弱化断言，作为测试维护待办单列。
- 旧 UX 复验首轮：17 通过、1 跳过、3 失败。3 个失败来自旧数字计费 HTTP 夹具未适配当前字符串协议，已使用既有 `billing-fixture-wire` 编码并补 catalog 读取，定向 **3/3 通过**；最后整组 **20 通过、1 条 opt-in 跳过**。保留了原金额/身份/行为断言，未修改产品以兼容错误夹具。
- 上传与下载定向补测 **7/7 通过**，包括 artifact ID/version/run 不一致拒绝下载、失败后重试取得精确 DOCX 字节、错误文件替换及临时错误重试。下载工具单元 **6/6 通过**（真实分块、未知/压缩长度、超时）。
- 公共契约 **72/72 通过**；171 个 synthetic + 12 个内部库样例、4 个数据生命周期样例通过。workspace 编译、web TypeScript 与 Vite 构建通过，保留已有大 bundle 提示。
- 目录直接修改范围的最终截图测试 **1/1 通过**；同尺寸比较两侧各 **3/3 通过**。这些与主回归有重复，不相加冒充独立覆盖。
- 原 integrity-delivery 整套曾有旧补证 UI/0积分断言失败；本轮仅修正并通过下载身份不匹配子集，没有宣称该整套全绿。
- 真正浏览器 125% 缩放尚未验证。已实际尝试 headed Edge + Windows 控制，测试窗口未在返回的可控制窗口中出现，随后停止该尝试。1093px 测试只表示窄视口，不代称 125%。最终统一验收应补 100%/125% 浏览器工具栏及键盘操作。
- 真实模型输出、真实后端大文件限速、线上账号找回配置、用户最终视觉验收仍需在统一集成环境完成。本批不改变账号恢复安全策略。

## 之前记录的问题如何处理

| 记录 | 本轮处理 |
|---|---|
| #788 字号/英文标题 | 已由 #790 修复并关闭；本轮 project-entry-layout 复验，不重复实现。 |
| #623 / #612 助手遮挡、收起恢复 | 当前实现已有右下入口、按需侧栏、桌面正文让位、窄屏焦点返回。复验草稿跨导航/刷新、五种窗口和多页 reflow；不恢复旧常驻布局。真实移动触摸/线上发布仍单独验收。 |
| #680 复核旧助手、重复控件 | 当前已用内联要求和统一按需助手；复验保存失败恢复、紧凑创建、原型布局、标题与导航。 |
| #361 / #384 材料与编制入口 | 主回归覆盖误传替换、原发行人可空、原稿声明、执行锁、失败恢复、事件/积分状态与返回上下文。已实现的旧切片不再重复改写。 |
| #682 / #685 / #448 汇总 | 汇总含上述 UI、后台执行、生产版本、Word内容及真实模型验收等不同范围。仅更新本轮已证实切片，不能整单宣称已解决。 |
| #819 诚信网站诊断 | 独立后台/站点可靠性事项，已有 #824 承接部分网站处理；不把 #817/#818 的页面修复宣称为所有网站查询已修好。 |
| #832 | 用户确认 by design，保持撤回，不重新打开，不改变全局侧栏选项目行为。 |

**代码完成，尚未部署，待统一发布。** PR #831 已合入上游；本 PR #837 已基于包含它的最新 develop 整理。生产统一发布、用户验收与开发测试是分别的状态。
