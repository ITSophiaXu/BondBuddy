# 准确执行版本的复核编辑结果验收（本地，未发布）

2026-10-27，起点 `cc6559e5b2e9411a30ce1d2700577b216381ca2e`，分支 `codex/desktop-ux-coverage-20261026`。输入、报告、用户与项目均为 synthetic。使用真实 PostgreSQL 16、Fastify HTTP、Python Word 转换、成果 promoter/finish/交付回执，以及桌面 Edge（Chromium）浏览器；私有 Blob 字节在内存中。没有真实供应商、Azure、支付或用户账号验收。

## 实现范围

`0127_review_execution_editors.sql` 新增 `(run_id,execution_version)` 主键的 canonical editor 表，完整 owner/project/run/execution/input revision/hash 分别整体 FK 到执行身份和复核业务快照。正文 schema、canonical SHA-256、准确原稿 pin/格式和时间均核验，不允许 UPDATE/DELETE。旧 editor 表和 run 主键保留，严格回填和 legacy bridge 原子同步 V1，精确镜像保留 PostgreSQL 微秒。

trusted writer 在 project→run→job 锁内核验租约与固定输入；滚动旧 writer 的真实死锁只在完整幂等登记事务内最多尝试三次，每次重验租约。reader 只读准确 canonical 结果，要求有效 final 交付回执、实时所有权/测试授权和全部交付成员，不回退旧表。GET 的数字 query 只做局部、严格转换；全局 AJV coercion 仍关闭。

人工导出保存完整 `source_execution`，Worker 用来源身份读取来源 editor。新旧请求的原 body 幂等保留；损坏或显式空 pin 在输入、stage 与转换边界拒绝，不能落入模型分支或借 checkpoint 跳过检查。缓存 wrapper、pending 请求和深拷贝固定完整身份，即使正文 SHA 相同也不能跨执行恢复。旧无 pin 请求仅兼容 V1，不补写来源字段改变旧请求。

## 采用结果

每行是一个独立 invocation，重复执行、不同集合与不同轮次不相加。准确命令、时间、退出码、跳过项及来源轮次见 [summary.json](summary.json)；全部原始记录和文件 hash 见 [manifest.json](manifest.json)。

| 集合 | 采用结果 | 冻结轮次 |
| --- | --- | --- |
| API editor / migration / concurrency | 17 pass / 0 fail / 0 cancelled / 0 skip | 1 |
| API related regression | 92 pass / 0 fail / 0 cancelled / 0 skip | 2 |
| Worker real correction / export | 8 pass / 0 fail / 0 cancelled / 0 skip | 2 |
| Worker related regression | 42 pass / 0 fail / 0 cancelled / 1 skip | 2 |
| Web recovery cache | 20 pass / 0 fail / 0 cancelled / 0 skip | 1 |
| Contracts | 45 editor examples；189 synthetic + 12 internal library examples；4 lifecycle examples；40 Node tests pass | 1 |
| Desktop browser | 19 expected / 0 unexpected / 0 flaky / 0 skipped | 2 |
| Build / typecheck | contracts、API、Worker 构建与 web 类型检查通过；Worker 在测试 seam 调整后重新构建 | 相应原始构建记录 |
| Fresh migrations | 新隔离模板完整应用到 0127 | 首次准备 |

唯一 skip 是 Windows 下既有 `report symlinks cannot publish outside files`。没有将其计为通过。浏览器使用真实 Edge，但业务接口由 synthetic route fixtures 提供；真实 PG/Python/HTTP 由独立 Worker 集合验证。两者均不构成 G03 同 run 新输入续做的完整桌面旅程。

关键覆盖包括：

- 真实迁移回填、双六字段 FK、严格 Unicode/emoji/引号/反斜线/控制字符 canonical hash、微秒 mirror；坏来源/格式/时间/hash 使事务整体回滚；两类 NOWAIT 冲突释放锁后重试。
- 真正 legacy/new writer 死锁；完整重试收敛到一份镜像，重试前租约过期仍拒绝且两表无部分正文。未放宽所有权、V1 或 input gate。
- 错误、过期、暂停、取消的租约不登记 editor；候选正文在真实 final finish 前不可公开。缺 canonical 不回退 legacy；正文损坏拒绝；撤销交付成员或测试授权后拒读。
- 源与导出任务的 input revision/hash 确实不同，导出固定准确来源 pin。真实 Python 生成旧/新 Word，授权下载后实际读取段落验证人工文本，旧字节不变；暂停捕获六个工作文件并恢复，不新增模型调用或积分 reservation。
- 网络失败后的原 body 重试，旧服务响应和旧 pending 兼容，错误执行 wrapper、跨页面同请求键/不同 pin 均阻止覆盖或提交；损坏下载拒绝并可重新授权重试。

## 冻结和保留的失败

两轮分别冻结 **2,217** 个文件，逐轮 before/after 完全相同，最终快照再次逐字节核对当前树。范围包括所列 API/Worker 源码和构建、web 源码/测试/unit 构建、contracts 源码/构建/examples、迁移、包配置及本轮 verifier/browser config。**既有 Python converter 源码和外部运行时未纳入前后冻结**；测试实际调用已配置本地 Python，不将该执行结果冒充 Python 运行时或源码的冻结证明。

