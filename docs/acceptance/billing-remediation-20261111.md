# 积分计价、扣费与任务失败修复执行记录

日期：2026-11-11。基线：`f0b8817938c20a91e7b0c86429f80e7e9ac98215`（develop）。本记录承接《积分计价与扣费排查报告》《诚信核查积分专项审核报告》《计费任务失败-case台账》及其合并修复计划。用户已授权执行修复、退役旧计价报价，并设计新的诚信核查标准。

代码完成，尚未部署，待统一发布。测试使用 Windows、Node.js、独立 PostgreSQL、Microsoft Edge、合成账户/材料/查询与支付响应；Python Word 生成及私有字节 readback 为真实本地执行。没有访问或修改生产账本，没有真实商户退款或真实模型/官网收费验收。

## 修复与 case 对照

| 计划 / Issue | 原触发及问题 | 代码处理与验收要点 |
| --- | --- | --- |
| FIX01 / #997 | 预留100、实扣7，allocation为空时审计按100推算余额，误隔离 | 新扣费写每个lot实扣；旧记录只有不可变结算与计量证据一致才只读重建。审计、退款、现金对价和订阅报表共同读取实扣证据，unknown不冒充全扣或零扣。 |
| FIX01 / #998 | 质量退款或整单纠正按预留100返还，超过实扣7 | 项目和lot返还均以实际原扣及累计返还为上限；并发共用原账户锁，数据库拒绝超退；历史已超退只报告和隔离，不自动追扣。 |
| FIX02 / #999 | 全部官网HTTP500，没有成功查询仍可扣整轮 | JS与SQL要求原运行内持久化且验真的成功查询；官网明确零结果可成功，阻断、未查询和无凭据失败不得收费。全部失败释放原预留。 |
| FIX03 / #1000 | 钱包隔离后已生成Word无法结算，取消也回滚，运行永久running | 持久化billing_reconcile暂停和原终态成果；取消意图可记录但不绕开资金隔离。独立修复/解隔离及显式恢复后复用原Word或执行原取消；供应商未知先转provider_reconcile。 |
| FIX03 / #1001 | 私有超时修复复活已释放的付费任务，反复触发结算23514 | 原预留已释放或合同终态时拒绝重新排队；已获授权的delivery-only恢复继续允许。重复拒绝不再动账。 |
| FIX04 / #1002 | 有效文件包报价遇新价表发布，提交时重算子任务价格而失败 | 持久化owner/input/price/expiry报价，一次绑定批次。底稿与文档两个子入口均固定原版本；工作底稿包和混合包发布后按原价受理及重放均通过。 |
| FIX04 / #1003 | 批次已接受，排到子任务时普通报价超过7天而无法继续 | 普通过期报价继续拒绝；已有有效scope_acceptance的子任务核验本人、原manifest、金额、取消状态后按原合同执行。 |
| FIX05 / #1004 | ¥10,789.20年付整期退款被前端¥10,000上限截断 | 现金输入按服务端订单资格与精确分解析，年付全额可核对；积分单位仍单独验证。 |
| FIX05 / #1005 | 100元退款申请前先消费/冻结，拒绝后原intent锁死余款申请 | 原接受锁内确认收据，再提交持久化确定拒绝；只有专门拒绝码解除浏览器pending。断网及一般错误保留原键原金额。 |
| FIX06 / #1006 | 到期授权为pending/active/cancel_pending时续费错误没有确定拒绝收据 | 沿用持久订阅拒绝收据，原订单先重放；未受理请求不创建新订单。 |
| FIX06 / #1007 | 旧5000诚信pending受旧wire或新协议冲突阻挡，无法恢复 | 两种wire均先查原收据；确未接受才提交不可变拒绝。双向DB触发器阻止拒绝与迟到接受并存；刷新不会自动另建收费任务。 |
| FIX07 / #1008 | 浏览器允许100主体，服务端计价仅支持5主体 | 新名单API与界面统一每轮5主体，公共历史DTO保留旧记录可读。 |
| FIX07 / #1009 | 同样名单再次明确核查复用同一scope身份 | 每轮独立round_id参与输入与范围hash；同请求幂等，新轮新合同，同轮重新导出免费。旧有效v2/v3报价保留原受理条件。 |
| FIX08 / #1010 | 一题的计算步骤误当多题；分号独立问题反而漏判 | 单题包括计算过程及编号核对步骤；明确独立问题导向既有本人问题清单，不从文本自动拆收费单位。 |
| FIX09 / #1011（产品任务） | 网页范围变化仍整轮同价，旧规则继续发新报价 | 新v4商业价按基础2000+85×可执行主体/官网栏目组合，最高22738；按成功组合实扣。旧HTTP策略开关、人工/固定价CLI发布、本地legacy API/profile退役。 |

