# #1385 模型名额等待期间停止动态计费

用户于2026-11-15确认：等待平台处理名额不收费，恢复后继续计费；本次修复不追溯改动历史账本。关联 #684 的有效工作时间规则。

## 实现

新增迁移 `0182_model_wait_billing.sql`，`bb_run_model_activity` 按每次请求 UUID、owner/run/job 和当前 lease token 保存 waiting/active/abandoned。这是计费活动投影，不替代共享模型许可，不变更任务状态或执行阶段。

`CodexDurableJournal` 在调用容量预算前登记 waiting，因此覆盖本进程 enter 队列与共享 PostgreSQL 队列。取得名额后登记 active；进程退出及结果处理结束后释放。即使账务记录失败也仍尝试释放真实许可；已有结果直接复用时不会创建新的等待请求。

状态转换和原有计费函数共用 run→job 锁，先采样旧区间，再更新活动，最后开启或冻结新时钟。有 waiting/abandoned 且没有 active 时将计费 lease_until 置空；恢复时从新的数据库时间开始，不追补排队时间。同一任务有任一 active 时继续原有效时间计费，不因其他并行请求等待而整单免费。

等待失败/取消后保留 abandoned 冻结标记，避免异常处理尚未完成就重开计时；其他 active 请求不能删除它。明确开始新执行阶段才清理该标记，新 claim 清理旧租约记录，终态清理全部活动记录。迟到旧租约回调无权修改新租约。

原计费公式、检查点比例、上限、暂停/取消/失败/交付结算政策保持。固定报价不因排队增加价格，未改共享四路或0181托管执行容量策略。

## 界面与契约

`AuthoringProgress` 在 `packages/contracts` 中新增可选 `model_waiting`；服务端仅对当前有效租约、无活动调用且确实在等待时返回true。页面显示“正在等待模型处理名额”“等待期间积分不增加”，原暂停、余额耗尽与终态优先。未改 run.state/stage 或复用初始队列的 queue_ahead。

原型 `product-prototype/public/authoring-live-progress.html`，实现 `apps/web/src/authoring-progress.ts`，基线 `1c35cc25`。本轮用户已确认上述等待体验；仅增加该状态，不变更布局或导航。

## 验证与交付

测试与固定版本将在完成后补充。真实API、PostgreSQL、任务租约、模型容量和账本使用合成材料/积分；容量回归不调用真实模型。浏览器夹具只能证明对应UI和请求行为，不能替代后端账本回归。

追加表不重写旧任务、价格或账本。迁移后旧二进制可读取原表，但旧 worker 不执行本修复，不能把混用新旧 worker 称为修复已生效。集成环境须协调 API、worker 和 web；本批未部署生产，最终统一验收待办。
