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

The checker itself was verified with 51 synthetic in-memory cases, including
wrong, conflicting or unsupported units; missing current-value cells; prior or
mixed periods; wrong or conflicting scope; conflicting current values;
prediction dates; and headings-only chapters. Historical tables and valid
in-table statement titles retain their own scope and units. This does not create product runs
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

## Read-only Word rendering on this Windows host

`render_docx_readonly.py` calls the documents skill's `render_docx.py` with the
bundled Windows Python and Poppler. This host has no bundled Windows LibreOffice;
the explicit conversion bridge uses the existing `/usr/bin/soffice` in WSL
`BondBuddyM3` (24.2.7.2). It runs only the converter and font matching in a new
network namespace, with a temporary LibreOffice profile and fontconfig cache.
It reads installed Windows fonts without copying or installing them. It does not
start the user's desktop office application or change its profile.

Resolve the current Python and renderer paths from the workspace dependency
loader and documents skill. From the repository root:

```powershell
& '<bundled-python.exe>' scripts/local-quality/render_docx_readonly.py '<downloaded.docx>' `
  --renderer '<documents-skill>/render_docx.py' `
  --output-dir '../quality-prelaunch-20261107/<unique-render-directory>'
```

The output directory must be new and inside the private evidence roots. Customer
input renders and all customer-generated output renders belong outside the Git
checkout. The original is hashed before and after; conversion receives a separate
copy. The bridge does not repair malformed OOXML paths. WSL uses `--exec` so file
names and font-match formatting are passed as arguments, never shell commands.
The receipt records exact bridge/renderer hashes, runtime, font matches, command
results, page/PDF hashes and whether the input remained unchanged. Old failed
receipts stay in their original directories.

Open every generated page image at full resolution and record the inspection in
the private evidence directory. Rendering success alone leaves visual inspection
pending. A render of the original establishes a source baseline only; a one-page
synthetic result does not establish full-document preservation. LibreOffice
rendering does not prove Word/WPS compatibility or financial correctness.
