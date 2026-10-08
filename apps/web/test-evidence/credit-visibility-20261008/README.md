# 积分余额与任务费用：界面对照

依据：用户 2026-10-08 要求；#41、#37、#361。原基线 develop `09fe96a3ce16487cc8951982dbf0a50671da7097`；本次原型补充和实现 `e45acdb50ee4096da438bf396d67dc8b414aa046`。

原型源：`product-prototype/public/credit-visibility.html`。仅新增用户明确要求的常驻积分、执行前报价提示和任务费用状态，保留已迁移页面、账号入口、材料和要求编辑流程。原型用精简的合成项目演示变更区域；实现仍呈现真实 API 支持的完整表单和任务事件。没有新问答页、积分流水页或计价规则。

| 状态 | 原型 | 实现 | 核对 |
|---|---|---|---|
| 报价（1440×960） | [原型](prototype-quote.png) | [实现](implementation-quote.png) | 所需／可用／预留后积分，确认按钮，左下常驻余额；实现滚到原材料页开始区 |
| 编制（1440×960） | [原型](prototype-running.png) | [实现](implementation-running.png) | 预留积分、可用余额、本轮账务状态；实现保留真实进度及任务操作 |
| 窄屏（390×844） | [原型](prototype-mobile.png) | [实现](implementation-mobile.png) | 折叠菜单后顶部余额持续可见；实现为长表单滚动场景 |

所有金额、名称、HTTP 响应均为 synthetic，未使用客户项目截图。差异为当前用户授权的余额卡／费用文案；其余框架沿现有原型，无需另设入口。

验证环境：Windows，Node 22+，Edge/Playwright，Vite 5192。

- 全仓 build 通过；最终前端 build 通过。已有大 bundle 提示，非构建错误。
- `npm run check:contracts`：167 公共／12 内部样例、4 生命周期样例及 29 OCR＋11 归属检查通过。
- `npm run test:unit -w @bondbuddy/web`：83/83。
- 浏览器 `account.spec.ts`＋`project-execution.spec.ts`：首轮 52/55；3 条旧 generation 测试缺少现有 `/m4/topics` API fixture，补充空 topics 后定向 3/3 通过，没有修改路由或跳过断言。
- 最终定向复验包含余额 0／异常／恢复／定时刷新／退出清理、桌面固定／低高度／手机、报价不执行、预留／结算／释放／读取失败重试、试用提示及旧 generation，共 6/6；另加延迟账务请求遇到任务终态的竞态 1/1。该竞态初次断言使用了错误的已有终态标题，改为真实“文档已生成，可下载”后通过。
- 共覆盖 56 个不同浏览器场景（按上述分次结果计）。原有报价调价重确认、积分不足充值返回、幂等、切换账号和材料版本边界保留。
- 线上收费开关／价格配置核查仅为只读。未发起真实支付、真实模型编制、原账号消费或用户内容验收；最终统一验收待办由原 Issue 跟踪。
