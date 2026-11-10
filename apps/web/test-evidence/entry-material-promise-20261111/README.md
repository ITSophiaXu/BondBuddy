# 更新入口材料前提文案统一（2026-11-11）

依据：Chris 于 2026-11-11 在 #361 的轻量 UX review。基线为 `develop` 的 `f95a8f2d`；本目录截图对应本次实现和同步原型，均为合成数据，用户尚未验收，尚未部署。

## 行为与界面

- 更新入口不再承诺“没有原稿也可编制首稿”，改为：可先保存项目；开始编制前需历史／参考募集书及原稿信息；已有核验成果可续改。
- 入口说明补充：本企业历史稿、母子公司稿或相似企业参考稿均可用；参考稿事实不作为目标发行人的既有事实。
- 创建页、空材料页和开始按钮条件保持一致：无稿、稿已保存但信息缺失时按钮禁用并给出具体原因；原稿齐备或已核验成果续改时可开始。草稿仍只要求发行人全称即可保存。
- 未恢复 2026-11-05 删除的重复准备说明或跳转按钮；原稿信息仍紧接上传区并位于财务材料之前。
- 同步 `project-entry-preview.js`、`desktop-workspace-polish.js`、`document-workspace.js` 中仍写“选填／没有参考稿也可以继续”的旧原型文案。

## 验证

- 全仓 `npm run build` 通过（含 web TypeScript 与 Vite）。
- `npm run check:contracts`：fail 0。
- `npm run test:unit -w @bondbuddy/web`：1104/1104 通过。
- `npm run test:domain`：479/479 通过。
- Playwright `entry-material-promise.spec.ts`、`required-reference.spec.ts`：4/4 通过，覆盖入口/创建页文案、无稿、信息缺失、原稿齐备、已核验成果续改五类场景。
- `npm run test:documents` 未通过：宿主缺少 Python `lxml`（30 个 import 错误），与本次前端文案改动无关。
- `prototype-workflow.spec.ts` 中 1 项既有失败（`#send-project-message` 当前仅在保存失败时显示，测试仍按旧交互点击）与本次改动无关；同组其余 37 项通过。

浏览器使用 Playwright Chromium，真实页面与 API client 配合合成 HTTP 响应；不代表真实模型生成或生产账务验证。

## 截图

- `entry-1440.png` / `entry-390.png`：更新入口实现，桌面与窄屏。
- `prototype-entry-1440.png` / `prototype-entry-390.png`：同尺寸原型对照（`project-entry.html?view=update`）。
- `create-1440.png` / `create-390.png`：创建页实现，仅发行人必填。
- `workspace-1440.png` / `workspace-390.png`：材料页实现，原稿必填且原稿信息在财务材料之前。
- `prototype-materials-1440.png` / `prototype-materials-390.png`：材料区原型对照（`prospectus-reference.html`）。

截图均为合成项目，不包含用户实际募集书。
