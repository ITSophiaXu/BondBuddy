# 更新募集书底部操作区

2026-10-11，依据用户本次截图反馈修正提示文字散落的问题。基线 develop：0359a4b4。

- 实现：apps/web/src/project-execution.ts、project-execution.css、quarter-controls.css。
- 原型：product-prototype/public/authoring-actions.html；共享布局：project-workspace.css。原型与实现随本次提交一起登记至 #361。
- 桌面将扣费提示和“开始编制”组成右侧同一排，垂直居中；左侧保留“上一步”。窄屏自动换行，手机两按钮底部对齐。
- 用户本次要求是布局调整依据；文案、定价、执行行为、公共契约与数据库没有变化。原型/实现同宽截图无交互偏离；原型省略整个项目内容，仅对照操作区。

## 验证

Windows + Chromium，synthetic HTTP fixtures；未调用真实模型、支付或生成 Word。

- contracts 构建通过；171 个公开示例、12 个内部示例、4 个生命周期示例及 40 项契约测试通过。
- web TypeScript 检查及 Vite 生产构建通过。
- 现有 project-execution.spec.ts 三项用例通过：正常一键提交及结算/返还刷新、试用零扣费、积分不足/充值返回。
- 使用现有截图钩子临时扩展 2356 / 1440 / 768 / 390 / 320 px 截图，生成后恢复测试源码；截图复验 1/1 通过。
- 2356/1440 宽屏操作栏高度 78px；768 为 110.39px；390/320 为 122.78px。文字换行、按钮和边界经截图检查。
- 初始本地验证遇到 API dist 未准备及沙箱无法启动 Chromium；准备既有编译依赖并通过工具申请权限后完成上述验证。

| 屏宽 | 原型 | 实现 |
|---|---|---|
| 2356 | ![原型](prototype-footer-2356.png) | ![实现](implementation-footer-2356.png) |
| 1440 | ![原型](prototype-footer-1440.png) | ![实现](implementation-footer-1440.png) |
| 768 | ![原型](prototype-footer-768.png) | ![实现](implementation-footer-768.png) |
| 390 | ![原型](prototype-footer-390.png) | ![实现](implementation-footer-390.png) |
| 320 | ![原型](prototype-footer-320.png) | ![实现](implementation-footer-320.png) |
