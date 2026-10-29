# Automatic task billing: targeted browser verification

2026-10-29. Synthetic local browser verification only. Final result: **7 passed, 0 failed, 0 skipped**, with an explicit assertion that each page emitted no unhandled browser errors.

## Source and execution boundary

- Workspace: `subscription-auto-billing-20261029`.
- Source HEAD at final verification: `19241ef12ef0289468ec1cb9c72b653b014160ec`, plus the uncommitted fixture/error-assertion changes described below.
- Test file SHA256: `e5cf0b2dfcf4cac6b6c909bfd1e39fc197dad35928403741ef3d210b44c8169d`.
- `apps/web/src/billing-types.ts` SHA256: `ac79be0244b52a54610c87cfff728ca0ff1c60ebfebab10da8138b9524f65744`.
- Test command: Playwright `test automatic-task-billing.spec.ts`, using the installed Edge channel, one worker, and `BB_E2E_BASE_URL=http://127.0.0.1:5213`.
- The private Vite proxy target was `http://127.0.0.1:1`; missed mocks could not reach an existing application backend. All task, quote, balance, and payment responses were synthetic HTTP fixtures.
- This assignment changed only the browser test and its evidence. Root applied the production schema correction. No application deployment, real payment, merchant operation, model call, source-image rebuild, or broad test suite was performed here.

## Findings and corrections

1. The old custom HTTP fixtures emitted JavaScript numbers for monetary fields. They now pass through `fixtureBody`; captured requests are validated with `fixtureRequest` while retaining the original decimal strings. Assertions check string values such as `"1218"`, `"22738"`, and `"0"`.
2. With realistic HTTP responses, QA and integrity workspaces failed to load. `billing-types.ts` had not overridden the named `QaWorkspaceSchema` and `IntegrityWorkspaceSchema` exports with their string-wire versions. Root added both overrides. The preserved schema diagnostic shows the original domain schema rejecting string `/amount_fen`, `/unit_amount_fen`, `/units`, and `/points`; the wrapped schema passes.
3. The recovery test read a hardcoded v1 local-storage prefix, while current writes use v2. After an actual test failure at that lookup, it was changed to obtain `resume_request` from the visible recharge link and call the public `readBillingTask` / `billingTaskReturnTo` APIs. It checks the original owner, task ID, v2 record, required string points, and original request body. The resumed raw HTTP body must exactly equal the original body; a reload must not create another task or payment.
4. Vite's buffered browser errors exposed a second stale fixture: `commerce()` returned a catalog for every `/commerce/**` request, including `/commerce/account`. A new page-error assertion reproduced three canonical-int64 exceptions in the consistency test. The fixture now serves two exact routes with separately validated `CommerceCatalogResponse` and `CommerceAccountResponse` objects. The final seven tests pass with no captured unhandled page error. No production wallet change was made.

## Preserved results

All paths below are relative to this evidence directory. Failed logs remain available; their results were not relabeled as passes.

| Stage | Actual outcome | Evidence |
|---|---|---|
| Initial wire-fixture diagnosis | Numeric quote rejected; encoded decimal string accepted | `automatic-task-billing-initial-schema.log` |
| First seven tests after wire-fixture correction | 2 passed, 5 failed: workspace schema errors | `automatic-task-billing-wire-fixed-initial.log` |
| Schema isolation | Unwrapped workspace rejects string fields; wrapped schema passes | `automatic-task-billing-workspace-schema-diagnosis.log` |
| Seven tests after root's workspace fix | 6 passed, 1 failed: obsolete recovery storage lookup | `automatic-task-billing-workspace-fixed.log` |
| Original recovery failure after fixture correction | 1 passed | `automatic-task-billing-recovery-fixed.log` |
| Page-error QA probe | 1 passed | `automatic-task-billing-pageerror-repro.log` |
| Page-error consistency probe | 1 failed, with 3 captured browser errors | `automatic-task-billing-pageerror-consistency.log` |
| Final seven tests after exact account/catalog fixtures | **7 passed**, 18.5 seconds | `automatic-task-billing-final.log` |
| Private Vite shutdown | Port 5213 connection refused; original PID 47608 stopped | `automatic-task-billing-cleanup.log` |

The seven final cases cover independent full review, QA one-click execution, uncertain QA recovery for both current and protected legacy price versions, integrity execution, an included zero-point consistency update, and exact original-task recovery after insufficient balance. They verify automatic submission without a price-confirmation dialog. They do not prove actual settlement, merchant payment, subscription collection, or worker/model output quality.

## Cleanup

An initial Ctrl+C attempt did not stop the original Vite process. `Get-NetTCPConnection` was not a reliable check in this restricted environment; `netstat` still showed PID 47608 listening. A second attempted Vite start was rejected by `--strictPort`, so it created no additional server.

After the final run, the process name/path and exact port/PID association were checked before stopping only PID 47608. A direct TCP probe returned `ECONNREFUSED` for `127.0.0.1:5213`; the original tool session then exited. Other services were not stopped.

## Docker verification handoff

The existing local helpers are `.tmp/billing-deployment-validation/create-context.mjs` and `.tmp/billing-deployment-validation/build-api.mjs`. Each accepts a full 40-character source SHA. The former runs with Windows Node and creates an exact Git allowlist context; the latter runs with WSL Node against `unix:///var/run/docker.sock` and builds only the original Dockerfile API target. Their original evidence filenames must be changed before reuse so the existing `279f13a` evidence is preserved. Root assigned any newer fixed-source image verification separately; it is outside this report.
