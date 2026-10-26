# First browser verification record

This is a record transcribed from the tool output, not the raw stdout file. The initial runs did not redirect stdout to disk. `browser-final.log` is captured directly from the final command.

## Environment check

Command: `npx playwright test tests/run-supplement-draft.spec.ts --reporter=line`

The default Playwright Chromium headless shell was absent (`chromium_headless_shell-1243`). All 11 attempts failed at browser launch; no application behavior ran. The installed Microsoft Edge channel was then used.

## First application run

Command from `apps/web`: `$env:BB_E2E_BROWSER_CHANNEL='msedge'; npx playwright test tests/run-supplement-draft.spec.ts --reporter=line`

Result: **10 passed / 1 failed**, 22.7 seconds.

The failed test was `unaccepted PUT with a lost response retries the identical request only after receipt says not found`.

The assertion inspected `state.reads` immediately after the pending-request retry button appeared. The button is rendered before the asynchronous exact-receipt GET is sent, so the expected request ID had not yet reached the synthetic HTTP fixture. The observed array was `[null]` (the initial draft GET). This was a test synchronization error.

The test now waits for the exact request ID to appear in the GET log and for the retry button to become enabled before retrying. No production source was changed for this failure.

The next run, with upload-completion recovery and owner/run departure checks added, passed **13/13**, 22.6 seconds.

## Intermediate screenshot run

A three-case screenshot run occurred while the frontend implementation was still changing. It had **1 passed / 2 failed** because M3/M4 resume labels changed from `继续复核` / `继续生成` to explicit `按原材料继续本轮复核` / `按原材料继续生成`. The two failures were selector timeouts. The final tests use the existing stable action attributes and assert the new explicit wording. This intermediate run is not included in the final passing count.

## Final scope

A subsequent 14-case run had **12 passed / 2 failed** in 45.0 seconds. The two CAS tests entered unknown-result handling because the test harness dynamically imported ApiClient separately from its consumers. Vite's development invalidation timestamps could load separate copies of the ApiError class, breaking `instanceof ApiError` in this synthetic harness. The raw output and result snapshots are preserved as `browser-intermediate.log` and `browser-intermediate-results/`.

Only the harness was changed to statically import ApiClient, shared panel and production consumers from the same module graph. The CAS subset then passed **2/2** in 8.3 seconds (`browser-cas-harness.log`); no production source was changed to fix these two test failures.

The static harness imports the same global CSS used by main.ts. Screenshots show actual production components in a synthetic shell, not the full application navigation or a complete main-route visual acceptance.

The final run waits for the frontend author's explicit source freeze. It includes **16 unique synthetic HTTP browser tests**, including a mismatched exact-save receipt, a delayed V0 availability GET after a confirmed V1 save, and failure to read a newer draft after an already verified exact receipt. A first 16-case run passed in 30.9 seconds (`browser-pretypefix.log`). Static checking then found a missing required session-loss callback in the new harness's ApiClient constructor; it was supplied as a no-op callback. TypeScript checking passed, and the final 16-case run uses that type-correct harness. Repeated runs are not counted as additional unique scenarios.

These tests exercise actual production components and HTTP client calls, with a stateful synthetic API fixture. They do not establish database, provider/model, Word artifact, supplementary adoption, rework-pricing or full G03 acceptance.
