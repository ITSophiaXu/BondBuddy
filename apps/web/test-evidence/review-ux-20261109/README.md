# 复核页头与上传宽度 — 2026-11-09

关联汇总 Issue：[#923](https://github.com/ITSophiaXu/BondBuddy/issues/923)，本 PR 处理 UX-2、UX-3；UX-1 的首屏上传区显示由 #924 处理。

用户反馈和测试日期均为 **2026-11-09（北京时间）**。用户本次截图明确要求精简重复信息及恢复组件宽度。这里仅使用合成项目和文件名，未上传原始客户截图或材料。

## 版本与范围

- 代码及原型 commit：`af08e3077caa01b0372fd70290e629d8b991e63a`。
- 最终开发基线：`d24dcdf5e8dee4d5a4e92c4aa2dd4489c23ab16a`。已无冲突 rebase，并在最终源码上复跑 9 项定向浏览器检查和 Web 构建。
- 原问题复现及扩展回归基线：`6bee8b186c9a694db84e992344768edb734c428d`。
- 实现：`review-workspace.ts`、`review-workspace.css`。页头保留标题、任务状态、一处项目名和更换项目入口，移除重复摘要与范围说明；详细项目信息及复核范围仍在材料页。
- 上传移除旧 `520px` 上限和旧进度条样式；隐藏操作列时释放其空间，使用共享进度样式。传输进度含百分比，保存状态占满可用宽度，错误及恢复操作仍保留。
- 原型：`product-prototype/public/document-workspace.html?view=results`（页头；原基准 `1f572963`）及 `review-materials.html?state=uploading|saving`（材料；原基准 `2f4b6ba9`）。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 新布局检查 | 8/8：2560、1440、390、320px；单处项目标识、长文件名、传输中、保存中、保存后采用及无横向溢出 |
| 最终定向复验 | 9/9：上述 8 项 + 运行页状态、刷新、暂停及计费展示既有场景；没有新增执行 |
| 相关浏览器回归 | 104 通过、9 个既有可选截图用例跳过、2 个基线已有失败，详见下方 |
| Web TypeScript / Vite | 通过；保留既有大 chunk 提示 |
| 公共契约 | 179 个公开合成示例 + 12 个内部示例、4 个生命周期示例、72 项单元检查通过；本 PR 未改契约 |
| 原型 | 1440/390px 的页头、上传中、保存中均已截图并目视检查；上传框与进度容器等宽，无横向溢出 |

在未修改 `6bee8b18` 上，新增的两项 1440px 用例分别复现重复发行人摘要和进度区域短 **661px**。修复后这两项及其宽屏/窄屏变体通过。初次类型检查缺少本地 API `dist`，编译 API 后通过；这不是产品代码错误。

扩展回归中的两项失败均在原基线单独复现，没有修改相关测试或放宽断言：

1. `review-upload-twelfth.spec.ts` 的相同文件重选用例：旧 `[role=alert]` 定位匹配两个元素，同时其预期错误文案已不匹配当前展示。原始失败发生在断言阶段。
2. `review-workspace.spec.ts` 的导航尺寸用例：旧流程等待“复核募集书”链接超时，尚未进入尺寸断言。

完整基线复现输出见 [baseline-existing-failures.txt](baseline-existing-failures.txt)。这两项不能记为通过；本 PR 没有调整上传恢复或导航业务行为。

## 同尺寸截图

| 区域 | 原型 | 实现 |
| --- | --- | --- |
| 页头 1440×960 | [原型](prototype-header-1440.png) | [实现](header-1440.png)、[修改前](before-header-1440.png) |
| 页头 390×960 | [原型](prototype-header-390.png) | [实现](header-390.png) |
| 上传中 1440×960 | [原型](prototype-uploading-1440.png) | [实现](upload-1440.png)、[修改前](before-upload-1440.png) |
| 保存中 1440×960 | [原型](prototype-saving-1440.png) | [实现](saving-1440.png) |
| 上传中 390×960 | [原型](prototype-uploading-390.png) | [实现](upload-390.png) |
| 保存中 390×960 | [原型](prototype-saving-390.png) | [实现](saving-390.png) |

另含 2560/320px 实现截图及完整运行页 `running-1440.png` / `running-390.png`。局部材料原型保留原来的独立页面外框，组件测试保留材料页上下文；对照范围为本次页头精简和上传宽度，不把既有原型外框差异当作新改版。运行页保留原状态、进度及操作。变更依据及确认人为本次提出两项修改的用户；自动化截图不代替用户实际验收。

## 复跑与交付边界

在 `apps/web` 启动本地 Vite（本次使用 5389），设置 `BB_E2E_BASE_URL=http://127.0.0.1:5389`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行：

```text
playwright test tests/review-ux-layout.spec.ts
playwright test tests/review-upload-progress-autosave.spec.ts tests/review-upload-twelfth.spec.ts tests/review-workspace.spec.ts
playwright test tests/review-workspace.spec.ts --grep "review live progress refreshes actual"
tsc --noEmit
vite build
```

本机复用了现有依赖，以 `node ../../node_modules/.../cli.js` 执行。全部浏览器用例为真实 Edge + 合成 HTTP，无生产数据库/存储、真实模型或支付调用；测试端口仅用于开发验证，不是统一本地用户验收版。无新增依赖、接口、数据库迁移、API 或 worker 改动。

**开发与定向自测完成；用户尚未验收；代码完成，尚未部署，待统一发布。**
