# WeChat refund API dates and transaction-bill coverage

2026-10-29. Targeted anonymous HTTPS reads of official public documentation only. No merchant endpoint, credential, payment, refund or statement was accessed. The ordinary sandbox blocked outbound sockets; the explicit `require_escalated` approval path then permitted these document reads. This is protocol evidence, not implementation or merchant acceptance.

## Sources and saved evidence

The exact HTML responses are retained locally under `.tmp/wechat-refund-date-sources/`. Derived `.txt` files strip scripts, styles and tags and decode HTML entities; their whitespace is normalized. Hashes below apply to the original HTML bytes, not the derived text.

|Source|Local file|SHA256|
|---|---|---|
|[Native refund application](https://pay.weixin.qq.com/doc/v3/merchant/4012791883)|`apply.html`|`2f7a98d57b4bf8154d3aac77ea7d84f82702c4315552d7afdb1629d0aced58c7`|
|[Query a refund by merchant refund number](https://pay.weixin.qq.com/doc/v3/merchant/4012791884)|`query.html`|`ae6b251d3f606ef984d8c209603deaba0292752eadbadadfd8572c2903a7e1ff`|
|[Native refund-result callback](https://pay.weixin.qq.com/doc/v3/merchant/4012791886)|`callback.html`|`aaee0c0f929e78e39294df6c850d23dd029d7e224acc8978a1f9107bfa5ac7cd`|
|[Apply for a transaction bill](https://pay.weixin.qq.com/doc/v3/merchant/4012791887)|`transaction-bill.html`|`5c3edf44b185acfa75170d81a4d338a9927b8adc20b2d44104c99c91a56a56a7`|
|[Transaction-bill format and fields](https://pay.weixin.qq.com/doc/v3/merchant/4013071246)|`transaction-fields.html`|`aaf6efa48ec6198caf5eb9576d0c1f8fa3cff01322a96654b30499bd7c6ec7dd`|

The application page directly links the Native callback and transaction-bill pages. The transaction-field page was already the official field reference in `WECHAT-STATEMENT-EVIDENCE.md`; this read rechecked that exact reference. No general search or unrelated source was used.

## Verified field meanings

### Application and query responses

Both application and query pages define the following response fields:

- `create_time` — **必填**, `string(64)`, **【退款创建时间】**: “提交退款申请成功，微信受理退款申请单的时间。” Format: RFC3339, `yyyy-MM-DDTHH:mm:ss+TIMEZONE`.
- `success_time` — **选填**, `string(64)`, **【退款成功时间】**: “退款成功的时间，该字段在退款状态status为SUCCESS（退款成功）时返回。” Format: RFC3339 with explicit timezone.

Thus API `create_time` establishes provider acceptance of the refund application. It is not the local request-row creation time. `success_time` records the later refund success and must remain a separate fact. The schema marks it optional; do not make a blanket required-field assumption for all refund statuses.

### Callback envelope and decrypted resource

The callback page defines envelope `create_time` as **【通知创建时间】**: “本次回调通知创建的时间。” It is notification time and cannot establish refund-application time.

The documented decrypted refund resource contains `success_time` (optional, refund-success time), but does **not** contain the refund API's application `create_time`. Its refund state is named `refund_status`. A callback-first success can therefore supply a success timestamp while still requiring an authenticated original-refund query to obtain application time. The notification envelope must not fill that gap.

### Transaction bill

The field reference states:

> “当天发起退款成功的退款单，退款发起成功就会出账，出账后退款状态不会更新。”

For `交易时间` it states:

> “指该笔交易的支付成功时间或发起退款成功时间（注：不是退款成功时间）”

The REFUND-format-specific columns separately define `退款申请时间` and `退款成功时间`. The implementation currently requests **ALL**, whose header has `交易时间` but not those two separate REFUND-only columns. ALL refund rows must therefore be associated with the accepted application date, not the later refund-success date. The bill's recorded refund state is its issuance snapshot and must not overwrite a later authenticated terminal result.

The quoted field page provides local-formatted bill times (`yyyy-MM-dd HH:MM:SS`) without an explicit timezone field. The current system uses the China bill-day convention. API RFC3339 values must be converted through that established bill-day function, not truncated in UTC; real merchant acceptance should also confirm the configured bill timezone.

## Minimum integration implications (proposal; not implemented by this evidence)

1. Extend `VerifiedRefund` with separate optional provider application/success timestamps. The WeChat application/query parser must validate `create_time`; the callback parser must never source application time from the envelope or an undocumented resource field. Validate provided RFC3339 calendar dates and offsets before normalization.
2. Persist authenticated date evidence with the same original refund, order, transaction, provider refund ID and merchant identity checks used by the existing receipt. A write-once side table is a small option that preserves the current terminal-row immutability rule. Alternatively, new columns require an explicitly narrow null-to-authenticated-value guard; existing non-null times and terminal money/state must stay immutable. Conflicting authenticated dates require reconciliation, not overwrite.
3. Store/enrich date evidence **before** the existing terminal replay return, without re-running settlement, refunding cash or changing credit lots. `applyVerifiedRefund` currently returns early for terminal rows; the database terminal guard also rejects any row change. Simply adding two columns to the ordinary update will miss callback-first and historical terminal refunds.
4. Provide a bounded original-refund **query-only** path for accepted/terminal refunds missing application evidence. The ordinary refresh and reconciliation worker stop querying terminal rows today. Date enrichment must never call `create` or `recoverSameRequest`, and transport failure must retain the coverage exception.
5. Reverse trade-bill coverage should use authenticated application date. Provider-accepted PROCESSING/ABNORMAL/CLOSED refunds can also belong to the bill because issuance is triggered by successful application, not refund completion; restricting coverage to local `succeeded` omits those cases. A merely local requested row without provider acceptance evidence is not proof of a missing channel bill row. Historical authenticated bill evidence remains a fallback, and disagreement with API dates is an explicit difference.
6. Preserve `refund_application_date_uncovered` where date evidence is still absent. A successful query may close that evidence gap; downloading an unrelated bill or receiving a callback timestamp may not. Statements continue to be read-only relative to cash/credits.

Suggested focused acceptance cases: callback-first success then query enrichment; application and success on different China dates; offset/UTC-midnight conversion; application accepted but still processing; later CLOSED after an issued processing snapshot; immutable date conflicts; terminal enrichment with unchanged balances/events; old rows with missing dates; signed but malformed/missing API application time; notification `create_time` deliberately different from refund application time.

## Adapter implementation and focused verification

`wechat-pay.ts` now emits optional `VerifiedRefund.providerCreatedAt` and `providerSucceededAt` as normalized ISO UTC strings. Authenticated API application/query responses require the documented `create_time`. Decrypted callbacks never supply `providerCreatedAt`, including when an unexpected resource `create_time` is present. `success_time` remains optional; when present it requires a success outcome and cannot precede known application time.

The parser accepts the documented whole-second RFC3339 representation with explicit numeric offset or `Z`, validates the Gregorian calendar, and rejects unknown offset `-00:00`, invalid date/time components, trailing input and values outside the supported four-digit positive UTC year representation. Unsupported fractions or leap-second representations fail explicitly rather than being silently normalized. This does not change payment-success time parsing.

The adapter and its dependencies were transpiled into private `.tmp/wechat-refund-dates-tests/`; shared build output was untouched. Windows Node **v26.13.0** ran `node --test .tmp/wechat-refund-dates-tests/wechat-refunds.test.js`: **10 passed, 0 failed, 0 skipped**. This includes the seven existing refund/authentication/cash-proof cases and three new date groups covering offsets and China-midnight boundaries, leap-year/calendar validation, missing application dates, optional success dates, contradictory status/chronology, and callback envelope/resource separation. All HTTP responses, notification payloads and RSA/AES keys were synthetic; the only test HTTP server was loopback.

Log: [adapter test output](completion/wechat-refund-dates-adapter.log). `git diff --check` for the two changed source/test files passed. Full API typecheck, database persistence, query-only enrichment, reverse coverage and release-runtime integration are owned by the main task and are not established by this adapter-only test.

Source hashes at this adapter verification:

- `apps/api/src/wechat-pay.ts`: `092cde45b511163b6354a89bc8daefbba75641036c03840ad8dbab522a2eb908`.
- `apps/api/src/wechat-refunds.test.ts`: `aecb1b2f8941e409b8cdd9d28474fb18b2193e338f768b3cfa97b8265ea2c2b0`.
