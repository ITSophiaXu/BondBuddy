# 统一工作区 UX 验证（2026-10-05）

本切片对应当前用户五项要求，关联 #55、#56、#361，不关闭父 Issue。依据：[产品决定](../../product-decisions/2026-10-05-unified-workspace-ux.md)。

- 原型与实现：本 PR 同一提交，原型入口 `product-prototype/public/workspace-ux.html`。原型是按本次明确要求生成的新交互镜像，JSON/CSS 来自共享渲染；仅使用合成发行人和材料。旧 review-v2 代表历史设计。
- 对照尺寸：桌面 1360×900、窄屏 390×844；截图均 fullPage。创建、材料、进度、结果及复核后更新分别对照。没有布局或操作范围偏离；原型右下角“合成数据”演示控制条仅为原型导航，截图对照时隐藏。运行中的轻微圆点动画像素差异不是阶段差异。
- 页面测试覆盖创建/编辑季度表单、分区上传响应丢失后重试、要求自动保存与并发冲突、无助手、两端真实进度、全部项目来源保持、旧结果下载、新结果修订的固定来源与幂等。
- 本地：TypeScript 编译、Vite production build、Web unit 76/76、公共契约样例 166+12+4、OCR/issuer contract tests 40/40。复核浏览器场景 28/28（含两条专用设计导出/对照）。
- 更新浏览器回归与 Linux 原生 PG/Blob/Word 集成结果以本 PR CI/后续记录为准；新集成覆盖跨账号拒绝、固定报告及材料、输入 hash、并发同请求、冲突请求、免费结果修订、真实双 Word 与崩溃恢复。
- 真实模型调用、客户原项目再次执行、行业结论验收未由合成测试代替。发布版本、备份与原页面核对将在 GitHub Issue 追加证据，不上传客户正文或截图。

| 页面 | 桌面原型 | 桌面实现 | 窄屏原型 | 窄屏实现 |
|---|---|---|---|---|
| create | [图](prototype-create-1360.png) | [图](implementation-create-1360.png) | [图](prototype-create-390.png) | [图](implementation-create-390.png) |
| materials | [图](prototype-materials-1360.png) | [图](implementation-materials-1360.png) | [图](prototype-materials-390.png) | [图](implementation-materials-390.png) |
| progress | [图](prototype-progress-1360.png) | [图](implementation-progress-1360.png) | [图](prototype-progress-390.png) | [图](implementation-progress-390.png) |
| results | [图](prototype-results-1360.png) | [图](implementation-results-1360.png) | [图](prototype-results-390.png) | [图](implementation-results-390.png) |
| updating | [图](prototype-updating-1360.png) | [图](implementation-updating-1360.png) | [图](prototype-updating-390.png) | [图](implementation-updating-390.png) |
