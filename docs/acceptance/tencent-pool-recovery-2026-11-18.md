# 腾讯执行池启动恢复与任务保全核查（2026-11-18）

开发任务，生产只读；本报告不表示已经部署或用户已验收。缺陷：#1618、#1619；关联池子总单 #1361、诊断 #1460、启动错误证据 #1400。

## 1. 为什么发生：可复核的因果链

北京时间。shuoling 的任务 `f63c7a40-7ba3-46f7-975a-f880f2f064b3`、`9ca72455-8c3a-41da-ab55-9d55a7269d80` 分别17:17:28和17:23:05提交。18:48:23只读复核仍为queued、attempts=0、未绑定执行节点；holder和active session均0。并发配置为全局8、节点8，没有证据支持“账号并发额度不足”或“模型运行慢”。

| 时间 | 原始证据 | 含义 |
| --- | --- | --- |
| 17:19:24—17:20:27 | 原Start操作及后续云回读：RUNNING、StartInstances SUCCESS、匹配request ID | 云开机已成功，不能重发开机请求当作恢复 |
| 17:20:04 | 节点journal：diagnostics-ready RuntimeError/exit 2；bootstrap dependency failed | 执行容器尚未进入启动链路 |
| 随后 | collector service和timer的ready.conf同样Requires/After该ready服务 | 上报故障反过来阻断采集，中央日志变旧 |
| 17:20:29—17:30:29 | 控制端私有vault的生成及expires_at；原dispatched marker存在 | 注册窗口十分钟，实际采用一分钟安全余量 |
| 17:29:33起 | execution_pool_reconcile_failed_closed；节点一直starting | 旧凭证失效后持续重试，并关闭全局准入 |
| 18:07:47 | 节点只读探针：内网SSH端口约9ms连接，原日志密钥认证成功；ready仍failed、Restart=no、NRestarts=0 | 后续通信已恢复，应用没有恢复入口 |

具体规则：

- `deploy/team-diagnostics/execution-bootstrap.drop-in.conf` 的前置依赖，以及 `node-maintenance/resume-node.py` 安装的两个 `ready.conf`，把单次同步失败放大成整条启动链路失效。
- `common.py::command` 抛出通用异常，`entry.py`只保留异常类，`collector.py`在上传前保存`source_status`。因此原SSH/同步失败的具体类别已经丢失。现存证据不能确定当时是网络、认证、远端命令还是ACK问题；本次不猜测。
- `enrollment.mjs::issueNodeEnrollment` 复用原vault，`expires_at > now()+60000`不满足便抛错；`ops-handler.mjs` 遇到starting便重试原凭证并return。该异常又进入关闭`budget_available`的总catch。`budget_available=false`在此不能解释成现金预算耗尽。

原始主机、SQL、TAT回执和脱敏分析保存在本机 `work/shuoling-queue-diagnosis-20261118`，不提交凭证、私有vault或客户原件。

## 2. 为什么旧测试没有发现

已有测试并非完全没有文件收集和下载验证：`m4-pipeline.pg.test.ts`包含真实API、PG、Blob、Word交付、下载及结算；`workpaper-direct-output.test.ts`覆盖缺文件、错误item_id及coverage缺项。但是这些独立用例不等于验证了节点热启动和文件收集失败后的完整恢复链。

本次启动缺口是：lost ACK用例由测试手动再次调用sync；warm-bootstrap用例主要核对不可变启动字节和身份绑定。缺少真实systemd依赖失败→独立采集→连接恢复→一次执行启动的验收，也缺少超过注册TTL后仍有排队需求、双starting节点和第二节点调度的组合。

新增回归在真实systemd中首先复现旧依赖死锁，再应用实际installer与dropin；不以静态文本断言代替服务行为。测试中归档传输和模型命令为synthetic，重试间隔从30秒加速为1秒；systemd、安装/回滚和依赖关系是真实的。真实云启停与模型质量不属于本次本地测试结论。

## 3. 为什么不能让局部故障丢掉整项任务

本次两个用户任务从未开始执行，没有已经生成的正文被启动故障删除。18:48快照积分为held，分别8,864和20,341，charged_points均NULL；预留不能称为已扣款，也不能称为已经退还。本补丁不改任务状态、用户余额、结算或租约。

修复策略：

