# #1551：底稿子任务的执行角色权限

`bb_m3_project_run_mutex()` 按调用者身份执行，创建 `bb_runs` 时会读取
`bb_workpaper_paid_check_items`，即使当前操作不是付费检查。生产受限角色的
原九项启动预检不包含该间接依赖，导致底稿批次在创建子 run 前暂停。

完整受限角色回归补齐四组依赖，线上四个角色也逐项只读确认缺失：

| 依赖 | 新增的最小权限 | 用途 |
| --- | --- | --- |
| `bb_workpaper_paid_check_items` | SELECT | 原互斥触发器检查同批次身份 |
| `bb_platform_principals` | SELECT(user_id,purpose) | run/job INSERT 触发器判定保留平台身份 |
| `bb_m4_executions` | INSERT(run_id,owner_user_id,topic_id,manifest,input_hash) | 创建冻结执行记录 |
| `bb_credit_reservations` | INSERT(charged_points) | 新任务写入初始预留金额；原有其余列授权保留 |

不增加表级 INSERT/UPDATE，不改触发器为 SECURITY DEFINER，不放宽项目归属、
同批次并发、跨批次互斥或计费规则。付费检查表和平台身份表没有新增写权限。
`managed-database-preflight.ts` 将原九项扩为十三项；任一新增依赖缺失，
登记/接单前即以 `MANAGED_DATABASE_PRIVILEGES_MISSING:<缺项名>` 拒绝。

## 统一发布步骤（本开发任务尚未执行）

1. 固定修复 commit 和实际运行版本，按现有部署锁核对主站数据库及执行池身份。
   记录这四个既有角色和当前 ACL 前像：`bb1361_formal_n1_author_v1`、
   `bb1361_formal_n1_review_v1`、`bb1361_formal_n2_author_v1`、
   `bb1361_formal_n2_review_v1`。若实际角色变化，按当前登记核定，不能盲目增建角色。
2. 用授权的数据库维护身份，对每个已核定角色执行
   `deploy/m1/security/managed-execution-prerequisites.sql`，传入 psql
   `runtime_role` 变量并开启 `ON_ERROR_STOP=1`。脚本可重放；前置迁移 0190
   必须已存在，本修复不需要新的 schema 迁移。
3. 按实际每个服务连接身份运行新版 `assertManagedDatabasePrivileges`，核对
   `current_user` 及全部十三项预检。确认新表 SELECT 为 true，
   INSERT/UPDATE/DELETE/TRUNCATE 仍为 false，并核对保留身份表仅两列可读、执行记录和预留仅指定列可插入。不能只用管理员查询成功代替受限身份验证。
4. 编译更新 worker 预检模块，按现行固定版本发布流程覆盖现存节点、两槽未来
   启动模板和业务 overlay 的准确 hash。既有打包描述符是旧版本凭据，不能只改其
   hash 或复用旧 PASS；保留其他模块前像。数据库授权不需要重启，但运行预检模块
   的更新必须按当前节点排空/登记规则实施。
5. 先用专用合成批次验证受限身份从创建子 run 到成果、终态与结算，再核对客户
   原批次 `95ec50dd-f532-412c-ba4f-94c5ab421960` 和
   `7af6d70e-8a40-4efa-8aca-66a5b1cfbf52` 的实时状态、run/attempt、账务和输入
   版本。日志中的 252 子项是当时的受阻数量，不是模型失败次数或当前状态保证。
   若仍符合暂停且未创建 run 的前像，获授权后通过正常 resume 操作续跑原批次，
   不复制批次、不重投客户材料、不删历史错误。

回滚先停止新增领取并排空，恢复本次预检模块/模板前像。若确需撤销新增读/写列授权，
仅撤销本次四组前像确证不存在的授权，并保留其他既有授权；撤销会重现原故障，
不能在运行中的正常底稿路径下直接操作。不能修改已结算账务或已完成成果。

## 开发验证边界

`managed-database-permissions.pg.test.ts` 使用捕获的受限 ACL，验证缺项拒绝及
幂等授权后的最小权限。`workpaper-progressive.pg.test.ts` 从正常 API 建批次，
由受限 worker 创建子 run，经过真实 PostgreSQL 触发器及队列/成果/结算函数；
Word 和供应商结果是 synthetic，存储为测试内存对象，不代表真实模型或生产官网验收。

代码完成与上线、用户验收分别记录。此修复不覆盖独立的助手消息权限 #1545、
官网出口 #1544 或模型生成质量。

## 原批次只读前像

2026-11-17 22:08:26（北京时间）复核：两批均为 paused/revision=2，分别
4/248 项，child_runs=0、attempts=0。该快照只证明当时尚未进入生成；发布者
仍需在实际恢复前再次核对。未修改两批次、任务输入或账务。