旧5000 worker门槛已由先前 #985 / PR #986 修复，不重复计算为本次新修复。

## 新标准与兼容边界

完整规则及设计理由见[诚信范围计价决定](../product-decisions/2026-11-11-integrity-scope-pricing.md)。例如1组合2085、49组合6165；49组合中成功2组合实扣2170、释放3995。分页、跳转、截图和重试不增加组合。C_plan保持unknown/null，该商业决定没有伪造成完整成本发布。

新报价保存不可变适用入口及查询词，参与scope hash，后续网站目录更新不能改写已接受范围。旧v2/v3、managed、已接受5000及付费订阅保价继续读取原合同。旧诚信报价缺少新轮身份时，“重新报价”明确导回核查页准备新轮，不生成无法执行的v4报价。

生产HTTP统一自动范围策略。显式旧策略只用于历史合同执行和Node测试夹具。保留历史价表、收据、审计和运营纠正；旧固定/人工报价CLI不能再发布新报价。本地 `/__legacy/api/v1/` 返回410；未来显式启动升级时先核验原实例idle，再停止本人实例的退役服务，保留其容器和私有卷；本次没有执行容器停止或升级。

## 自动化证据

所有PG套件通过 `isolatedTestDatabase()` 克隆已迁移模板，不在模板上直接执行测试写入。新增迁移0167、0168、0170—0174仅追加，未改已部署迁移。每条函数替换带精确anchor检查，前序不符即中止迁移。

最终业务源码完整构建 `npm run build` 通过；公共示例与契约 `npm run check:contracts` 通过；Web `npm run test:unit -w @bondbuddy/web` 为1121 passed / 0 failed / 0 skipped；本地升级与seccomp安全回归 `node --test scripts/local-prelaunch/upgrade.test.mjs scripts/local-prelaunch/seccomp.test.mjs` 为11 / 0 / 0，包含退役orphan的停止顺序和失败保护。

最终结果如下，批次之间有重叠和重跑，不相加冒充独立案例总数。日志随本记录归档，均为合成资料，无生产数据或凭证；归档仅清理行尾空白，原始输出保留在本地证据目录。

| 批次 | pass / fail / skip | 证据 |
| --- | --- | --- |
| 全仓构建 / 公共契约 | exit 0 / exit 0 | [build](./billing-remediation-20261111/build-verified.log)、[contracts](./billing-remediation-20261111/contracts-verified.log) |
| Web 单元 | 1121 / 0 / 0 | [日志](./billing-remediation-20261111/web-unit-final.log) |
| API 计费单元 | 45 / 0 / 0 | [日志](./billing-remediation-20261111/billing-unit-final.log) |
| 实扣、退款、安全审计与报表 | 49 / 0 / 0（38 顶层，含嵌套父 test） | [账本说明及精确命令](./billing-remediation-20261111/ledger-实扣与恢复验证记录.md)、[日志](./billing-remediation-20261111/ledger-actual-charge-final.log) |
| 订阅与 worker 超时恢复 | 14 / 0 / 0（含订阅父 test） | [日志](./billing-remediation-20261111/ledger-recovery-subscription-final.log) |
| 历史报价与扣费兼容 | 14 / 0 / 0 | [日志](./billing-remediation-20261111/historical-billing-final.log) |
| 退款、订阅最终补跑 | 21 / 0 / 0（20 独立业务案例） | [FIX05/FIX06 说明及命令](./billing-remediation-20261111/FIX05-FIX06-验证记录.md)、[日志](./billing-remediation-20261111/FIX05-FIX06-pg-final.log) |
| 诚信 v4 单元 / API PG / worker PG | 29 / 0 / 0；4 / 0 / 0；12 / 0 / 0 | [诚信说明及精确命令](./billing-remediation-20261111/诚信v4-验证记录.md) |
| 文件包、自动价格与商业主链路最终综合 | 39 / 0 / 0，75.4 秒 | [日志](./billing-remediation-20261111/root-integration-verified.log) |
| 本地退役与 seccomp | 11 / 0 / 0 | [日志](./billing-remediation-20261111/retirement-verified.log) |

