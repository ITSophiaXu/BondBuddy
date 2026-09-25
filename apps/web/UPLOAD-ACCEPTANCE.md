# #12 上传、去重与恢复验收记录

后续进展（2026-09-25）：#149 已接入持久化解析任务；浏览器解析状态、历史稿源信息、真实 Python 解析/去重/重登恢复的新增证据及剩余阻塞见 [MATERIAL-PROCESSING-ACCEPTANCE.md](MATERIAL-PROCESSING-ACCEPTANCE.md)。以下保留 #142 当时的交付记录；其中“未接入识别”的结论以该后续记录为准。

日期：2026-09-25。基线：develop `8474591`。本次为 #12 的后续实现，复用 #111 上传页面、#116 项目事件以及已有文件结构检查；不关闭 #12。

## 本次交付

- 根据项目“有／没有历史募集书”显示本企业历史稿或可选相似稿上传入口。切换不会删除先前材料，已保存记录继续可见。
- 复用公共固定分区、资金用途材料提示；明确财务报告已包含报表和附注时无需重复上传，募投资料按用途提供。
- 页面最多同时处理 2 份文件，其余排队；每份可取消或单独重试。百分比来自真实传输字节，100% 之后仍等待服务端核验和提交。
- 当前页面保留文件 hash 和上传 session。重试先调用原 session 的 complete；已提交则直接取回材料，未收到字节才续传，过期/失效 session 才重建。断线或 5xx 的不确定结果不冒充保存成功。
- 同 owner、项目、role、hash、大小和 MIME 的内容复用一份当前未删除材料版本；改文件名不重新建材料。不同用途分区、项目和账号各自隔离。页面去重展示并提示复用结果，统计不重复相加。
- 单份 100 MiB；保存新版本时按项目锁检查当前未删除材料总数 60、总量 500 MiB，容量已满仍可复用相同内容。暂存 upload 由既有 #8 过期清理策略管理，**这不是暂存对象的空间预留配额**。
- 保存与识别状态分开：本次仅保证有效材料持久化事件不重复，不宣称历史稿识别已经完成。

## 契约与迁移

新增 `0018_m1_upload_reuse.sql`。不可变 `bb_upload_reuse_receipts` 将冗余上传 session 指向已保存材料的精确版本，按 owner/project 校验。复用凭证与 `upload.reused` outbox 原子提交；不增加第二条 `material.persisted` 或项目材料事件。首次保存仍复用现有事件格式和不可变版本。

冗余 session 的字节暂存状态保留 `received`，在明确配置的 orphan grace 后经现有 tombstone 流程清理；语义上的完成由复用凭证表示。complete 在清理以后仍能解析同一凭证，但已删除材料返回 404、缺失/损坏的原对象返回 503，绝不复活材料或错误报告保存成功。已解析的复用 session 拒绝再次 PUT。

请求和响应 JSON 结构、role 和错误码不变；`UploadCompleteRequest → MaterialResponse` 可返回原材料的 `upload_id`、文件名和版本，客户端不得假设它等于本次 session。公共包新增 `M1_UPLOAD_LIMITS`，没有另建枚举。应用此迁移后再部署新 API；旧迁移未修改。API/数据库提交顺序为项目锁 → upload 锁，与删除和输入快照一致。

## 已取得的证据

环境：Windows，本机 Node 22.16.0、PostgreSQL 16.14、Azurite 3.35.0；两个隔离测试数据库。Azurite 使用 `--skipApiVersionCheck` 兼容 SDK 的 2026-06-06 接口日期；这不代表 Azure 实际部署已验收。所有文件均由仓库测试生成器合成，没有客户资料、生产凭证或真实模型调用。

| 检查 | 结果 |
| --- | --- |
| 全部 M1 包构建、公共契约样例 | 通过；56 个样例 |
| Web draft/form 单元测试 | 8 个通过 |
| 原 server 测试 | 3 个通过，含真实登录/重登录、上传、账号隔离、快照和 outbox 回滚 |
| 新 upload-reuse 测试 | 3 个通过：并发同内容、跨作用域、清理后重放、已删/缺失对象、复用 outbox 回滚；60 文件并发末位；500 MiB 精确边界 |
| 原存储配置/保留清理与上传安全测试 | 6 个通过，含加密、伪格式、结构损坏、活动内容、并发解析限流和 Blob 写入前检查 |
| 小文件持续上传 | 60 份合成文本实际经过 HTTP handler、PostgreSQL、Azurite，末位并发竞争仅一份可新增；约 45.1 秒。不是 500 MiB 大文件压测 |
| 500 MiB 边界 | 使用显式合成的既有材料大小元数据验证容量算术与事务，新增文件实际经过 Blob；不是 500 MiB 实际传输证据 |
| 浏览器真实上传 | 3 份 PDF 中 1 份损坏，另外 2 份保存；排队可见；100% 字节时仍显示保存中 |
| 浏览器确认响应丢失 | 本地测试 seam 在成功 commit 后断开一次响应；显示结果未确认，点击“核对并继续保存”取得原结果 |
| 浏览器重复/重开 | 历史稿和改名副本只显示 1 份；出现复用提示；关闭标签后重新打开恢复 4 份真实保存记录 |
| 历史稿选项 | 有历史稿时不显示相似稿入口；无历史稿时显示可选相似稿，旧历史稿记录保留但不再显示添加入口 |

自动化复现：`npm ci`、`npm run build`、`npm run check:contracts`、`npm run test:unit -w @bondbuddy/web`。在独立 PostgreSQL 16/Azurite 上迁移后，设置 `BB_TEST_DATABASE_URL` 和 `BB_TEST_AZURITE_CONNECTION_STRING`：

```sh
node --test --test-concurrency=1 apps/api/dist/server.test.js apps/api/dist/upload-reuse.test.js
node --test --test-name-pattern='configuration|tombstones pin|upload' apps/api/dist/storage-lifecycle.test.js apps/api/dist/upload-safety.test.js
```

`tests/upload.spec.ts` 补充了响应丢失与改名重复的回归用例。本次浏览器验证通过 Codex 浏览器工具操作真实页面；未宣称本机已执行整套 Playwright 套件。原 PostgreSQL dump/restore 用例未在本次重跑（本机嵌入式发行包不含 pg_dump/psql），不能据此宣布 #8 的恢复验收通过。

## 仍需关闭的交付条件

1. #8 部署环境的 Azure Blob/TLS、存储容量与备份恢复验收；真实 100 MiB/500 MiB、1500 页混合文件压测及并发用户目标。当前文件结构解析还有自己的资源上限，以 `apps/api/UPLOAD-SAFETY.md` 为准。
2. #76/M1-31 将 `material.persisted` 接入历史稿识别消费流程并验证端到端去重、重启恢复和源信息展示。本次测试只证明单有效版本和单持久化事件，没有冒充有效识别任务已执行。
3. 缺页/缺附注/缺期间及 OCR 存疑数字的实质预检属于材料证据链联调。上传结构通过不能判断文件是否遗漏真实页面，当前保留待确认提示，不虚构“材料完整”。
4. 必需材料的可执行性检查仍在项目预检门禁处理；允许先保存不完整项目不等于可以启动更新。真实任务开放前仍需 #16、#79 和 Word 交付门禁。

合并前需由受影响负责人确认：Chris（上传页面/客户端）、Xuefeng（单版本事件交接和解析复用语义）。按最新 AGENTS.md 不请求或等待 Felix review。
