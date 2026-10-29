# 支付宝账单凭据与精确对账增量

2026-10-29。仅合成本地验证，无真实商户账单、扣款、退款或模型调用。

原规格要求微信和支付宝、`downloadStatements`及渠道日对账。此前只有微信账单实现；本轮补充支付宝验签下载与可恢复的证据记录，但没有官方CSV字段契约和真实商户账单，因此不宣称支付宝对账已完成。

## 行为与证据边界

- 支付宝仅支持trade日账单凭据读取，能力默认关闭；不调度未实现的资金账户账单。请求用字符串`secure="true"`，RSA2原文验签后只从官方HTTPS主机和精确路径下载，校验签名URL中的PID与商户一致，不跟随重定向。
- ZIP仅在内存有界读取，检查CRC、目录/本地记录、压缩大小和膨胀、编码及文件类型；不提取文件到磁盘。只保留响应与下载文件摘要、文件名摘要、内容摘要、字节数、编码和行数，下载URL、token和原始CSV不进入持久化证据。
- 支付宝没有微信SHA1。0156保留历史微信证明约束，支付宝另用`alipay_rsa2_download_url`及签名响应SHA256；数据库校验凭据类型和商户/日期范围，并拒绝缺失证明。历史记录仍不可改写。
- 文件可下载不代表支付或退款行已核实。支付宝`totals`为JSON null，`entries`为空，保存`ALIPAY_CSV_FORMAT_UNVERIFIED`覆盖差异并保持job `unknown`，释放租约后退避重试。没有将请求应用ID冒充每行应用证明，没有以结算款替代买家现金，没有用本地日期补造退款日期。
- 共享微信对账中的金额、积分及费用使用严格int64整数比较，数据库差异以十进制整数持久化。其他应用/支付类型、错误商户、错误渠道身份/金额/日期的行不会覆盖本地应有付款。对账模块不调用支付、退款或积分写入函数。

## 验证记录

所有支付、退款、用户及文件均为synthetic。各测试组存在重叠，不相加冒充独立场景总数。

|验证|结果与证据|
|---|---|
|数据库迁移|空库安装及从0155隔离模板升级均完成157个迁移、至0156；旧模板未修改，临时空库已清理。[记录](completion/payment-statements-0156-migration.json)|
|支付宝下载、ZIP及原支付/退款单测|初轮28/28；独立检查发现先split后检查行数的内存问题，改为单遍扫描后相关18/18（新增近10MiB全换行ZIP边界）。[初轮](completion/alipay-statement-adapter-initial.log)、[修复后](completion/alipay-statement-adapter-final.log)|
|Alipay共享PG接线|最终4/4，0跳过；覆盖proof/JSON null/unknown/backoff、21张财务表前后不变、trade-only调度、身份拒绝及数据库证明约束。[最终](completion/alipay-statement-pg-verified.log)|
|精确金额及隔离PG|初轮7/7；增加缺少认证付款时间的覆盖检查后，最终8/8，0跳过。覆盖相邻大整数、原积分差1、错误应用/支付类型不遮蔽漏单、多商户/用户隔离、不精确金额回滚、不用本地入账时间代替渠道时间。[初轮](completion/alipay-statement-exact-regression.log)、[最终](completion/exact-final.log)|
|配置/部署|运行时配置5/5、部署检查13/13、真实Compose config-only矩阵10/10；无up/build/pull或真实商户请求。[配置](completion/alipay-statement-config.log)、[检查](completion/alipay-statement-deployment-checks.log)、[Compose](completion/alipay-statement-compose.log)|

新PG测试的初轮失败来自夹具用户名超过32字符，下一轮夹具退款单位及SQL参数类型不正确；修正夹具后通过，未放宽业务或数据库约束。[初轮](completion/alipay-statement-pg.log)、[第二轮](completion/alipay-statement-pg-final.log)完整保留，`final`是该次日志文件名，不表示该轮已成功。

初次工作区构建在新增PG测试的类型推断处失败；加显式类型后API构建通过，worker/Web也通过。原contracts/domain/rule包已在初次运行完成，没有把失败的整条命令标为通过。[初次](completion/alipay-statement-workspace-build.log)、[API](completion/alipay-statement-api-build.log)、[worker](completion/alipay-statement-worker-build.log)、[Web](completion/alipay-statement-web-build.log)。

旧支付/退款/微信对账回归初轮30项中29通过、1个旧夹具失败：付款回调缺认证success_time，而CSV具有日期，新增严格时间覆盖检查如实报告差异。补充匹配的合成付款时间后，原失败项定向复验1/1通过、0跳过，未重跑其余29项；[初轮日志](completion/alipay-statement-existing-regression.log)、[定向复验](completion/refund-rerun.log)分别保留。

换行内存修复、缺时间coverage语义和全部夹具修正后，统一API编译再次通过，见[最终API构建](completion/alipay-statement-api-final-build.log)。独立复核覆盖proof的SQL NULL防护、int64比较、商户隔离、错误行覆盖和有界解包。官方协议及未核实字段范围见[协议依据](ALIPAY-STATEMENT-EVIDENCE.md)，配置和PG详细断言见[专项记录](ALIPAY-CONFIG-AND-PG-VALIDATION.md)。

源码提交`80e53ab`的原发布API镜像也已构建成功，Node22全工作区编译完成；精确镜像内七个测试文件46/46通过、0跳过，测试无网络、无真实密钥或商户请求，临时容器清理后原容器/卷清单不变。[成品镜像记录](RELEASE-API-80e53abed396-VALIDATION.md)与早期镜像分开保存。

## 未完成条件

需取得可追溯的支付宝trade CSV字段说明或经许可脱敏的正式格式样本，再实现逐行金额、身份、日期及汇总校验，并完成真实商户验收。该证据缺口不能由合成夹具或支付成功回调替代。自动续费签约/代扣也仍为独立的未实现渠道能力。

本轮不改任务价表、订阅权益或认可的经营预算，不使原基准情景自动达到60%公司净利润。
