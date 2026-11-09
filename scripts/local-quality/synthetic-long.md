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

## Completed actual synthetic product run: 2026-11-09

The original task `e19a5883-342f-4563-b833-0f4b844a63b0` completed on production
image source `76b8e3c1dece9b50a745c3ff4e144f63d88aebfc`. Its final observation used
test-source HEAD `aafd5f76e6e7a7b4b5edd272a02fd1748a1de432`; the observation records
the individual script hashes separately from the running image. The final record
is `synthetic-long-run-2026-11-09T02-38-12-193Z-e1ec14d5/observation-2026-11-09T02-49-30-500Z.json`
under the external quality root. It has `status:passed`, `finalized:true`, empty
errors/page errors and a complete final ledger. Observation created or resumed
no task; the accepted original run was preserved after the initial harness failure.

The real downloaded clean and tracked Word files pass **17/17 mechanical checks**,
including all **24 financial controls in each output**, all 14 chapters, six tables,
26 retention anchors, media, styles, section geometry, repeated table headers and
directory/bookmark relationships. Accepting tracked changes matches the clean
body; rejecting them matches the original body. Both browser download hashes were
independently rechecked against the saved files after rendering.

One completed, measured `gpt-6-sol` call produced the result. The local ledger has
one run, one reservation, one 8,864-point reserve event and one 8,864-point settlement,
with no release event. The synthetic-channel recharge credited 1,000,000 points;
the final balance is 991,136 available and zero frozen. Exact original-request
replay leaves the complete ledger and model-call count unchanged.

Both generated files render to **43 pages**, and all **86 pages** were inspected at
their original rendered resolution. No clipping, overlap, garbled text, completely
blank page, missing image or missing repeated table header was observed. This is
**completed visual review with retained layout findings**, not a flawless-layout
pass: page 6 contains only two ending lines, page 31 contains a four-line financial
explanation, and several table-following analysis paragraphs have tight spacing.
The tracked review also notes substantial unused space after the table tail on
page 20. The original inspection findings remain unchanged in
`synthetic-long-generated-render-20261109/{clean,tracked}/inspection.json`.

The same run's `pagination-investigation/pagination-root-cause.json` records that
`styles.xml` bytes are unchanged, all 32 original explicit page breaks remain,
and the 15 inserted paragraphs add no pagination properties. Added disclosure
naturally overflows before preserved page breaks; no inherited pagination-property
defect was established. This supports retaining the sparse-page/spacing warnings,
not deleting disclosure or silently editing generated outputs. Source and output
hashes remain intact. LibreOffice inspection does not establish Word/WPS compatibility
or professional financial approval.

Together with the 38 distinct functional cases on `fc76c9c7`, this is the **39th
functional scenario**. Observation retries, target rechecks, and the 32 synthetic or
51 RQ matcher cases do not increase that count. The ignored combined record is
`.local/receipts/final-functional-with-synthetic-long.json`; the original 38-case
summary and all red attempts remain preserved.

The three RQ originals have explicit user authorization for this acceptance through
`https://api.enterprise.githubcopilot.com/` using `gpt-6-sol`. Their separate task
`97d26241-09fc-4338-a2bf-9f1253ef5ace` is being observed and is not included as a pass
in this synthetic result. The later single-start UI image
`50554262e64962785cb964440ebf5e250d333269` is running and passed its expanded real
zero-balance source-correction case in 32.5 seconds. That focused UI repeat does not
change this generated-document result's `76b8e3c1` image identity. See the
[UI acceptance record](../../docs/acceptance/local-prelaunch-20261109/README.md).
