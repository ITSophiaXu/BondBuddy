# 上传 UX 统一 — Issue #935 / PR #930

开发和自测完成，代码完成，尚未部署，待统一发布。用户尚未验收；本目录不是统一本地集成验收版。

实现与公共原型版本：`ac55c82bd9e449dc8a1d268fe3a2fd36d4906d7c`。已整合 develop `43e6ecc2`（合并提交 `49eed89c`）。修改前截图来自 `da923cc2` 的逐页审查；该版本已含 PR #930 的第一轮文件生成调整，不能当作生产现状截图。

## 交付与对应页面

公共外观定义在 `apps/web/src/upload-ux.css`，可访问文件选择及拖拽包装在 `upload-picker.ts`。既有页面保留自己的文件输入、事件、上传队列及业务确认；公共包装不替换 FileList，也不重写上传协议。

| 范围 | 改动 | 证据前缀 |
| --- | --- | --- |
| 更新募集书 | 参考稿与财务区同为 112px 标准入口；原角色、多选、拖拽和只读约束保留 | `update-reference`、`update-audit` |
| 复核募集书 | 标准入口、补证弹窗、文件卡片、44px 重试/移除；删去重复错误段落 | `review-entry`、`review-recovery` |
| 文件生成 | 来源区与其他模块共用样式；目录/模板/文件夹/补充资料使用紧凑入口；仅需原字节时重选 | `actual-*`、`preparation-*`、`progress-file-generation-*` |
| 历史文件/底稿入口 | 模板弹窗、底稿目录选择与恢复按钮共用样式 | `workpaper-*`、`progress-workpaper-*` |
| 项目问答 | 清单和补充入口统一；精简恢复说明，突出确认与取消 | `qa-entry`、`qa-recovery` |
| 诚信核查 | 原生文件框替换为标准入口，仍需单独保存补充证据 | `integrity-entry`、`integrity-recovery` |
| 项目文件/一致性检查 | 关联文件弹窗与恢复入口统一；仅确需原字节时显示重选 | `project-import`、`progress-project-file-*` |
| BondBuddy 对话 | 保留适合输入区的紧凑附件入口，恢复主/次按钮共用样式 | `assistant-entry`、`assistant-recovery` |
| 历史主题式制作 | 来源、模板、补充入口及恢复文件卡片统一，格式提示保留 | `topic-entry`、`topic-recovery` |

标准入口最小高度 112px，紧凑入口和恢复动作最小高度 44px，动作最小宽度 44px。白底描边为次要操作，深绿实心为主要操作；附件允许保留回形针等用途图标。传输百分比和保存阶段继续使用既有 `uploadProgressHtml`，不伪造进度。

## 原型与实际截图

公共原型：`product-prototype/public/upload-ux-unified.html`，与上述实现同在 `ac55c82b`。标准、紧凑、传输中、保存中、待处理、需原文件、已保存七类示例见 `prototype-1440/390/320.png`。新增原型按用户本次明确要求统一控件；既有业务页面结构和确认语义保留，尚未取得用户操作验收。

- [修改前逐页概览](before-overview.png)
- [修改后手机概览](mobile-overview.png)（同为 390px 视口截图，拼图等比缩放；原始截图另存）
- [公共原型 390px](prototype-390.png) / [1440px](prototype-1440.png) / [320px](prototype-320.png)
- [复核恢复 390px](review-recovery-390.png) / [1440px](review-recovery-1440.png)
- [生成恢复 390px](actual-recovery-390.png) / [1440px](actual-recovery-1440.png)
- [问答恢复 390px](qa-recovery-390.png) / [诚信补证 390px](integrity-recovery-390.png)
- [关联文件 390px](project-import-390.png) / [聊天附件恢复 390px](assistant-recovery-390.png)

原始截图文件名末尾标记视口宽度；局部截图的像素宽度为控件所在区域宽度。对应 JSON 记录实际尺寸、样式、accept/multiple 和页面级溢出，包含不可见输入，不把隐藏输入算作可见操作。人工查看了上述入口和恢复态及手机拼图；自动检查标准高度、44px 操作区域和上传区域边界。

已知范围：诚信核查 320px 视口的页面级 JSON 仍记录横向溢出；上传表单及本次新增控件均在视口内，本 PR 没有重排该页的顶部步骤/全页布局。聊天恢复区保持可滚动，较长说明可能需要滚动查看。没有声称所有业务页面的整体布局均完成整修。

## 验证

2026-11-09，Windows / Microsoft Edge，真实前端路由或组件控制器 + 合成 HTTP、文件、项目与账号。最终选定回归 **78 passed，0 failed（1.6 分钟，2 workers）**。涵盖 8 组全站入口/恢复/公共组件检查、8 组导航保护、键盘文件选择、隐藏原生输入的 Tab 焦点、单/多文件拖拽、禁用字段、长文件名、取消、原请求恢复、仅缺字节时重选、正确角色和模板/目录业务状态。

```powershell
# 在 apps/web 执行；本次使用隔离 Vite 端口 5329。
$env:BB_E2E_BASE_URL='http://127.0.0.1:5329'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/upload.spec.ts tests/prospectus-panel.spec.ts tests/generation-source-ux.spec.ts tests/all-upload-progress.spec.ts tests/workpaper-upload.spec.ts tests/upload-entry-recovery.spec.ts tests/upload-ux-consistency.spec.ts tests/file-template-preparation.spec.ts tests/generation-navigation-recovery.spec.ts --grep 'reference and audit|reference upload matches|reference drag|reference drops|corrected selection|generation|source actions|only asks|active upload|optional materials|cancel before byte|live file picker|upload.*progress|upload at|project file resumes|project file recovery|support resumes|support retains|template creation resumes|saved directory recovery|directory import succeeds|removing a failed|empty state|lost byte acknowledgement|audit|shared|support recovery|support automatically|navigation|unconfirmed adoption|independent catalogue|custom templates|supplement exposes|template uploads|directory loading' --timeout=40000 --max-failures=3 --workers=2
node ../../node_modules/typescript/bin/tsc --noEmit --pretty false
node ../../node_modules/vite/bin/vite.js build
```

TypeScript 和 Vite 构建通过；Vite 提示既有大 chunk 大小警告。contracts 编译通过。`git diff --check` 通过。部分旧断网夹具原本要求手工确认，但 develop 的新接口已自动恢复；本次更新测试以覆盖自动确认与真正持久化的暂停记录，没有回退接口行为。

合成测试验证页面交互和请求身份，不证明真实存储、模型、账务或成果链路已验收。本次没有生产访问写入、模型调用、收费任务或部署；没有新增依赖、公共接口或数据库迁移，仅 web。后续交专门集成测试与发布 chat 统一处理。