- 采集与远端同步准入解耦。采集继续保存本地记录；只在精确ACK后推进uploaded游标，上传失败将stage/code/exit_status和backlog写回source_status。错误分类来自固定枚举，不输出stderr、命令参数或凭据。
- bootstrap前置入口最多等待30分钟。ready成功后exec进入原Node入口；服务自身保持Restart=no。只有明确发生在broker只读注册阶段的pending/deadline才可在Node入口内有界再试，保留原每分钟启动准入约束；执行进程开始后或结果未知的错误不重跑。
- 原注册版本精确回读确认后，至多创建3个新的不可变版本，沿用同一PG token、节点epoch、源版本、云操作和request ID。每个新版本仍只有十分钟TTL。原Put未确认不得利用过期绕开幂等记录；不重发Start、不覆盖旧版本。
- 两个starting节点都推进注册恢复；慢节点仍计入库存和实际费用。只有新鲜、可准入的需求及原费用上限允许时，才使用剩余的第二节点容量；不突破两节点或总模型并发，也不停止、销毁或释放可能仍有工作的节点。
- 超过恢复上限保留明确`execution_pool_enrollment_exhausted`/`execution_pool_boot_delayed`证据。两个槽位都故障仍需人工修复，不能自动停掉不明状态的进程来腾位置。

## 4. 扩大核查后的其他缺口

| 范围 | 已核实的代码/记录 | 当前处理与边界 |
| --- | --- | --- |
| M4文件收集失败 #1592 | `workpaper-direct-output.ts`依次读`workpaper-result.json`、`workpaper-coverage.json`，校验schema/item_id/全文coverage；`codex-adapter.ts`将该类收集异常映射为MODEL_OUTPUT_SCHEMA_INVALID，随后finally清理工作区。M4没有接入fileWorkspace.onFailure | 不能从通用错误码或模型自述反推具体失败字段。该批历史记录已缺少完整收集拒绝证据，本次未宣称定位或修复该单；应独立补收集故障证据、保全及阶段恢复 |
| 模型续租确认 #1540 | 当前`model-call-budget.ts`仍把续租确认异常视作取消信号；原缺陷已有真实PG延迟回包3/3注入证据，非腾讯特有 | 原Issue继续跟踪，不用提高并发或改启动脚本冒充已解决；本次保留其现有租约安全边界 |
| 募集书恢复快照 #1341/#1343 | develop已具备file_authoring_recovery_captures支持/结果记录与相关测试；是否可续跑仍取决于完整且匹配的已保存快照 | 不把“字段存在”当作所有文种均可恢复；容量取消、M4收集异常等分支不能自动套用该保证 |
| 已持久化成果后的交付/结算 | `m4-pipeline.pg.test.ts`核对崩溃后复用结果、实际下载、冻结积分归零、唯一收费、未知用量与reconciliation | 复用现有定向集成测试；synthetic模型，不证明真实DeepSeek内容质量，也不证明收集前损坏文件已获保全 |

## 5. 验证记录

- `npm run build`：全仓构建通过，只有既有前端bundle大小提示。
- Python诊断归档测试：37项通过，涵盖安全分类、上传状态持久化、未确认记录保留和前置等待边界。
- 真实Linux/systemd：旧依赖死锁复现；恢复后只启动一次；运行失败不重启；installer回滚还原原依赖，4项通过。
- Node/PG/Blob集成最终结果：见同批PR测试回执及本地 `work/pool-recovery/integration.tap`。提交前补齐准确计数，不把启动成功当作全链路通过。

## 6. 统一发布接续（本chat未执行）

没有新增DB迁移或第三方运行时依赖。Python、Node、systemd均为现有节点组件。

必须将控制端与节点端作为同一批发布：先更新节点的enrollment解析器、bootstrap入口及完整模块依赖（含新增`enrollment-version.mjs`），再启用控制端新版本发行逻辑；旧解析器不支持新generation。现有节点及未来新建镜像/模板都需固定版本、核对模块hash和真实服务定义；不能仅发布主站容器。历史managed-overlay/managed-release-manifest是旧版本收据，本次不改写或伪造其hash，发布chat须从固定合入版本生成本批新包。

诊断执行节点配置需`execution_bootstrap: true`，installer会备份并管理bootstrap dropin和两个历史collector ready.conf；主站诊断配置不启用该标志。安装不激活或重启任何生产服务。统一发布者按既有锁、在途任务检查和用户验收规则接续激活。保存installer备份收据；回滚恢复原文件，并按当时真实节点会话/云操作决定接续，不能删除vault、dispatched标记或租约来“重置”。

恢复版本保留已确认的k个前序版本，避免清理环节重复读取：k次确认＋最多1+3×(10−k)次退休清理＋Get/Put/Get，共不超过34−2k次，仍满足原每节点每tick最多34次、两节点68次的费用上界。每个完成云操作最多4次不可变发布，最多2个节点。SSM十版本上限及旧epoch经确认Stop后的退休规则保留。发布时沿用并核验现有费用约束，不通过加节点上限解决故障。

最终统一验收待办：现存节点热启动及未来冷启动、归档短暂不可用后自动恢复、真实注册与claim、保存成果和下载、正常drain/stop；当前两项用户任务的实际终态与账务由获授权发布环节复核。代码交付、本地验证、用户验收、生产部署分别登记。
