# Task billing Web audit and targeted corrections

2026-10-30 · Subscription phase baseline: `0e245e17` · The 12 SKU tariff and 1.7 price schedule are unchanged.

## Result

Current automatic-price tasks execute from the business action without a second amount-confirmation step. Three local insufficient-balance links now resolve the exact durable task intent; the payment return continues that request with the same owner, body, request ID and quoted scope. HTTP 429 keeps the pending authoring request. Workpaper copy and receipts describe delivery settlement and actual ledger charges.

Subscription-page logic, payment plan prices, API/worker pricing rules and historical task billing were not changed by this Web slice.

## Source audit

| Task family / Web entry | First execution path | Evidence in this slice |
|---|---|---|
| Prospectus quarter / annual / two-year / three-year / migration / new | `project-execution.ts` → automatic quote → execute | Shared entry source audit; automatic authoring, shortage and 429 browser tests |
| Independent full review | `review-workspace.ts` → automatic quote → review execution | Direct execution browser test |
| Question replies | `project-qa-workspace.ts` → immutable scope request → run | Direct execution, uncertain v2/v3 recovery, shortage return tests |
| Integrity check | `integrity-workspace.ts` → quote → run | Direct execution browser test |
| Related document generation | `file-workspace.ts` → all automatic per-document quotes → batch | Source audit; no new related-document browser case in this slice |
| Workpaper generation | `workpaper-panel.ts` → server unit price → direct batch | Three targeted automatic-generation cases |
| Per-file consistency check | `project-file-check-batches.ts` → selected file quotes → batch | Local funding link, refresh, same-request return and completed notice reconciliation |
| Same-scope consistency maintenance | `file-consistency.ts` → per-file update quotes → direct update | Zero-cost included scope and paid insufficient-balance return, desktop/mobile |
| Workpaper per-file check | `workpaper-library.ts` → pinned Word versions → paid check batch | Whole batch, single file, explanation exclusion, payment return, historical family isolation and receipt tests |

Legacy/manual price confirmations remain on their historical branches. Scope selection, missing-input preparation and explicit retries of unknown submissions are distinct from an additional amount-confirmation gate.

## Corrections

1. `billing-task-recovery.ts` exposes a local-link resolver that verifies the authenticated owner, stored digest/TTL, path, request ID and canonical request body. Only the matching `needs_funds` envelope supplies a funding link. It does not start a payment or choose another task on the same page.
2. `project-file-check-batches.ts` uses that named link after 402 and after page reload. Once the server list proves the original create request was accepted with the same source and files, the stale waiting notice is cleared. The success return is not inferred merely from a missing browser record.
3. `file-consistency.ts` preserves the exact rejected update request for its funding link, including across reload. It also persists `needsCredits` before saving the cache; the previous ordering could lose the funding state. The generic legacy recharge flow stays on its own branch.
4. `project-execution.ts` attaches the matching recovery link after 402. HTTP 429 now retains the local pending request, consistent with central recovery, so retry does not change quote/body under the old request ID.
5. `workpaper-panel.ts` distinguishes current delivery settlement from historical progressive billing. Current copy says the whole batch budget is checked and files are reserved and settled independently; a mere explanatory output is not charged as a generated document. Canonical string amounts are formatted with `formatPoints`.
6. `workpaper-library.ts` shows the API's `charged_points` beside the original delegated points. Failed/cancelled run states no longer claim a completed release without ledger evidence.

## Verification

All runs used `http://localhost:5189` with separate Playwright Edge contexts and synthetic HTTP fixtures. They did not operate the user's open account tab, create real payments, consume models, or restart services.

| Check | Final targeted result |
|---|---:|
| Recovery unit suite (`billing-task-recovery.test.ts`) | 12 / 12 |
| Automatic entry/recovery browser suite (`automatic-task-billing.spec.ts`) | 10 / 10 |
| Automatic authoring browser cases (`project-execution.spec.ts`, grep `automatic authoring`) | 3 / 3 |
| Automatic workpaper generation browser cases | 3 / 3 |
| Workpaper paid check browser cases | 6 / 6 |
| Per-file check return after accepted-notice reconciliation | Targeted repeat passed |
| Web TypeScript no-emit check | Passed after final source changes |
| Unit-test TypeScript compile | Passed |
| `git diff --check` | Passed; repository LF/CRLF warnings only |

These are separate targeted runs, not a claim that the entire repository suite was run.

One intermediate paid-workpaper test exposed an old fixture issue: a `**/commerce/**` wildcard returned a catalog as `/commerce/account`, so the wallet received no balance fields. The fixture now separates catalog/account and uses the production canonical-string money wire. The affected single-file test was rerun and passed, including its uncaught-browser-error assertion. No exception was suppressed and wallet product logic was not changed.

## Visual evidence

The existing workpaper prototype has an explicit `workpaper-batch.html?billing=automatic` preview. Its default historical mode remains available. Current automatic price, button, budget description and delivery-settlement wording match the implementation. The same 350-file selection and 1440×960 / 390×960 viewports were used. The pricing-card region was captured, preserving the nearby scope, total and action.

| Viewport | Actual Web | Prototype |
|---|---|---|
| 1440×960 | [Web card](task-recovery-ui/workpaper-automatic-card-1440.png) | [Prototype card](task-recovery-ui/workpaper-prototype-card-1440.jpg) |
| 390×960 | [Web card](task-recovery-ui/workpaper-automatic-card-390.png) | [Prototype card](task-recovery-ui/workpaper-prototype-card-390.jpg) |

The prototype was also exercised through `cua_repl`: keyboard activation of “开始生成底稿” entered the synthetic progress view with no amount dialog. Browser viewport overrides were reset. This is synthetic interaction evidence, not actual generated Word/ledger evidence.

Additional Web screenshots: [consistency funding desktop](task-recovery-ui/consistency-local-funding-1440.png), [consistency funding mobile](task-recovery-ui/consistency-local-funding-390.png), [workpaper paid checks desktop](task-recovery-ui/workpaper-paid-batch-1440.png), [workpaper paid checks mobile](task-recovery-ui/workpaper-paid-batch-390.png).

No layout was redesigned in this slice. Minor card edge/pixel differences arise from the historical prototype shell and browser screenshot capture; the relevant prices, labels, hierarchy and responsive wrapping were inspected.

## Limits / handoff

- This Web slice does not prove external payment-provider settlement, actual DeepSeek cost/quality, production account ledger mutation, or full document generation. The API/worker agent's integration evidence is separate.
- The related-document automatic branch and shared prospectus SKU dispatch were read, but each of the six prospectus classifications and related-document generation were not individually executed in this Web slice.
- No 24-month projection or commercial demand validation was performed here. Root will complete the user's requested commit/push sequence before financial modeling.
- Source changes are ready for integration. Root owns final service upgrade, production build, commit and PR push.
