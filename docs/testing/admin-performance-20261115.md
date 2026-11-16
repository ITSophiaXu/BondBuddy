# #1415 运营后台步骤性能验收记录

本批在既有 `/admin/` 运营概览增加独立的“步骤性能”查询，在单 run 任务追踪增加同名标签。保留既有导航、快照筛选、状态统计、批次和任务详情。开发基线为 `e277c27a`，工作分支 `feat/fine-step-timing`；UI 与原型同批修改，最终提交由集成负责人登记。

**开发和自测完成；本地隔离版已启动并验证。用户尚未验收，尚未部署。**

## 实现与计量口径

- 性能查询直接调用受 `log_reader` 保护的 `/api/v1/admin/performance/summary`，按任务类型、阶段、步骤及版本、模型、发布版本、任务和步骤结果分组。分位数来自服务端完整筛选集；前端不从最多 1000 条的 inspection 快照回算。展示 P50/P90/P95、有效分位样本数、未闭合和缺测数。筛选键从 contracts 的 `PERFORMANCE_FILTERS` 导入。
- 打开单 run 的“步骤性能”才读取 `/api/v1/admin/performance/runs/:run_id?limit=200`。“加载更多”沿用不透明游标及固定成员快照，保留每页读取时点和审计 ID。未全部载入时不把局部子步骤当作完整记录。
- 父行以父区间裁剪后的直接子区间并集计算未解释时间，不累加并行时长。顶部解释覆盖排除 `run.execution`、`stage.execute`、`model.call`、`model.attempt` 等纯容器；有真实起止的 `model.exec` 是 CLI 整段执行边界，包含模型和工具，不是供应方纯推理耗时。只有完整采集、完整分页及完整计时时才给出确定的未解释值。
- 运行中已历时截至该步骤所在页的查询时间；缺终态不使用 `updated_at` 伪造结束。失败缺测、采集丢弃/错误、保留期清理记录分别显示，未测值不计为 0。会话展示清理时间、数量、原因和策略版本。
- 展开步骤查看调用、模型、缓存、输入工作量、producer/author/shared span、执行/作业/会话关联及版本。只显示正式契约允许的元数据，没有材料正文、提示词、命令或工具输出。
- CSV/JSON 导出保存读取审计 ID、查询时间、覆盖范围及完整度。汇总包含服务器返回的全部分组；单 run 明确只导出已载入页。CSV 对可能被电子表格执行的公式字符串转义。

## 验证结果

| 验证 | 结果与范围 |
|---|---|
| web 整体类型检查 | `tsc -p apps/web/tsconfig.json --noEmit` 通过；最后共享筛选常量接入也完成定向编译 |
| web 生产构建 | 最终类型检查与 Vite build 通过；admin JS 80.78 kB、gzip 27.22 kB。Vite 对大于 500 kB 的主应用包给出非阻断提示 |
| 新旧后台相关单测 | 59/59：性能并集、纯容器不冒充解释覆盖、缺测、分页、CSV、异步退出，以及既有状态/计时/异常和业务关联 |
| 后台浏览器回归 | 23/23：既有后台 18 项 + 新性能 5 项，使用明确标注的合成 API 响应；包含查询、200 条分页接口、导出、读取失败重试、退出竞态、手机布局 |
| 筛选示例和共享契约调整后 | 17/17 性能定向单测通过；真实可输入示例为 `update / review / qa`、`model.exec`、`production / non_production_test` |
| 真实 HTTP / 登录 / API / PostgreSQL | 通过；使用隔离数据库 `bb_perf_ui`，没有路由拦截或自定义 principal |
| 完整筛选范围 | 真实 inspection 显示 1000/1002 条，独立性能汇总仍覆盖完整 1002 条；其中 1001 条明确没有埋点 |
| 单 run 分页 | 本地工作真实采集 214 条 span，首次 200 条、随后 14 条，完整载入后保留嵌套关系及覆盖状态 |
| 读取审计与权限 | 汇总、第一页、第二页的 3 个 audit ID 均在 `bb_log_access_audit` 找到；实际登录的普通测试账号读取性能端点返回 404 |
| 截图与滚动 | 桌面对照均 1440×1000；手机均 390×844。214 行全部在 DOM 内，滚至末行可见，无页面横向溢出 |

单测和浏览器计数是不同组合的测试运行记录，不将重复复验累加成新的独立用例数。完整本地回执见 [ui-verification.json](evidence/issue-1415/ui-verification.json)。原始导出保留在工作区 `work/fine-step-timing-ui/live-run-export.json`。

实际数据库内的账号、项目、任务均为合成 fixture。`model.exec` / `model.tool` 标签来自测试脚本中的本地延迟与循环，没有调用模型供应商，不代表生产慢任务测量、真实生成效果、Word 交付或计费验收。合成 run 使用失败终态，遵守真实数据库的 Word 成功交付约束，未伪造成功成果或关闭门禁。

## 原型对照与截图

此前原型目录没有运营后台页面，既有依据见 `docs/testing/admin-task-status-20261113.md`。本批按用户指定范围补充 [后台原型](../../product-prototype/public/admin/index.html)，沿用基线 `/admin/` 页面；不新增用户业务页。`product-prototype/admin-performance-build.mjs` 从本批相同渲染函数与 CSS 生成原型，原型页明确标注合成数据。

