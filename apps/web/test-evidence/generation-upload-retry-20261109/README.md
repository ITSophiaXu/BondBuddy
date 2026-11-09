# 文件生成上传重试按钮 — 2026-11-09

对应 [UX 汇总 #923](https://github.com/ITSophiaXu/BondBuddy/issues/923) 的 UX-4。用户要求重试按钮与其他按钮一致，并与文件名保持同行。用户原始截图和文件名未提交，所有验证数据均为合成。

- 开发基线：`d24dcdf5e8dee4d5a4e92c4aa2dd4489c23ab16a`。
- 代码及原型 commit：`6d033299fd1571437595a5e8090d4164134571aa`。
- 实现：`apps/web/src/prospectus-panel.ts`、`generation-flow.css`、共享 `product-prototype/public/file-generation-ux.css`。
- 局部原型：`product-prototype/public/generation-upload-retry.html`，`?restored=1` 展示刷新恢复后的同类操作；补充既有 `file-generation-flow-approved.html`，不改其其他流程。

## 改动与验证

“重试上传”和恢复后的“重试此文件”使用共享 `btn secondary`。删除专用 ID 上的绿色背景及 14px 顶部间距。文件名和按钮用左右两列排列，长文件名只在自身区域换行，状态位于文件名下方。空状态不占行，清除选择保留独立操作位置。

未修改基线在 1440px 已复现原问题：按钮圆角为 0、顶部间距为 14px、绿色背景且无描边；同页标准次级按钮为 8px 圆角、0 顶部间距、白底描边。新增用例在基线失败，修复后通过。

**2026-11-09（北京时间）验证结果：**

- 新增 **6/6** 浏览器检查：1440、390、320px × 当前失败/刷新恢复。比较实际计算样式与共享次级按钮，核验文件名和按钮同行、垂直对齐、无横向溢出及键盘重试。
- 每个重试场景仅创建 1 个上传会话、传输 1 次字节、采用 1 次文件，仍停留在材料选择步骤，没有自动生成任务。
- 相关回归 **47/47**：`file-generation-flow.spec.ts`、`prospectus-panel.spec.ts`，包含上传失败重试、恢复、来源选择、非法文件清除、已保存文件以及其他用途共享组件。
- API 编译（为 Web 检查准备本地类型依赖）、Web TypeScript 和 Vite 构建通过；Vite 的既有大 chunk 提示保留。
- 局部原型的 6 个尺寸/状态组合均已运行、截图并确认同行且无溢出；桌面和窄屏图片已目视检查。

## 截图对照

| 场景（高度均为 960px） | 原型 | 实现 |
| --- | --- | --- |
| 当前失败，1440px | [原型](prototype-retry-1440.png) | [修复后](retry-1440.png)、[修改前](before-retry-1440.png) |
| 当前失败，390px | [原型](prototype-retry-390.png) | [实现](retry-390.png) |
| 当前失败，320px | [原型](prototype-retry-320.png) | [实现](retry-320.png) |
| 刷新恢复，1440px | [原型](prototype-restored-1440.png) | [实现](restored-1440.png) |
| 刷新恢复，390px | [原型](prototype-restored-390.png) | [实现](restored-390.png) |
| 刷新恢复，320px | [原型](prototype-restored-320.png) | [实现](restored-320.png) |

原型为独立的材料组件示例，实际截图包含原导航和步骤；对照范围是按钮的共同样式和文件行布局。用户本次截图为修改依据，自动化验证不代表用户已验收。

## 复跑与交付

在 `apps/web` 启动 Vite；本次使用 `BB_E2E_BASE_URL=http://127.0.0.1:5390`、`BB_E2E_BROWSER_CHANNEL=msedge`：

```text
playwright test tests/generation-upload-retry.spec.ts
playwright test tests/file-generation-flow.spec.ts tests/prospectus-panel.spec.ts
tsc --noEmit
vite build
```

本机复用现有依赖，以 `node ../../node_modules/@playwright/test/cli.js` 等入口执行。真实 Edge + 合成 HTTP，仅验证 UI 和客户端流程，不是数据库/存储/真实模型链路验收。无生产或支付调用，无新增依赖、接口、数据库迁移、API 或 worker 改动。

**开发与自测完成；用户尚未验收；代码完成，尚未部署，待统一发布。**
