# 复核表单宽度与共享步骤（2026-10-06）

用户在当前会话确认：复核表单与更新募集书同宽；复用顶部“创建项目 → 材料与要求”的框架，保持复核独立字段、分区材料和三维结果。对应 #361 / #448 B07。

实现与原型源码 commit：`f2f930dd6950e277cb5c50796edfa43f2ffd28ba`，基于 develop `4de8d8d`。原型为 `product-prototype/public/workspace-ux.html`；`workspace-ux-scenes.json` 和 `workspace-ux-preview.css` 是本次决定对应的渲染镜像，不能作为独立后端证据。

- 去掉创建/编辑卡片 820px 上限。与更新卡片的左右边界及宽度在 1920、1360、820、390px 四种视口一致；大屏卡片均为 1396px。
- 直接复用 `workspaceSteps` 和页面标题框架；创建/编辑为第 1 步，材料准备为第 2 步。结果及运行期间隐藏准备步骤，保留独立复核 tabs、三维报告和真实任务进度。
- 手机顶部原有“复核免费”标记单独成行，因此卡片纵坐标较更新入口低 24px；卡片宽度、侧栏、主区、字体及步骤尺寸一致。这是既有业务标记差异，本轮不改收费提示。
- 上传和末尾选填要求、数据/API/worker、计费与文档生成不变。无新增业务字段、数据库或配置变更。

验证环境：Windows / Edge / Vite，所有截图及 API fixtures 均 synthetic，无客户材料、真实调用或付费。

验证：`review-workspace.spec.ts` 定向创建/编辑/刷新/结果步骤、四视口真实几何比较、原型场景导出和同尺寸对照共 4 项通过；其中首次把手机卡片纵坐标也要求绝对一致的断言失败，核对出上述既有顶部标记后限定为桌面/平板纵坐标一致，手机保留实际宽度和布局断言，定向复验通过。TypeScript/Vite build 通过，保留既有大于 500kB 提示。契约示例 166+12+4 通过，未改变的契约 OCR/发行人绑定 40/40（复用上轮相同源码构建）；最终 PR CI 另行记录。新工作区初次构建缺 API dist，先构建 API 后通过，不修改类型门禁。

对照图（两边均为上述源码 commit；同尺寸）：

| 场景 | 实现 | 原型 |
|---|---|---|
| 创建，1360×900 | [实现](implementation-create-1360.png) | [原型](prototype-create-1360.png) |
| 创建，390×844 | [实现](implementation-create-390.png) | [原型](prototype-create-390.png) |
| 材料，1360×900 | [实现](implementation-materials-1360.png) | [原型](prototype-materials-1360.png) |
| 材料，390×844 | [实现](implementation-materials-390.png) | [原型](prototype-materials-390.png) |

[1920px 更新入口](update-entry-1920.png) / [1920px 复核入口](review-entry-1920.png)，独立测量见 `scale-1920.json`、`scale-1360.json`、`scale-820.json`、`scale-390.json`。原型偏离仅为用户本轮明确确认的加宽与共享步骤，未发现额外业务流程偏离。客户原账号线上页面复测、实际部署及用户体验验收分别在 #361 / #448 记录，不由本地测试推定完成。
