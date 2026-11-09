# Desktop prelaunch bad cases (real local stack)

This suite uses the public HTTP API, real cookie authentication/CSRF, dedicated PostgreSQL,
private Azurite objects, and the real Python material worker. It does not inject a principal,
fabricate an API response, seed a successful task, or call a model. All account names and
documents are synthetic. It performs no real payment or production operation.

## Run

First build and start the current checkout with `scripts/local-prelaunch/`. The environment
must have its own `.local/local-prelaunch/config.json` and answer at `http://localhost:18087`.
The helpers validate the origin, instance ID, Compose project name, and isolated database name.

From the repository root on Windows:

```powershell
$env:BB_E2E_LOCAL_PRELAUNCH = '1'
$env:BB_E2E_BASE_URL = 'http://localhost:18087'
$env:BB_E2E_BROWSER_CHANNEL = 'msedge'
$env:BB_PRELAUNCH_WSL_DISTRO = 'BondBuddyM3'
npm run build -w @bondbuddy/contracts
node node_modules/@playwright/test/cli.js test --config=apps/web/playwright.config.ts local-prelaunch-bad-cases.spec.ts local-prelaunch-material-identity.spec.ts --workers=1 --retries=0 --reporter=line
```

The encrypted PDF fixture uses `BB_PRELAUNCH_FIXTURE_PYTHON` if set, otherwise the bundled
desktop Python path on Windows or `python3` on Linux. It requires `pypdf`. On Linux run
the same Playwright command with a local installed browser and omit the Edge channel.

Optional controls:

- `BB_PRELAUNCH_CONFIG`: explicit path to this instance's configuration JSON.
- `BB_PRELAUNCH_EVIDENCE`: evidence parent folder; defaults to `.local/local-prelaunch/bad-cases`.
- `BB_PRELAUNCH_EVIDENCE_RUN`: unique invocation label for a coordinated acceptance run.

Each test registers an actual local account through the UI. The suite uses 22 accounts for
21 cases (the ownership case needs a second account); keep local registration admission
limits large enough for these synthetic accounts while preserving normal authentication.

## First batch: 16 cases

| Case | Expected real behavior |
| --- | --- |
| Financial materials alone; incomplete source metadata | Start is disabled with a concrete explanation. Input lock rejects missing source/information. Fill source fields, reload, lock and quote successfully. |
| Wrong market/product; impossible reporting date | API rejects both without saving a project. Correct project can be saved/opened. |
| Unsupported browser file | Actionable replacement; no upload write or misleading retry. The replacement saves and downloads exactly. |
| Zero-byte browser file | Actionable error; no upload write. A valid file can then be selected. |
| Zero size, unsupported MIME, over-limit API declarations | Reject before creating any upload or material. A normal browser upload still works. |
| Short PUT; same-size incorrect hash | Real API rejects; no private Blob or material. Original declaration accepts correct bytes; duplicate PUT/complete return one material. |
| Interrupt before PUT reaches server | Retry selected file; original upload ID is retained and one material exists after reload. |
| Lose PUT response after server commits | `route.fetch` reaches the real server, then `route.abort` loses the browser reply. Automatic reconciliation saves one original upload/material. |
| Lose complete response after server commits | Same mechanism; reconcile the existing real completion and recover after reload. |
| DOCX bytes declared as PDF | Raw upload stores exact bytes; legacy real Python parser fails and UI offers readable recovery guidance. Normal replacement parses. |
| Damaged DOCX | Same actual parse failure/recovery chain. |
| Truncated DOCX | Same actual parse failure/recovery chain. |
| Corrupt PDF | Same actual parse failure/recovery chain. |
| Password-encrypted PDF | Real password encryption; `MATERIAL_ENCRYPTED` and unencrypted-copy guidance. Normal replacement parses. |
| Empty-content DOCX | Preserve actual parser outcome and inspect persisted parse evidence for no invented nonempty quote. Normal replacement parses. |
| Foreign account | Read, download, delete, input lock and execute denied without filenames leaking or task/credit writes. Foreign account can create/use its own project. |

The current unified authoring path intentionally stores supported original bytes opaquely and
does not start an auxiliary parser at upload. The bad-content tests explicitly use the existing
legacy material-processing path to inspect the real parser and UI. This establishes parser
error/recovery behavior, not the quality of a complete unified model-generated document.

Three additional material-identity cases cover renamed equal bytes with role-specific
deduplication, changed source adoption/metadata and stale pins, and same-account material
pins from a different project. Every rejected identity is corrected through the real API/UI
before a successful saved input, without executing or charging a business task.

Two financial-material cases upload malformed and truncated XLSX bytes into the financial/audit
partition, wait for the real Linux/Python parser failure, and then upload a valid native synthetic
financial workbook. The replacement must parse successfully and persist real cell evidence;
all periods/figures are explicitly synthetic. Upload admission is still raw byte storage.

## Evidence and assertions

Every test saves `evidence.json` with the synthetic account owner, local instance/database,
test source SHA256 values, real HTTP statuses, before/checkpoint/final SQL snapshots, errors,
and `final.png` or `red.png`. Passwords and cookie values are not captured. Each invocation
gets a fresh directory; red evidence is retained when a later run passes. Playwright attaches
the JSON evidence to its own result as well.

