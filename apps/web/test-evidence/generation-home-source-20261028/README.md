# 文件生成首页募集书确认 · 验证与集成交接

状态：开发和自测完成；尚未纳入统一本地集成版，用户尚未验收。代码完成，尚未部署，待统一发布。

基线：develop `6725d8f74da2c9793698f1eaf8179eb76ab55b5c`。原型与实现同为 `1295194da911e6e0edb9d94a01cd7e798d2a0cd3`；交互调整依据为用户本次两张截图和要求，关联 #361。独立分支 `fix/generation-home-source-20261028`。

## 交付行为

首页展示完整募集书卡片，可上传替换、下载、选择历史版本或确认当前稿。确认后直接进入底稿目录/文件与模板清单，不经过第二页确认。新上传成功后在首页一次采用即可选择生成方式；上传中、失败未恢复、版本未采用或结果未知时不可继续。选择旧版不会被其他已保存新版重复阻断；发现并发换版要求重新确认。

模板方式沿用现有来源固定接口；底稿方式不修改模板草稿。上传、采用和首页确认均不启动任务或扣费。无 API、worker、契约、数据库迁移、价格和新增依赖变化。

## 验证结果

Windows 本地真实前端、ApiClient、Edge 浏览器，所有 HTTP 业务响应及材料均为 synthetic。没有调用真实模型，没有连接生产数据库、Blob 或账务；不能作为后端链路或用户实际验收。

| 浏览器测试集 | 最终通过 |
| --- | ---: |
| file-generation-flow.spec.ts：首页确认、首次/替换上传、历史版、刷新、冲突、重试、两种直达路径、长文件名及原型 | 31 |
| file-generation-workbench.spec.ts：模板、补料、费用确认、原范围恢复、手机布局 | 40 |
| generation-entry-intent.spec.ts：文种快捷入口、草稿、恢复与跨页导航 | 26 |
| prospectus-panel.spec.ts：上传、下载、删除及其他页面采用交互 | 14 |
| prospectus-selection.spec.ts：选择/上传回执、并发与错误恢复 | 12 |
| workpaper-batch.spec.ts：目录、批量任务、历史请求、暂停与结果 | 13 |
| 合计（不重复计算复跑） | 136 |

首轮 135 项为 133 通过、2 失败：底稿首页测试仍使用旧入口；提交恢复测试在请求到达前断言，改为等待请求记录后保留原请求完全一致校验。随后补入历史版测试，flow 31 项全部通过；底稿复验发现同类旧预检查测试缺少异步等待，保留全部业务断言并补齐等待后，底稿完整 13 项全部通过。失败记录不计为通过。

contracts/domain/rule-pack-registry/rule-applicability-context/API/worker 编译、web TypeScript 检查和 Vite 构建通过。契约检查 49 项、171 项合成公开样例、12 项内部样例及 4 项生命周期样例通过。最终测试文件再次通过 web TypeScript 检查。Vite 保留仓库既有的大包提示。

浏览器命令（在 apps/web 目录，先在本分支启动 Vite）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5276'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/file-generation-flow.spec.ts tests/generation-entry-intent.spec.ts tests/file-generation-workbench.spec.ts tests/workpaper-batch.spec.ts tests/prospectus-panel.spec.ts tests/prospectus-selection.spec.ts --reporter=list
```

## 原型与页面检查

- 原型 `product-prototype/public/file-generation.html`、`file-generation-preview.js`；已迁移实现 `apps/web/src/file-workspace.ts`、`prospectus-panel.ts`；共享 `file-generation-ux.css`。
- `implementation-source-*` / `prototype-source-*`、`implementation-choices-*` / `prototype-choices-*`：1440、390px 同尺寸组件对照。原型外围工具栏、实现项目上下文及助手属于既有外壳；业务布局和操作没有额外偏离。
- `entry-{1440,390,320}.png`、`home-long-name-{1440,390,320}.png`：首页及长文件名；各尺寸无横向溢出，上传/确认/生成方式按钮可操作。
- `source-empty-*` / `source-uploaded-*`：保留的募集书管理入口兼容性。

已目视检查桌面、手机和同尺寸原型截图，未发现裁切或文字重叠。全部截图为合成项目和数据。

## 后续集成验收

将本分支合入独立集成测试版后：已有募集书项目 → 文件生成首页 → 确认当前稿 → 分别选择两种方式，核对无重复页面；再测试首次上传、替换上传、历史版本、刷新恢复及失败重试。现有任务和草稿应保留原范围。

本次 5276 仅供开发回归与静态原型比对，测试结束后关闭；没有提供新的统一本地后端测试环境。重新运行可在 apps/web 目录执行 `node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5276 --strictPort`，停止使用 Ctrl+C。原型只模拟界面，不上传文件或生成成果。

最终统一验收仍需指定集成测试 chat 整合；生产发布由统一发布 chat 按用户授权执行。
