# M1 统一编制入口：原型对照

原型来自 develop `afa73f2` 的 `product-prototype/public/app.js`、`project-workspace.js`；实现来自 PR #499 的 `48f6f485b42e242bb16b12b02417c33f6c272d71`，涉及 `apps/web/src/main.ts`、`update-form.ts`、`source-prospectus.ts`、`project-conversation.ts` 和 `project-execution.ts`。截图全部使用 synthetic 数据，不含客户材料、账号凭据或模型输出。

桌面视口 1440×960，移动视口 390×844；下列均为视口截图，非缩放整页图。

| 页面 | 原型 | 实现 |
| --- | --- | --- |
| 创建项目·桌面 | [原型](prototype-create.png) | [实现](implementation-create-viewport.png) |
| 创建项目·移动 | [原型](prototype-create-mobile.png) | [实现](implementation-create-mobile-viewport.png) |
| 材料与要求·桌面 | [原型](prototype-materials.png) | [实现](implementation-materials-viewport.png) |
| 材料与要求·移动 | [原型](prototype-materials-mobile.png) | [实现](implementation-materials-mobile-viewport.png) |

## 已获确认的调整

确认人：产品负责人 ITSophiaXu，当前会话 2026-10-01；依据为[统一编制决定](../../../../docs/product-decisions/2026-10-01-unified-prospectus-authoring.md)。

- 保持侧栏、项目创建→材料与要求两步、右侧补充区和同页任务/成果布局。
- 去掉有／无历史稿选择；改为明确填写目标年度及一期。取消自动滚动推定的期间。
- 历史／参考募集书统一为选填；原稿下分别填写企业关系、原企业、市场、品种和报告期。原稿信息不覆盖目标。
- 原对话改为用户补充要求的保存和编辑；没有助手聊天。保存与开始编制是两个动作。
- 任务按真实状态显示；暂停缺项说明具体下一步，允许停止旧任务后使用新输入。
- 成果仅展示修订版和清洁版两个用户下载入口；说明原稿企业／上一版成果／无旧文对照，保留实际摘要与待确认事项。
- M2 积分入口保持未开放；不存在扣费动作。

浏览器验收覆盖保存、编辑、重开、冲突、账号切换、上传重试、显式执行、双份下载和损坏文件拒绝。它不替代真实模型调用、目标部署验证或 Word/WPS 客户端验收。
