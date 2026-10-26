# Desktop UX delivery — 2026-10-26

Refs #361. This integrates the user's completed desktop UX refinement into
`develop` at `030b0c5657bba34c921587d372e586c212de3d6a`. The original local
delivery contained 271 files against `ffd637fac6c1fdf1581112e728f21ec29a94c67c`.
The frozen delivery and its historical evidence remain unchanged outside this
checkout. This PR prepares a repository release; it does not deploy a service.

## Resulting behavior

- Project entry, authoring, periodic updates, project files, generation, review,
  questions and integrity checks retain the relevant project, draft, version,
  original request and saved result when the user returns.
- Uploads and uncertain submissions reconcile their original receipt instead
  of creating a second transfer, paid task, export or batch.
- Saving a prospectus retains a version without adopting it. Adoption has its
  own confirmation, identifies the chosen version and preserves existing task
  inputs. Saved versions remain discoverable after project reentry.
- File consistency distinguishes current inputs from historical conclusions,
  supports filename and status filters, preserves reading position, and shows
  the exact selected versions, manual items and total fee before an update.
- Review drafts remain recoverable while downloads identify the saved Word
  version. Artifact ID/run/version checks and download progress from current
  develop are retained, including the label for outputs without body revisions.

The integration resolves conflicts in `file-consistency.ts`,
`prospectus-panel.ts` and `review-editor.ts` rather than replacing the current
remote files with the older delivery. The remote embedded prospectus uploader,
selected-file card, replace/cancel actions, empty-state entry links and shared
stylesheet remain available alongside the refined version confirmation flow.

## UI reference

The existing baseline is `product-prototype/public/` at the develop commit
above, especially `prospectus-panel.html` and `prospectus-panel.css`.
Implementation files are `apps/web/src/prospectus-panel.ts`,
`file-consistency.ts` and `review-editor.ts`, with the UX styles in the same
directory. Desktop comparisons are in `visuals/`.

Intentional changes from that older prototype are the user's completed UX
refinement: saving and adopting are separate, version history exposes exact
references, and confirming a paid consistency update enumerates the original
files and charge. Saving never silently adopts a version. Existing phone work
is retained; no new phone acceptance claim is made.

## Verification

- Full workspace production build passes (API, worker and browser included).
- Web units: 882 passed, zero skipped or failed. This includes the check that
  all browser-imported prototype CSS survives the Docker context and COPY.
- Public contracts: 171 synthetic and 12 internal-library examples, lifecycle,
  OCR and generation-input binding checks pass.
- Project-file batch recovery API: 9 passed, zero skipped or failed.
- First merged browser group: 45 passed; one opt-in screenshot collector skipped.
  Covers confirmation scope, unknown receipts, saved-version reentry/adoption,
  original upload reconciliation, review draft recovery and verified downloads.
- Final additional browser and visual results are recorded in
  `validation.json`.

All browser HTTP fixtures and API route fixtures are synthetic. These results
do not claim real model execution, PostgreSQL/Blob integration, Word/WPS
compatibility, ledger acceptance or business-user acceptance. Historical
screenshot collectors require explicit local baseline inputs; current product
assertions run without the author's external evidence directory.

The `Desktop UX integration` workflow repeats the build, contract, unit, batch
recovery and merged browser checks on the actual Linux PR merge tree, in
addition to the repository's existing integration workflows.

## Deployment handoff

This change adds no database migration and no required environment variable.
Deploy the API and browser from the same release commit because the browser
handles the shared `PROJECT_FILE_BATCH_INPUT_EXPIRED` error code. The standard
release builds API, worker, web and egress images together.

After review/CI and the normal `develop` to `master` release PR, deploy the
merged master SHA on the configured deployment host with the existing command:

```bash
bash deploy/m1/scripts/deploy.sh <merged-master-sha>
```

Keep the previous release SHA/images and existing environment configuration.
The script builds from `git archive`, applies the existing migration set,
switches the stack, records the release and runs its smoke check. The Docker
build context now explicitly includes `prospectus-panel.css`; a source build
alone would not have caught its prior omission.

After deployment, verify login/project entry; save a prospectus without a
current-selection change; explicitly adopt it; inspect and cancel a consistency
update before confirming; reopen an existing task; and download the saved Word.
Use an authorized test project for any operation that creates a real task.

If needed, use the existing rollback command with the captured previous SHA:

```bash
bash deploy/m1/scripts/rollback.sh <previous-release-sha>
```

There is no new schema change to reverse in this PR. Real Docker image builds,
production smoke tests and real-service acceptance are deployment-stage work
and have not been executed by this repository publication task.
