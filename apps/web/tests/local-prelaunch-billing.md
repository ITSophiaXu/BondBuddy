# Local full-stack billing acceptance

These opt-in desktop tests require the already-running dedicated instance at
`http://localhost:18087`. They register real synthetic accounts through the product UI,
use real cookies/CSRF and current int64 billing DTOs, and inspect the instance's actual
PostgreSQL ledger with read-only SQL. They never start infrastructure, use `page.route`,
grant credits directly, seed a successful task, or manually finish a run.

Only the payment channel is synthetic: explicit channel outcomes flow through product
payment/refund processing. The worker tests use the actual deployed queue, Python tools,
private Blob storage, model adapter and Word delivery. The real-model case requires a
separately coordinated model execution window; it does not read credential files.

First run the eight non-model payment/refund/subscription cases:

```powershell
$env:BB_E2E_LOCAL_PRELAUNCH='1'
$env:BB_E2E_BASE_URL='http://localhost:18087'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_PRELAUNCH_WSL_DISTRO='BondBuddyM3'
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-billing.spec.ts --workers=1 --retries=0 --reporter=line
```

After the actual model preflight and shared-queue coordination:

```powershell
$env:BB_E2E_REAL_MODEL='1'
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-billing-worker.spec.ts --workers=1 --retries=0 --reporter=line
```

| Case | Actual chain being checked |
| --- | --- |
| 01 | Invalid, numeric, fractional, zero and over-limit amounts create no order or ledger event; minimum valid order can close. |
| 02 | Product recharge UI → pending query → channel-paid/product-pending gap → original query/callback replay → one credited lot and immutable original request. |
| 03 | Callback UI credits once; failed/closed orders and forged signatures add no money. |
| 04 | Cashier refund request → exact freeze → channel failure remains pending → product refresh releases once; failed request key remains the same refund. |
| 05 | Concurrent original refund key, overage, changed amount, terminal replay and foreign accounts cannot freeze, settle or release twice. |
| 06 | Free actual question extraction → zero-balance UI rejection → actual payment return automatically replays identical request → real model/Word/settlement → replay adds no model or charge. |
| 07 | Actual worker receives an unreadable mandatory reference → durable failure before model invocation → exact reservation release → original replay changes no ledger. |
| 08 | Old numeric wire rejects a new purchase, current wire creates the same intent, old wire safely replays the persisted original and original query credits once; changed amounts conflict. |
| 10 | Real monthly subscription purchase → pending has no balance → verified payment issues one expiring monthly lot → repeated checkout/query/callback and premature renewal preserve original rights. |
| 11 | Real annual subscription purchase → verified payment issues only the first monthly lot → eleven later installments stay scheduled → repeated payment and browser refresh issue no extra rights. |

Cases10/11 compare the actual displayed catalog, order cash amount, wallet lot,
original cash consideration, immutable period and account projections. They also confirm
that a one-cycle purchase does not authorize automatic future charges. These cases do not
advance time, exercise recurring merchant mandates, or claim future monthly installments
or real merchant transactions were accepted.

Case06 also rejects an unaccepted legacy numeric task request and the actual old
`project-qa-question-60-v1` price version before creating a new run, then restores the
current UI request after payment. Its completed real task is replayed through the old wire
without changing the locked price, result, model calls or charge. This covers transport and
price-version compatibility. The separate legacy-policy suite below also exercises persisted
`authoring_balance_v2` tasks through a separately started API configured for that policy.

Each execution creates a new `.local/local-prelaunch/billing/<invocation>/` evidence tree
with real HTTP statuses, current source hashes, account-scoped SQL checkpoints, screenshots,
errors and, for case06, the authorized actual model-generated Word download. Passwords,
cookies and model credentials are omitted. Failed evidence is retained.

Actual execution on 2026-11-07 used instance
`45811ffb-4ea8-4ee2-92d5-44c96cdae454`, current production image source
`757a9871c890ace5fe2b408c2aac45d3948439c7`, real Windows Edge and read-only WSL
PostgreSQL checkpoints. Cases01–05/08/10/11 passed 8/8 in 55.0 seconds; case07
passed 1/1 in 17.8 seconds. Every saved result has no page errors. Evidence lives under
`.local/local-prelaunch/billing/2026-11-07T02-33-50-754Z-9e6fb9d2/` and
`.local/local-prelaunch/billing/2026-11-07T02-35-21-867Z-15a7f289/` respectively.

