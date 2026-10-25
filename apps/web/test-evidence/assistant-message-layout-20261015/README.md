# BondBuddy 消息、状态与附件布局修复

2026-10-15 用户截图反馈：发送后的正文被挤压，处理状态嵌入用户气泡并竖排，已发送文件仍占据底部上传区。本次反馈为修复范围依据，不包含生产发布授权。关联 #361。

- 基线：`f52d5a16c23208a74cf2ae8ab13f2ed4a4769fbc`（develop）。
- 实现和原型：`53f65c76722410b3a502b64b09705842ca320e44`。
- 实现：`apps/web/src/project-assistant.ts`、`project-assistant.css`。
- 原型：`product-prototype/public/project-assistant-refined.html`，使用本地合成文件演示。

## 原因与行为

原气泡使用通用 `.user` 类，受到主页面用户栏 `display:flex;align-items:center` 的影响。消息作者、正文及消息内部的处理状态横向挤压。上传完成条目也没有在消息提交成功后清除；重复文件的反馈文案又被误用来判断是否已保存。

1. 气泡使用独立的 `ba-message-user` / `ba-message-assistant` 类，作者和正文纵向排版。
2. 排队、运行、查询和失败状态置于用户气泡外，以 BondBuddy 署名单独展示；完成后移除等待提示。
3. 用户气泡中的“本轮使用 N 份材料”读取已有 QA manifest 固定材料版本，点击展开文件名，刷新仍可恢复。后续新上传文件不会被追记到旧消息。这里表示本轮实际输入材料，包含关联项目的材料，不声称均为本次新上传。
4. 接收到消息成功回执后只移除发送开始时的上传条目。报价确认、消息提交失败均保留附件和文字；报价或提交期间新增文件仍留在输入区。文件继续保存在会话材料中。
5. 上传成功标记在文件保存且关联会话完成后设置，重复文件复用成功可正常发送和准备任务，不再依赖中文状态文案。

没有 API、公共契约、数据库、迁移、后台 worker、费用规则或依赖变更。历史消息直接使用既有固定输入；没有 manifest 的消息不推断附件归属。没有修改生产数据或执行生产操作。

## 同尺寸原型对照

| 尺寸 | 实现 | 原型 |
| --- | --- | --- |
| 1440 × 960 | [实现](implementation-1440.png) | [原型](prototype-1440.png) |
| 760 × 1648 | [实现](implementation-760.png) | [原型](prototype-760.png) |
| 390 × 844 | [实现](implementation-390.png) | [原型](prototype-390.png) |

三个尺寸均使用同一条合成债务整理请求及 19 份合成 TXT 文件。正文、材料折叠清单、独立回复状态和空输入区一致。保留的参考差异：原型主工作区是占位页面，未复制实现的会话材料总数入口；截图中的输入框焦点样式也不同。这些不是本次产品交互偏离。截图不含客户材料。

## 验证

- Windows / Microsoft Edge，真实 Vite 前端，HTTP 接口由 Playwright 合成夹具提供。网页范围包括上传、报价、提交、轮询、刷新、重试、历史、窄屏和侧栏交互。
- 针对性首轮 6 项：2 通过、4 失败，原因是新增测试在会话初始化完成前选择文件；加上输入区可用等待后，6/6 通过并生成以上截图。
- 助手完整回归：21 通过、1 个既有可选取证测试跳过（`approved prototype comparison capture`）。本次同尺寸取证通过独立的 `ASSISTANT_MESSAGE_EVIDENCE` 开关完成。
- 最后补充报价阶段并发附件保护，复验相关 2/2 通过（其中 1 个新增测试，1 个提交失败/并发附件测试）。最终测试文件共 23 项，其中 22 项已通过、1 项可选跳过；没有为本次改动执行不相关测试。
- 最终 TypeScript 检查和 Vite 构建通过；构建保留已有大 bundle 提示。独立工作区先构建 contracts、domain、rule-pack-registry、rule-applicability-context、api，解决新工作区缺少生成类型文件的问题。
- 契约验证：171 个合成示例 + 12 个内部库示例及冲突/恢复/用量约束通过；4 个数据生命周期示例通过。`git diff --check` 通过。

复现命令（仓库已安装依赖并构建上述依赖包后）：

```powershell
# 独立终端：apps/web
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197
# 测试终端：apps/web
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:ASSISTANT_MESSAGE_EVIDENCE=(Join-Path (Get-Location) 'test-evidence/assistant-message-layout-20261015')
node ../../node_modules/@playwright/test/cli.js test tests/project-assistant.spec.ts
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ../../node_modules/vite/bin/vite.js build
```

本次没有真实 API/Blob/数据库联调、真实模型调用、扣费或 Excel 生成；模拟回复不证明生成内容质量。统一集成时使用测试账号上传多文件，发送、等待回复、刷新并检查旧消息材料，再核验失败重试。现有统一本地入口未改动，临时 5197 测试进程完成后停止，不将该地址交付为可用的完整集成版。

**开发和自测完成；尚未纳入统一本地集成版；用户未验收；代码完成，尚未部署，待统一发布。**
