# 审计报告必填：已部署并核验（#1523 / #1525）

2026-11-17 14:32:06（北京时间）已完成主站 API/Web 的限定发布。更新募集书必须上传、保存并选入本轮的“审计报告（可含报表及附注）”；缺失时网页禁止开始，API 在输入锁定、报价及新任务提交处返回 `422 INPUT_REQUIRED` / `materials.audit` / `AUDIT_REPORT_REQUIRED`。报表、附注、参考募集书或续改成果不能替代审计报告。现有任务和准确幂等重放继续使用原输入；这是材料角色与保存状态校验，不是报告内容真伪核验。

## 固定版本与授权

- 功能 PR #1523 已合入 develop：`91c6691c3a1213b5bd09b7606bcda3a1d2dcbb36`。
- 发布 PR #1525 已合入 master：`6f3fd69a2c8dec98da2986ed55f0bdece86c72f2`；业务源码为 `e7c0c3b61c60e18bff3e1af9759655a79872d787`，从稳定 master `d6cd6a381eaf27536fec4b693cd0fd962dbe79dc` 仅挑入本功能和测试夹具。
- 用户在当前 chat 明确批准“批准本次限定例外，部署 #1525”。本收据仅记录此批 API/Web 的 12 文件发布。完整当前 commit/tree 真实模型质量凭据仍缺失，既有 #1500 文档缺陷未解决；`full_quality_gate_passed=false`，`human_document_acceptance=false`。
- 本目录同步到 develop 仅为保存发布证据，不触发再次部署。

## 限定范围与可复现性

- API 保留原不可变镜像 `sha256:e995a4928f4ec16048ac6b5c5cc136bf9582baf758bc71361cb08e20f4a9eb85`。从线上读回的五个编译模块应用 `api-scope.patch`；补丁来自开发前后的同编译器输出，输出与正式构建核对，所有补丁上下文精确匹配。
- Web 保留原不可变镜像 `sha256:1f49ae4d66c277e023901b2ec7b28b4f4a97e048d5110e35ad805ff9b80129be`。从 `abd903e0de6fb360247ed90eb6624ebc5aeba9ca` 加已部署 #1495 和 #1482 的网页差异重建，七个原网页文件的 SHA256 全部与线上收据一致，再应用 `web-scope.patch`。保留已有 44 个启用/85 个暂停站点和加密上传提示。
- 归档含五个 API/契约模块和七个网页文件，路径与前后 SHA256 见 `manifest.json`。归档 SHA256 为 `e80d7167203a9a4fb809fa177d31784f8e7ccd3e50b2a4e4174b526fad05978d`，721547 字节。这是记录源组合的局部发布，不将整个镜像标注为新源码。
- 无数据库迁移、依赖、模型、worker、解析/上传确认、控制端或节点启动模板变更。生产数据、配置凭据及客户原件不入包。

## 验证与边界

最新 develop 基线构建、公共契约检查通过；真实 Fastify 与独立 PostgreSQL 的相关 API 20/20，前端单元 38/38。原 API 镜像中的断网候选检查 5/5，包括真实依赖导入及 422 公共错误，未连接生产数据库或模型。精确候选网页的审计必填和参考募集书 Edge 6/6，含缺失、只有报表/附注、补齐、移除及续改；1440/390 像素截图检查通过。材料、账号及浏览器 API 均为 synthetic，不是用户验收或真实生成验收。

上线后的实际容器模块检查通过：无审计报告返回 422 及上述字段错误，有审计报告被接受。此项直接执行已部署模块，不是生产业务 HTTP 写入。公网 HTTP 9/9 通过：七项网页文件准确 hash、healthz 200、匿名 me 401。公共站点资源上的 `apps/web/tests/required-audit.spec.ts` Edge 3/3 通过，覆盖缺失、补齐/移除和续改不能替代；API 路由为 synthetic mock，不创建生产任务或触发模型、支付。`postdeploy.json` 确认全部 12 文件 hash、API/Web 健康、零重启、无 OOM、其他服务保持、无 pending 且部署锁已释放。

旧 `integrity-retired-sites.spec.ts` 仍预期全量 49 个入口，与既已部署的属地范围不同，出现 4 失败、1 通过；未修改的线上七文件基线复验同样四个失败点及实测值，确认是既有夹具口径差异，不声明全部浏览器套件通过。GitHub hosted CI 因账户付款/额度限制未启动，不计为通过。

## 发布收据与恢复

`prepare.py` 和 `prepared.json` 保留初始准备证据。激活前重新核对实际容器、文件 hash、活动任务及最新共享组件台账；在原 config/deploy/migration 锁内保存本批 pending，只以原镜像、`--no-deps` 切换 API，然后重建 Web 刷新 API 连接。核验成功后仅按 CAS 更新两项组件记录，清理本批 pending 并释放锁。

- `activation.json`：实际发布时间、源码、归档、容器/镜像、12 文件 hash、部署模块结果与本次用户例外。
- `postdeploy.json`：发布后实际状态、保护组件、pending 与锁清理。
- `public-verification.json`：公网九项读验证。
- `preserved-cache.json`：闲置临时组装缓存的可恢复归档与磁盘余量收据。

最初因其他批次 integrity1477 持锁而未进行切换；经用户授权协调，对方安全收尾后才取得窗口，保留其新 ops 容器 `8dd88c4d0eb06d357fd30972b02860c3e55d750c9241a4aa2305c0766be9c69e`。另一次磁盘预检在切换前安全退出；随后将无容器/进程引用的旧临时组装缓存完整归档，核验 2264 项字节/hash/权限/归属后仅移除解压缓存，空余为 2699100160 字节。没有删除镜像、数据库、客户材料或原备份。

原配置前像、运行收据与缓存归档位于服务器 `/var/lib/bondbuddy/audit-required1523-20261117/private`；共享收据位于 `/var/lib/bondbuddy/migration-908/state-main/release-audit-required1523-20261117.json`。新 API 容器为 `c848e510d6a8f506cac6254c9a922224d76c2c72daefbca6ffacf9c6c685a247`，新 Web 为 `134d1b15e989575223a77783b5bb7a8129fffa867ac3c60b37a1c730236f7827`。

若需恢复，先重读实时版本和活动任务，在同一部署锁内确认本批仍为受影响组件当前版本，再使用保存的 `api.before.compose.json` / `web.before.compose.json` 与原镜像恢复对应服务，重新验证健康、文件及组件登记；不覆盖后续批次、不降库。不得直接重跑旧激活计划。
