# 2026-10-13 更新说明宽度修复

来源 PR #697 新增 `31e971202bf0273cc25c2e83930b090bc29af82c`，集成产品源码 `e21fb81786d75e3aee0bd0ef1bf444e1e59807f5`。取消更新说明内层 78ch 限制，让正文填满卡片可用宽度；字号、行距和分节层级不变。原型同步，Issue #361 登记此次原型 commit；合成同尺寸对照见 `apps/web/test-evidence/authoring-summary-width-20261013/`。

- 源和集成 web TypeScript / Vite 通过；只有已有包体积提示。
- Edge 成果页现有回归 **30/30**，覆盖 1920、1440、390 视口及卡片可用宽度，无横向溢出。
- **真实本地浏览器 1/1**：说明宽度分别为 **1354 / 983 / 297px**，均等于外层卡片内容宽度。查看过真实桌面截图，右侧不再留窄栏造成的大片空白。
- 沿用成功项目，不新建业务任务。清洁版 6,384,486 字节、修订版 6,633,577 字节，均与服务端原元数据 SHA-256 一致；错误 0、业务写请求 0、新模型调用 0。
- 网页仍为 http://localhost:5178，账号 integration_user，密码沿用共享交接。刷新已有完成项目，向下查看“本次更新说明”；无需重跑或重新下载 Word。
- 只更新前端，API、worker、数据库、存储及原项目/成果保留；不需要重启服务。API 仍 0556ca5a，worker 仍 f9ea165 / 镜像 85e2a227…（#698）。
- 前端构建 `index-Dn8-WZwY.css` / `index-ixsg7H5X.js`。无契约、迁移或依赖变化；原 start/status/stop 脚本继续适用。

真实证据仅保存在共享 `work/local-integration-runtime-20261012/evidence/summary-width-20261013/`；截图不提交 GitHub。服务前后快照为 `summary-width-status-before-20261013.json` / `summary-width-status-after-20261013.json`。

开发和自测完成，本地集成版可验收；用户尚未验收；代码完成，尚未部署，待统一发布。
