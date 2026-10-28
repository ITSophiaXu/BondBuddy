# 募集书材料上传入口合并 · 2026-10-28

用户明确要求：去掉上方重复按钮，把准备材料的提示合并到下方材料区，保留一个清晰的上传入口。关联前端范围：#361；不关闭该 Issue 的其他事项。

开发和自测完成。尚未纳入统一本地集成版，用户尚未验收；代码完成，尚未部署，待统一发布。

## 版本与界面

- 基于 develop `859e7adac43b1e44fe2543e4ed18b24d0097dfed` 的独立分支 `fix/financial-upload-entry-20261028`。
- 实现、原型与测试源码：`d6c2d7a2`。实现为 `apps/web/src/main.ts`、`project-execution.ts`、`authoring-onboarding.css`。
- 静态原型：`product-prototype/public/authoring-materials-entry.html`，使用合成项目和共享样式保存本次用户确认的页面结构；文件选择仅演示，不上传、不开始任务。
- 改前合成界面对照：`95184462d3a6a4cfc4ac4f535f4e4081c33ea087` 中相同更新工作区。此版本与本次 develop 基线均展示截图所示的独立准备卡片和重复快捷按钮。
- 影响已迁移的更新募集书材料页及继续修改的准备区；无 API、worker、契约、数据库迁移、计费或新增依赖变化。

经用户确认的布局变化：删除独立准备卡片及其“添加财务材料”按钮，将说明、补充要求定位和下一轮底稿选择放入“提供项目材料”。财务文件继续从现有分区上传；财务期间说明仍保留。首次准备不重复显示小标题，继续修改保留“准备下一轮募集书”。续改刷新后重新展开材料区，使版本选择仍可访问；执行中的材料继续锁定。

## 同尺寸对照

桌面统一 1440 × 960，手机统一 390 × 844；全页截图高度随内容变化。原型与实现的材料区结构、提示位置和上传入口一致。静态原型不执行 API，悬浮助手及非本次操作不作为原型交互验收范围。

| 场景 | 改前界面 | 本次静态原型 | 实现 |
| --- | --- | --- | --- |
| 桌面 | [改前](reference-1440.png) | [原型](prototype-1440.png) | [实现](implementation-1440.png) |
| 手机 | [改前](reference-390.png) | [原型](prototype-390.png) | [实现](implementation-390.png) |

上传区域近景：[桌面](implementation-upload-1440.png)、[手机](implementation-upload-390.png)。续改恢复：[桌面](continuation-1440.png)、[手机](continuation-390.png)。已检查相关页面，没有横向溢出；补充要求定位可用。截图及原型均为 synthetic，不包含用户项目文件。

## 验证

- Edge：`authoring-onboarding.spec.ts`、`authoring-next-layout.spec.ts`、`authoring-continuation.spec.ts` 共 43 个用例最终通过。整组最后一轮 42 通过、1 个旧下载定位器失败；将定位限定到历史成果区后，该用例定向复跑 1/1 通过，原有文件名、字节、任务及版本断言全部保留。详情见 [浏览器结果](browser-results.json)。
- 调整中发现续改刷新的原折叠逻辑会遮住移入材料区的选择器，已在恢复准备状态及首次展示任务时修复；桌面/手机刷新、目标期间编辑、依据读取异常 4/4 定向通过。
- 唯一财务分区上传 → 保存原字节和哈希 → 不自动开始 → 明确开始后固定输入并锁定材料 → 刷新保持单一任务，现有浏览器链路通过。
- contracts / domain / rule-pack-registry / rule-applicability-context / API 构建后，web 完整 TypeScript 检查和 Vite 构建通过。Vite 保留现有的大分包体积提示。
- 契约：171 个公共样例、12 个内部样例、4 个生命周期样例及 49 个契约测试通过。
- 静态原型桌面/手机无溢出、无脚本错误，补充要求焦点通过，见 [原型检查](prototype-check.json)。

浏览器使用合成项目、合成文件和模拟公开 HTTP 边界；不代表真实解析、数据库/存储、模型生成、扣费或用户验收。没有生产操作。

复跑：先在仓库根目录依次编译 `packages/contracts`、`packages/domain`、`packages/rule-pack-registry`、`packages/rule-applicability-context`、`apps/api` 的 tsconfig；在 `apps/web` 使用 `node ../../node_modules/typescript/bin/tsc --noEmit` 和 `node ../../node_modules/vite/bin/vite.js build`。测试通过独立 Vite `--host 127.0.0.1 --port 5256` 运行，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5256`、`BB_E2E_BROWSER_CHANNEL=msedge`，再执行上述三个 Playwright 文件。临时页面服务在开发结束后停止，不把该地址作为已交付的本地集成版。

## 集成验收步骤

1. 更新募集书 → 材料与要求：上方无独立准备框和“添加财务材料”按钮，材料卡片中保留完整准备提示。
2. 在审计报告 / 财务报表及附注分区上传一次文件，核对已保存状态；只在明确点击“开始更新”后启动。
3. 点击“填写补充要求（选填）”，焦点进入原补充说明输入框。
4. 已完成项目点击“继续修改”，核对本轮底稿选择及已保存材料，刷新后仍可编辑下一轮；返回上一轮仍可下载原成果。
5. 任务开始后材料只读；手机宽度下检查提示换行与上传操作。