After the strict file-boundary diagnostic and real contained model preflight passed,
case06 passed 1/1 in 31.6 seconds. The actual UI rejected the original task with 402,
then a 1,218-fen payment automatically resumed the identical request and locked v3 quote.
Run `f76ca726-ea56-494e-a0a9-61d08b06c702` succeeded with one completed
`gpt-6-sol` model call and measured usage. The ledger contains exactly one 1,218-point
reservation and one 1,218-point settlement; current and legacy terminal replays changed
neither model calls nor money. Evidence is under
`.local/local-prelaunch/billing/2026-11-07T02-52-28-429Z-db78f1ec/`.

The actual authorized Word download is 1,506 bytes with SHA-256
`0e51e0116dadb094bfa3d4f2c201112bf6639fb27d9afdf3afbca02bc62fd88f`, matching
the persisted artifact. Independent read-only OOXML inspection confirmed that the
original question remains, the answer names the exact synthetic issuer and 2025 report
period from the pinned reference, and it explicitly avoids inferring missing financial
data. This is a focused factual/structure inspection, not rendered desktop Word QA.

Thus all 10 billing cases passed. The initial root preflight failure
`AUTHORING_FILE_SANDBOX_UNAVAILABLE` and `/proc/1/environ` diagnostic remain preserved
under `receipts/authoring-seccomp-2026-11-07T02-47-03-273Z-red-*`. The local derived
seccomp was narrowed to preserve the proc deny mask, and the production verifier was
kept. A passing local synthetic-payment test is not a real merchant transaction,
production-payment acceptance, future installment/recurring mandate acceptance, or
complete document-quality acceptance.

## Persisted legacy-policy recovery: 2026-11-08

`local-prelaunch-legacy-billing.spec.ts` passed both cases on the same isolated instance
and production image source `757a9871c890ace5fe2b408c2aac45d3948439c7`.
The legacy API uses the same current binary with subscription/outcome policy selection
disabled and paid authoring/review enabled; the main API and real worker use the current
configuration. This verifies persisted policy compatibility, not a historical binary/schema
upgrade or reproduction of the user's unidentified production failure.

| Case | Observed real chain |
| --- | --- |
| Before model | A legacy task starts with 1 point, durably pauses at `credits_exhausted` before any model call, and a verified payment through the current API automatically resumes the same run. It completes one measured `gpt-6-sol` call and settles the original 17,900-point price. |
| After model | A legacy task starts with 1,790 points and pauses after the measured model call and provider result are persisted. Current-API payment resumes the same run, reuses the exact call/result and model checkpoint, and settles the original 17,900-point price without another model call. |

Both cases preserve the run, execution request, job, input revision/hash, reservation and
quote identities across recovery. The ledger contains unique debit event keys totaling the
original price, no remaining frozen points, and only one run/reservation. Both actual Word
downloads match their persisted artifact hashes. Terminal replay through either API leaves
the ledger, model attempts, result and original price unchanged.

Reproduce after model preflight and shared-queue coordination, using the same environment
variables above with `BB_E2E_REAL_MODEL=1`:

```powershell
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-legacy-billing.spec.ts --workers=1 --retries=0 --reporter=line
```

The two passing case records are under
`.local/local-prelaunch/bad-cases/legacy-recovery-correcte-2026-11-08T10-44-43-588Z-3f197e1c/`;
the account-scoped ledger/model summary is
`.local/local-prelaunch/legacy-recovery-summary-20261108.json`.
The initial failed observations remain in their original evidence directories. The harness
correction scoped the recharge link to the observed dialog and checked its original
project/run return target; it did not alter product state or weaken billing assertions.

## Image-version boundary

The 2026-11-07 ten-case results and 2026-11-08 two-case legacy recovery results above are
historical acceptance of image source `757a9871c890ace5fe2b408c2aac45d3948439c7`.
They do not establish acceptance of the later checkout merged with `develop` at
`55a073c1d280836ee14d6f8c32786baaeaf95fca` or subsequent fixes. Final-image billing
reverification is still pending. Record the running image identities and fresh test evidence
when it finishes; a successful image build or a cached ready receipt alone is not that result.
