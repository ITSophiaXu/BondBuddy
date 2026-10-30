# 支付宝交易账单规范化：实现范围与验证

2026-10-30。依据同目录 `ALIPAY-TRADE-FIELDS-20261030.md` 的官方正文，以及 `completion/alipay-official-trade-detail.png`、`completion/alipay-official-trade-summary.png` 的可见结构。此次没有连接商户账户、调用真实支付或退款；测试账单与密钥均为 synthetic。

## 已实现范围

- 验签下载地址、PID 一致性、HTTPS 原点/路径、30 秒时效、10 MiB ZIP 限额和既有 ZIP/CRC/解压/编码约束不变。CSV 原文只在进程内短暂解析；持久化仍仅保留文件哈希/编码/大小元数据及已规范化字段，不保留原文件名、下载地址、账号注释或商品描述。
- 支持一份中文业务明细文件；必要列为支付宝交易号、商家订单号（兼容官方图片的商户订单号）、业务类型、完成时间、订单金额。字段按名称定位，允许顺序变化，元单位后缀兼容中文/英文括号。退款行还必须有退款批次号或退款批次号/请求号。业务类型只支持交易、退款。
- 商家实收、商家优惠、服务费为可选证据。缺列或空值保持 `null`，不会写成零。完成时间保留 `YYYY-MM-DD HH:mm:ss` 本地字符串；本解析器不附加时区或声称官方提供 UTC。
- 每份明细必须有交易/退款两条尾汇总，分别核对笔数和已有的实收、优惠字段。订单金额、手续费总额是从明细推导的聚合，不能描述为独立尾汇总证明。
- 金额使用有界 `BigInt` 和 canonical int64 字符串，避免浮点和大整数舍入。`amountFen`、`merchantReceivedFen`、`merchantDiscountFen`、`feeFen` 为非负幅值，交易/退款方向来自业务类型；`sourceAmounts` 保留原数值的正负号，去掉纯显示格式如前导零或加号。退款本金/实收/优惠必须逐行同号，且已知三项满足本金=实收+优惠；不把混合符号错误用绝对值掩盖。手续费符号独立保留。负数交易收款目前不属于支持子集。
- RFC4180 解析支持引号、引号转义、描述字段内换行；逻辑行 32768 字符、64 列、至多 20000 个条目且条目原物理行号不超过 20000。既有 ZIP 层的单遍物理行数扫描仍在，未重新引入按无界换行分割的分配风险。
- 允许已定义结构的第二份业务汇总文件：门店编号/名称、交易订单总数、退款订单总数、订单金额、商家实收、商家优惠，并可包含已列出的优惠/卡消费/服务费/分润/实收净额列；先把门店行与合计行核对，再与只有交易收款、没有退款的明细比较计数及可比较金额。顺序可变化。此列名子集是实现兼容条件，不声称被裁切图片证明了所有商户的完整 CSV 表头。

## 保留为未覆盖的情况

含退款的独立汇总文件因正逆净额配置尚未取得充分格式证据，整包保持 unresolved；单明细中的退款行可以规范化。其他未识别汇总、英文/缺必要列配置、多份明细、超过两份文件、缺尾汇总、错误日期/金额、冲突订单映射、重复事件、后续损坏行或未知尾行均全包保持：

```json
{"normalization":{"status":"unresolved","reasons":["ALIPAY_CSV_FORMAT_UNVERIFIED"]},"entries":[],"totals":null}
```

不部分收录前面的有效行；不把无文件或未知格式当成零交易。有效空明细必须具有已识别表头和两条零笔零金额尾汇总。实际商户的文件配置、代表性付款及退款样本仍待最终统一验收，合成用例不替代该验收。

`normalized` 只说明这个配置子集的字段与汇总通过解析。账单覆盖 PID 下交易，不给每行填请求 APPID；商家实收不等于买家现金。归属、本地已认证支付/退款、买家实付、完成日及其他缺失证据仍交共享对账检查判断。账单解析不修改钱包、不发起支付或退款。

## 验证记录

运行环境：本机 Node v26.13.0。无网络、无新依赖。

1. 私有 `transpile.mjs` 转译后运行 format/archive/adapter 三套：35/35 通过，11.192 秒。此时 format 为 14 项、archive 9 项、adapter 12 项。
2. 最后增加双向订单/交易号一致性和物理行边界用例，重跑 format：15/15 通过，0.859 秒。其余两套无改动；最终整体构建与回归由主 agent 统一执行。
3. 新解析器独立 `tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck apps/api/src/alipay-statements-format.ts` 通过。

定向测试命令：

```text
node .tmp/alipay-statement-tests/transpile.mjs
node --test .tmp/alipay-statement-tests/alipay-statements-format.test.js .tmp/alipay-statement-tests/alipay-statements-archive.test.js .tmp/alipay-statement-tests/alipay-statements.test.js
```

私有转译测试与单文件类型检查不冒充全 API 构建或 PostgreSQL 集成通过。
