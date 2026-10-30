# 更新募集书材料页面简化

用户于 2026-10-30 根据实际页面截图要求：删除下方重复的历史／参考募集书上传区；标明募投项目与权证材料选填；删除本页全部“按细分类别补充材料（选填）”入口。此次用户要求作为页面调整依据。

代码版本：`2b2868f0`。对照基线：`c6cc55c8`（develop）。实现入口为 `apps/web/src/main.ts` 的材料分区；沿用 `product-prototype/public/project-workspace.*` 和 `optional-materials.*` 的现有样式。这次不修改旧原型。

- 页面上方保留唯一的历史／参考稿上传和明确选用入口。
- 下方原稿上传控件删除；存在有效原稿时仅显示“原稿信息与格式”，保留信息补全和格式来源选择，无原稿时隐藏整个分区。
- “募投项目与权证材料（选填）”标题与上传提示明确可选。
- 所有细分类上传折叠区删除。各主分区保留现有入口；旧项目已经保存的细分类文件仍显示，原角色、处理状态、删除和任务引用保持。

同尺寸浏览器对照（合成项目，1440×960 和 390×960 视口，全页截图）：

| 视口 | 修改前 | 修改后 |
| --- | --- | --- |
| 桌面 | [截图](before/materials-1440.png) | [截图](after/materials-1440.png) |
| 手机 | [截图](before/materials-390.png) | [截图](after/materials-390.png) |

已逐屏查看上下分区、上传按钮、选填提示及窄屏换行；无横向溢出。与基线的布局差异即上述三项用户要求及保留旧材料记录所需的显示调整。截图中的余额/补充说明读取提示来自精简模拟 API，不代表正式服务故障或可验收的完整本地服务。

## 验证

Node + TypeScript：contracts、domain、rule-pack-registry、rule-applicability-context、API、worker、web 编译通过；web Vite 生产构建通过。保留已有的大 JS 包提示。

Windows Edge，独立 Vite 端口 5387，真实页面 + synthetic HTTP/文件回执。53 个相关用例分组验证通过：

- `upload.spec.ts`：18 项，含多文件、去重、自动保存、恢复和已有细分类材料可见性。
- `authoring-source-guide.spec.ts`：9 项，原稿补全、准确定位、锁定和明确开始。
- `source-format-template.spec.ts`：7 项，格式选择、版本绑定、刷新恢复和锁定。
- `prospectus-panel.spec.ts`：15 项，上方上传、保存/选用分离、版本和删除。
- `project-execution.spec.ts` 定向 4 项：桌面/手机上传到明确开始；旧原稿记录删除、恢复及下一轮引用。

首次把前四个文件放在一个 Playwright worker 连续运行时为 48/49：source-guide fixture 对全局 TypeBox `date-time` 的精确日期注册影响了 panel fixture 的另一日期。panel 整文件单独复验 15/15 通过；不将首次运行表述为全过，不在本 UI 修复中扩大到共享测试注册器改造。

重现：在仓库根目录构建各 workspace 后，进入 `apps/web` 启动 Vite，设置 `BB_E2E_BASE_URL` 指向该进程、`BB_E2E_BROWSER_CHANNEL=msedge`，通过 `node ../../node_modules/@playwright/test/cli.js test <上述文件>` 分组运行。截图可设置 `BB_MATERIAL_UX_EVIDENCE=<目录>`，运行 `upload.spec.ts --grep "optional materials expose"`。

未运行真实 API/数据库或真实模型；两个 opt-in 本地端到端脚本已更新为上方上传和明确选用，未冒称本次执行。无新增依赖、数据库迁移或后端行为变更。本次开发自测不等于用户验收。

**代码完成，尚未部署，待统一发布。** 集成时只需纳入此 PR 并重新构建 web；本次临时页面测试服务完成后停止。
