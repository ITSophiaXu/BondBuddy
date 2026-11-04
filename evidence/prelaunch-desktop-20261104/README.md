# 正式收费前桌面体验排查（2026-11-04）

状态：修复候选，未合并、未部署，真实充值及付费任务验收未完成。本文区分线上观察、隔离回归与发布资格；不能据此宣布收费上线验收通过。

范围为桌面端的任务可完成性、重复操作、误导提示、填写中断、恢复和下载。未新增手机端需求。实现和原型基线均为 `7f3c4ac77ef2128a5c9793bc31a20f2b8c84c9e5`；2026-11-04 再次 fetch 后 origin/develop 未变化。

产品修复提交：`ecfd757407a499026df487f2ab01486687ad860b`，后续下载范围/复核提示修复 `d7e0aa0e27a646fb6b4c90b72fda57501a53c613`，退款归月修复 `f0f7a6bba73a108869ab30ede74f7f0f5e7375c7`。最终根构建和契约检查覆盖上述全部源码；证据与验收矩阵另以文档提交登记。Draft PR [#875](https://github.com/ITSophiaXu/BondBuddy/pull/875)。

## 两类正式上线必过项

用户明确要求文件生成质量链与充值/计费/扣费链分别通过完整场景验收。对每项区分机械检查、真实组件、真实模型/资金与独立成果复核，缺项即未通过；这两类不能因本轮体验修复完成而自动放行。

1. 文件质量：原稿采用与准确版本、输入/hash/报告期、材料解析与来源、财务事实和缺项、章节完整性、格式/修订与清洁稿、成果下载及续改。详见 [quality/README.md](quality/README.md)。
2. 资金链：正式渠道充值、金额/商户/签名核对、幂等到账、报价/预留/结算、失败取消释放、并发与未知结果恢复、权益期限及退款。详见 [billing/launch-gates.md](billing/launch-gates.md)。

**文件质量的已确认代码阻碍：** 当前基线的 `apps/worker/src/file-authoring-delivery.test.ts` 明确断言带 `WORD_QUALITY_REJECTED` 的结果仍 deliver，且 `content_review=not_performed`。这种旧交付策略不能满足新的上线质量要求；修复在独立 Draft PR [#871](https://github.com/ITSophiaXu/BondBuddy/pull/871)，尚未合入。本轮没有复制或放宽该门禁。生产 worker 完整版本未核实，因此这是当前候选源码的确定缺口，不冒充已核实的生产运行行为。

## 已修复的八类问题

| 优先级 | 复现及用户影响 | 修复与证据 |
| --- | --- | --- |
| P1 | 无历史原稿首稿的双 Word 字节相同，被存储去重为同一 artifact；用户点击继续修改却被认定清洁版不合法，无法继续工作。 | 只对服务端新读取且 run/version/hash、Word 类型、available/passed、无基线及准确双稿引用全部匹配的首稿别名放行；准备及提交前均重新核对，输入变化仍阻止提交。见 task-flow。 |
| P1 | 下载元数据或成果字节长时间无响应，页面一直忙碌，用户无法重试或切换历史。 | 成果元数据和成果字节读取分别限定 120 秒，并取消流读取；即使 reader 忽略 abort 也释放调用方。原材料/M4 文件保留原有无额外总时限行为，避免中断慢网活跃传输；离页仍可取消。保留归属、同源、字节数和 SHA-256 校验，已保存成果无需重新生成。 |
| P1 | 服务端明确拒绝在有效订阅周期内开通新周期，浏览器却永久保留“结果未知”的付款意图；原 key 还可能在周期结束后变成新付款。 | 新增只读终态拒绝账本及公共错误；原 owner/key/hash 的拒绝持久化，刷新后可确认结束，再重新选择。已有订单、pending period 和 mandate 的原 key 恢复不被清除；legacy 请求也校验准确 hash。 |
| P1 | 未付款时选错金额或渠道，只有继续原单，无法安全改选。 | 复用已认证关单 API；只有服务端确认原单终态才允许重新选择。pending/unknown 保留原单；付款抢先成功时显示付款结果并只继续一次原任务。离开账号页后晚到的记录读取不会把用户导航覆盖回账号页。 |
| P1 | 渠道已确认 10 月退款成功，本地到 11 月才补记事件，月度现金流却把退款归到 11 月；扩展年付回归复现差额恰等于 489,020 分退款。 | 只读报表按准确 refund/owner 的认证 `provider_succeeded_at` 归月；真正跨月退款仍归退款成功月。缺日期显式保留未归月金额，月度退款总额与净现金流为 unknown。输出版本 exact-v2，钱包和退款流水 writer 不变；两渠道、上海月界、迟到及同号补证回归通过。原始失败保留，见 billing/launch-gates。 |
| P2 | 账号后台轮询替换表单 DOM，打断输入法组合、金额或说明填写；打开的计费 FAQ 自动收起。 | 继续读取后台状态，正在编辑控件或对话框时保留 DOM，并保持展开、焦点和选区。覆盖实际退款金额及质量说明 textarea。 |
| P2 | 问答、文件生成等空项目的“继续准备”跳到募集书更新，用户不确定应在哪继续。 | 按项目类型恢复 update/review/generation/qa 对应准备入口；不改变项目或提交任务。 |
| P2 | 新账号首次上传问题清单后误称从历史任务续答；复核仅因余额不足被拒绝，却还要求用户重查输入与范围。 | 新清单明确显示“已识别问题清单，尚未开始回答”，历史续答准确说明来源，首次上传不创建回答任务。复核的 `CREDITS_INSUFFICIENT` 只保留准确补款提示，不再拼无关的重查要求；其他输入拒绝仍提示核对。 |

任务流合成场景、实际命令和同尺寸对照见 [task-flow/README.md](task-flow/README.md)。账号/支付的实际命令、合成截图与视觉限制见 [billing/README.md](billing/README.md)。新增关单重选交互的原型偏离尚待产品确认，本文不代签。

## 线上实际走查

地址为 `https://bondbuddy.gululai.com`，桌面 viewport 1440×960。使用单独注册的测试账号并接受已获用户确认的协议；原业务账号与业务任务未修改。所有本轮上传内容均为标明 synthetic 的虚构数据。

- 已通过真实 UI 注册、创建项目、上传 DOCX/PDF、保存补充说明，并刷新核实材料版本及已保存说明恢复。空白输入框只是新说明编辑区，既有说明仍在列表中，无数据丢失。
- 已上传并采用合成募集书 V1，问题清单免费整理出三题，核对已有材料、保存本轮要求并从账号页返回恢复。
- 文件生成复用当前募集书，目录从默认 248 项缩为单份底稿（预计 3,458 积分），保存合成编制要求；尚未执行生成。
- “开始回答”因余额 0 明确阻止执行，保留原题、材料、要求及唯一待执行请求，提供充值后继续入口；当前真实任务消费 0 积分。
- 复核选择项目已有 V1 与保存要求，刷新后两者恢复；“开始复核”明确因余额不足未启动，账号页保留准确原复核请求和返回入口，记录区显示暂无消费或预留。该结果不证明充值成功后的实际恢复。新增现场截图留在本机 `outputs/prelaunch-desktop-20261104/live-review-recharge-unavailable.png`。
- 账号页显示“支付渠道暂未开放，暂不能开通订阅或充值”，订阅按钮禁用，充值区没有金额/渠道/提交控件。这是新用户无法完成付费任务的收费上线阻碍。
- 线上 FAQ 曾实测被轮询收起；既有成果 Word 只读下载成功。本轮不把该既有成果算作新账号的生成或付费交付证据。
- 观察到 Web 资源 `/assets/index-3I4fg0_u.js`、`/assets/index-CF0oSORG.css`；未核实 API/worker/egress 的完整部署版本，不能用 Web bundle 代替全服务版本。

实时截图及测试账号凭据保存在本机受控输出/忽略目录；凭据、原材料、生成成果、数据库运行目录不进入此 PR。

用户先允许最多 10,000 积分消费，后明确取消本次测试预算上限并要求完整验证充值。非现金赠分与真实充值不能互相代替；目前未执行任何运维发分、购买或订阅。真实充值验收应覆盖本人可操作的正式渠道订单、认证回调/查询、一次到账和原任务恢复；不能用伪支付、手工修改订单或在生产启用合成 provider 充当通过。

## 验证结果

| 检查 | 结果与边界 |
| --- | --- |
| 根目录 `npm run build` | 全部后续源码修复完成后再次通过；保留既有 Vite chunk 体积提示。 |
| 根目录 `npm run check:contracts` | 全部后续修复后再次通过：179 个合成样例、12 个内部库样例、4 个生命周期样例及其脚本测试。 |
| 任务/下载/付款意图单元 | 下载范围收窄后再次合并运行 69 passed，0 failed，0 skipped；包含材料/M4 的 150 秒分块读取及父级取消回归。 |
| `subscription-account.spec.ts` | 最终完整运行 49 passed，0 failed；包含轮询、关单、付款竞争、跨页及未知结果恢复，旧聚焦结果不重复累计。 |
| 任务执行、问答续答与任务结果三个浏览器套件 | 最终完整运行 117 passed，0 failed，1 skipped（既有 opt-in `M2 deferred charge prototype screenshots`，非功能测试失败）。均以 synthetic HTTP fixture 驱动真实 Edge 和前端；沿用套件中既有的小屏断言，没有新增手机端需求，不代表真实模型/支付调用。 |
| 隔离真实 Fastify/PostgreSQL 计费回归 | 36 passed，0 failed，0 skipped：billing-wire、billing-int64、subscriptions、annual subscriptions、subscription changes。专用端口 55434，已正常停止，未触生产数据库。 |
| 扩展资金链真实组件 | C34、R66、P64、V25、F18 各组修后全通过、无 skip；有重复/嵌套，不相加。V 原 22 pass/3 fail、F 先红 1 pass/2 fail 原样保留。真实 Fastify/隔离 PG/密码协议，渠道与模型合成；真实 CLI smoke 通过，专用 PG 已 smart-stop。 |
| 文件质量及各入口导出 | 原件 15/15；Windows Python 99 项 98 pass/1 权限语义 fail，Linux 对应完整小套件 8/8；多入口 Linux 导出 94/94；Node 52 pass/2 平台 skip，两个 symlink 安全项 Linux 原样 2/2 复验。worker 授权 opt-in 项和 HTTP/PG/Azurite 输入链 5/5 已补实跑。保留原失败/skip；各组重叠，不相加，非完整发布 gate。详见 quality。 |
| 复核计费与恢复定向浏览器 | 后续提示修改后 4 passed：桌面不足保留输入、缺价不免费执行、实际预留/扣费/释放展示、丢响应沿用原意图。Synthetic HTTP fixture，不代表本次新增真实充值或模型执行。 |
| 第二轮续改跨层 | subject `8df8b50`，7 passed/0 skip（父 test＋6 场景）：真实 Fastify routes/隔离 PG/queue 与编译 guard 验证同 ID 双稿、精确 input 引用、正常换稿和拒绝场景。app.inject 不经 TCP/Nginx/ApiClient/浏览器；认证、Word 与内存 Blob 为 synthetic。#871 质量拒绝、expiry 与真实模型整链未执行。见 quality。 |
| whitespace / 原始证据 | 源码及文档通过；原始失败 `component-price-coverage.tap` 与 `component-refund-facts-red.tap` 保留 Node 生成的 8 处缩进空行，完整 diff 检查会报告它们，未为绿灯清洗失败证据。此目录关闭文本换行转换，CRLF 是有效行尾；第二轮后 34 个证据文件 hash 与清单一致。 |

单元最终命令：

```powershell
npm exec tsc -- -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/authoring-continuation.test.js apps/web/dist-test/api.test.js apps/web/dist-test/artifact-download.test.js apps/web/dist-test/download-progress.test.js apps/web/dist-test/checkout-intent.test.js
```

浏览器最终命令（apps/web）：

```powershell
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_E2E_BASE_URL='http://127.0.0.1:5176'
npm exec playwright -- test tests/subscription-account.spec.ts --output .test-output/final-subscription
npm exec playwright -- test tests/project-execution.spec.ts tests/project-qa-continuation.spec.ts tests/task-results.spec.ts --output .test-output/final-task-flow
npm exec playwright -- test tests/review-workspace.spec.ts --grep 'paid review starts.*1440|enabled review never starts free|review task receipt displays|paid review response loss' --output ../../.local/playwright-final-outputs/review-checks
```

### CI 接线复核

对已推送 head `96dcce8eb44833938b23a242477cecccd40fcc1a` 的实际 workflow 核对发现：桌面 CI 会执行全部 Web unit，但其八个浏览器文件不包含本轮首稿、问答及账号恢复场景；固定积分 CI 会编译新报表，却不执行报表 unit/PG 回归。已保留原清单并追加四个浏览器套件、四条复核定向场景，以及订阅拒绝、退款归月和报表消费者的七个 API 测试文件。测试列表实读为桌面 255 项/12 文件，另复核定向 4 项；这只是配置/发现验证，实际通过状态以新 head 的 GitHub run 为准。原有 20/15 分钟上限、权限、隔离数据库和环境开关保持。

上述旧 head 的 [CLI review run](https://github.com/ITSophiaXu/BondBuddy/actions/runs/41776225273) 在构建原生沙箱时因 `npm ci` 的网络 `ECONNRESET` 失败，尚未进入该阶段后续测试；已保留失败链接，本机原日志在忽略目录。未通过改 Docker/模型版本或跳过沙箱处理。M4 core 的同 head run 已成功；其余及追加清单的新 head 检查需分别读回，不把旧 SHA 绿灯转移为新 SHA 通过。

## 迁移、分类和剩余验收

- 迁移 `0164_subscription_checkout_rejections.sql` 只新增拒绝表、复合主键、hash 约束和不可变 trigger；不改旧迁移。新增错误 `SUBSCRIPTION_CHECKOUT_REJECTED` 在 packages/contracts 唯一定义。
- 发布顺序必须先迁移、再 API/Web，并避免新旧 API 混跑。已有拒绝记录后，回退 API 必须仍保留拒绝查询守卫；旧 API 忽略拒绝表，不能仅因 schema additive 就判定可直接回退。
- 首稿续改涉及输入依据的传递影响，应保留分支待独立生成敏感路径验收；contracts、db 及相关 API 需逐文件确认。付款恢复分类为支付状态/契约/数据库迁移，不能当作纯展示修改。
- 本轮没有修改 worker、prompt、模型、解析、知识或费率。取消的是本轮测试预算限制，没有取消产品计费边界。
- 真实充值、真实模型回答/生成/复核/诚信核查、Word 专业质量及客户端兼容性仍未完成；不能由合成测试、已有成功文件或赠分替代。
- 真实渠道代码已有微信 Native 与支付宝 RSA2 page/wap 的创建、查单、关单和认证回调。账号当前空 providers 只能说明没有自助付款通路，不能判断未启用还是坏配置；旧 recharge-config 在新版模式下可能有意关闭，不单独作为结论。生产 API 工厂的 ready/disabled/invalid 预检未执行：现成密钥已定位，但目标 SSH 在远端协议/主机公钥出现前 reset；现有 Azure 登录不含已确认的目标订阅。未关闭主机校验、未改防火墙/商户配置、未生成伪支付。
- 遵守独立发布说明中的质量要求：提交 PR、合并、发布资格及部署结果分别记录；不伪造 #871 门禁或准确发布 SHA 凭据。本候选只交付 Draft PR，不自行合并或部署。
