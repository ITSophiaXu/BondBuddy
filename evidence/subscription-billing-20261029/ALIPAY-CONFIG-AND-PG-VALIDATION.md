# 支付宝账单配置、部署接线与持久化验证

2026-10-29，本地合成验证。支付宝 CSV 业务格式尚未核实，下载凭证保留为 `unknown`，不构成完整对账或商户验收。默认开关保持关闭。

## 配置与部署接线

- 新增 `BB_ALIPAY_PAY_STATEMENTS_ENABLED=0`，仅接受 `0` / `1`。启用账单必须同时启用 `BB_ALIPAY_PAY_ENABLED=1`；非法开关或关闭支付渠道却启用账单时，在读取凭据前返回既有 `status: invalid`、空 provider 列表。
- 默认或显式 `0` 不暴露 `downloadStatements`。显式启用只接入 `options.statementsEnabled`，不启用退款或外部自动续费授权。
- Compose 只向 API 注入该开关。沿用现有每日账单调度与重试，不增加额外调度变量。
- 账单启用时，部署检查要求 `BB_EGRESS_ALLOW` 包含官方精确下载主机 `dwbillcenter.alipay.com`；原支付网关 `openapi.alipay.com` 仍单独检查。父域、通配、URL、伪造后缀不能替代精确主机，外部 `NO_PROXY` 绕过也会失败。没有自动放通主机。
- `.env.example` 明确提醒：当前 CSV 格式未核实，下载后仍为 `unknown`；格式与商户验收完成前保持关闭。

本子任务修改配置范围为 `payment-provider-config.ts` 及其测试、`deploy/m1/compose.yaml`、`.env.example`、`scripts/check-payment-deployment.mjs` 及其测试；另新增独立 `apps/api/src/alipay-statements.pg.test.ts`。支付宝适配器、共享调度、迁移由本轮其他工作负责，未在此子任务中修改。

## 验证结果

|范围|结果|原始日志|
|---|---|---|
|支付 provider 配置|5/5，0 失败/跳过|[config](completion/alipay-statement-config.log)|
|部署检查器|13/13，0 失败/跳过|[checker](completion/alipay-statement-deployment-checks.log)|
|真实 Compose 配置解析|10/10 预期符合|[Compose](completion/alipay-statement-compose.log)|
|支付宝账单 PostgreSQL 集成|4/4，0 失败/跳过|[最终 PG](completion/alipay-statement-pg-verified.log)|

配置与 PG 测试运行于 Windows、Node `v26.13.0`。配置测试仅使用合成密钥/回执与注入依赖；新增测试断言没有凭据文件读取或商户请求。既有文件权限测试中的 POSIX 专属分支不在 Windows 执行，不能据此宣称本轮验证了 POSIX 文件权限。

Compose 矩阵在 WSL `BondBuddyM3` 使用真实 `docker compose config`，覆盖 base/prod 各五种情况：默认关闭、合法启用、支付渠道关闭、非法开关、缺下载主机。验证实际开关注入及对应拒绝原因；使用独立空 env 文件和全合成进程设置，不读取实际 `.env`，不记录原始配置 JSON。只执行配置解析，没有 `up`、`build`、`pull` 或商户请求。

PG 使用已迁移至 `0156_payment_statement_provenance.sql` 的 `bb_billing_complete_20261029_v4` 作为只读模板，通过测试辅助函数创建文件专属数据库副本，进程结束时删除副本；未修改原模板。最终进程 exit 0，无待清理测试服务。

## PostgreSQL 断言

1. 合成适配器的已下载证据经过调度后持久化 `alipay_rsa2_download_url`、签名响应 SHA-256、下载 SHA-256、请求应用/商户/日期及非敏感文档摘要；`totals` 是 JSON `null`，不是 SQL NULL。无归一化交易行，记录 `alipay_statement_format_unverified` 覆盖差异。任务保持 `unknown` 和退避重试，`completed` 不增加；同一证据重试不重复保存下载凭证。
2. 先通过领域接口建立合成实付与成功退款，再比较 21 张钱包、支付、退款、订阅、售后账表的完整 JSON 文本；账单持久化和重试前后全部不变，积分审计一致。
3. trade-only provider 仅创建前七日 trade jobs；不创建 funds jobs，不接受显式 funds 排队，也不领取原有 funds job。
4. 外部商户、其他应用、其他账单日期、签名 URL 商户或请求日期不匹配、混入 SHA1、下载 hash 不匹配均拒绝持久化证据并保持可重试。直接 SQL 插入另验证 provider/proof 方法绑定，以及 NULL 微信 SHA1、缺签名响应 hash、缺应用身份不能绕过数据库 guard/CHECK。

上述输入明确为 synthetic 适配器结果，不声称验证了真实签名、官方 CSV 业务含义或真实商户。适配器下载/验签测试应引用其独立证据。

## 保留的失败与修复记录

- 统一首次 build 发现新增测试的 TS7022 推断问题；为查询结果补明确结构类型后由主代理续跑 API/worker/Web 构建。原日志保留为 [初次 build](completion/alipay-statement-workspace-build.log)。
- [PG 初轮](completion/alipay-statement-pg.log) 四项均因新夹具用户名超过上限而在 setup 失败。缩短夹具用户名，并补 setup 失败时关闭连接池。
- [PG 第二轮](completion/alipay-statement-pg-final.log) 两项通过；其余失败分别是新夹具对 1:1 充值退款误传 points，以及直接 SQL 的 text/char 参数推断歧义。改为原订单正确的 `amount_fen` 请求与显式参数 cast，未改生产行为、数据库约束或业务断言。
- 仅转译更新后的测试文件，最终四项全部通过，最终证据使用独立 `verified` 文件名，前两轮日志未覆盖。

这些结果是本地定向验证，不代表 GitHub Actions 整套通过，也不代表重新构建或部署了包含本轮账单代码的新镜像。
