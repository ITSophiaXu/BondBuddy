# Audit PDF quality gate and bounded sampling release candidate

This fixed package carries PRs #1591, #1605 and #1610 into the inspected production component mix. Uploaded audit PDFs in update projects receive a separate no-OCR/no-model quality job. Low-resolution evidence blocks the next step, input locking, quotes and new execution until replacement. v3 checks at most eight representative pages, stops at the first low-resolution page, and reuses valid v2 receipts. Sampling does not guarantee coverage of financial statement pages or every low-quality page.

## Exact scope

- Source: develop merge `25de37d1d1e8efc82edafa163d437dc89eb7b122`; dependencies #1591 `79c7b3678d729788831d9d669a0e005f4fea26f0` and #1605 `5d7c3e5f2212cd504562bb75eaed17ec57a65de6`.
- Release base: master `c03084e0aac4a105b22a1ed5466d5ae4b3c50121`.
- Tencent API: eight runtime files. Web: seven assets, rebuilt from the reproduced current production source composition.
- Azure parser: eight runtime files; independent upload confirmation: four runtime files. The latter is necessary for upload completion to enqueue inspection immediately.
- No database migrations, additional dependencies, model calls, accounting changes, compilation/review worker updates, cloud networking changes or capacity changes.
- Retain each actual immutable image, credentials, mounts, environment, networking and process settings. Parser must preserve its existing `/opt/venv/bin` PATH. The image default alone lacks that PATH; changing it would break PDFium resolution.

`manifest.json` binds all 27 files, exact before/after hashes and archive hash. `runtime-scope.patch` contains only the three PR deltas applied to actual live files after normalizing CRLF. The only semantic conflict resolutions add the PDF exports without adding an unrelated account-recovery export. `web-scope.patch` applies to the already deployed #1531 browser composition; all seven current production assets were reproduced byte-for-byte before applying it. Existing task scheduling, audit-required, encrypted-upload and integrity-site changes are retained. This is a fixed composite; do not describe the old images as rebuilt from the final release commit or deploy the whole master/develop stack.

## Verification

- Candidate contract and web builds pass. Exact original web baseline: 7/7 byte-identical.
- Existing production API image plus all its actual code overlays and this candidate: 7/7 isolated tests pass.
- Existing parser image plus candidate and the actual production PATH: 4/4 pass, including real PDFium over synthetic 120-page low DPI and 1600-page clear PDFs. Checked pages: 1 and 8; measured detector times approximately 152 ms and 119 ms in that run, excluding upload, hashing and queue time.
- Independent upload-confirmation image plus candidate: 2/2 pass.
- Exact built web bundle in Edge: 8/8 pass at 1440/390 px, including low-quality blocking, retry, replacement, retained audit-required checks and v3 sample-count wording. Business HTTP responses are synthetic fixtures; this is not production upload acceptance.
- Development evidence remains in `docs/acceptance/audit-pdf-quality-sampling-20261118.md`: actual isolated API/PG16/Azurite/worker chain 6/6, other relevant integration 10/10, full builds and contracts, Python and browser checks. These are not relabeled as tests of the mixed production package.
- Initial canaries intentionally exposed incomplete test setup: omitted existing API overlays; omitted the parser's actual PATH; an incorrect upload-completion export name in the test. Final runs correct the harness, not production behavior. Original logs remain in the private work directory.

## Release gate and status

The user's instruction to deploy #1610 authorizes preparation and deployment of this batch. The current repository release policy separately requires a current commit/tree real-model golden bundle and independent human document review. No such receipt exists for this candidate; `full_quality_gate_passed=false`, `independent_human_document_acceptance=false`. Earlier release exceptions do not apply automatically. This candidate has not been activated, no production service has been restarted, and no deployment or user acceptance is claimed. Do not merge/activate on these scoped test results alone without the required receipt or an explicit user decision changing the gate for this exact batch.

## Controlled activation and rollback plan

Before activation, refresh origin/master and all four actual component identities, effective file hashes, existing configuration/deploy locks and pending receipts. Preserve fresh private before-configurations, container inspections and shared component manifests. Reconcile any unknown operation before retrying. Enforce the runbook's free-space margin; preserve any archived data and restoration metadata.

Use the existing host-specific deployment locks, create-only configuration probes and `--no-deps`. Drain the parser and independent confirmation consumer gracefully; do not stop managed authoring/review jobs or unrelated containers. First establish a parser able to consume v3, then update the producer/API and confirmation consumer, and finally refresh web. Preserve all old parser versions and v2 receipts. Apply no migrations. Keep a durable batch pending receipt until all four effective file sets, process configuration and health have been verified.

Post-activation requires a synthetic authenticated upload through the real public/API/private storage/confirmation/parser path: low PDF blocks; clear replacement restores readiness; incomplete checks remain blocked and retryable; direct input/quote/execute cannot bypass it; no model/credit reservation from the low-quality rejection. Verify actual hashes, polling UI and existing task continuity. Record this separately from document generation and user acceptance.

Rollback uses the same locks, requires this exact batch still current, and restores the preserved component configurations/images; no database or customer/accounting restoration. Roll back producers/API/web before retiring v3-capable parser code. Retain the compatible parser while any v3 jobs remain queued/running, or explicitly drain them first; never let an old parser claim v3 jobs. Do not overwrite another batch's later changes.
