# 文件生成 UX Flow：实现与验收交接

状态：开发和自测完成；尚未准备统一本地集成版，用户尚未验收，尚未部署。

## 版本与设计依据

- 代码及原型归档提交：`61e46c3e`。
- 开发基线：`6725d8f74da2c9793698f1eaf8179eb76ab55b5c`（develop）。
- 用户于 2026-10-28 确认“按这个设计重新实现文件生成的 UX FLOW”，并明确要求保留文件表格“添加一行”。
- 募集说明书入口参照 [PR #787](https://github.com/ITSophiaXu/BondBuddy/pull/787) 的 `86229e0f3bf1c1ac35c11d3222810f6f9ae6ffe6`，使用“上传新募集说明书 / 选择项目已有募集说明书”两个原生单选项、版本下拉和当前选中文件反馈。
- 用户确认的交互设计归档：[file-generation-flow-approved.html](../../../../product-prototype/public/file-generation-flow-approved.html)。归档 Git blob 为 `e326dd148a3a29d76feca2387ad452f93564e88c`，与本 PR 实现提交一起版本化。归档中的生成、余额、文件均为演示。
- 前端原型登记关联：#361；影响实际页面为 `#generate` 的募集说明书、生成内容、确认和结果页，不修改复核页面。

## 最终流程

1. 进入项目文件生成后先上传或选择募集说明书。有保存版本时展示已有版本；没有版本时展示上传。上传保存并选用后仍停留在第一步，由用户点击下一步。
2. 选择“按目录批量生成”或“按模板生成文件”。已有目录显示文件名、识别数量与“更换目录”；只有无目录时出现大上传入口。目录按文件夹分组，支持搜索、整组选择及逐项勾选；长目录在清单内滚动。
3. 模板方式保留文件表格、添加一行、自动复用已保存模板、换模板、移除、去重以及每行已保存要求与依据。补充要求和依据默认折叠；未保存要求会重新展开。
4. 两种方式均进入独立确认页。模板按既有固定价格展示范围及计费规则；底稿展示所选目录范围和费用上限。返回调整不丢失选择；确认前不提交生成任务。
5. 确认后显示任务进度和成果。既有下载、暂停、续跑、失败重试、幂等请求、补充资料恢复与版本锁定沿用原实现。生成记录入口可切换查看两类任务。

## 同尺寸原型 / 实现对照

以下 `viewport` 图片均为 960 px 高；另有同名不带 `viewport` 的整页图。全部为合成项目和模拟接口数据，不含真实成果。

| 页面 | 宽度 | 用户确认的原型 | 实际前端 |
| --- | --- | --- | --- |
| 募集说明书 | 1440 | [原型](prototype-source-1440-viewport.png) | [实现](source-existing-1440-viewport.png) |
| 募集说明书 | 390 | [原型](prototype-source-390-viewport.png) | [实现](source-existing-390-viewport.png) |
| 募集说明书 | 320 | [原型](prototype-source-320-viewport.png) | [实现](source-existing-320-viewport.png) |
| 文件表格 | 1440 | [原型](prototype-template-1440-viewport.png) | [实现](template-table-1440-viewport.png) |
| 文件表格 | 390 | [原型](prototype-template-390-viewport.png) | [实现](template-table-390-viewport.png) |
| 文件表格 | 320 | [原型](prototype-template-320-viewport.png) | [实现](template-table-320-viewport.png) |
| 已有目录 | 1440 | [原型](prototype-directory-1440-viewport.png) | [实现](directory-1440-viewport.png) |
| 已有目录 | 390 | [原型](prototype-directory-390-viewport.png) | [实现](directory-390-viewport.png) |
| 已有目录 | 320 | [原型](prototype-directory-320-viewport.png) | [实现](directory-320-viewport.png) |

确认页：[模板桌面](template-confirm-1440.png)、[模板手机](template-confirm-390.png)、[目录桌面](directory-confirm-1440.png)、[目录手机](directory-confirm-390.png)。上传状态：[无稿](source-empty.png)、[上传失败](source-upload-failed.png)。

逐屏核对结果：第一步二选一、第二步模式与已有目录的视觉层级、模板表格及添加行、第三步独立确认、手机无横向溢出均已检查。原型示例账号、文件名、文件数量不同于合成测试，实际前端继续使用产品现有侧栏、项目上下文和 BondBuddy 悬浮入口。独立归档未加载原内联宿主的图标运行时，原型截图的部分装饰图标缺省。

需要在集成版实际验收的兼容差异：生成仍通过现有 API 选用项目当前稿，不增加“每个功能独立选择版本”的后端存储，界面没有沿用原型“所选版本只用于本次生成”的承诺；正在使用的当前稿遵守既有删除保护，来源卡提供更换而不提供强制删除。目录更换在页内展开。以上为保留既有 API/数据保护的实现边界，未将代码自测等同于用户确认这些差异。

## 验证

- 148 个相关浏览器用例覆盖 8 个 spec，最新针对改动流程、入口意图、手机及底稿的 71 个用例全部通过。其余表格与共用募集说明书组件 77 个用例通过。曾出现的旧断言失败已按新流程修正；长目录手机截图超时在限制清单滚动区域后复跑通过。
- 前端 TypeScript `--noEmit` 和 Vite production build 通过。Vite 保留原有大包体提示。
- contracts 的 49 个 integrity/workpaper/OCR/issuer-binding 检查通过；171 个公开样例、12 个内部参考库样例、4 个生命周期样例通过。
- 运行环境：Windows，Node 24.22.1，Playwright + Edge，前端 Vite 监听 `127.0.0.1:5189`。没有修改依赖或 lockfile。

浏览器测试加载真实前端代码，通过 Playwright 路由模拟 HTTP、上传回执、任务和余额；它们验证页面、选择、恢复、请求内容及错误状态，不证明真实存储、worker、模型调用、收费或 Word 生成质量。未运行真实模型生成，没有连接生产数据，也没有生产变更。

复跑命令（先在仓库正常安装依赖并编译 workspace packages；本次使用已有依赖和本工作区编译产物）：

```sh
# 终端一，在 apps/web
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5189 --strictPort

# 终端二，在 apps/web；设置 BB_E2E_BASE_URL=http://127.0.0.1:5189
# Windows 另设置 BB_E2E_BROWSER_CHANNEL=msedge
# 截图另设置 BB_FLOW_EVIDENCE=test-evidence/generation-ux-flow-20261028
node ../../node_modules/@playwright/test/cli.js test file-generation-flow.spec.ts file-generation-workbench.spec.ts generation-entry-intent.spec.ts generation-mobile-workbench.spec.ts prospectus-panel.spec.ts prospectus-saved-reentry.spec.ts prospectus-selection.spec.ts workpaper-batch.spec.ts --workers=1
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../node_modules/vite/bin/vite.js build
```

Vite 仅为本次前端测试服务，不能当作统一本地验收入口；在启动它的终端按 Ctrl+C 停止。

## 集成交接

- 无数据库迁移、无新环境变量、无新增依赖，API/worker/计费契约未改。
- [PR #786](https://github.com/ITSophiaXu/BondBuddy/pull/786)（`8d58a8ab03b60ce3425340c11d23554b9e4599a2`）也修改生成首页与来源入口。本实现覆盖该入口布局；整合时不要重复叠加 #786 的旧“先选择方式”首页。未修改、关闭或合并该 PR。
- #787 是视觉/交互参照，其复核改动仍需按自身 PR 集成。本 PR 没有把未合并复核代码复制进来。
- 由开发集成测试 chat 整合固定版本，在独立测试数据库及存储上验收：无稿上传、切换项目已有稿、已有/新目录、表格添加与替换、补充要求保存、确认前不提交、真实任务进度、断网恢复、下载、收费边界，以及两类记录互相切换。
- 用户完成统一本地集成版验收后，再由指定发布 chat 按授权统一上线。**代码完成，尚未部署，待统一发布。**
