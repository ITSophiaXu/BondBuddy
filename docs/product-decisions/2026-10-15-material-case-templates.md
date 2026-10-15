# 2026-10-15 案例模板与新增材料

用户要求将提供的案例结构、标题、字体等固化为知识模板，并在材料生成中增加申请书、启用推荐函。本决定扩展此前首发四种材料的范围。

新增 `application`（沪深普通私募申请书）和 `recommendation`（交易商协会 PPN/MTN 推荐函）。公开市场及品种枚举继续复用 contracts；本功能适用范围由 `m4DocumentScopeSupported` 定义。详细资产与缺口见 [模板目录](../../knowledge/material-drafting/2026-10-15/README.md)。

材料工作区保留既有导航、材料卡、来源募集书、补充资料、要求和生成按钮；新增两张可选卡，按类型显示市场、品种及案例版式。BondBuddy 对话助手支持同一材料类型和市场品种，任务确认卡继续通过原有输入、报价及执行路径提交。当前费用沿用每份材料 4500 积分及已有动态扣费规则，不新增申请书按成本计费费率。

本批提供 11 个版式变体（包含用户随后补充的可读上交所主承销商核查意见），按精确范围调用，任务提交时固定模板完整字节和 hash。案例版式不承载项目事实；生成正文及独立说明时，继续保留原始资料、缺项与未确认事项。材料模板不改变法规库的审批状态，也不把已完成工程验证视为行业签认。

本批变更是开发交付。原型补充页为 `product-prototype/public/material-case-templates.html`，原页面依据为基线 `207d0b7` 中的 `material-studio.js`；实际页面为 `apps/web/src/material-workspace.ts`。截图和范围说明见 `apps/web/test-evidence/case-templates-20261015/README.md`。本地集成、用户验收和生产部署由对应专用 chat 按当前分工推进。
