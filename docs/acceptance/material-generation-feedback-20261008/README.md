# 材料生成失败反馈（2026-10-08）

## 问题与修复

材料生成在请求报价失败时，只在页面顶部更新错误。用户点击页面底部的生成按钮后看不到原因；任意错误又会显示“重试保存草稿”，把计费配置或执行错误误报为保存失败。

本次在生成按钮旁同步显示现有状态与错误（`role=alert`），并单独记录保存失败状态。异步保存失败立即显示重试入口，保存成功后移除；报价失败不会出现保存重试。原输入、报价确认、幂等执行与计费逻辑保持原有行为。

## 依据与对照

- 关联 #57、#66、#361；原型基线 `09fe96a`，`product-prototype/public/material-studio.js`。
- 原型已有提交区内的 `d.error` / `upload-error`，本次补齐迁移页面的同处反馈，不新增页面或收费决定。原型源代码没有修改。
- 同尺寸原型/实现截图重新运行：1440×960、390×844，见 `apps/web/test-evidence/m4-prototype-20261007/`；正常页面结构保持一致。
- 额外异常截图：[桌面](implementation-error-desktop.png)、[手机](implementation-error-mobile.png)。两图均为 synthetic HTTP fixture，不是真实客户材料或真实生成结果。

## 验证

- Windows / Node 22.14.0 / Edge，独立 Vite 端口 5198。
- `npm test -w @bondbuddy/web -- tests/m4-workspace.spec.ts`：17 passed，0 skipped（`M4_UX_EVIDENCE=1`）。
- `npm run build`、`npm run check:contracts` 通过；167 个公共示例、12 个内部示例、4 个生命周期示例及 40 项契约测试通过。
- 两个新增场景验证：页面顶部已在视口外时，报价返回 `BILLING_NOT_READY` 的错误仍在生成按钮旁可见；不出现错误的保存重试；不创建任务、不扣费、不修改保存输入。
- 保存失败场景验证：错误与重试入口立即出现；成功同步后移除重试入口。

## 验证边界

本次仅修复反馈，不发布费率、预算或新计费规则。`BILLING_NOT_READY` 由合成 HTTP fixture 返回；不把页面测试称为真实模型或 Word 交付验收。此目录只包含合成截图和代码测试证据。
