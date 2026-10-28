# Commercial scope billing validation

Base: `origin/develop` / `5d24d5d` (2026-10-28). Implementation, tests and updated account prototype are in this change's working tree. Windows, Node 24, PostgreSQL 16 isolated local template/clones. This is a code review candidate, not a production deployment.

## Executed

- `npm run build`: contracts, domain, registries, API, worker and web passed. Subsequent targeted API/web builds cover the final edits.
- `npm run check:contracts`: passed; strict synthetic examples and integrity/OCR/issuer-binding tests.
- All migrations through 0123 applied from an empty local PostgreSQL database. The final template includes explicit SQL NULL/type guards.
- `scope-quotations.pg`, `integrity-scope.pg`, `outcome-billing.pg`, `project-scope-quotation.pg`: 10 passed, 0 failed, 0 skipped against the final template. Pending requests cannot create paid tasks; same task types use different approved amounts; ownership/action/input/amount/lines bind; published prices cannot change; stale inputs fail; delivery/failed release/correction/paid check reuse/QA original-scope followup and per-file retries tested.
- Payment/account/history/provider group: 16 passed, 0 failed, 0 skipped. Real RSA signatures and AES-GCM use synthetic keys and local mock responses. Forged/mismatched notifications and concurrent repeats cannot add money. Exact-amount top-ups preserve one ledger and do not start tasks.
- Existing billing/M4/review activation PostgreSQL regression: 5 passed, 0 failed, 0 skipped. Existing dynamic and fixed policies retain their behavior.
- Project-file check/update history suites: 38 passed. Query fixtures updated for the new joined quote fields while retaining isolation/history assertions.
- Scope work-item unit validation: 2 passed.
- Browser and UI evidence details are in `ui/README.md`; the web unit suite result is recorded in the PR.

Groups above overlap in scope coverage and are not intended as a single summed test count. No production database, real client materials, paid model call or real merchant was used. Synthetic balances, prices, approvals, messages and Word bytes must not be reported as revenue, willingness to pay or professional acceptance.

## Evidence and limits

`ui/*-viewport.png` are matching 1440×960 crops of the synthetic account full-page screenshots; the original full-page PNGs remain alongside them. The QA confirmation image shows a synthetic work-item quote rather than a fixed per-question price. Account prototype and implementation differ in fixture content and existing navigation; this is not pixel-identical UI sign-off.

Actual work-item tariffs and automatic scope identification are not validated. The first controlled pilot uses trusted operational review and publication of each scope quote; this is not assumed to be a cost-free scalable operating model. Real DeepSeek full-task cost/quality, merchant payment/refund/invoice arrangements and 60% net profitability remain final acceptance/operating validation items. New charging and WeChat flags default to disabled. No production migration, enabling of sales, deployment, actual charge or refund was performed.
