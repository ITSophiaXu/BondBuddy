# #1415 运营后台性能对照

此前 `product-prototype/public` 没有运营后台原型（见 `docs/testing/admin-task-status-20261113.md`），本批补齐同一个 `/admin/` 页面的对应原型；不新增用户业务页或产品导航。

既有结构基准：提交 `e277c27a` 的 `apps/web/src/admin-inspection-main.ts`、`admin-inspection-detail.ts`、`admin-inspection-render.ts` 和 `admin-inspection.css`。本批增量：运营概览内“步骤性能”区域；单 run 任务追踪内“步骤性能”标签。原型由本批相同的渲染函数和 CSS 生成，最终 PR commit 由集成负责人登记。

打开 `index.html` 查看概览；`?detail=full` 查看完整瀑布，`?detail=partial` 查看部分分页，`?detail=incomplete` 查看运行中及失败缺测，`?detail=denied` 查看权限/接口失败。页首明确标注合成原型，不读取生产 API，不将样例数字当作实测。

实现对照范围：

- 运营概览保持已有状态统计、用户/任务导航、快照筛选；性能区域有独立查询条件，通过服务器完整筛选集聚合，展示 P50/P90/P95 和有效样本量，不使用 1000 条快照回算分位数。
- 单 run 打开标签才读首批 200 条步骤，“加载更多”延续不透明游标；根/子步骤、折叠、展开上下文、会话及采集完整度同屏。窗口内允许横向滚动，手机页面本身不溢出。
- 并行子步骤按父区间裁剪后求区间并集；部分分页、未结束、丢弃或缺测时未解释耗时为未知。运行中已历时截至所在页读取时点，不冒充最终耗时。
- 调用、缓存、输入工作量、共享关联和执行版本仅展示已采集白名单字段。旧任务未埋点不补造数据。
- 汇总导出含全部服务端分组；单 run 导出明确仅已载入页。CSV/JSON保留审计ID、读取时间、范围及缺测；CSV对可能的公式字符串转义。
- 原型查询与导出为合成演示；真实页面使用 `GET /api/v1/admin/performance/summary` 和 `GET /api/v1/admin/performance/runs/:run_id`，读权限和查询审计由API检查。浏览器回归另用明确标注的合成响应，不声称覆盖真实模型质量。

重新生成：先编译 web 定向测试及 `admin-inspection-detail.ts` 到 `apps/web/dist-test`，再运行 `node product-prototype/admin-performance-build.mjs`。同尺寸对照使用 `apps/web/tests/admin-performance.spec.ts` 保存的概览、瀑布、手机截图及原型相应区域，最终证据路径由本批集成记录补齐。

开发交付不代表本地集成验收或生产部署。
