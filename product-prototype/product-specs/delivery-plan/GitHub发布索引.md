# GitHub 任务入口

> 本轮M4/M5拟拆分，尚未更新远端milestone／正文／标题。M4-04／05／06原#60／61／62拟改归M5，身份不变；新M5-08～12暂无GitHub编号。以[阶段决定](../../../docs/product-decisions/2026-10-06-m4-m5-priority-split.md)为准，旧记录不代表首发范围。

> 2026-10-06 M4 本地review：下面M4标题为拟更新稿，链接／issue身份沿用历史登记；未重新核验或修改远端。M4跟踪#4、子任务#57～#68，当前GitHub正文／状态不代表本稿已发布。新交互／费用按[当前M4决定](../../../docs/product-decisions/2026-10-06-m4-agent-workspace.md)，旧M3段落保留历史记录。

仓库：[ITSophiaXu/BondBuddy](https://github.com/ITSophiaXu/BondBuddy)

历史发布时已读取 GitHub 核对标题、标签、里程碑、正文和父子关系；该记录不表示后续范围修改已发布或实现。本文保留链接，认领与完成状态以 GitHub 为准。

2026-10-04 当前 M3 为 #47／#48／#49／#55／#145／#56／#537／#538 八项，交互与 A01–A22 见[联动工作区决定](../../../docs/product-decisions/2026-10-04-review-assistant-linked-workspace.md)。常规操作无需聊天文本即可通过按钮完成，桌面大于 900px 右侧助手常驻、小于或等于 900px 唯一抽屉；快捷／对话统一任务时间线，真实阶段安全摘要、双向结果定位和历史回看保持，明确采纳提议后绑定不可变输入再执行。完整复核无差异来源报告，讨论引用另存，版本记录归工作台。本次无用户报价、余额校验、充值、冻结、扣费或结算，保留真实 usage／内部成本。#77／#78 和 #50／#52／#53／#54 移出 M3，#51 独立检索服务不再计划；M2 账务与 M4 独立 QA 均非 M3 前置。

| 阶段 | 里程碑 | 跟踪 issue |
|---|---|---|
| M1 | [M1 · 网页版注册/登录与募集书更新上线](https://github.com/ITSophiaXu/BondBuddy/milestone/1) | [#1](https://github.com/ITSophiaXu/BondBuddy/issues/1) |
| M2 | [M2 · 积分与付费功能上线](https://github.com/ITSophiaXu/BondBuddy/milestone/2) | [#2](https://github.com/ITSophiaXu/BondBuddy/issues/2) |
| M3 | [M3 · 募集书复核与结果修订上线](https://github.com/ITSophiaXu/BondBuddy/milestone/3) | [#3](https://github.com/ITSophiaXu/BondBuddy/issues/3) |
| M4 | [M4 · 材料与问答核心闭环上线（立项＋普通私募摘要，Codex CLI）](https://github.com/ITSophiaXu/BondBuddy/milestone/4) | [#4](https://github.com/ITSophiaXu/BondBuddy/issues/4) |
| M5 | [M5 · 材料与助手扩展及 Windows 交付](https://github.com/ITSophiaXu/BondBuddy/milestone/5) | [#5](https://github.com/ITSophiaXu/BondBuddy/issues/5) |

| 任务 | Issue |
|---|---|
| M1-01 明确 Web 优先架构、数据生命周期与公共接口 | [#6](https://github.com/ITSophiaXu/BondBuddy/issues/6) |
| M1-02 接入真实手机验证码注册、登录与 Web 会话 | [#7](https://github.com/ITSophiaXu/BondBuddy/issues/7) |
| M1-03 实现账号设置、找回、会话管理和注销 | [#9](https://github.com/ITSophiaXu/BondBuddy/issues/9) |
| M1-04 建立项目、材料、任务、成果版本与账号隔离 API | [#8](https://github.com/ITSophiaXu/BondBuddy/issues/8) |
| M1-05 交付首页、项目列表、搜索与草稿恢复 | [#10](https://github.com/ITSophiaXu/BondBuddy/issues/10) |
| M1-06 完成更新项目表单与发行市场／发行方式联动 | [#11](https://github.com/ITSophiaXu/BondBuddy/issues/11) |
| M1-07 实现材料固定分区、真实上传进度和失败重试 | [#12](https://github.com/ITSophiaXu/BondBuddy/issues/12) |
| M1-08 实现 Word/PDF/表格解析与可追溯原文锚点 | [#13](https://github.com/ITSophiaXu/BondBuddy/issues/13) |
| M1-09 接入扫描 PDF/图片 OCR 与不确定数字确认 | [#14](https://github.com/ITSophiaXu/BondBuddy/issues/14) |
| M1-10 建立项目事实、来源冲突与解析缓存 | [#15](https://github.com/ITSophiaXu/BondBuddy/issues/15) |
| M1-11 验证 Codex 框架调用 DeepSeek 的生产接入 | [#16](https://github.com/ITSophiaXu/BondBuddy/issues/16) |
| M1-12 实现后台任务队列、进度、取消和检查点恢复 | [#17](https://github.com/ITSophiaXu/BondBuddy/issues/17) |
| M1-13 实现更新项目右侧多轮讨论与补材料继续 | [#18](https://github.com/ITSophiaXu/BondBuddy/issues/18) |
| M1-14 建立规则包版本、适用性与能力发布机制 | [#19](https://github.com/ITSophiaXu/BondBuddy/issues/19) |
| M1-15 补齐并验收上交所普通私募公司债规则与章节模板 | [#20](https://github.com/ITSophiaXu/BondBuddy/issues/20) |
| M1-16 补齐并验收上交所小公募公司债规则与章节模板 | [#21](https://github.com/ITSophiaXu/BondBuddy/issues/21) |
| M1-17 补齐并验收上交所大公募公司债规则与章节模板 | [#22](https://github.com/ITSophiaXu/BondBuddy/issues/22) |
| M1-18 补齐并验收深交所普通私募公司债规则与章节模板 | [#23](https://github.com/ITSophiaXu/BondBuddy/issues/23) |
| M1-19 补齐并验收深交所小公募公司债规则与章节模板 | [#24](https://github.com/ITSophiaXu/BondBuddy/issues/24) |
| M1-20 补齐并验收深交所大公募公司债规则与章节模板 | [#25](https://github.com/ITSophiaXu/BondBuddy/issues/25) |
| M1-21 补齐并验收PPN 定向债务融资工具规则与章节模板 | [#26](https://github.com/ITSophiaXu/BondBuddy/issues/26) |
| M1-22 补齐并验收MTN 中期票据规则与章节模板 | [#27](https://github.com/ITSophiaXu/BondBuddy/issues/27) |
| M1-23 补齐并验收CP 短期融资券规则与章节模板 | [#28](https://github.com/ITSophiaXu/BondBuddy/issues/28) |
| M1-24 补齐并验收SCP 超短期融资券规则与章节模板 | [#29](https://github.com/ITSophiaXu/BondBuddy/issues/29) |
| M1-25 补齐并验收DFI 储架发行规则与章节模板 | [#30](https://github.com/ITSophiaXu/BondBuddy/issues/30) |
| M1-31 上传后识别历史募集书的市场、发行方式和报告期，形成更新难度依据 | [#76](https://github.com/ITSophiaXu/BondBuddy/issues/76) |
| M1-26 基于本发行人历史原文更新全文并形成可追溯修订 | [#31](https://github.com/ITSophiaXu/BondBuddy/issues/31) |
| M1-27 实现跨市场/品种和多档安排的全文联动更新 | [#32](https://github.com/ITSophiaXu/BondBuddy/issues/32) |
| M1-32 建设后台募集书库、分类索引与首批可用参考数据（移出 M3，后续待排期） | [#77](https://github.com/ITSophiaXu/BondBuddy/issues/77) |
| M1-33 实现后台募集书库的持续增量更新、审核与版本退役（移出 M3，后续待排期） | [#78](https://github.com/ITSophiaXu/BondBuddy/issues/78) |
| M1-28 无历史稿时按前三大业务自动匹配参考稿并编制新稿 | [#33](https://github.com/ITSophiaXu/BondBuddy/issues/33) |
| M1-29 交付基于历史原文的 Word 修订版或无历史稿新稿 | [#34](https://github.com/ITSophiaXu/BondBuddy/issues/34) |
| M1-34 上线前交付统一用户行为、Prompt、Job、Token 与错误日志 | [#79](https://github.com/ITSophiaXu/BondBuddy/issues/79) |
| M1-30 完成 Web 更新功能上线验收、部署与运行保障 | [#35](https://github.com/ITSophiaXu/BondBuddy/issues/35) |
| M2-01 实现平台积分账本、批次和并发冻结 | [#36](https://github.com/ITSophiaXu/BondBuddy/issues/36) |
| M2-02 实现按真实工作量的分类、系数与冻结估算 | [#37](https://github.com/ITSophiaXu/BondBuddy/issues/37) |
| M2-03 将 M1 真实调用日志接入计费归因与外部服务成本计量 | [#38](https://github.com/ITSophiaXu/BondBuddy/issues/38) |
| M2-04 将更新任务接入一键冻结、结算与失败释放 | [#39](https://github.com/ITSophiaXu/BondBuddy/issues/39) |
| M2-05 接入真实充值订单与支付渠道 | [#40](https://github.com/ITSophiaXu/BondBuddy/issues/40) |
| M2-06 交付钱包、充值、流水、余额不足和费用结果页面 | [#41](https://github.com/ITSophiaXu/BondBuddy/issues/41) |
| M2-07 实现退款、支付对账、纠错和发票申请 | [#42](https://github.com/ITSophiaXu/BondBuddy/issues/42) |
| M2-08 上线欢迎赠分与旧用户/旧权益迁移 | [#43](https://github.com/ITSophiaXu/BondBuddy/issues/43) |
| M2-09 实现邀请、每日活跃与活动风控 | [#44](https://github.com/ITSophiaXu/BondBuddy/issues/44) |
| M2-10 上线账务运营、价格条款与真实成本校准 | [#45](https://github.com/ITSophiaXu/BondBuddy/issues/45) |
| M2-11 完成积分支付上线及更新任务商业闭环验收 | [#46](https://github.com/ITSophiaXu/BondBuddy/issues/46) |
| M3-01 完成复核工作区、常驻项目助手与统一任务时间线 | [#47](https://github.com/ITSophiaXu/BondBuddy/issues/47) |
| M3-02 实现审计证据财务复核与确定性勾稽 | [#48](https://github.com/ITSophiaXu/BondBuddy/issues/48) |
| M3-03 实现市场合规、披露完整性和真实格式复核 | [#49](https://github.com/ITSophiaXu/BondBuddy/issues/49) |
| M3-04 建立公开数据适配、授权与主体匹配契约（移出 M3，后续可选） | [#50](https://github.com/ITSophiaXu/BondBuddy/issues/50) |
| M3-05 独立公开信息检索／来源快照服务（不再计划） | [#51](https://github.com/ITSophiaXu/BondBuddy/issues/51) |
| M3-06 完成启信宝真实授权接入及工商核验（移出 M3，后续可选） | [#52](https://github.com/ITSophiaXu/BondBuddy/issues/52) |
| M3-07 完成 Wind 真实授权接入及债券数据核验（移出 M3，后续可选） | [#53](https://github.com/ITSophiaXu/BondBuddy/issues/53) |
| M3-08 完成企业预警通真实授权接入及风险核验（移出 M3，后续可选） | [#54](https://github.com/ITSophiaXu/BondBuddy/issues/54) |
| M3-09 编排三维复核并导出有来源的问题报告与 Word 批注 | [#55](https://github.com/ITSophiaXu/BondBuddy/issues/55) |
| M3-11 实现复核结果驱动的修订计划与明确执行 | [#145](https://github.com/ITSophiaXu/BondBuddy/issues/145) |
| M3-10 完成复核与结果修订的集成及上线验收 | [#56](https://github.com/ITSophiaXu/BondBuddy/issues/56) |
| 统一任务与对话时间线投影、事件恢复契约（真实 GitHub 新任务，不新增旧发布 ID） | [#537](https://github.com/ITSophiaXu/BondBuddy/issues/537) |
| 问题级复核提议的明确采纳与执行来源绑定（真实 GitHub 新任务，不新增旧发布 ID） | [#538](https://github.com/ITSophiaXu/BondBuddy/issues/538) |
| M4-01 交付首批材料生成与问答合并工作区、按文种构建输入及成果联动（归M4） | [#57](https://github.com/ITSophiaXu/BondBuddy/issues/57) |
| M4-02 接入首发两文种模板、准确版次及私有隔离（归M4） | [#58](https://github.com/ITSophiaXu/BondBuddy/issues/58) |
| M4-03 实现普通私募立项报告与券商规则适配（归M4） | [#59](https://github.com/ITSophiaXu/BondBuddy/issues/59) |
| M4-04 实现主承销商核查意见模板（归M5） | [#60](https://github.com/ITSophiaXu/BondBuddy/issues/60) |
| M4-05 实现法律意见书模板和结论证据约束（归M5） | [#61](https://github.com/ITSophiaXu/BondBuddy/issues/61) |
| M4-06 实现推荐函模板及市场/用途适配（归M5） | [#62](https://github.com/ITSophiaXu/BondBuddy/issues/62) |
| M4-07 实现普通私募募集说明书摘要（归M4） | [#63](https://github.com/ITSophiaXu/BondBuddy/issues/63) |
| M4-08 通过 Codex CLI 实现基础专业问答、材料解读和确定性财务计算（归M4） | [#64](https://github.com/ITSophiaXu/BondBuddy/issues/64) |
| M4-09 实现首批助手意图路由、任务草稿回填与既有按轮计费（归M4） | [#65](https://github.com/ITSophiaXu/BondBuddy/issues/65) |
| M4-10 交付常驻助手、首批真实任务时间线、成果标签与完整恢复（归M4） | [#66](https://github.com/ITSophiaXu/BondBuddy/issues/66) |
| M4-11 通过 Codex CLI 交付首批两文种、真实 Word 与准确底稿的全文迭代（归M4） | [#67](https://github.com/ITSophiaXu/BondBuddy/issues/67) |
| M4-12 完成立项、普通私募摘要、基础 QA 与真实 Codex CLI 的最终统一验收（归M4） | [#68](https://github.com/ITSophiaXu/BondBuddy/issues/68) |
| M5-01 确定桌面壳并建立安全的 Web 复用层（归M5） | [#69](https://github.com/ITSophiaXu/BondBuddy/issues/69) |
| M5-02 实现安装包、依赖分发、签名更新和回滚（归M5） | [#70](https://github.com/ITSophiaXu/BondBuddy/issues/70) |
| M5-03 实现本地账号隔离的项目、材料与缓存存储（归M5） | [#71](https://github.com/ITSophiaXu/BondBuddy/issues/71) |
| M5-04 实现本地任务执行、托盘、断网和崩溃恢复（归M5） | [#72](https://github.com/ITSophiaXu/BondBuddy/issues/72) |
| M5-05 统一 Web/Windows 账号、钱包和跨端任务边界（归M5） | [#73](https://github.com/ITSophiaXu/BondBuddy/issues/73) |
| M5-06 实现 Web 到本地迁移、项目备份和用户支持（归M5） | [#74](https://github.com/ITSophiaXu/BondBuddy/issues/74) |
| M5-07 完成 Windows 安装、升级、安全与已开放业务验收（归M5） | [#75](https://github.com/ITSophiaXu/BondBuddy/issues/75) |
| M5-08 扩展组合材料生成与准确章节/段落改稿（M5） | 待发布，暂无GitHub编号 |
| M5-09 扩展专业 QA 的实时查询、法规适用检索及深度分析（M5） | 待发布，暂无GitHub编号 |
| M5-10 承接跨业务自动执行及可编辑 QA 成果（M5） | 待发布，暂无GitHub编号 |
| M5-11 完成扩展文种、专业 QA、组合与跨业务的统一验收（M5） | 待发布，暂无GitHub编号 |
| M5-12 扩展模板库管理、公募摘要及市场/机构适用范围（M5） | 待发布，暂无GitHub编号 |
