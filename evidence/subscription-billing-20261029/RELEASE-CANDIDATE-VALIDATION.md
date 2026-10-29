# 订阅与自动扣费最终开发验证

2026-10-29。本记录对应 `feat/subscription-auto-billing-20261029` 在 `f85702bba5e4eeaf0e4edf52aba8f42974b0ed4b` 之后的开发增量，交付于草稿 [PR #814](https://github.com/ITSophiaXu/BondBuddy/pull/814)。这是本地工程验证，未部署、未开启生产收费、未进行真实商户扣款或新一轮 DeepSeek 调用。

## 本次交付

- 明确业务请求后自动锁范围、预留、执行与交付结算；失败释放，付款恢复和重试沿用原意图。
- 可选月订阅加永久充值；独立全面复核按两次向上取整公式加入第12项，27,195积分，标价271.95元。规划成本不是模型实测成本。
- 12项成本/价格版本管理、独立权限、任务质量退款、历史订阅订单详情；保留原价格、原lot、原实付对价和期限。
- 默认十进制int64字符串协议、精确账本及页面运算；旧协议仅用于精确读取和原请求重放。月度事实报告区分预收、兑付对价、质量返还、现金退款与到期余额。
- 钱包/商户持久隔离、SQL与API资金写入保护、受控投影修复和独立恢复；异常后的原单查询、取消和核实关单仍可进行。
- 普通关联文件按份交付和结算；失败项保留原价重试。已付同版本检查复用原有效成果，混合批次只执行新文件，不产生零价重复模型调用。

## 验证结果与证据

测试集合存在交集，父测试也可能计入Node测试执行数，不能把各行相加当作独立场景总数。所有用户、订单、支付回执、成本及模型建议均为synthetic；普通文件的Word生成、提取和交付使用真实本地处理链路。提交日志仅清理行尾空白和文件末尾多余空行，保留失败、告警、计数和诊断内容。

|验证|结果|证据|
|---|---|---|
|全工作区构建|通过，contracts/domain/rules/API/worker/Web全部完成|[构建日志](completion/final-workspace-build.log)|
|从空数据库执行全部迁移|通过，`template0`至0155；另验证既有0154模板升级0155|[全量迁移](completion/clean-migration-final.log)、[增量迁移](completion/migration-0155-final.log)|
|公共契约示例及计费契约|示例检查通过，独立计费契约12/12，0跳过|[契约日志](completion/contract-examples-final.log)|
|完整Web单元测试|930/930，0跳过|[Web日志](completion/final-web-unit.log)|
|API选定计费回归|初次109次执行中106通过、3个旧数字断言失败；修正为字符串协议后，原3项独立复验3/3通过。未表述为单次109/109全绿|[初次日志](completion/final-api-billing-regression.log)、[3项复验](completion/final-api-int64-fixtures.log)|
|资金隔离核心|8/8，0跳过|[隔离日志](SAFETY-ISOLATION-TESTS.log)|
|隔离接线及支付恢复|10/10，0跳过；含未配置渠道仍扫描、已隔离退款恢复与关单|[集成日志](completion/safety-integration-tests-final.log)|
|精确金额与经营事实|API/PG/Azurite52/52；月度/返还12/12；报告单元4/4；请求恢复11/11，均0跳过|[分组说明](completion/int64/README.md)|
|权限、价格管理、任务返还|管理API29次执行及契约12项通过；价格管理Edge7/7|[价格与权限](PRICE-ADMIN-AND-PERMISSIONS.md)|
|订阅、任务售后与历史订单|Edge31/31，历史原订单PG4/4；原对价返还与原订单恢复的详细证据另列|[任务售后](TASK-QUALITY-REFUNDS.md)、[历史订单](SUBSCRIPTION-ORDER-DETAIL.md)|
|普通逐份检查与0155复用|PG8/8（父1＋子7）、Edge8/8，均0跳过；最终全构建之后执行|[PG日志](completion/final-ordinary-file-worker-0155.log)、[浏览器日志](completion/task-refunds/browser-ordinary-file-check-batches.log)、[行为与截图](ORDINARY-FILE-CHECK-BATCHES.md)|

最后一组覆盖100份边界、101份拒绝、余额不足整批无副作用、并发同键只预留一次、真实Word单份交付、失败释放、原报价关闭后重试、两项目并发、连续两次零价复用不创建attempt/hold/模型调用、旧文件加新增文件仅执行新增项，以及原成果不可交付时拒绝免费执行。0155还经过独立只读审查，检查归属、完整输入及结果hash、未退款、原结算与本批零扣费绑定。

最终源文件和选定构建产物SHA-256见[验证时哈希](completion/final-source-and-build-hashes.json)。其中`base_commit`为本轮修改前版本，源文件哈希用于对应本次交付；构建产物本身不提交。Git空白检查通过。

## 已处理的验证失败

- API初次失败是3个测试仍期待旧number响应。修正HTTP断言、测试内部字符串拼接及BigInt差额后，只复验受影响文件；没有为满足测试放宽生产协议。
- 普通Word测试前两次使用了错误的Python变量，保留为历史诊断：`final-ordinary-file-worker.log`及`final-ordinary-file-worker-correct-runtime.log`。后者文件名并不代表配置已经正确。最终设置`BONDBUDDY_WORD_PYTHON`和`BONDBUDDY_TEST_PYTHON`，0155版本8/8通过；不得用旧失败日志代替最终结果。
- API测试的隔离转译目录一度导致相对资源路径找不到。最后3项在实际`apps/api/dist`依赖布局中复验通过，后续全工作区构建再次通过。
- 本轮文档复核将协议头统一为实际代码的`X-BB-Billing-Format`。

## 界面核对

账号、价格管理、任务售后和逐份检查均沿用对应原型入口，未新增普通用户工作导航。价格管理与账号说明保留桌面/手机截图；逐份检查最终截图为1440×960、390×960同尺寸原型/实现对照，已目视核对。批次成功/失败状态、逐份费用及失败重试入口一致，手机页面无横向溢出。静态原型的演示壳层与真实应用既有导航差异见各专项证据。

## 复验环境与范围

本机Windows、Node 26.13.0、Edge、本地隔离PostgreSQL及Azurite。最终数据库模板为从`template0`全量迁移的`bb_billing_complete_20261029_v3`；业务测试只在克隆中执行。数据库地址通过`BB_TEST_DATABASE_URL`注入，不连接生产。

复验普通文件链路使用`node --test --test-concurrency=1 apps/worker/dist/ordinary-file-check-batches.pg.test.js`，并配置上述Word Python变量。浏览器测试为`apps/web/tests/ordinary-file-check-batches.spec.ts`，配置`BB_E2E_BROWSER_CHANNEL=msedge`。公共构建命令为`npm run build`，契约命令为`npm run check:contracts`。

初轮Windows环境没有Docker CLI，未验证实际容器启动、发布镜像网络代理或生产Node运行时。继续验收时已找到本地BondBuddyM3 WSL内的隔离Docker，新增验证及实际发现的构建问题见下节，不能把初轮环境限制继续表述为本机没有可用容器。Vite保留约1.90MB主JS分块警告，构建成功；该性能优化不属于本次资金正确性验收。

## 继续目标后的补验

- 远端`172b6a4`的六个CI作业全部在启动前因GitHub账户账单/支出限制结束，`steps=[]`；未产生代码执行结果。[官方注释](completion/github-ci-172b6a4.json)保留原原因，没有调高账户支出限额或重写工作流。
- Desktop工作流对应八个文件在本地Edge补验75/75、无跳过。修正了5个把HTTP字符串缓存与领域数字夹具错层比较的断言，并新增首发/重放原始HTTP body相同的验证；详见[Desktop补验](DESKTOP-CI-LOCAL-VALIDATION.md)。
- M2剩余契约/API初轮55次执行中46通过、9失败；4个旧金额断言已迁移，5个缺失原样本的测试补齐原哈希材料后全部定向复验通过，没有宣称单次55/55。详见[M2补验](M2-CI-LOCAL-VALIDATION.md)。
- M4核心七个API文件初轮17项中13通过、4个旧金额断言失败；三个修改文件复验10/10，其余四文件7项初轮通过，17个独立测试均有通过证据。详见[M4补验](M4-CI-LOCAL-VALIDATION.md)。
- 当前部署静态检查器11/11通过。真实Docker Compose合成配置矩阵24/24按预期通过，WSL Node v24.14.0本地HTTPS代理四项探针通过；这些不是发布镜像或真实商户证据。
- 实际API镜像构建发现两处发布输入缺口：订阅/价管CSS未被复制；Web类型检查依赖的本地测试配置及声明未被复制。分别在`e277321`、`279f13a`修复，保留完整类型检查；动态发现实际CSS/测试脚本依赖的打包检查2/2通过。首次实际构建失败日志保留，修复后镜像结果以独立构建证据为准。
- `279f13a0f086ca1048b38058fcc94703763f8b5a`的原Dockerfile API目标构建成功，镜像`sha256:1ecf1c3b12966ffa986716dfdde891d1d31b25f2bcdfa20fde4061c780d421d2`、Node v22.23.4。精确Git白名单构建上下文不含客户样本、运行目录或真实密钥；全工作区构建在镜像内通过。以该不可变镜像运行的HTTPS CONNECT、代理故障不直连、NO_PROXY及正常证书验证探针4/4通过，见[镜像构建与探针](RELEASE-API-LOCAL-VALIDATION.md)。
- 同一镜像在无外网出口、无宿主端口的临时Docker内网完成空库156个迁移至0155，M2四个worker测试4/4、无跳过；只读挂载经哈希核实的合成CLI夹具。实际API入口启动后`/health`返回200，仅证明进程及路由启动。临时容器及网络按精确ID清理成功，见[隔离worker专项](M2-WORKER-IMAGE-VALIDATION.md)。未构建完整worker/OCR镜像，未验证生产商户或完整发布环境。

以上补验增加了工程证据，但未解除真实商户、完整标准成本源、专业成果验收、经营条件及远端CI账户问题。初轮哈希文件仍对应初轮验证时的源码；后续提交及镜像证据分别记录其精确版本，不混用为同一次验证。

`279f13a`镜像及其worker、代理证据保持历史版本绑定。随后自动扣费浏览器复验发现实际页面缺陷：QA与诚信核查直接引用了领域数字金额WorkspaceSchema，拒绝正常接口返回的字符串金额。`19241ef`将两处具名导出改为既有wire schema，保留严格校验；Web类型检查与构建通过。相同方式的其他运行时schema引用另经只读核对，未发现同类遗漏。最新生产代码因此已不同于`279f13a`，新镜像构建与浏览器结果分别记录，不用旧镜像代表修复版本。

自动扣费七个浏览器场景最终单轮7/7通过，0跳过，全部增加未处理页面异常断言。涵盖独立全面复核、QA、诚信核查、一致性维护、旧/新版报价恢复及补款沿原请求执行。原测试宽泛commerce路由误把账户响应写成目录，已拆成两个通过schema校验的确切mock；恢复入口使用当前公开读取方法，保留首发/重放原始HTTP body逐字相等、无额外任务/支付断言。最初页面打不开、旧恢复fixture及错误mock的失败证据全部保留，见[自动扣费定向验收](completion/AUTOMATIC-TASK-BILLING-VERIFICATION.md)。

最终测试夹具调整之后，Web源码与当前全部E2E TypeScript检查再次通过，见[最终类型检查](completion/automatic-task-final-typecheck.log)；页面schema修复后的Web产物构建见[构建日志](completion/workspace-wire-web-build.log)。

修复源码`19241ef12ef0289468ec1cb9c72b653b014160ec`已重新完成原Dockerfile API目标构建：镜像`sha256:854478de05dc26f5c91c51470dbe76ac129e87d0579f0e3700c325c1dd326cda`，Node v22.23.4，运行时及OCI源码标识一致。全工作区编译与网页生产构建通过，身份探针仅运行于无网络、只读容器；临时容器已清理，完整前后既有资源清单一致。详见[修复后镜像](RELEASE-API-19241ef12ef0-VALIDATION.md)。该版本之后只修改测试夹具、断言和文档/证据；未重新运行旧镜像的worker/代理用例，也不把旧运行结果绑定到新镜像。

## 发布及经营边界

收费开关默认关闭。升级顺序、停旧worker、同步API/worker/网页、独立权限及回退见[升级手册](../../apps/api/BILLING-UPGRADE-RUNBOOK.md)。真实微信/支付宝商户安全配置、正式支付及原路退款验收、签约代扣适配器与专业成果质量仍待完成；现有适配器提供单期订阅及手动续期，不宣称真实自动续费可用。

原11项完整标准成本源尚缺，不能发布缺源的新成本价版。沿用用户已认可预算，24个月不含支付费/税预算304.46万元，其中45.62万元历史管理回收在税后单列；基准税后经营净利约-24.82万元，回收后约-70.44万元。预收款及过期积分没有计入任务收入，未为了盈利倒推用户数。此开发交付并未证明公司达到60%净利润，真实用户理解、购买、复购和单位成本仍需实际数据验证。
