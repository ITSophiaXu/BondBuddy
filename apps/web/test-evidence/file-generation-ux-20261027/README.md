# 文件生成 UX · 2026-10-27

用户要求重设计截图中的文件生成页面，减少无用元素并改善关键入口；查看预览后进一步要求“选择要生成的文件的 UX 紧凑一些，现在占了太大的空间”。本目录记录该开发方案、自测和集成交接，不表示用户已验收。

初版实现及对应原型 commit：`bb46d676b37f4a6348e7e5adcb355ae239f4dc1b`，左右布局修正及对应原型：`57c0d643`；基于 `origin/develop` 的 `1d8615c38fe8c843908b75e4344abee7acbf3545`。独立分支 `feat/file-generation-ux-20261027`，[PR #757](https://github.com/ITSophiaXu/BondBuddy/pull/757) 以 `develop` 为 base。

## 左右布局修正

用户再次反馈左侧较短、右侧内容很长。补充要求和补充依据已从右侧模板栏移出，放到上方选择/模板区域之后，桌面横跨页面并排展示，手机按顺序堆叠。当前两份模板示例中，目录约 631px、右侧约 625px；下方两张卡片各宽 501px，使用整页宽度。预览手机可选区默认折叠，与实际页面一致。

本轮 `file-generation-workbench.spec.ts` **33/33** 通过；新增布局断言覆盖补充区位于两栏之后、跨满页面、两卡并排等宽，原保存/上传重试和费用确认用例全部通过。TypeScript / Vite 再次通过。原型 1440/390/320px 无溢出或脚本错误，全选和清空通过；[测量记录](balanced-layout.json)、[下方区域截图](balanced-bottom-1440.png)。初版其他验证结果保留于下文。

## 改动

- 页面使用全站已有项目上下文，移除重复项目条和三步导航；标题区直接提供更换项目、生成记录、项目文件。
- 无募集书时使用一个可点击、可拖放的上传区，隐藏空历史和重复上传折叠项。选中文件后展示保存、取消、重选；已有版本可直接下载、替换和查看历史。
- 文件目录默认展开并放在模板前，桌面目录与模板并排；窄屏按阅读顺序排列。文件选项为 44px 整行点击目标、桌面双列、紧凑分类间距；长说明改为悬浮提示并保留无障碍文本。保留全选、清空、折叠和键盘勾选。
- 模板随选择展示。底部保留费用核对入口，并在缺模板时直接提供“添加 N 份模板”。补充要求、依据及原保存恢复流程保留。
- 募集书采用、版本固定、原请求重试、账号/项目隔离和费用确认沿用原业务语义。无 API、worker、公共契约、数据库迁移或新增依赖。

源码：`apps/web/src/file-workspace.ts`、`prospectus-panel.ts`、`project-entry.ts`。共享样式：`product-prototype/public/file-generation-ux.css`。原型：`product-prototype/public/file-generation.html`、`file-generation-preview.js`。影响已迁移的文件生成项目入口、选稿、选文件页面及生成记录导航；上传区新布局仅应用于 generation 用途。

## 原型与实现对照

原型从真实前端的合成场景 DOM 快照生成，并复用相同 CSS；选文件两边截图已更新至 `57c0d643`，选稿场景沿用初版基准。相同视口逐屏核对。原型省略全站导航与项目上下文壳层，并带有“示例数据，不上传或生成”工具条，因此整页高度和垂直起点不同，不主张逐像素一致。

| 状态 / 视口 | 原型 | 实现 |
|---|---|---|
| 未上传 / 1440×960 | [原型](prototype-source-empty-1440.png) | [实现](source-empty-1440.png) |
| 未上传 / 390×960 | [原型](prototype-source-empty-390.png) | [实现](source-empty-390.png) |
| 已有募集书 / 1440×960 | [原型](prototype-source-current-1440.png) | [实现](source-current-1440.png) |
| 选择文件 / 1440×1000 | [原型](prototype-documents-1440.png) | [实现](documents-1440.png) |
| 选择文件 / 390×844 | [原型](prototype-documents-390.png) | [实现](file-generation-preparation-390.png) |

另有 320px 选择、上传及费用确认截图。桌面原型的 12 项目录高约 631px，全部选项高 44px；此前同版原型压缩前因输入框最小高度及旧网格样式仍占约 844px，本次清除了冲突。实际前端测试也检查行高、目录高度、右侧单列宽度及无横向溢出。最终视觉确认人：待用户实际验收；未自行将开发方案标为验收通过。

## 验证结果

- `node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json`：通过。
- `node node_modules/vite/bin/vite.js build apps/web`：通过；保留原有大于 500kB bundle 提示。
- 契约校验：171 个合成样例、12 个库样例、4 个生命周期样例和 44 项单测通过；本次无契约改动。
- Edge：`file-generation-workbench.spec.ts` 33 项 + `prospectus-panel.spec.ts` 7 项，最终整组 **40/40** 通过。覆盖选择、模板上传/复用、缺模板快捷入口、费用确认、版本固定、原请求/上传恢复、隔离，以及 1440/390/320px 布局。
- Edge：`generation-entry-intent.spec.ts` + `prospectus-saved-reentry.spec.ts` 共 37 项，整组首轮 **35 通过、2 失败**；移除旧步骤链接后的导航断言、手机补充要求先展开的测试操作修正后，失败两项定向 **2/2** 通过。合计 77 项最终均通过，不将其表述为单次 77/77 完整运行。
- 最后增强缺模板快捷入口断言、键盘勾选及截图去焦点后，对应两项再 **2/2** 通过。
- 原型三场景 × 桌面/手机，共 6 个视图无脚本错误、无横向溢出；全选、清空和键盘选择烟测通过。测量见 [prototype-layout.json](prototype-layout.json)。

浏览器命令示例（工作区根目录，PowerShell）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_UX_EVIDENCE_DIR=(Join-Path (Get-Location).Path 'apps/web/test-evidence/file-generation-ux-20261027')
node node_modules/@playwright/test/cli.js test -c apps/web/playwright.config.ts tests/file-generation-workbench.spec.ts tests/prospectus-panel.spec.ts --output="$env:TEMP/bondbuddy-generation-ux-final" --workers=2
node node_modules/@playwright/test/cli.js test -c apps/web/playwright.config.ts tests/generation-entry-intent.spec.ts tests/prospectus-saved-reentry.spec.ts --output="$env:TEMP/bondbuddy-generation-entry-final" --workers=2
```

初次工作区编译依赖缺失，按仓库顺序构建 contracts/domain/rule registries/API 后 web 类型检查通过；初次取证夹具为空 source 时未处理版本接口，修正合成夹具后通过。旧断言仍寻找“当前版本：V”、旧“项目文件 →”和三步导航，已随界面更新而修正，隔离和请求语义断言保留。调试时一组 77 项运行被主动停止，不列为成功结果。没有以失败或中断的运行充当通过证据。

## 本地预览与集成交接

本机已启动并检查可访问的预览：

`http://127.0.0.1:5197/@fs/C:/Users/yingx/OneDrive%20-%20Microsoft/Documents/ChatGPT/BondDraftAI/BondBuddy-file-generation-ux-20261027/product-prototype/public/file-generation.html?scene=documents`

预览无登录要求，使用合成文件和本页内存状态；工具条切换未上传、已有募集书、选择文件。选择后模板区及数量更新，原型操作提示明确说明其模拟边界。它不是统一本地集成测试版，未启动真实 API、worker、数据库或存储，也未进行真实上传、计费或模型调用。自动化使用真实前端组件 + synthetic HTTP fixtures。

重启预览：在本工作区运行 `node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5197 --strictPort`，停止时在对应终端按 Ctrl+C。本次没有修改其他 chat 的测试服务或统一交接文件。

集成 chat 应从本 PR 固定提交整合，在独立测试数据库/存储中复验：上传并保存/明确采用、选择多个文种、已有模板复用与缺模板添加、补充要求、费用核对、生成记录和下载；真实模型生成效果与账务另行验证。无需迁移或安装新依赖。

状态：开发和自测完成；尚未纳入统一本地集成版；用户未验收；**代码完成，尚未部署，待统一发布**。
