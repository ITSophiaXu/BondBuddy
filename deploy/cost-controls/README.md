# BondBuddy 流量与费用修复（2026-11-07）

## 已实施的代码

- 底稿页和文件生成页共用可见性感知轮询器。只在队列 queued/running 或仍有已开始条目正在执行时轮询；完成、部分完成、取消以及静止的暂停状态没有持续计时器。隐藏标签页取消当前轮询请求，返回前台只同步一次；关闭页面不会取消后台任务。
- 活动页分别每 10/15 秒读取 `GET /api/v1/projects/{project_id}/workpapers/progress` 和 `file-generation/progress`。响应示例：`{"revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","active":true}`。不变时不读取完整工作区。底稿历史链接通过 `batch_id` 查询参数纳入指定批次，仍逐次校验项目和批次归属。
- 变更标识由有序的批次/条目状态、阶段、错误、结果 hash、交付状态、已扣积分、文件版本、维护检查和来源选择生成。不能只用 batch.revision，因为子任务阶段、结算和文件维护会独立变化。数据库读取不包含文件正文、links 或整份任务 manifest；响应不含项目名称和用户信息。它是私有的条件读取协议，未引入共享缓存或 304 缓存。
- 底稿工作区和批次（包括文件生成嵌套批次）的 file.original/current 现在是 `ProjectFileVersionSummary`：保留版本、来源、下载 pin 和一致性摘要，不含 links。同一版本的两份巨大证据不再重复发送。核查/维护内部读取仍返回完整 `ProjectFileVersion`，存储无删除，无迁移。原页面没有消费该 links 字段；外部自行实现的客户端如依赖此内部字段需调整。
- 列表 SQL 投影必要字段，目录项读取不再带整份任务输入。同一工作区多个批次共用一次文件版本查询。初始打开、人工操作、返回前台和状态变化仍会读取必要目录/成果；不是把所有请求变成 94 字节。
- 底稿成果列表也移除完整证据，仅查询当前页关联条数，并返回 active。生成或核查活动结束后停止刷新，隐藏页暂停；有活动时保持原分页摘要读取，以覆盖历史核查任务，不能把它与两个进度 token 接口混为一谈。
- 轮询不重叠；上传/操作/下载期间让位；错误按指数间隔重试，连续五次失败暂停自动刷新并显示提示。再次操作或切回前台可重试。API 不可用时不会降级为持续请求旧的大接口。
- 实际 web 镜像使用的 Nginx 配置增加 JSON 压缩，继续 private/no-store。SSE 不在 gzip 类型列表。四条相关 GET 路由增加不含 ID、IP、查询串和正文的字节日志，保留原访问日志。

## 本地验证

合成真实 PostgreSQL 样本：248 项、120 份文件、25,997 条关联。旧式双份证据响应 34,394,480 字节；摘要响应 233,634 字节；状态响应 94 字节。所有关联在内部读取中仍完整。与历史线上 26.18 MB 响应不是同一数据集，不能把这个数字当作上线后的实测。

覆盖数据库查询、两个入口、无变化 token、阶段/错误更新、暂停时在途任务、历史批次与跨账号隔离；浏览器验证两块真实组件的请求次数、前后台切换、完成停止和销毁；单元验证单请求并发和退避。具体最终测试命令及结果记入 PR。

验证环境为 Windows、Node 22、本机独立 PostgreSQL、Edge。未调用真实模型或生产数据库。

- `npm run build`、`npm run check:contracts` 通过；成果列表补充后重新构建 contracts/API/web 通过。
- `node --test apps/api/dist/generation-progress.pg.test.js apps/api/dist/workpaper-download.test.js apps/api/dist/workpaper-legacy-checks.pg.test.js`：3/3；另运行任务路由 2/2 和 ZIP 11/11。
- `node --test apps/web/dist-test/task-poller.test.js`：5/5。
- Playwright `generation-egress.spec.ts workpaper-progress-routing.spec.ts workpaper-library.spec.ts`：30/30；`file-generation-flow.spec.ts`：17/17。
- 官方 Nginx 1.28.0 本机测试（只替换 upstream、端口与文件路径）：语法有效；合成 JSON 180,014 → 513 字节，私有缓存头、Vary、SSE 不压缩、路由字节日志脱敏均通过。
- 旧 `workpaper-batch.spec.ts` 存在目录准备入口和充值控件断言失败。用未修改的 `757a9871` 导出完整 web/原型资源重跑两个代表用例，复现同一缺失 `.wp-directory-current` / `#subscription-topup-amount`。没有把这些失败计入通过，也没有据此改动本次无关的产品路由。

告警模板已准备，未执行 Azure 部署/发送通知；Azure 端模板校验和测试告警仍属于统一发布步骤。

## 发布与验收

无数据库迁移、无新 npm 依赖、无模型调用。先发布 API（增加 progress 路由、精简列表），再发布对应 web/Nginx，执行统一集成验收。API 向前兼容旧 web 的实际用法；旧标签页仍会轮询，但响应已经去掉证据，页面重新加载后才采用停止策略。回滚 web 可保留新 API；回滚 API 时也要回滚新 web，避免 progress 路由缺失。

上线后使用有权访问的测试项目核对：终态页面静置 10 分钟没有周期请求；后台标签页无周期请求；切回有一次刷新；活动任务进度、错误、计费和结果变化能显示；Word/ZIP/核查继续可用。检查 `Content-Encoding: gzip`、`Vary: Accept-Encoding`、私有缓存头以及实际外层代理是否保留协商。用现有轮转日志按 route 汇总 bytes，再对比 Azure 小时出站与滞后的账单；跨云数据库/对象存储流量与网页响应流量分别观察。

本 chat 只交付开发代码；未执行生产部署、重启、网络更改或资源删除。专用集成/发布 chat 按既有用户验收规则接收本 PR。

## 费用配置与资源节省

`deploy/cost-controls/azure-budget.json` 和 `azure-egress-alert.json` 是待发布的 ARM 模板。预算按订阅账单币种设置，实际费用 50%/80%/100% 和预测费用 100% 提醒；VM 在滑动一小时出站超过默认 2 GiB 时告警。通知邮箱、已有 Action Group、预算额度均由发布时填写，不预填收件人，也没有发送通知。预算提醒不是硬性上限；指标告警可能产生小额监控费用，发布前核对现有告警避免重复。

此前账单显示旧日本资源组约 HK$87 的磁盘/IP/快照费用，VM 解除分配仍可能收费。发布负责人先确认旧资源的恢复依赖、快照保留和现有迁移状态，再提交逐资源清理清单。本 PR 不删除这些备份。不直接缩小当前执行机：先采集 7 天 CPU/内存、队列等待、OOM 和并发峰值，再评估规格；低用户数不代表 Word/模型执行内存峰值低。

优先顺序：发布本次流量修复 → 验证实际字节和终态零轮询 → 启用预算/出站提醒 → 确认旧资源后清理 → 按真实峰值选 VM 规格。不要以无限制采集访问正文、增加高频付费监控或新的长期开机测试机来处理本次问题。
