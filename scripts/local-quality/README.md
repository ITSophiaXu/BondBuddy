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

## First actual RQ result and retained content failure: 2026-11-09

Original run `97d26241-09fc-4338-a2bf-9f1253ef5ace` completed on image `50554262`.
The creation observer passed in 31.1 minutes: both actual downloads match storage
hashes, 15/15 mechanical checks and 38 financial controls per output pass, and one
measured model execution settles the original 8,864-point quote exactly once.
Original-request replay leaves the ledger unchanged. These results remain preserved.

Independent semantic review then found current-period definitions left at the old
half-year, narrative amounts/ratios inconsistent with updated tables, and an unclear
debt-principal formula. The user-facing delivery note also exposed internal paths,
hashes and tool operations. This is a **content/experience failure**, not a passing
RQ acceptance or a reason to silently replace the Word files. It does not change the
product's generated-file availability policy or retrospectively alter the original
15-check mechanical report.

Private evidence is under
`../quality-prelaunch-20261107/2026-11-09T03-17-00-444Z-00c6c2b2/`, including the
original words, `rq-q3-quality-report.json`, `rq-narrative-semantic-review.json` and
read-only render receipts. Clean renders to 246 pages and tracked to 248; complete
visual acceptance is not claimed for these content-failing outputs. General
generation guidance and independent narrative checks are being strengthened before
a separate actual revalidation; customer numbers are not copied into synthetic tests.

## Separate narrative and user-note checks

`rq_q3_narrative_check.py` adds five bounded checks per output: flow and balance
period definitions, current nonoperating-expense narrative, one-year debt narrative,
and the disclosed treatment of interest in the debt definition. Controls come from
the authorized original statements and notes, with independent component/total
reconciliation; generated tables cannot supply expected amounts. Explicit principal
and interest-inclusive treatments are distinguished. Unknown formulas or ambiguous
periods/scopes require clarification rather than a passing result. This does not
replace manual checks of qualitative claims or source-note inconsistencies.

The first frozen checker passed **58 purely synthetic tests**, including mixed dates, conflicting
scope, incomplete/extra amount sequences, conflicting definitions and ratios, and
valid historical comparisons. A root recheck of the original failing pair still
returns **0/10, exit 1**, while original Word, mechanical and manual-review hashes
remain unchanged. The new private report is under
`narrative-independent-recheck-20261109T041708-ac410786/` in the original run folder.

The actual browser observer now checks the Artifact API's user-facing delivery note
for bounded internal-execution details. Its **16 synthetic boundary/evidence tests**
pass; that lexical result alone does not establish business completeness. Each
creation/resume observation writes its reports and screenshot into a new
`quality-observation-*` directory, records checker source hashes and preserves
earlier reports. Existing downloaded bytes are reused only when their SHA-256 still
matches the actual artifact; different bytes never overwrite saved evidence.

Generation prompt/template v3, committed in `05ed9bc1`, addresses fact-location
coverage, definitions, table/narrative/formula consistency, unsupported qualitative
claims and user-facing explanations. Static and focused worker checks pass; actual
full-document revalidation was performed separately below.

## Second actual RQ result and bounded observer correction

New task `303d314f-d8b4-44cf-a3f4-78ec1408c04b` ran on `05ed9bc1` / template v3,
using only the three explicitly authorized originals. It succeeded after 33.2 minutes,
with 15/15 mechanical checks and 38/38 financial controls per Word. The original
8,864-point quote settled once, one measured model call completed, frozen balance
returned to zero, and original-request replay left the complete ledger unchanged.
The public delivery note passed its bounded internal-detail check. The original
observer nevertheless finished red because its frozen narrative checker returned
6/10; that report and the original files remain unchanged.

Two independent semantic reviews compared the authorized originals, source caveats,
definitions, narratives and formulas. Current short debt, total debt and the ratio
reconcile with independently extracted source controls. The delivered definition is the sum of
seven carrying-value components, excluding separately reported interest. It uses
amortized bond carrying values; it must not be described as face principal. The
checker's historical internal key `principal` does not redefine that accounting basis.
Source contradictions remain in anchored comments and the user-facing delivery note;
unsupported business material remains pending confirmation.

The observer was then corrected for valid carrying-value wording and made conservative
about unknown entities, negated definitions, conflicting bond measurement, simulated
liquidity scenarios and mixed stock/flow dates. Its final `4827c8e4` version passes
**113 synthetic tests** and **21 independently rerun probes**. No customer output was
changed to accommodate the checker, and no new model call was made for these rechecks.
The original defective pair remains **0/10**. The second pair is **8/10**: both
one-year-debt narrative checks remain `clarification_required` because the bounded
parser does not establish all document-wide issuer/period links. These are not
reported as automatic passes or as fresh generation failures. The separate manual
reviews record the wider context explicitly; unsupported wording remains conservative.

Private evidence is under
`../quality-prelaunch-20261107/2026-11-09T04-21-40-551Z-a9776370/`:
`quality-observation-2026-11-09T04-54-24-940Z-3a506863/` retains the original 6/10,
semantic and transaction reviews; `narrative-113-independent-recheck-20261109T0529/`
retains the later 8/10. Clean SHA-256 is
`e5565aa696355830c8b7d939e0c57f5e7cd92d0c2e430faa4491410175af4ce9`;
tracked is `caad858c5210eddad776ad3edeef705faeaaf41692d894d8219fd8feb96a5334`.

The new files render to 246 clean pages and 253 tracked pages. Full visual review is
complete under `visual-review-v1/complete-visual-review.json`: all 486 unique PNGs
were actually inspected across 21 batches; 13 exact duplicate PNG hashes account for
the other page instances. The record covers all 499 pages with zero uninspected pages,
and retains all findings rather than declaring flawless layout. Source comparison confirms inherited split numeric lines and clipped
project-name cells. In the affected table, all 37 exact row heights, column widths and
name cells match the original in both outputs. These visible risks remain findings;
they do not become a flawless layout result merely because the source also has them.

The final independent layout diagnosis inspected 13 corresponding source/clean/tracked
pages. Tracked pages 149 and 163 have visible LibreOffice revision bars crossing text
in inherited wide tables; table widths, grids, borders and affected first-cell XML are
unchanged. This is a retained display finding, not evidence of new table corruption.
The page-150 overlap attribution was corrected: its line is in empty cell space.
Repeated numbering in tracked page 231 also matches the original source. Neither
the comparisons nor mechanical hashes establish Word/WPS compatibility.

## Rendering-observer boundary

The short current-authoring cashier case exposed a Windows output-path limit:
LibreOffice produced one-page PDFs, but Poppler returned zero PNG paths for deeply
nested output directories. Both original receipts remain preserved. The wrapper now
rejects zero page images instead of calling that a successful render. A targeted long
path reproduced the guarded failure; new short directories rendered one page per Word,
both actually inspected. No business task or model was repeated for this correction.
