# WeChat close and daily statement evidence

2026-10-29. Official public-document reads and synthetic local tests only. No merchant transaction, refund, statement or credential was used.

## Official protocol evidence

Read directly over HTTPS on 2026-10-29:

- [Close order](https://pay.weixin.qq.com/doc/v3/merchant/4012791881): POST `/v3/pay/transactions/out-trade-no/{out_trade_no}/close`, original `mchid`, successful response **204 with no body**. A signed original-order query determines the local payment state after a close attempt.
- [Apply for transaction statement](https://pay.weixin.qq.com/doc/v3/merchant/4012791887): `bill_date`, `bill_type=ALL`; SHA1, hash value and a five-minute download URL. Amounts are in CNY yuan; the adapter converts them to integer fen. Only successful payment/refund-application activity appears.
- [Apply for funds statement](https://pay.weixin.qq.com/doc/v3/merchant/4012791888): funds accounts are BASIC, OPERATION and FEES; next-day retrieval is recommended after 10:00. Funds movement time is not customer refund-success time.
- [Download statement](https://pay.weixin.qq.com/doc/v3/merchant/4012791889): download requests are signed; download responses intentionally contain **no response signature**. The downloaded file is checked against the SHA1 from the previously verified application response. The documentation shows both `/v3/bill/downloadurl` and `/v3/billdownload/file`; the implementation allows these exact paths on `api.mch.weixin.qq.com`, rejects redirects and sends no authorization to other origins.
- [Transaction fields](https://pay.weixin.qq.com/doc/v3/merchant/4013071246): the refund row is produced when the refund application succeeds; its recorded refund status **does not update after the bill is issued**. Gross order amount, settlement amount, coupons, requested refund amount and fees are distinct fields. An old PROCESSING snapshot must not contradict a later confirmed refund.
- [Funds fields](https://pay.weixin.qq.com/doc/v3/merchant/4013071249): business number, funds flow number, accounting time, income/expense direction, amount and account balance; money and points are separate ledgers.

The implementation requests uncompressed output. A signed `NO_STATEMENT_EXIST` response may establish absence; an unsigned error or creating/unknown response cannot. Unsupported historical formats, inconsistent totals, untrusted manifests, identity mismatches, altered hashes, excessive files and unrecognized money movements produce unresolved jobs/differences. No statement result writes credits or refund settlements.

## Local verification

The source was transpiled to a disposable isolated directory; no shared build output was changed. Local Node v24.22.1 ran **24/24** adapter and format tests covering existing payment/refund behavior, same-request recovery, original-order close races, signed manifests and requests, hash validation, strict download origins/paths, redirects, compressed data rejection, size cancellation, authenticated absence, integer money and modern CSV totals. All data and signing keys were generated synthetic fixtures.

All **6/6** database cases passed against an isolated clone of the synthetic PostgreSQL template migrated through 0143. The updated statement module and tests were independently transpiled to a temporary directory, with unchanged dependencies taken from the parent's API build; no shared build output was changed. They exercise original-lot cash-proof recovery, closing across unknown outcomes, historical statement/refund comparisons, concurrent statement claims, durable differences/alerts, the rule that statement-only cash entries cannot issue credits, and refund reverse coverage. API `tsc --noEmit` and all **10/10** payment-deployment checker cases also passed.

The original verification above predates persisted API refund dates. Migration 0157 now preserves authenticated API application/success dates and compares trade rows using application time, including accepted processing and closed refunds. Terminal records with missing dates can receive query-only original-ID proof enrichment without replaying financial events. See [field evidence and implementation](WECHAT-REFUND-DATE-EVIDENCE.md) and [incremental verification](WECHAT-REFUND-DATES-INTEGRATION.md). Historical records still lacking both authenticated application time and matching verified statement evidence produce `refund_application_date_uncovered`, a merchant-wide coverage exception that is not assigned to a fabricated bill date. A known application on the requested bill date without a matching row produces `local_refund_missing_from_statement`; conflicting time/identity/amount rows cannot suppress it. No local or notification-envelope timestamp substitutes for provider time.

This evidence does not claim live merchant permissions, accepted real bills, actual provider settlement, or deployment. The exact release image and configured merchant still require final acceptance.
