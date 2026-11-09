# Purely synthetic long-document quality acceptance

This case uses a newly invented issuer, text, financial observations and diagram.
The builders never read customer samples, customer-derived text/images, RQ values,
or product results. The 2025 source has 14 chapters, 26 retention anchors, six
long tables, internal directory links, chapter styles, repeated table headers,
an original Pillow diagram, and header/footer page numbering. The new workbook
and notes cover 2026 Q3, with separate consolidated and parent scopes. Consolidated
workbook amounts are yuan; parent workbook amounts are ten-thousand yuan; original
Word tables use ten-thousand yuan. The 24 controls include current values and
opening/prior-nine-month comparisons. These are engineering fixtures, never
professional or industry approval.

## Prepare inputs without a model

Resolve the bundled Python/Node/package paths with the workspace dependency
loader. Do not use repository-installed spreadsheet packages. Create an ignored
task runtime directory containing a `node_modules` junction to the returned
bundled packages. The workbook builder uses its public Artifact Tool API.

Run the documents/spreadsheets skill operation marker before the first artifact
creation. Then from the repository root, using a new external fixture directory:

```powershell
& '<bundled-python>' scripts/local-quality/synthetic_long_fixtures.py --output-dir '<new-external-fixture-directory>'
& '<bundled-node>' scripts/local-quality/synthetic_long_workbook.mjs --fixture-dir '<external-fixture-directory>' --runtime-dir '.local/synthetic-long-runtime'
& '<bundled-python>' scripts/local-quality/synthetic_long_validate.py --fixture-dir '<external-fixture-directory>'
& '<bundled-python>' scripts/local-quality/synthetic_long_matcher_cases.py
```

Render the source and notes using `render_docx_readonly.py`, the documents skill
renderer, and the existing network-isolated WSL conversion bridge. Inspect every
page. A fixture is ready only when the source has 30–50 rendered pages and the
latest images show no overflow, orphan paragraphs/images, or damaged tables.
Inspect all six workbook previews too. Never describe fixture rendering as a
product-generated output pass. Keep earlier red render/checker evidence.

The independent validator reads saved XLSX values, verifies 24 typed controls,
reconciles balance-sheet and income/cash-flow totals, and checks that 2025 annual
and 2026 Q3 cash movements tie to the balance-sheet cash changes. It does not
approve the invented figures as accounting facts.

The matcher has 32 in-memory positive/negative tests. Wrong units, wrong scope,
old/full-year/stock periods, forecast labels, missing units and conflicting new
values or missing numeric cells must fail. All explicit unit declarations are
collected; unsupported or unparsable declarations fail. Caption/header/unit declarations cannot contradict one another;
merged years and invalid flow labels ending in “月末” are rejected even when a
second correct column or table is present. An unchanged old table cannot be hidden
by adding a separate correct table. Directory links must resolve to preserved
chapter bookmarks. Passing the original source as both outputs to
`synthetic_long_check.py` must return nonzero: it lacks current values and actual
tracked edits. This negative check is not a generated product result.

## Actual local product run

Wait for the shared real-model window. The fixture directory and all evidence
must be direct children of `../quality-prelaunch-20261107`, outside the checkout.
Use the real local production API/worker; no HTTP mocks, fake results, injected
principals or SQL mutations. Windows commands need the approved elevated launch
for Edge and the existing WSL containers. Use a unique `--output` directory and
log outside the repository to avoid browser-test interference.

```powershell
$env:BB_E2E_LOCAL_PRELAUNCH='1'
$env:BB_E2E_REAL_MODEL='1'
$env:BB_E2E_SYNTHETIC_LONG='1'
$env:BB_E2E_BASE_URL='http://localhost:18087'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_PRELAUNCH_WSL_DISTRO='BondBuddyM3'
$env:BB_PRELAUNCH_SYNTHETIC_LONG_FIXTURES='<verified-external-fixture-directory>'
$env:BB_PRELAUNCH_EVIDENCE_ROOT='<quality-root>/synthetic-long-billing-evidence'
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-synthetic-long.spec.ts --workers=1 --retries=0 --reporter=line --output '<unique-external-playwright-directory>'
```

The test saves the accepted run/request immediately. `session.json` is private
and must never be printed or committed. It checks the immutable three-material
input with exact material IDs, versions and hashes, original quote, one measured `gpt-6-sol` call, one reserve and settlement,
no release or residual frozen balance, real browser downloads and file hashes,
17 independent output checks, then exact replay without another charge/call.
Rendering the generated clean/tracked output remains a separate required review.

After a harness interruption, first inspect the original receipt/task. Set
`BB_PRELAUNCH_SYNTHETIC_LONG_RESUME_DIR` to that private run directory and execute
only `local-prelaunch-synthetic-long-resume.spec.ts`. It restores the original
session and observes the same task without creating an account, project, payment
or task. Do not restart the creation spec to make up for an observation timeout.
The resume file also includes a read-only immutable-target check; select it alone
with `--grep 'verify the original immutable target without submitting'` when
investigating an observer assertion without waiting for the task to finish.
It records the test-script hashes, Git HEAD and actual running image identity.

The checker imports only the pure `word_inventory`/XML helpers from the existing
OOXML module. It never invokes its RQ baseline/authorized-file readers. Mechanical
checks do not prove full substantive correctness or Word/WPS compatibility.

## Input preparation verified on 2026-11-09

The external bundle `synthetic-long-fixtures-20261109-v3` has a 40-page source
and three-page notes. All 43 rendered pages were visually inspected. All six
financial tables continue across two pages with repeated headers; the diagram
and caption share a page with body text. The 14 internal directory links resolve
to the corresponding chapter pages. Original DOCX hashes remained unchanged.
See sibling `synthetic-long-render-v3/inspection.json` and
`synthetic-long-render-v3/toc-navigation-check.json` under the external quality
root. All six workbook previews match the already inspected v2 images exactly.

The saved workbook passed 24 typed numeric controls and both scope reconciliations.
Strict TypeScript checking passed; Playwright discovered the two creation/resume
tests. The 32 in-memory matcher cases passed. The original source used as both
outputs correctly fails (14/17 checks): current financial values and actual
tracked edits are absent. Earlier v1 (55-page overflow) and v2 (one blank page)
fixtures and their red evidence are retained. These preparation results do not
claim that the product has generated or delivered a passing long document.

The first actual submission was accepted as `e19a5883-342f-4563-b833-0f4b844a63b0`.
Its creation observer then failed by asserting the optional legacy
`target_confirmation` response. Read-only inspection verified that both the
immutable manifest and the actual model workspace `input.json` contain the correct
2026 Q3 target and all three unchanged materials. The observer now verifies the
immutable unified-authoring manifest, including the complete reporting window,
instead of the optional legacy DTO. Its original-task target recheck passed
without another account, payment or task. The original red observer evidence is
retained; this correction is not a document-quality pass.
