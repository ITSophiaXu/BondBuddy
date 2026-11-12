# Live login and OCR preparation migration — 2026-11-12

## Observed failure and limits

The browser-runtime preflight at commit `38a049e0e7f692d4fea4c755401c34d36f696ea1` (tree `f2b11835a4f87e9256c705f4e32e95fd525d0ecb`) ran the unchanged `account-live.spec.ts`, `ocr.integration.spec.ts`, and review progress prototype case. The retained JSON report records one pass and two failures, with no skipped or flaky cases. Its SHA-256 is `e488e24e7e8ebb89b250764f40d3847f468bd5643744223f99bcfe8d25557ca5`.

Both failures were at `live-helpers.ts:22`, waiting to click the exact link `全部项目`. The account case reached its original 30,000 ms budget (30,044 ms recorded); OCR reached its original 120,000 ms budget (120,048 ms recorded). The outer invocation ended after 159,200 ms and was not cut off by its 300,000 ms limit.

Only the JSON/stack and stdout were retained from that run. The container's error-context, screenshots, and trace were not copied out before cleanup. They have not been inspected, and the old run does not prove that UI login succeeded. The separately recorded `navigator.onLine=false` environment issue remains a separate investigation; this patch does not change networking or infer that it is resolved.

## Current navigation evidence

At develop `9d04b109370a3664aa9b0c4737ca90d7ef873960`:

- `apps/web/src/main.ts` sends successful form login to `#tasks` and renders the main-navigation link `任务进度与结果`.
- `apps/web/src/project-browser.ts` renders the same exact page heading.
- `docs/product-decisions/2026-11-05-desktop-ux-polish.md` identifies the approved desktop refinement and says navigation/login behavior stays unchanged. Its linked `product-prototype/public/desktop-workspace-polish.html` and the existing `task-results.html` use the same navigation text and route.
- `main.ts` labels the current account `当前登录账号` and fills it from the authenticated `/account` response after matching `user_id` to the current identity. The public contract normalizes registered usernames to lowercase ASCII.

## Change

The shared helper still fills the real login form and clicks its submit button. It now observes that exact same-origin `POST /api/v1/auth/login`, requires HTTP 200 and an active session, checks `/api/v1/me` using the browser context's own cookie jar, and requires the same returned user ID. It also checks the displayed account name against the requested normalized username before navigating.

The old link/heading selectors become the exact `任务进度与结果` selectors. The link is scoped to the main navigation. Mobile-menu handling remains after authenticated identity confirmation. No account is created or logged in through an additional API call, no cookie is copied between contexts, and no generic page-readiness condition substitutes for authentication.

The OCR case's next preparation steps also referenced removed controls (`新建更新项目` and editable `项目名称 必填`). These were identified by static inspection, not by a later observed browser failure. The case now uses the task page's existing page-header `新建项目` link, asserts its `#/new` target, fills `发行人全称`, checks the generated name, and requires the actual project-create HTTP 201 response to match the issuer/name and navigated project ID. Scoping to `#main > .page-head` avoids the second same-name link rendered inside the new account's empty project list. This follows `docs/product-decisions/2026-10-11-project-auto-name.md` and the existing `project-workspace.js` prototype; no new creation fields are required.

The complete auto-name path was checked statically: `main.ts` creates a blank draft with null market/offering and passes `autoName=true`; `updateFormFields` renders `output#generated-project-name`; `bindUpdateForm` writes the issuer-driven value on form input; `readUpdateForm` recomputes that same value for submission; and `generatedProjectName` appends `-募集书更新` when market/offering are unset. The test's synthetic issuer and explicit expected name match that path, including the displayed output and saved project response.

`ApiClient.completeUpload` sends `Prefer: respond-async`, accepts intermediate HTTP 202 `confirming`, and polls until the material response. The OCR case now observes the one original upload-session HTTP 201 and a terminal completion response, requires HTTP 200 on that exact project/upload URL, and validates material ID/version, upload ID, audit role, filename, PNG media type, byte size, and SHA-256 against the uploaded fixture. Observers are installed before selecting the file. The test sends no additional upload or completion requests and does not switch the product to synchronous completion.

The preflight environment initially ran only the API with run execution disabled; it did not run the upload-confirmation consumer. The verification owner confirmed this separate environment gap and is preparing the actual isolated confirmation consumer for the next run. Merely waiting for HTTP 200 cannot establish that the consumer works. This patch neither runs it manually in the case nor claims that the gap has been validated as resolved.

## Validation and remaining work

Offline TypeScript parsing/transpilation of both edited files and `git diff --check` pass. The registration helper is textually unchanged after LF normalization for comparison. Thirteen of the 14 importing test files and Playwright configuration are unchanged from develop. In the edited OCR case, the full original block from database-pool creation through actual OCR execution, crop review, versioned user correction/reload, and both foreign-account HTTP 404 assertions is unchanged. The one file-selection call, original processOcrMaterial call, and 30 s / 120 s case budgets are retained.

No browser, API, database, Docker runtime, build, or model call was started for this patch. These are static checks, not a passing live test result. The original complete account/OCR cases must run again within the unified candidate verification, including their later business assertions. The PR remains Draft until that evidence is available. Code complete; not deployed; awaiting unified release.
