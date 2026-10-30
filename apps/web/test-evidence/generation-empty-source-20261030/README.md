# 文件生成：空项目隐藏已有募集说明书入口

状态：开发和自测完成。尚未纳入统一本地集成版，用户尚未验收。代码完成，尚未部署，待统一发布。

基线：develop `6819bb74`。实现、同步原型及回归用例：`c2d85299`。分支：`fix/generation-empty-source-20261030`。关联页面跟踪：#361。

## 原因与修复

用户 2026-10-30 截图反馈：新项目没有募集说明书，文件生成第一步仍显示“选择项目已有募集说明书”。此前 `2f4b6ba9` 只修复了复核页 `review-workspace` 的空项目入口；文件生成使用的 `ProspectusPanel.renderGeneration` 仍无条件渲染两种方式。既有空项目测试只断言默认选中上传，没有断言已有文件入口隐藏。

只有已核对且属于当前项目的版本列表非空时，才显示两种方式。没有可选版本时直接显示上传区，隐藏两种方式及空版本选择器，提示改为直接上传。刷新后列表变空，即使之前选中过项目版本，也回到上传区。已有但尚未设为当前稿的版本仍可选择；首次上传保存后恢复方式选择，刷新可重新选用。

实现：`apps/web/src/prospectus-panel.ts`。原型：`product-prototype/public/file-generation-flow-approved.html?empty=1`。本次交互变更依据为用户本轮截图和明确要求。原型与实现同为 `c2d85299`；仅同步本次空状态显示条件，没有额外业务规则调整。无 API、worker、契约、数据库迁移或新增依赖。

## 验证

真实前端、ApiClient、Edge 浏览器，业务 HTTP、账号、文件及任务均为 synthetic。没有连接生产数据库、存储、账务或调用真实模型；这不是统一本地后端集成版或用户实际验收。

| 浏览器测试集 | 已输出通过的用例 |
| --- | ---: |
| file-generation-flow.spec.ts：空项目上传、首次保存、重载、已有版本、冲突、上传重试、原型 | 17 |
| prospectus-panel.spec.ts：空项目桌面/手机、刷新变空、已保存但未选用、其他项目响应、上传恢复及共享面板 | 20 |
| prospectus-selection.spec.ts：版本保存、采用、并发与回执恢复 | 12 |
| 合计 | 49 |

补齐 generation-flow.css 的组件测试加载后，generation 相关 8 项独立复验全部通过，运行器正常退出（exit 0，`.last-run.json` 为 passed）；不重复计入上表。首轮冷启动单项在 Vite 依赖预编译期间加载超时；不把该超时当成功能断言失败或通过证据。首轮完整回归输出了 49 项用例通过，但运行器退出阶段停住；停止该运行器后重跑，同一组在输出 24 项通过后再次停住，已停止本次测试进程。表中 49 项是用例输出，不表示整组运行器正常退出；独立 8 项和构建是本次正常结束的验证结果。整组运行器停顿原因未查明，后续集成环境应重新运行完整回归。

contracts/domain/rule-pack-registry/rule-applicability-context/API TypeScript 编译、完整 web TypeScript 检查和 Vite 生产构建通过。契约样例 171 项、内部库样例 12 项及生命周期样例 4 项通过。首次 web 类型检查因本工作区尚无 API 等构建产物失败，补齐依赖构建后通过；未修改产品代码来回避该检查。Vite 保留仓库既有的大包提示。

## 页面检查

- `implementation-empty-{1440,390,320}.png`：真实组件及实际 generation 样式，空项目直接上传，三种宽度均无横向溢出。
- `flow/prototype-empty-{1440,390,320}.png`：同视口原型，已有文件入口和空选择器隐藏。
- `flow/source-empty.png`：完整应用文件生成页面，上传前下一步不可用。

同尺寸对照检查限于本次募集书卡片空状态。原型包含预览外壳及卡内下一步，真实组件截图只包含募集书卡片；实际应用下一步仍在既有页面页脚。本次未调整这些既有布局。已查看桌面完整页面和手机截图，未发现裁切、重叠或空选项占位。

## 复验与集成

在本分支 apps/web 下启动：`node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5293 --strictPort`。测试设 `BB_E2E_BASE_URL=http://127.0.0.1:5293`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node ../../node_modules/@playwright/test/cli.js test tests/prospectus-panel.spec.ts tests/file-generation-flow.spec.ts tests/prospectus-selection.spec.ts`。5293 是开发回归端口，不是用户统一本地集成入口；停止本次 Vite 进程即可关闭。

集成后操作：新建无募集书项目 → 文件生成 → 只显示上传区；上传保存一份后两种方式出现且下一步可用；刷新仍保留已保存文件；已有版本项目可正常切换和选用。由指定集成测试 chat 汇总本批版本后交用户验收，再由统一发布 chat 按批次授权上线。
