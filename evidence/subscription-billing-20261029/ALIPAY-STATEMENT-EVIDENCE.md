# Alipay statement evidence intake and explicit unresolved coverage

2026-10-29. Public-document research and synthetic local verification only. No merchant credentials, customer files, live payment, refund, mandate, or statement request were used. This change **does not claim completed Alipay business reconciliation**.

## Official facts verified

1. [Current official V2 request model](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayDataDataserviceBillDownloadurlQueryModel.java), generated 2026-05-26: `bill_date` accepts daily or monthly periods; daily data is T+1, normally generated before the next day's 09:00; `secure` must be the string `"true"` for an HTTPS download URL. Non-true values request HTTP.
2. [Current official V2 response model](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayDataDataserviceBillDownloadurlQueryResponse.java), generated 2026-05-26: `bill_download_url` expires if not downloaded within 30 seconds; `bill_file_code=EMPTY_DATA_WITH_BILL_FILE` means an empty-data file can be obtained. Neither field provides a channel SHA1 or SHA256 checksum.
3. [Official OpenAPI specification](https://github.com/alipay/alipay-sdk-java-all/blob/master/v3/api/openapi.yaml), retrieved on this date: the request's `bill_type` example is `trade`; the response example is `http://dwbillcenter.alipay.com/downloadBillFile.resource?bizType=X&pid=X&fileType=X&bizDates=X&downloadFileName=X&fileId=X`. Together with the V2 `secure` option, this supports restricting actual downloads to **HTTPS**, exactly `dwbillcenter.alipay.com` and `/downloadBillFile.resource`. The local downloaded OpenAPI source SHA256 is `f0b5be3d7de8bdfce2fb44e0a258cb1ecba1b851e6a2a9584b67a7f87ceddf0e`.
4. The already pinned official Node SDK **4.14.0** continues to create RSA2 request signatures and verify the original response-object bytes. The transport remains the existing bounded `fetch` with the deployment's normal TLS/proxy handling.

These sources verify the metadata/download protocol. They do **not** establish the current trade or signcustomer CSV columns, refund request identity, buyer cash, row application identity, or row date semantics. A limited search of the official Java, Node and Python SDK repositories found no official CSV/ZIP example. The public documentation pages returned a JavaScript shell; the final public documentation metadata query returned `illegal_request`. Research stopped rather than inventing a CSV contract.

A browser-origin permission request was rejected by automatic approval review because browser-origin access had not been separately granted. No browser workaround was used. The official SDK sources above were read through separately approved anonymous HTTP requests, without browser cookies or account access.

## Implemented boundary

- `AlipayPayOptions.statementsEnabled` defaults off. When explicitly enabled, the provider exposes `statementAppId`, `statementKinds: ['trade']`, and `statementAccounts: []`. No signcustomer/funds job is advertised.
- The metadata request is the signed `alipay.data.dataservice.bill.downloadurl.query` with the requested daily `bill_date`, `bill_type: 'trade'`, and `secure: 'true'`. Each retry obtains a new URL. Current/future or invalid dates and unsupported accounts are rejected before network access.
- The signed URL must contain one `pid` exactly matching the configured merchant. A missing/mismatching PID, duplicate query keys, credentials, explicit ports, fragments, non-HTTPS URL, other host/path or path normalization is rejected. This records a matching **signed URL parameter**; it does not assert that every CSV row is separately identified by merchant/application.
- Downloading uses normal TLS verification, no redirects, no custom unverified agent, a bounded header/body timer, and at most 10 MiB. HTTP errors, HTML, compressed HTTP bodies, declared/actual size mismatches and late responses remain unresolved. Aborted or rejected streams are cancelled.
- ZIP inspection happens entirely in memory. It permits at most 8 flat CSV members, 10 MiB per member and 20 MiB in total, at most 100:1 expansion, stored/deflate methods and checked descriptors. It verifies central/local header agreement, non-overlapping contiguous member regions, output size and CRC. Paths, links, directories, duplicate names, encryption, ZIP64 and unsupported metadata are rejected.
- CSV bytes use strict UTF-8/GBK decoding. A UTF-8 BOM is authoritative for encoding only; without a BOM, differing valid UTF-8 and GBK decodings are rejected as ambiguous. Invalid bytes, control characters, excessive line size/count and unsupported archives stay unresolved. No CSV business row is interpreted.

## Meaning of the returned evidence

`VerifiedAlipayStatement` binds the requested date, configured request app, matching signed-URL PID, hash of the RSA2-verified raw response, and the locally calculated archive SHA256. `sha1` is always null. A local file checksum is **not** represented as a channel-signed file checksum.

Documents retain only original-name hashes, content hashes, byte lengths, encoding and line count. Raw filenames, document contents and signed download URLs/tokens are absent from the returned/persisted envelope.

Every accepted archive currently has:

```json
{
  "normalization": {
    "status": "unresolved",
    "reasons": ["ALIPAY_CSV_FORMAT_UNVERIFIED"]
  },
  "entries": [],
  "totals": null
}
```

`availability: 'available'` means archive evidence was obtained and inspected; it does not mean rows were reconciled or that no transactions occurred. Even `EMPTY_DATA_WITH_BILL_FILE` does not generate zero financial totals. Unsupported or absent metadata does not fabricate an empty statement. Shared reconciliation must persist the evidence separately, retain an explicit coverage difference and unknown/backoff state, and never write wallet balances from these files. The parent task owns that integration and its PostgreSQL acceptance.

## Independent local verification

Eight selected source/test modules were transpiled into `.tmp/alipay-statement-tests`; shared `dist` was not modified. This private transpilation is not a full TypeScript typecheck. The parent performs the unified API build/typecheck.

The initial focused run passed **28/28**, zero skipped: 7 ZIP/encoding cases, 10 statement-adapter cases, and all 11 existing Alipay payment/refund unit cases. Tests generate their own RSA keys and invented ZIP/CSV bytes. They intentionally do not claim those bytes are an official Alipay bill format. Covered behavior includes exact signed request parameters, changed/forged metadata, SSRF/redirect boundaries, merchant mismatch, stream cancellation, actual byte caps, timeouts/late responses, fresh metadata on retry, ZIP integrity/resource limits, encoding ambiguity, evidence redaction, and explicit unresolved totals/coverage.

The preserved run is `completion/alipay-statement-adapter-initial.log`. No remote request occurs in that suite. No existing successful suite was rerun beyond the directly affected Alipay adapter regression.

## Remaining work

Actual CSV normalization, per-row payment/refund/fund matching, and complete reverse coverage require an authoritative format contract and representative permitted merchant samples with documented identity, amount and date semantics. The implementation must not infer missing refund IDs, buyer cash or dates from nominal totals, merchant receipts, filenames, local records or similar-looking rows. Actual merchant signing/product eligibility, download acceptance and production egress also remain external acceptance conditions. The current change safely acquires bounded evidence; the original requirement for completed Alipay daily reconciliation remains open.