综合回归最终命令：

```powershell
$env:BB_TEST_DATABASE_URL='postgresql://bondbuddy@127.0.0.1:55439/bb_billing_remediation_verified_20261111'
node --test --test-concurrency=2 apps/api/dist/automatic-pricing.test.js apps/api/dist/automatic-billing.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/file-generation.pg.test.js apps/api/dist/scope-standard-pricing.pg.test.js apps/api/dist/billing-price-admin.pg.test.js apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/commerce-economics.pg.test.js
```

完整构建为 `npm run build`，契约为 `npm run check:contracts`，Web 为 `npm run test:unit -w @bondbuddy/web`，本地安全回归为 `node --test scripts/local-prelaunch/upgrade.test.mjs scripts/local-prelaunch/seccomp.test.mjs`。PG 环境为 Windows 本机 127.0.0.1:55439，最终严格边界模板名为 `bb_billing_remediation_verified_20261111`；较早批次的模板及命令见各验证记录。Word 子进程使用本机 Python，官网和 provider 响应均为 synthetic。

首次文件包新回归暴露仅底稿包不应要求空的 document_quotes，已修复并在最终39项验证；较早综合回归的 economics fixture 缺必填参考稿，只补本人合成参考稿及原稿信息，原成本断言保留，最终49项及39项均通过。诚信新增保价 fixture 初跑用户名超过32字符，只缩短用户名后 API 4项全过；共享构建时序造成的旧 dist 导入失败也在统一构建及补跑中消除。失败日志保留在本地原始输出，最终通过以本表归档日志为准。

提交前校验 [95 个代码、配置和测试文件指纹](./billing-remediation-20261111/source-fingerprint.json)，全部与最后测试源码一致；它用于追溯本轮合成回归，不是正式发布质量凭据。`git diff --check` 通过。

浏览器已有22个不同案例通过，覆盖年度输入、旧numeric/string pending、明确重试、持久拒绝解锁与普通错误保留。使用现有生产组件的7张实现图和3张最接近原型图均为1440×960并逐张查看，见[界面核对及限制](./billing-remediation-20261111/README.md)。原型缺少完整异常态，记录不声称逐状态像素一致或完整页面用户验收；没有新增布局或页面步骤。

## 发布、回退与最终统一验收

- 迁移与contracts/API/worker/web必须来自同一准确提交；新v4不能由未识别v4的旧worker执行。统一发布先核验在途合同、排空或安全暂停，再应用迁移及更新服务，保留回滚与恢复记录。
- 回退保留新增表、不可变报价、拒绝及资金事件；不得删除迁移或把v4数据交给不兼容旧镜像。应停止新受理并使用识别v4的兼容版本恢复，或向前修复。
- 当前commit/tree的真实模型金样、真实官网成功/阻断、渠道退款与用户最终验收尚未执行，按仓库统一发布门禁单独完成。合成测试不能签发正式发布凭据。
- 历史生产误隔离/超退/卡住任务只形成盘点与纠正依据，没有批量改账、追扣或自动恢复。钱包仍隔离时，原有售后资格读取受资金写隔离保护；本轮主要解决既有成果暂停、取消与显式恢复。
- 本机没有Docker CLI，未执行Compose展开或真实容器升级；本地启动、停止及seccomp安全逻辑已通过11项单测，容器层验证列入统一发布检查。
