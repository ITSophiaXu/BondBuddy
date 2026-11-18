# 尽调底稿包导航拆分

关联问题：[#1626](https://github.com/ITSophiaXu/BondBuddy/issues/1626)。

本次按用户 2026-11-18 的明确要求，只增加“尽调底稿包”导航并搬移原功能。保留现有页面、控件与步骤；不实施此前讨论的布局重设计。

## 改动范围

- `#workpapers` 复用原 FileWorkspace、FileGenerationPanel 和 WorkpaperPanel，承载募集说明书选择、目录与模板、章节顺序、试生成及底稿结果。
- `#generate` 保留其他 12 类文件。新准备清单与报价按当前入口限定文种，原 API、生成器、计费与上传恢复逻辑继续复用。
- 在现有按用户和项目隔离的浏览器缓存中保留普通文件选择与底稿章节顺序，避免来回切换丢失；目录、模板、资料和编制要求仍沿用现有项目准备记录。
- 旧 `#generate` 底稿书签转至新入口，保留任务、批次及返回项目参数。充值恢复沿用原请求，成功后清除恢复参数。
- 旧的未确认混合提交保持原请求与范围，继续使用现有恢复流程；历史批次仍可按原记录查看，不拆分历史账单。

没有 API、worker、契约、依赖或数据库迁移改动。

## 视觉依据

基线原型：`product-prototype/public/file-templates-v2.html`，基线提交 `933844bbb39bc62dc21380e6fd863bd6d8b7e551`。开发分支已对齐后续 develop `303ea69a`（目标报告期文案更新，与本次文件无重叠）。

原型用于对照原有组件样式。本次导航、页面归属与“文件模板”文案变更依据用户最新要求，不要求沿用原型把底稿与其他文种放在同页。

| 尺寸 | 现有原型 | 尽调底稿包 | 文件生成 |
| --- | --- | --- | --- |
| 1440 × 960 | [原型](workpaper-navigation-20261118/prototype-1440.png) | [截图](workpaper-navigation-20261118/workpapers-1440.png) | [截图](workpaper-navigation-20261118/documents-1440.png) |
| 390 × 960 | [原型](workpaper-navigation-20261118/prototype-390.png) | [截图](workpaper-navigation-20261118/workpapers-390.png) | [截图](workpaper-navigation-20261118/documents-390.png) |

截图为本地真实前端组件，项目、HTTP 数据和任务结果均为合成数据。已查看四张截图，准备区域分别归属对应入口；手机布局没有横向溢出，操作区沿用原样。

## 复验方式

构建与单元检查（仓库根目录）：

```text
npm run build
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/project-navigation.test.js apps/web/dist-test/file-generation-entry.test.js apps/web/dist-test/file-generation-cache.test.js
npm run check:contracts
```

浏览器回归从 `apps/web` 运行：

```text
node ../../node_modules/@playwright/test/cli.js test workpaper-navigation.spec.ts file-generation-choice-layout.spec.ts file-generation-flow.spec.ts file-template-preparation.spec.ts generation-save-feedback.spec.ts workpaper-progressive.spec.ts
```

本次 Windows 使用 Microsoft Edge、单 worker，临时 Playwright 配置在 `127.0.0.1:5471` 启动独立 Vite，`reuseExistingServer: false`，结果写入 `work/nav-split-test-results`。复验可使用仓库原配置及 `BB_E2E_BROWSER_CHANNEL=msedge`，或为独立端口创建同等临时配置；临时配置不属于产品改动。

## 验证结果

- 全仓构建通过；对齐 `303ea69a` 后再次执行前端类型检查及生产构建通过。
- 导航、入口范围与原文件缓存单测：27 pass / 0 fail / 0 skip。
- `check:contracts` 通过（包括 182 个合成样例、12 个内部模板库样例及其附属检查）。
- 六个浏览器测试文件共 93 项：首轮 91 pass / 2 fail / 0 skip；两处失败分别为新入口切换尚未完成就拦截保存、历史批次 fixture 未提供单批查询响应。修正测试后，在最终代码上复跑受影响的保存反馈与入口测试文件，26 pass / 0 fail / 0 skip；其余 67 项已通过，本次生产改动未再变动。93 项均已获得通过结果。
- `git diff --check` 通过。

## 验收边界

覆盖导航高亮、普通文种隔离、章节顺序与选择恢复、报价范围、旧链接和历史批次、原请求恢复、上传重试、模板匹配、保存队列/冲突、试生成/续跑/下载入口以及桌面和手机布局。

这是开发自动化验证，没有调用真实模型、支付渠道或生产数据。真实后端生成链路与用户操作验收由后续固定版本的本地集成测试完成。

代码完成，尚未部署，待统一发布。用户尚未验收。
