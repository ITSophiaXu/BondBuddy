# Local full-document quality acceptance

This is the authorized `rq-202509` case: the three unchanged originals, the same
issuer, SSE private offering, and the confirmed 2023/2024 plus January–September
2025 target. The browser test uses the actual local production API, PostgreSQL,
object storage, durable worker and the configured real `gpt-6-sol` / `max` model.
Payment is a synthetic channel that exercises the product payment transactions.
Do not submit the full run until the shared real-model window is available.

Customer evidence, prompts, screenshots and downloaded Word files are written
outside every Git checkout to `../quality-prelaunch-20261107`. The three source
files remain in the explicitly authorized sample directory and are checked by
SHA-256 before and after execution. Do not add the evidence to an issue or PR.

The financial baseline uses saved values of eight core cells and 30 additional
line items from six visible statements. It excludes hidden worksheets, does not
follow workbook links, and does not recalculate or approve financial facts.
`rq_q3_saved_error.py` records the location of formula errors: the visible-sheet
`D168` error is an isolated auxiliary formula outside that sheet's print area,
with no metric or period label; it is not used by the 38 controls.

The independent downloaded-Word checker covers 15 mechanical checks: source
chapter titles and nonempty body content, severe truncation, all 38 financial
controls in both outputs under the current period/scope/statement/unit, clean and
tracked semantics, XML parsing, source embedded media, page section geometry and
style IDs. Any conflicting current-period numeric candidate fails the relevant
control. These checks do not establish industry approval, complete substantive
correctness, or Word/WPS visual compatibility. Source formula caches remain
unapproved; missing or uncertain facts must remain marked for human review.
The checker records the delivered result independently and does not change the
product's download availability or run state.

The checker itself was verified with 19 synthetic in-memory cases, including
wrong units, prior periods, wrong scope/statement, conflicting current values,
prediction dates, and headings-only chapters. This does not create product runs
or generated documents. Reusing the original document as both outputs correctly
fails five of the 15 checks: current financial controls and actual tracked
changes. Its full red report is retained outside the checkout.

To run only the authorized real-sample browser case after the model window is
granted, use this PowerShell environment for that one test process:

```powershell
$env:BB_E2E_LOCAL_PRELAUNCH = '1'
$env:BB_E2E_REAL_MODEL = '1'
$env:BB_E2E_RQ_REAL_SAMPLE = '1'
$env:BB_E2E_BASE_URL = 'http://localhost:18087'
$env:BB_E2E_BROWSER_CHANNEL = 'msedge'
$env:BB_PRELAUNCH_EVIDENCE_ROOT = 'C:/Users/lezhai/Downloads/Bondbuddy/quality-prelaunch-20261107/billing-evidence'
node ../../node_modules/@playwright/test/cli.js test local-prelaunch-real-sample.spec.ts --workers=1 --reporter=line
```

Run the command from `apps/web`. Keep the detailed environment and account
evidence private. The test itself records `realCustomerInputs:true`, synthetic
accounts/channel, real immutable input, real model call journal, one settlement,
actual browser downloads, independent quality results and final original hashes.
A failed generator or checker must remain a red result until its cause is fixed;
do not manually finish a task, substitute a miniature Word, copy the original as
an output, or weaken the assertions to make this full-document case pass.
