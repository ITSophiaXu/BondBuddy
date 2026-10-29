# Exact-v2 economics verification

2026-10-29. Synthetic local tests only. No live supplier, merchant, customer payment or invoice was used. Approved pricing, demand assumptions and operating budgets were not changed.

## Change and compatibility

`commerce-economics.ts` now reads original consumed allocation and correction-lot A/Q slices as integer text and sums them with BigInt rationals. It does not use SQL division or Number to aggregate cash consideration. Supplier numeric costs and expense amounts are loaded as text and summed exactly. Fixed-budget allocations remain separate from incremental cost. Unmeasured/unpriced usage, unconverted foreign currency, missing categories, missing cash basis and stale reviews remain unknown/incomplete.

The internal CLI reports `commerce-economics-exact-v2`. Integer quantities are decimal strings, finite decimal costs are exact strings, and consideration/contribution/margin values are reduced `{numerator,denominator}` objects containing strings. Rounded values are isolated in `display_only` with `authoritative=false`, `nearest_ties_away_from_zero`, six places for cash/currency and eight for ratios. Actual supplier invoice cost and company after-tax profit/margin remain null.

New snapshot hashes include the algorithm version and both directions of original-lot slices. Old immutable reviews remain queryable as stale hashes; they cannot approve exact-v2. Expense write input and original expense hashes remain unchanged.

Full field compatibility: [CLI guide](../../docs/runbooks/commerce-economics-exact-report.md). Public int64 wire work is separate and **not completed** by this change: [migration audit](../../docs/product-decisions/2026-10-29-billing-int64-migration-audit.md).

## Executed tests

Parent completed the shared workspace build before this run. This verification did not modify shared dist.

Runtime: Node **v24.22.1**. PostgreSQL tests cloned the existing local synthetic template `bb_billing_complete_20261029`, migrated through 0144, through `isolatedTestDatabase`; they did not write to the template.

```text
node --test --test-concurrency=1 apps/api/dist/commerce-economics-math.test.js apps/api/dist/commerce-economics.test.js apps/api/dist/commerce-economics.pg.test.js
```

Result: **19 passed, 0 failed, 0 skipped**; 3 arithmetic cases, 15 summary cases, 1 PostgreSQL integration case. Full process output: [ECONOMICS-EXACT-V2-TESTS.log](ECONOMICS-EXACT-V2-TESTS.log).

The arithmetic/summary tests include 0.1+0.2, long finite decimals above the JS safe integer range, int64 boundaries, several non-divisible original A×p/Q slices, partial and complete correction subtraction, negative contribution after a full reversal, explicit zero cash, missing cash basis/allocation, foreign currency, late/unknown costs, display rounding and invalidation of old algorithm reviews. The PostgreSQL case verifies actual read/write evidence flow, immutable expense records, preservation of an earlier synthetic review, rejection of its old hash, fresh exact-v2 review, repeat review idempotency and late-cost invalidation. Non-divisible paid-lot arithmetic is covered by synthetic unit slices; this run does not claim a live payment or end-to-end commercial project.

`git diff --check` passed for the modified tracked economics sources. New documentation under `docs/` matches the repository ignore rules and must be explicitly included when preparing the final change; no commit was made by this subtask.

## Independent Alipay cash-evidence review

Read-only review covered `alipay-pay.ts` payment/query/refund conversion and its caller-side cash proof/hold behavior. No verified new cash-handling defect was found in that scope.

One potential field mismatch was independently checked against the official source and ruled out: both [trade refund response](https://raw.githubusercontent.com/alipay/alipay-sdk-java-all/master/v2/src/main/java/com/alipay/api/response/AlipayTradeRefundResponse.java) and [fastpay refund query response](https://raw.githubusercontent.com/alipay/alipay-sdk-java-all/master/v2/src/main/java/com/alipay/api/response/AlipayTradeFastpayRefundQueryResponse.java) contain `present_refund_buyer_amount`, described as this refund's buyer amount and not returned by default. The query adapter therefore has an official basis for requiring that independently returned field. The request's `refund_amount`, cumulative `refund_fee` and merchant `send_back_fee` are not substituted for missing buyer cash.

These official files were retrieved read-only on 2026-10-29. The review does not establish that a particular merchant account is enabled to receive the field. Refund enablement remains conditional on actual merchant capability verification, and a missing field retains the existing frozen refund for same-request reconciliation.
