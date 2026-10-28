# 文件生成交互验证与交接 · 2026-10-28

本批从 develop `e05df68f` 独立开发。用户要求消除批量底稿入口的默认选中错觉和重复确认上传，并优化完整生成流程。

## 验证

使用本地真实前端、ApiClient、Edge 浏览器及合成 HTTP 响应，逐项验证实际页面控制器与请求内容。没有调用真实模型，没有连接生产数据库、对象存储或扣费。模拟上传结果不代表后端/真实模型链路已经验收。

| 测试集 | 通过 |
| --- | ---: |
| file-generation-workbench.spec.ts：模板选择、补充依据、费用确认、按原范围恢复、手机布局 | 40 |
| prospectus-panel.spec.ts：自动上传、拖放校验、上传恢复及其他页面原有采用交互 | 7 |
| file-generation-flow.spec.ts：等权入口、首次/换版两条完整路径、刷新、冲突、上传锁定、批量返回、原型对照 | 15 |
| generation-entry-intent.spec.ts：快捷文种、草稿、恢复与跨页导航 | 26 |
| workpaper-batch.spec.ts：目录、350项选择、检查、费用确认和任务进度 | 15 |
| 合计（不重复计算复跑） | 103 |

最终相关测试均通过。开发过程中同步更新旧入口/按钮断言；收窄新测试的 HTTP mock 路由，避免误拦截同名契约模块。先前失败不当作通过，均修正后复验。最后对导航锁定改动定向复跑完整 flow 15 项。

TypeScript 检查、Vite 构建、171 项合成契约样例 + 12 项内部样例、4 项生命周期样例通过。构建仍报告既有大包体积提示，本次未调整打包架构。

## 页面证据

- `entry-{1440,390,320}.png`：两个同等入口，未进入方式前无上传面板或模板下一步。
- `implementation-choices-{1440,390}.png` / `prototype-choices-{1440,390}.png`：同视口、同内容宽度的原型/实现对照。
- `source-empty-*` / `source-current-*` / `source-uploaded-*`：初次准备、当前稿和上传后单一继续操作。
- `documents-*`、`file-generation-preparation-*`、`file-generation-confirmation-*`：文件与模板以及最终费用确认。

1440、390、320px 均无页面横向溢出。已目视检查入口、上传成功、窄屏及原型对照截图；原型外围展示的是预览工具条，业务组件使用与实现相同的样式。原型只模拟状态，保留醒目标识。原型和实现随本 PR 同步交付，未作为已验收界面发布。

## 复验方式

从仓库根目录启动独立前端：`node node_modules/vite/bin/vite.js --config apps/web/vite.config.ts apps/web --host 127.0.0.1 --port 5198`，或在 `apps/web` 内运行 `node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198`。关闭对应终端进程或 Ctrl+C 即停止，不影响其他本地服务。

独立预览使用当前前端的 `/@fs/<仓库绝对路径>/product-prototype/public/file-generation.html`。不需要登录，工具条可切换“选择生成方式 / 未上传 / 已有募集书 / 选择文件”。预览没有上传真实文件或生成成果。

自动化命令（在 `apps/web`）：设置 `BB_E2E_BASE_URL=http://127.0.0.1:5198`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node ../../node_modules/@playwright/test/cli.js test tests/file-generation-flow.spec.ts tests/file-generation-workbench.spec.ts tests/prospectus-panel.spec.ts tests/generation-entry-intent.spec.ts tests/workpaper-batch.spec.ts --config playwright.config.ts`。

## 集成交接

无数据库迁移、API、worker、契约或新增依赖。仅需集成前端和同步原型。统一本地集成版尚未更新；用户尚未验收。正式验收应覆盖一个真实文件的上传持久化、再次进入/刷新、采用版本，以及两种方式对应的任务入口和已有任务下载。

开发和自测完成。代码完成，尚未部署，待统一发布。