| 画面 | 实现（真实本地 API，合成数据） | 对应原型 |
|---|---|---|
| 运营概览性能区域 | [1440×1000](evidence/issue-1415/live-summary-desktop.png) | [1440×1000](evidence/issue-1415/prototype-summary-desktop.png) |
| 完整分页瀑布 | [1440×1000](evidence/issue-1415/live-waterfall-complete.png) | [1440×1000](evidence/issue-1415/prototype-waterfall-desktop.png) |
| 手机任务详情 | [390×844](evidence/issue-1415/live-mobile.png) | [390×844](evidence/issue-1415/prototype-mobile.png) |

另保存 [部分分页](evidence/issue-1415/live-waterfall-partial.png) 和 [滚到末行](evidence/issue-1415/live-waterfall-last-rows.png) 的固定视口证据。已逐图核对页面结构、标签、指标、瀑布列与滚动范围；实现与原型的差异是合成样例内容、任务状态、行数、读取时间和审计值，未发现本批性能区域的结构或交互偏离。原型三行用于说明并行区间，真实本地 fixture 的 214 行验证分页和滚动，两者不作数值对等或性能对比。

最初对整个瀑布子元素调用 `locator.screenshot()` 产生了约 1.6 万像素高的截图，父级固定抽屉在视口外裁剪内容，造成长图下部空白。那不是页面新增空白区域，也不是虚拟列表：214 行均实际渲染，滚至末行已验证。最终证据均改用固定 viewport screenshot，未提交最初的巨长图。

## 本地访问、重启与停止

已验证入口：`http://127.0.0.1:5175/admin/`，实际 API `http://127.0.0.1:4315`。仅连接 `127.0.0.1:55415/bb_perf_ui`；数据库由本批完整迁移的 `bb_perf_template_v3` 克隆。没有启动 worker，不处理真实业务任务。

测试账号 `perf_ui_operator`（`log_reader`）与 `perf_ui_viewer`（普通账号），测试密码均为 `PerfTest1415!Local`。这些固定账号和密码只用于脚本显式限制的本地合成数据库，不能用于生产。

从仓库根目录运行，使用本机已有 Node.js 24；先完成 contracts、依赖包与 API 的构建。两个终端分别启动：

```powershell
$env:BB_PERFORMANCE_UI_DATABASE_URL='postgresql://perf_test:perf_test_local@127.0.0.1:55415/bb_perf_ui'
node apps/web/tests/admin-performance-live.mjs seed
node apps/web/tests/admin-performance-live.mjs serve
```

```powershell
$env:BB_API_PROXY_TARGET='http://127.0.0.1:4315'
Set-Location apps/web
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5175
```

在对应启动终端按 `Ctrl+C` 停止 API 或 Vite。若启动终端不可用，先用 `Get-NetTCPConnection -LocalPort 5175,4315 -State Listen` 核对监听 PID，再检查其命令行，只停止本批进程。本次核验 Vite PID 为 `98252`，API PID 为 `58920`（最终修复后重启，exec session `62636`）；PID 会随重启改变，不应长期直接复用，也不要批量结束所有 Node 进程。停止网页/API不会删除本地测试数据库。

复验真实链路与补拍：

```powershell
$env:BB_PERFORMANCE_UI_DATABASE_URL='postgresql://perf_test:perf_test_local@127.0.0.1:55415/bb_perf_ui'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node apps/web/tests/admin-performance-live.mjs verify
```

合成浏览器回归设置 `BB_E2E_BASE_URL=http://127.0.0.1:5175` 后运行 `admin-performance.spec.ts`、`admin-inspection.spec.ts` 和 `admin-inspection-status.spec.ts`。实际 API 验证脚本对主机、端口、数据库名做强制校验，无法误接生产数据库。

本文件只登记后台性能 UI 的开发与自测；总体验证由 `docs/testing/issue-1415-performance.md` 汇总。原型一致与自动化通过均不等于用户已验收或已获本批生产发布授权。

## #1422 工具边界缺测补修（最终版本）

工具只有结束事件或超过采集限额而省略时，`model.exec` 的 `tool_timing_complete=false` 现在会使 API 与界面覆盖度保持不完整。界面展示“工具计时缺测”，不再输出确定的未解释时间；真实已测的 CLI 总耗时保留，仍参与该步骤的服务端分位数。对应原型已用最终渲染器重新生成，新增“工具计时缺测”合成状态。

本次前端单测 19/19，两个缺测浏览器用例 2/2，最终 web 类型检查及 Vite 构建均 exit 0。两个浏览器用例使用固定 1440×1000 viewport 截图，并验证整条模型步骤在可视范围内；不使用受父抽屉裁剪的长元素截图。定向 PostgreSQL 回归 1/1（两种场景，未选中用例未计入 TAP），随后主验证复跑全部性能 unit + PostgreSQL 12/12、无失败或跳过，记录见 `work/performance-final-1422.log`。

新增证据：[结束事件缺开始](evidence/issue-1422/browser-completed-only.png)、[工具省略](evidence/issue-1422/browser-omitted.png)、[同状态原型](evidence/issue-1422/prototype-tool-missing.png)、[验证记录](evidence/issue-1422/verification.json)。此前完整分页与手机截图仍说明原有状态，这三张是最终缺测状态补充。

最终确认 `http://127.0.0.1:5175/admin/` 使用本次源代码，`http://127.0.0.1:4315` 已加载最终 API 编译结果；本地合成账号登录及真实本地汇总请求返回 200，仍为 1002 条合成任务。没有重建 seed、启动 worker 或调用真实模型；本次仅开发与自测完成，尚未部署，也不代表用户验收完成。
