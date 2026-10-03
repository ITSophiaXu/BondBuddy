# 上传后原稿信息必填：界面对照与验证

核对日期：2026-10-03。原型和实现均为 `4515264`，基于 `develop cf0e946`。仅使用合成账号、文件和 HTTP fixture；没有真实客户材料、支付或模型调用。

原型位置：`product-prototype/public/project-workspace.js` 的材料页原稿信息区。实现位置：`apps/web/src/source-prospectus.ts`、`project-execution.ts`。两边按相同窗口尺寸滚动到原稿字段顶部，由 Chromium 截图。

| 尺寸 | 原型 | 实现 |
|---|---|---|
| 1440×960 | [桌面原型](prototype-source-required-desktop.png) | [桌面实现](implementation-source-required-desktop.png) |
| 390×844 | [手机原型](prototype-source-required-mobile.png) | [手机实现](implementation-source-required-mobile.png) |

两边均保留文件下方的原稿字段，新增“上传后必填”说明、缺项提示及开始前校验。字段顺序一致：原发行人、企业关系、市场、品种、最新报告期；报告期仍为年份＋3／6／9月末／年末。无原稿时不显示此必填区。

现有实现的字段间距比原型大，材料分类展开方式与原型不同；本次未改布局或分类。手机截图需向下滚动才能看到完整提示。以上是实际偏离记录，不声称已经获得人工逐屏验收。必填行为来自用户当前明确决定，见[产品要求](../../../../docs/product-decisions/2026-10-03-source-information-required.md)。

本轮验证：

- contracts、API、worker 和 web TypeScript，以及 web Vite 构建通过。
- 公共契约 166 个合成示例、12 个内部示例与 4 个生命周期示例通过；原稿校验和八档分类共 7 tests passed。
- `project-conversation.spec.ts` 与 `project-execution.spec.ts` 首轮 53 passed、5 failed。5 个失败均为旧测试更换／增加原稿后没有声明；补齐合成声明后定向 7 passed（5 个修复场景＋2 个尺寸的新必填场景）。58 个不同用例均已在上述运行中通过，未宣称单次完整运行 58 passed。
- 覆盖逐项缺失、每份原稿、刷新保留、更换市场重选品种、替换材料使旧声明失效、无原稿可开始、缺项不调用报价／输入锁定／执行接口。未改运行中 worker 和 Word 交付逻辑。
- 合成原型实际上传后验证开始按钮禁用，并生成以上原型截图。

浏览器命令：在 `apps/web`，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5178`，执行 `playwright test tests/project-conversation.spec.ts tests/project-execution.spec.ts`；失败场景修正后按用例名定向复跑。

API PostgreSQL 的新提交拒绝、旧缺项输入拒绝及原免费任务幂等重放测试已加入本 PR 的 Linux CI；结果以 PR 当前提交的检查记录为准。未部署生产；正式支付及上线验收仍归 #40／#46。
