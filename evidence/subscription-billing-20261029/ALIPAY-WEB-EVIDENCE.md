# Alipay Web adapter evidence

2026-10-29. Public-document reads and synthetic local tests. No merchant keys, customer material, live payment, refund or mandate were used.

## Supported protocol

The official `alipay-sdk` is pinned to **4.14.0** in the API dependency and lockfile. Direct-merchant RSA2 public-key mode supports an explicitly selected PC Web or WAP Web checkout. Signing and verification use the SDK; bounded server transport uses the existing environment-proxied `fetch`, with the exact `https://openapi.alipay.com/gateway.do` origin/path. Response verification uses a structurally extracted original JSON object substring, never `JSON.stringify` of a parsed object. Callback verification uses strict once-decoded form fields and the official `checkNotifySignV2`.

Configuration and refund enablement default to off. The configuration requires `page` or `wap`; there is no automatic App-product selection, service-provider token, certificate-mode fallback or recurring mandate. Ordinary query/close recovery remains on the original order. Refunds use the same original request ID, query the particular refund after initiation, and require separate original and refunded buyer-cash evidence. Refunds never treat cumulative `refund_fee`, merchant `send_back_fee` or nominal order totals as the missing per-refund buyer cash.

## Official sources read

All retrieved read-only on 2026-10-29:

- [Official Node SDK README](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/README.md): `pageExecute(..., 'GET', ...)` returns a Web checkout URL; PC method is `alipay.trade.page.pay`; notification signature verification; public-key and certificate configurations are distinct.
- [Official Node SDK implementation](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/src/alipay.ts): `sdkExecute`, `pageExecute`, `checkNotifySignV2`, `rsaCheck` and original-response verification. The implementation in the installed pinned release was inspected as well. Transport is not delegated to SDK `exec`, and no SDK HTTP debugging is enabled by the adapter.
- [PC Web request model](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePagePayModel.java): `FAST_INSTANT_TRADE_PAY`, `out_trade_no`, `total_amount`, `time_expire` and redirect QR mode.
- [WAP Web request model](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradeWapPayModel.java): `QUICK_WAP_WAY`, `seller_id`, `quit_url` and absolute expiry.
- [Trade query response](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradeQueryResponse.java): `buyer_pay_amount` is actual buyer payment; `receipt_amount` is merchant receipt; `send_pay_date` is transfer to the seller; `TRADE_CLOSED` covers both unpaid closures and full refunds.
- [Refund request model](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradeRefundModel.java): keep `out_request_no` unchanged after errors; the same request number is refunded only once.
- [Refund response](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradeRefundResponse.java): `refund_fee` is cumulative; `present_refund_buyer_amount` is this refund's buyer amount and is not returned by default.
- [Refund query response](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradeFastpayRefundQueryResponse.java): `out_request_no`, per-request `refund_amount`, original `total_amount`, `REFUND_SUCCESS`, and `present_refund_buyer_amount`. The latter is explicitly documented as this refund's buyer amount and **not returned by default**; its availability must be verified for the merchant before enabling automatic refunds. An absent status is not reliable final failure and a later query may succeed.

The public documentation pages for [PC Web](https://opendocs.alipay.com/open/028r8t) and earlier [PC integration](https://opendocs.alipay.com/open/270/105899) returned a JavaScript shell. Field claims above are therefore supported by the official SDK source/models, not by a claim that the shell contained readable API tables.

## Local verification

The source and tests are independently transpiled into a temporary directory; shared build output is not modified. Test keys and all merchant/trade/refund IDs are generated or invented fixtures. Tests cover both Web products, exact request signing, non-canonical response text, forged and altered signatures, duplicate envelope/form keys, strict UTF-8/CNY parsing, late callback replay, original-order identity, closed/refunded ambiguity, cash-evidence separation, timeout/size limits and same-refund recovery.

The independent run passed **17/17**: 11 adapter cases, four provider-configuration cases (including existing WeChat regressions), and two PostgreSQL cases. All **11/11** deployment-checker tests passed. The PostgreSQL suite uses an isolated clone of the synthetic template migrated through 0143. It covers form callback commit-before-ack, concurrent duplicate delivery, query-based repair after a failed credit transaction, unchanged protected-route behavior, and keeping a refund frozen until authenticated buyer-cash evidence is available. The latter test caught and verified the normalized refund reference: `alipay_` plus SHA256 of the authenticated `[trade_no, out_request_no]` JSON tuple, preserving the existing ledger identifier alphabet without changing refund mathematics.

Final API `tsc --noEmit` passed after the parent's contract rebuild. The 11 adapter cases were rerun successfully after adding explicit response-body cancellation for timeout and oversized-header rejection; both cancellation paths have assertions. The parent task performs the final shared release build. The independent tests transpile source into a temporary directory and run with Node v24.22.1; they do not claim an unchanged final release image.

## Remaining acceptance

These results do not prove an actual merchant has signed either Web product or enabled the required per-refund buyer-cash field. Production app-to-seller identity, public keys, callback endpoint, proxy/release-image behavior and real payment/query/close/refund acceptance remain external configuration checks. Public-key mode is the supported mode; certificates, ISV/partner grants, cross-border flows, recurring mandates and Alipay daily statements are not implemented here. No channel is enabled by this change.
