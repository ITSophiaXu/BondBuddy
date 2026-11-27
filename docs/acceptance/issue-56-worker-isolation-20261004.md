# 更新与复核的执行容量隔离

Related #56。2026-10-04 用户要求修复共享单执行名额造成的阻塞。

旧配置只有一个 run/parse 通用槽；复核、格式重问和更新竞争它。另一个 parse-only 槽不能执行更新。本切片复用 #548 的完整异步复核校验与锁顺序修复，不改变校验结论或重发未知调用。

## 设计

- Compose `worker` 只领取 update/generation/qa，`worker-review` 只领取 review，`worker-parse` 只领取材料解析；生产 `worker` 为两个副本、各一个槽，review/parse 各一个槽。两个 authoring 副本通过 `FOR UPDATE SKIP LOCKED` 领取不同任务，不共享执行名额。复核助手只在复核进程启动，探针只在原 worker 启动。更新与复核使用不同容器、事件循环和 staging 卷，复用同一镜像与现有模型配置。
- 任务类型来自公共契约，在 PostgreSQL 选取候选前过滤，过期租约和暂停恢复按同样的范围分工。保留 run → job 锁顺序、SKIP LOCKED、归属/token fencing、取消与未知调用对账；没有迁移或新公共枚举。
- 继承只读根、cap_drop、seccomp/AppArmor、出站代理与只读认证文件。目标机实际为 2 vCPU/16 GiB：每个更新副本和复核各限 0.75 CPU/2 GiB，解析限 0.5 CPU/1 GiB。资源上限不是吞吐承诺。数据库 45 连接为 API 10、worker 4×5、ops 2 及维护留余量。
- 私有 worker group 前缀标记各进程心跳。API readiness/ops 必须同时看到 authoring、review、parse 新鲜心跳，不能由一个健康进程掩盖另一个缺失。公开 schema 不变，无页面改动。

## 验证命令

`npm run build`、`npm run check:contracts`；独立 PostgreSQL/Azurite 上运行 `node --test apps/worker/dist/runtime-isolation.test.js apps/worker/dist/runtime-parse-slots.test.js`；`node --test deploy/m1/scripts/worker-isolation.test.mjs` 检查真实 Compose 合成配置。新回归进入 Linux CI。

覆盖长复核期间更新执行、旧排队复核不抢更新容量、并发领取唯一性、跨组过期租约隔离、旧 token/取消拒绝、心跳分组缺失/过期及安全配置继承。实际 pass/fail 以 PR 和发布回执为准，未运行不算通过。

## 发布与原任务

从合并的 master 精确 SHA 发布。先核对所有 run 与复核助手活动租约，保留正在编制的项目；私有备份回读后使用 `BB_DEPLOY_INFLIGHT_GATE=1`。部署/恢复管理全部 worker 和 ops。回滚至隔离以前的版本必须用旧版 checkout/Compose，移除新服务；不能用不识别过滤的旧镜像启动三个新服务。保留加法 schema 和用户新数据。

部署后分别核对三容器的 SHA、PID、领取范围与新鲜心跳，再验证站点及实际任务。代码和合成验证不等于原报告、Word 或业务验收。原复核两次未知结果调用不会自动重试；缺失报告仍待恢复决定。
