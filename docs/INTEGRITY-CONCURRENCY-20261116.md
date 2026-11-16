# 诚信核查与募集书并行修复（#1441）

## 问题与只读取证

2026-11-16 用户报告同项目更新募集书时启动诚信核查返回 PROJECT_RUN_ACTIVE。网关记录北京时间 10:38:35 的诚信启动请求为 HTTP 409；同账号同项目募集书更新于 10:36:36 创建、10:36:37 运行、11:10:35 成功交付。关联依据为账号、项目、请求时间和状态；API 未记录所提供 correlation ID，未声称按该 ID 精确命中。排查仅用只读数据库角色与日志，没有修改生产任务、账务或服务。

诚信入口原来检查同项目所有未终态任务，并进入 canonical 文书互斥；其 generation 类型还被数据库文书互斥覆盖。启动诚信同时覆盖项目 latest_input_revision，会破坏募集书报价绑定。

## 修复与兼容

- 诚信 check/export 与文书双向独立，同项目诚信操作仍串行，原幂等、归属、积分与运行快照继续保留。
- 用既有不可变诚信输入识别任务，保留 generation、integrity_v1 和历史 worker/账务契约；API 与数据库均实施相同边界。
- 诚信不覆盖募集书 latest_input_revision；普通冻结输入在项目锁内按 max(revision)+1 分配，避免输入编号冲突。
- 原文书之间 canonical 互斥、批次成员/容量、账号关闭和项目删除保护保留。
- 统一发布先应用新增 0188_integrity_independent_runs.sql，再启用新 API。回退包至少保留 max(revision)+1 分配修复；不能直接恢复仍按 latest+1 分配的旧 API。

## 已完成验证

固定基础版本 develop 343701e4311486795516472a2e35e47191c90d08；独立工作区、Windows Node 22.14.0、专用本地 PostgreSQL 16.13，无生产数据库连接用于测试。

- 完整 191 项 SQL 迁移通过，包括新增 0188。SQL 使用 Git 提交/发布来源的 LF 换行；Windows CRLF 原样回放会使既有 0180 的文本 marker 失配。没有修改任何已部署迁移。
- `node --test apps/api/dist/integrity-concurrency.pg.test.js`：4 passed / 0 failed / 0 skipped。真实 Fastify、数据库、队列领取、任务列表与积分账本，材料均为 synthetic。覆盖两种启动顺序、原报价和输入保持、免费导出、后续版本编号、重复请求只预留一次、并发新轮互斥、跨账号隔离、canonical 双向边界、DB 直接插入保护、诚信历史项目首次募集书上传/冻结/报价/执行。
- `npm run check:contracts` 通过：32 项报价/诚信展示/底稿用例、29 项 OCR v2、11 项发行人绑定用例；179 个公共与 12 个内部合成示例、4 个生命周期示例。
- 全部 workspace 构建通过（contracts、domain、rule-pack-registry、rule-applicability-context、API、worker、web）；最终 API/worker/web 构建退出码 0。
- 现有诚信回执 1/1、诚信报价范围 4/4、底稿渐进批次 9/9 通过；M4 回归 5/7 通过，其 2 项旧范围/价格断言失败见下表；authoring-task-kind 旧无报价分支失败亦见下文。该扩展命令合计 22 passed / 3 failed / 0 skipped；最终新增并发文件另行以 4/4 结果为准。
- `git diff --check` 通过。

本次没有调用真实模型或官网，不将 API/数据库合成验证声称为模型质量、网站可访问性或用户验收。

## 扩展回归与基线差异

保留以下未修改的现有测试问题，不将其计为通过：

- project-file-batch-recovery.test 的精确字符串断言仍期待 FOR UPDATE OF p，当前 project() 在已有 f580f1ed 已改为 FOR NO KEY UPDATE OF p。仅内存更新该精确断言的诊断运行 9/9 通过；仓库测试未改。
- authoring-task-kind.pg.test 与 review-workspace.test 未声明历史计费 fixture，却直接发送无报价执行请求，现行默认商业模式返回 QUOTE_REQUIRED。该默认来自已有 530c1773；本修复未改计费开关。
- m4-workspace.pg.test 的历史固定 QA 期待 BILLING_NOT_READY，现行商业范围校验返回 SCOPE_UNSUPPORTED；另一旧价格断言期待 4500、实际现价 7965。相关报价和费率代码均未修改。

## 交付状态

核心并发开发和针对性自测完成；代码尚未部署，待统一集成与发布。用户尚未验收本批修复；未运行生产迁移、部署或服务重启。
