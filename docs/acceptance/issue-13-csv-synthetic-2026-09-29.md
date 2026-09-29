# #13 CSV 合成边界证据记录

日期：2026-09-29。范围：仅补 #13 的 CSV 合成工程证据与严格校验回归，不改解析语义、公共契约或迁移。

## 结论先行

- **CSV 目前只有合成工程证据，没有可交付的授权真实 CSV。**
- **不得用 XLSX 转存或另存冒充客户原生 CSV。** 真实 CSV、目标机审计和签名 PDF 属外部项，不在本次切片内。
- 合成测试通过只证明工程路径可用，不等于行业验收，也不解除 #13 对真实样本的验收要求。

## 本切片改动

| 文件 | 作用 |
| --- | --- |
| `python/tests/test_document_parser.py` | 新增 `test_synthetic_csv_boundary_regression_keeps_versioned_anchored_evidence`：走真实 `parse_request`，核对 `document-parse-response-v1` 信封、不可变材料绑定、表头、带分隔符的引号字段、字段内换行、转义引号、空值跳过与连续 `record_id`、`csv:rNNNNNN:cNNNN` row/column 定位、严格 record 键集合。 |
| `apps/worker/src/document-parser-csv.test.ts` | 新增 Node 严格校验回归：接受合法 CSV 响应，拒绝缺失/多余 document 键、空 `delimiter`、错误补零、row=0、缺/多 locator 键、错误 locator_type、重复 `record_id`、材料身份不匹配；并含 gated 真实 Python→Node 桥接用例。 |
| `python/README.md` | 记录 CSV 仅合成、无授权真实 CSV、禁止 XLSX 转存冒充。 |

未改：`packages/contracts/`、`db/migrations/`、run 状态机、公共枚举、其它 issue 文件。

## 证据

- `npm run build`：通过（contracts/domain/rule packs/api/worker/web）。
- `PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v`：59 tests，OK（2 skipped，皆需外部 opt-in）。
- `node --test apps/worker/dist/document-parser-csv.test.js`：3 pass / 0 fail，含真实 Python 子进程 CSV 解析跨严格边界用例。

合成夹具（UTF-8，CRLF 行结束）覆盖：表头行、`"1,234,567,890,123.45"` 引号内逗号、`-98765432109876543210.00` 大数精确保留、字段内换行 `负债\n合计`、转义引号 `引号""转义""`、空单元格（跳过但保留坐标与连续 record_id）。

## 剩余阻碍

- 无授权真实 CSV 原件；需产品负责人提供并登记来源/哈希后才能做真实样本验收。
- 目标机审计与签名 PDF 不在本切片，见各自 issue。
