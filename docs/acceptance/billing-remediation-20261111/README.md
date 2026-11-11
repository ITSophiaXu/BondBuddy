# 积分修复界面与原型核对证据

取证日期：2026-11-11。取证时实现基线 `f0b8817938c20a91e7b0c86429f80e7e9ac98215` 加当时未提交修复；取证时未提交或发布。后续提交及合并以主执行记录和 PR 为准。

10 张 PNG 均使用 Microsoft Edge headless、1440 × 960、DPR 1。原型从仓库文件启动只读静态服务；实现通过既有 Vite 装载真实组件和现有生产 CSS，在独立临时 HTML 宿主渲染合成资料。未改产品源文件、未连接生产、未调用真实支付或网站查询。图中的边距容器和“合成视觉取证”说明属于取证宿主，不是新增产品界面。

仓库没有年度退款表单、诚信完整名单及 pending 异常态、`billing_reconcile` 的逐状态原型。本记录引用最接近的原型，明确记录差异；不能据此声称这些状态与原型像素一致。修复沿用现有表单、名单、状态卡组件，不新增页面布局。

| 核对项 | 最接近的原型与已核验最后提交 | 当前实现及核对结果 |
| --- | --- | --- |
| 年度整期现金退款 | `product-prototype/public/account-credits.html?subscription=1&cycle=annual`；HTML：`172b6a4f44ebef1389ccd0d5bea205c92bbbc397`；`subscription-account-prototype.js`：`0e245e175f8a2953626eb11d422e939158421c96` | 原型显示密集年付 ¥10,789.20 和年度规则，但没有退款输入。真实 `CommerceRefunds` 在年度退款资格下，原单金额、实付、可申请额及只读输入均显示完整 ¥10,789.20；未被旧 ¥10,000 上限截断。保留现有退款组件布局。 |
| 五主体限制及错误恢复 | `product-prototype/public/integrity-notes.html`，`d93b5e14813bbf82cb5375991c0f984c773b4bda` | 原型仅有说明文本框，没有完整工作区。真实 `IntegrityWorkspace` 沿用名单、范围、说明及底稿区。已有五主体时点击添加，行数仍为五，现有状态区显示“每轮最多 5 个对象。”。 |
| 旧收费请求恢复 | 同上，无 pending 原型 | 合成旧 numeric 5000 请求保留原金额和请求键。渲染后 POST 为 0；只有点击“确认重试原核查”才发送一次原请求；合成 API 返回 `BILLING_REQUEST_REJECTED` 后 pending 消失、原名单说明保留、编辑恢复，不自动另建任务。当前服务价格夹具使用新规则；原 pending 保持历史 5000，未被改价。 |
| 账务核对暂停 | `product-prototype/public/task-results.html`，`06bea6118605c665b9038b78a01734cf2ef7fed7` | 原型是任务列表，没有该异常态。真实 `authoringStatus` + `taskProgress` 以合成 `paused/billing_reconcile` 渲染“正在核对积分账务，任务已暂停”，保留进度阶段；没有显示成功或要求充值。此图是独立生产组件展示，不是完整项目页面验收。 |

## 同尺寸截图

| 主题 | 原型截图 | 实现截图 |
| --- | --- | --- |
| 年度金额 | [年度套餐原型](./prototype-annual-account-1440x960.png) | [年度退款金额](./implementation-annual-refund-1440x960.png) |
| 五主体 | [说明区原型](./prototype-integrity-notes-1440x960.png) | [五主体名单](./implementation-integrity-five-subjects-1440x960.png)、[超限反馈](./implementation-integrity-limit-feedback-1440x960.png) |
| 原请求恢复 | 无对应异常态 | [待确认原请求](./implementation-integrity-pending-before-1440x960.png)、[持久拒绝后恢复编辑](./implementation-integrity-pending-rejected-1440x960.png)、[拒绝反馈](./implementation-integrity-rejected-feedback-1440x960.png) |
| 账务核对 | [任务列表原型](./prototype-task-results-1440x960.png) | [账务核对暂停](./implementation-billing-reconcile-1440x960.png) |

已逐张视觉检查：金额和提示可见，没有文字叠压；五主体名单较长，因此分别保留顶部和状态区两张同尺寸视图。年度原型页左上 logo 在仓库原型资源下显示为未加载，占位原样保留，没有修改原型来制造一致。

可重现脚本：[capture-ui-evidence.mjs](./capture-ui-evidence.mjs)。结构化结果：[observations.json](./observations.json)。截图脚本断言金额、只读状态、五主体行数、超限文案、0 次自动提交、1 次明确重试、持久拒绝后解锁及账务暂停文案；这些组件截图不能替代数据库和完整浏览器协议回归。
## 实际看图观察

以上 PNG 已用 `view_image` 实际打开检查，PNG 头逐一验证为 1440 × 960（7 张实现图、3 张原型图，共 10 张）。

- 年度退款：五个金额块与只读金额输入处于同一个现有面板内；¥10,789.20 和 10789.20 完整，核对申请按钮可见。
- 五主体：顶部计数为 5，名单行结构、添加按钮和注册地/范围控件沿用现有样式。名单超过一屏，底部另截图显示“每轮最多 5 个对象。”及新规则预估 2,425 积分，没有叠字。
- 原 pending：黄色原请求确认卡显示历史 5,000 积分；名单控件禁用；该图不包含后台是否收据存在的视觉推断，0 次自动提交由脚本断言。
- 持久拒绝后：确认卡消失，名单控件恢复正常；底部另外保留“上次请求未受理，已结束该申请。”和当前 2,085 积分预估图，原核查说明仍在。该预估来自当前规则的合成一主体/一网站范围，并没有改写旧 pending 的 5,000 金额。
- 账务核对：现有五阶段进度条保留，第三阶段高亮，标题清楚显示暂停及核对账务；没有成功标识或充值入口。
- 原型：年度卡内 ¥10,789.20 可见；诚信原型只包含说明区；任务原型只有项目列表。原型缺失上述状态，故这些图用于说明现有风格与行为边界，不能构成逐状态像素一致证据。
