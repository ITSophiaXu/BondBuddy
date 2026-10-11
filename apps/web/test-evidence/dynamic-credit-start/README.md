# 动态余额与同任务续跑验证

本次界面直接按用户 2026-10-11 的截图和要求实现，原型为 `product-prototype/public/authoring-dynamic-balance.html`；基于 develop `ffa249d0`，提交前同步原稿表单压缩改动。截图与本次 PR 源码一起保存；没有独立人工签认。原型省略既有导航和材料区，运行卡、充值弹窗、余额与恢复文案一致。

| 尺寸 / 状态 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 积分用完 | [原型](prototype-dynamic-exhausted-1440.png) | [实现](dynamic-exhausted-1440.png) |
| 390×844 积分用完 | [原型](prototype-dynamic-exhausted-390.png) | [实现](dynamic-exhausted-390.png) |
| 1440×960 到账继续 | [原型](prototype-dynamic-resumed-1440.png) | [实现](dynamic-resumed-1440.png) |
| 390×844 到账继续 | [原型](prototype-dynamic-resumed-390.png) | [实现](dynamic-resumed-390.png) |

环境：Windows、Node 24.19、Edge、本机独立 PostgreSQL 16，全部迁移成功应用。界面使用合成 HTTP 数据；API/worker 使用合成材料与私有存储替身。没有真实支付、真实模型或生产账本操作。

- 七个包的 TypeScript 构建和 Vite 生产构建通过；仅有既有包体大小提示。
- 公共契约：171 + 12 例子、4 个数据生命周期例子及 40 项契约测试通过。
- `project-execution.spec.ts` 完整回归 65/65 通过；最终余额事件同步后补跑 5 项，旧提示断言先报错，更新为本次新文案后定向通过。未把首次失败删除或计为通过。
- API/worker 定向测试 16 项通过，无跳过：动态扣费、v1/旧规则、计费与流水、复核价格、真实支付回调校验、公共事件投射、AI 状态、暂停检查点和 worker 接缝。后续补充“材料阻碍与积分同时耗尽”及“文件未齐不可收尾款”后，核心 5 项再次通过。
- 动态测试覆盖 0 积分拒绝、1 积分启动、并发扣款不透支、重复到账幂等、检查点复用、人工暂停不被到账覆盖、尾款不足保存双 Word、补款交付、平台失败退款和账本审计。
- 原型四个尺寸/状态组合无脚本错误和横向溢出，页面使用真实模态 dialog，支持稍后充值与键盘退出。

发布限制：本轮只读查询 Azure 现有管理命令仍为 Creating/Updating，executionState 与 exitCode 均无返回。未发布三端及 0104 迁移，未宣称线上验收。必须按产品决定协调 API、所有相关 worker、数据库和 web；不得仅发布前端。