At each relevant rejection/recovery point, direct `docker exec psql` assertions verify no new
`bb_runs`, `bb_credit_events`, `bb_credit_reservations`, or `bb_model_call_attempts`, and no
change in remaining/frozen credit lots. Auxiliary material parse jobs may be created. Saved
files are downloaded through the actual authorized API and compared with original bytes/hash.
The PUT mismatch case additionally reads the private Blob from inside the local API container
and verifies no object was written. SQL and container commands use argument arrays/stdin;
no shell interpolated SQL or credential printing is used.

## Remaining complete-acceptance cases

These are planned coverage, not claims that the first batch passed them:

- Two-tab duplicate upload; wrong hash or nonexistent material version in a pin.
- Ambiguous XLSX directory mapping; correct mapping and resume the original import.
- Upload interrupted across browser/context closure before reconciliation, and expired session.
- True password-encrypted Office files; the first batch covers a real encrypted PDF only.

The later final-image run below covers unified bad-file correction through actual model/Word
delivery and the payment, reservation, release and recovery cases. It does not turn the
first-batch parser tests into full-document quality acceptance.

## Recorded local run: 2026-11-07

The command above completed against instance `45811ffb-4ea8-4ee2-92d5-44c96cdae454`:
**21 passed, 0 failed, 3.6 minutes**. This was a real local HTTP/browser/PostgreSQL/Blob/Python
run, not the earlier fixture-only preparation checks. All 21 final database observations
confirm unchanged run, credit-event, credit-reservation and model-call counts, and unchanged
remaining/frozen credits. Both corrected native XLSX files persisted 15 nonempty cell quotes.

The first attempt retained 15 passes and six failures in separate `red-*` directories.
Four failures used a nonexistent material-list endpoint; recovery actually uses the public
project-events API followed by material reads. Two failures selected a file during execution
restoration: `setInputFiles` can dispatch even while the real picker is disabled. The helper
now waits for the actual input to be enabled rather than testing the fieldset. No fixed sleep,
fabricated response or silent re-selection was added. The full 21-case run then passed.

The retained local evidence folder is
`.local/local-prelaunch/bad-cases/corrected-harness-2026-11-07T02-42-12-751Z-57c67e9a/`.
Its `summary.json` checks all final observations and records SHA256 for each case's evidence;
each case also retains its final screenshot. Source hashes in the evidence identify the tested
test files. Build/container identity is recorded separately by the local environment receipts.
These parser/recovery results do not claim full model-output quality or payment acceptance;
the generation and payment suites own those checks.

## Final-image functional run: 2026-11-09

The same isolated instance ran production image source
`fc76c9c7e74aa420cba8a97962fc4e422565ee44`. The final functional result is
**38 distinct cases passed: 24 input/material + 8 payment without model + 6 worker cases**.
Earlier attempts and historical runs are not counted as additional cases.

The 24 input/material cases comprise the existing 21 bad-file/identity cases, two browser
input-correction cases, and one source-declaration correction case. That additional case
changes valid but mistaken issuer relationship, market/offering and report period through
the UI, then checks reload, immutable input and quote against the corrected declarations.
All 24 final account-scoped database observations preserve the original task, reservation,
credit-event and model-call counts and remaining/frozen points.

These 24 cases and the eight payment cases passed together in **5.0 minutes**, with one
worker and zero retries. Their evidence roots are:

- `.local/local-prelaunch/bad-cases/final-fc76-nonmodel-2026-11-09T01-53-02-466Z-420a6094/`
- `.local/local-prelaunch/billing/final-fc76-nonmodel-wsl/2026-11-09T01-56-04-288Z-5f7fc007/`

The six worker cases cover normal authoring, corrupt adopted DOCX followed by a corrected
immutable round, QA recharge recovery, QA unreadable-reference release, and old-policy
credit exhaustion before/after model completion. The corrected DOCX case confirms one
failed attempt before model use, exact release, actionable recovery, a new input revision
and run, one successful model call, actual dual-Word downloads and one settlement. The old
failed run and its ledger remain unchanged. Details are in
[the billing record](local-prelaunch-billing.md#final-image-revalidation-2026-11-09).

The first worker batch retained **5 passes and one harness failure**: the test incorrectly
expected `next_cursor` to be null after the final event. The API preserves its last event
cursor. The corrected assertion checks that cursor against the terminal run, then requests
the next page and verifies an empty page with the same cursor. The corrected bad-file case
passed separately in **1.8 minutes**. Its original red evidence and log remain unchanged;
no task, ledger or generated result was changed to repair the assertion.

The earlier sandbox attempt also remains preserved: WSL denied the fixture's initial
read-only database observation, so it was stopped before business assertions and rerun
with the reviewed WSL permission. Its prematurely saved `status: passed` values are not
acceptance evidence; the failure log and `final-database-error` establish that failure.

The combined `.local/receipts/final-fc76-functional-summary.json` records all 38 selected
evidence paths and SHA-256 values, excluded failures and source logs. Each selected result
was independently checked for empty errors/page errors and a complete final database or
ledger observation. Worker debit totals, preserved recovery identities, measured model
attempts and actual downloaded file hashes were also checked; status alone was not used.

Accounts and payment-channel outcomes are synthetic; HTTP, PostgreSQL, Blob, Python,
worker execution and five completed measured `gpt-6-sol` calls are real. These are focused
functional and recovery checks. The authorized long-form sample and its complete content/
rendering acceptance remain unfinished; this result does not claim real merchant payment
or final full-document quality acceptance.