轮次间只增加 Worker 内部转换测试登记 seam/夹具修复和本地浏览器/定向 probe 配置；准确变化路径及 hash 在 `summary.json.source_transitions`。API editor、缓存和契约采纳第一轮，Worker/桌面及完整 API 回归采纳第二轮；没有宣称全部来自同一次测试运行。

原始失败全部保留：

1. 沙箱 initdb 的 Windows restricted token code 87；没有创建 cluster，提升后在同一新目录成功初始化。
2. 首次新 PostgreSQL 启动的就绪轮询过短；原进程未重启，恢复模式核对同一 PID/目录/端口/启动时间后通过。
3. 首次 API/Worker 构建指出新测试中 UUID 推断类型与 string 赋值不匹配；只修正夹具变量类型后通过。
4. 初次 API editor 集合 15 tests / 12 pass / 3 fail：夹具缺 Origin，以及尝试改写原 run 输入被已有不可变 gate 正确拒绝。修正测试后包含并发案例的 17 项完整通过。
5. 第一轮 API 回归 92 tests / 91 pass / 0 fail / 1 cancelled：旧 artifact 边界测试达到其 30 秒限制。相同测试、相同限制的独立 probe 1/1 通过；完整集合随后重跑，采用结果见表。没有关闭 JIT、修改全局 PG 设置或放宽业务检查。
6. 第一轮 Worker 回归 41 pass / 1 fail / 1 skip：旧转换 unit 的单 query 假库没有事务连接。该 unit 改用内部登记 callback，继续真实 Python/Word 表格解析并核对输出；生产默认仍使用 trusted registrar，真实 PG 集合没有替换该登记。第二轮完整集合通过。
7. 首次浏览器 19 项均未启动浏览器：预期的 Playwright Chromium executable 不存在，随后 Windows WebServer teardown 卡住。只在核对本轮精确父子 PID 与专用端口后停止 Vite PID 41828，原 CLI 正常写出失败 JSON/HTML；补充清理记录与原失败均保留。改用本机已安装 Edge 后 19/19 通过，第二轮正常清理。

## 重现与清理

独立 cluster `.local/editor-postgres/data`，仅监听 `127.0.0.1:15530`，角色 `bb_editor_test`，模板 `bb_execution_editor_template_20261027`。验证器删除继承的 BB/provider/Azure/PG/Node options 等环境，明确指定测试库和本地 Python，不使用生产服务。并发测试设置 session deadlock_timeout，所用本地 initdb 角色是 superuser。桌面 Vite 仅用 `127.0.0.1:15531`，strictPort、禁止复用其他服务、单 desktop worker、零重试。

复现时将 `reproduction/verify.mjs` 和 `reproduction/playwright.config.mjs` 放到 `.local/execution-editors-20261027/`。已有本仓库依赖、父目录 embedded PostgreSQL 与指定 Python；浏览器使用本机 Edge。新环境依次运行：

```powershell
node .local/execution-editors-20261027/verify.mjs initdb
node .local/execution-editors-20261027/verify.mjs pg-start-direct
node .local/execution-editors-20261027/verify.mjs database-create
node .local/execution-editors-20261027/verify.mjs migrate
node .local/execution-editors-20261027/verify.mjs build
node .local/execution-editors-20261027/verify.mjs web-test-build
node .local/execution-editors-20261027/verify.mjs source-before
node .local/execution-editors-20261027/verify.mjs contracts-check
node .local/execution-editors-20261027/verify.mjs web-cache
node .local/execution-editors-20261027/verify.mjs api-editor
node .local/execution-editors-20261027/verify.mjs worker-editor
node .local/execution-editors-20261027/verify.mjs worker-regression
node .local/execution-editors-20261027/verify.mjs browser-editor
node .local/execution-editors-20261027/verify.mjs api-regression
node .local/execution-editors-20261027/verify.mjs source-after
node .local/execution-editors-20261027/verify.mjs database-audit
node .local/execution-editors-20261027/verify.mjs pg-stop
```

验证器禁止覆盖已有 cluster/database，Windows 上 initdb/浏览器清理需要适用的本机进程权限。每次调用使用独立记录目录，verifier/config 的所有使用版本按 hash 保存。最终仅保留原 0027 的准确禁用平台种子，所审计业务表、clones、其他 clients 均为零，核对本轮准确 PID **31256** 后成功停止；停止/status=3/无 PID 文件证据见 summary 和原始记录。

## Goal 状态

G03 / UX-A03 与完整 UX goal 保持 **active、未完成**。全局 V1 和 current-input integrity view 未改，既有不可变 run origin 继续阻止采用新输入；即使 editor storage key 允许表示版本，也不能据此执行 V2。现有免费人工导出仍创建独立 export run。源材料 retention、数据库 editor 正文旧 cleanup、版本化报告/M4/检查点/调用、实际旧工作复用与增量处理、同 run 补料采用、新 Word 桌面全旅程仍待完成。

用户已选 B：必要重做另行报价、确认追加金额后继续；B1/B2 计算规则尚未确定，本轮未自行定价或追加扣费。不重算用户旅程覆盖率；没有 push、PR 或部署。既有封存验收目录保持不变。
