# Cross-entry PostgreSQL delivery and recovery evidence

This archive records local execution of 18 existing critical PostgreSQL test files: nine API files and nine worker files. The original 17 cross-entry files use synthetic materials/models. The additional annual-fact integration reads one already-authorized historical DOCX with the real local parser; its database identities and reviewer authorization are synthetic, and it calls no model or external website. Each file has a successful execution at the source/build hashes in [results.json](results.json). These are unchanged successful first-run files and targeted successful reruns, not one all-green combined rerun.

The runtime subject is `da5974ba96d318c1dbdc6c9c22909099d220c41b` plus five final test-fixture files captured by [final-test-fixtures.patch](final-test-fixtures.patch). Changes include lawful HTTP int64 strings, explicit synthetic queue setup for the review fixture, and new QA mixed-material quality/recovery/accounting assertions. No runtime product file changed in this follow-up. Both raw-byte and LF-normalized source SHA-256 values are recorded for comparison with Git-normalized blobs. The earlier protocol/queue-only patch remains as [pre-mixed-test-fixtures.patch](pre-mixed-test-fixtures.patch).

All original first failures and intermediate failures are retained byte-for-byte together with their original metadata. Counts below are per execution, including imported/nested units. Do not add runs together; each of the two workpaper test processes imports 11 catalogue unit tests. Every run has zero cancelled, skipped and todo tests. The final QA binding points to its expanded mixed-material run; the earlier successful wire-only run keeps its own original binding.

| Execution | Tests | Pass | Fail | Seconds |
| --- | ---: | ---: | ---: | ---: |
| api-nine-first | 12 | 11 | 1 | 184.45 |
| api-review-wire-retry | 1 | 0 | 1 | 10.07 |
| api-review-runtime-retry | 1 | 1 | 0 | 12.70 |
| worker-files-first | 10 | 9 | 1 | 64.87 |
| worker-files-wire-retry | 1 | 1 | 0 | 35.96 |
| worker-workpapers-first | 24 | 23 | 1 | 46.58 |
| worker-workpapers-wire-retry | 12 | 12 | 0 | 30.99 |
| worker-qa-first | 1 | 0 | 1 | 27.06 |
| worker-qa-wire-retry | 1 | 1 | 0 | 29.81 |
| worker-integrity-first | 1 | 0 | 1 | 20.50 |
| worker-integrity-wire-retry | 1 | 0 | 1 | 28.33 |
| worker-integrity-wire-retry-2 | 1 | 1 | 0 | 24.78 |
| worker-m4-case-first | 1 | 1 | 0 | 26.74 |
| worker-qa-mixed-materials | 1 | 0 | 1 | 19.94 |
| worker-qa-mixed-materials-query-fix | 1 | 1 | 0 | 23.09 |
| worker-rq-annual-pg-first | 1 | 1 | 0 | 29.43 |

The expanded QA scenario pins a readable adopted mandatory prospectus and a valid supplementary DOCX with no extractable text in the same draft. It verifies both source pins; a named partial-extraction gap in result and Word; a useful answer citing exact readable spans; a second answer with specific missing evidence; the saved answer/hash unchanged across pause/resume; exactly one durable model intent per question; and a single 120 settlement for the confirmed two-question scope. Replaying the completed request adds no run or credit event. The existing mandatory-unreadable-prospectus failure before model calls, complete release and no artifact remain tested. This is text-extraction partial coverage, not tolerance for missing or hash-mismatched Blob inputs, malformed packages, real model judgment or new insufficient-funds coverage.

The first mixed-material execution failed because the added test SQL queried nonexistent `bb_model_call_attempts.run_id` (42703). The final query joins `bb_jobs` by job and owner; the same file then passed. This is a test-query defect, not a product bug. Earlier, the Integrity wire-retry fixture mistakenly changed the deliberately invalid number `expected_points:1` into string `'1'`, reaching business 409 while the assertion remained wire 422. Its final run restores number 1 and preserves 422. The API wire-retry reached `CAPABILITY_NOT_READY` at the initial pause, before resume; its final fixture adds `enableSyntheticQueue:true`. No separate run using only `enableRunRuntime:true` was performed. Other first failures were stale HTTP number fixtures or the absent QA output-directory environment variable.

The annual-fact integration passes 1/1 and persists 16 fail-closed candidates from the already-authorized historical DOCX through real local parsing, material readiness, controlled producer and isolated PostgreSQL. Sample case/file/SHA and source/build bindings are recorded in its original metadata. No original sample, fact ledger payload or generated file is copied into this archive. This is limited parser/persistence evidence, not complete financial or generated-document acceptance.

Execution used Node v26.13.0, npm 11.20.0, TypeScript 5.9.3, Python 3.12.14, PostgreSQL 16.14, Azurite 3.35.0 and Chromium 153.0.8010.12 (Playwright revision 1243) on Windows. The archived compilation commands exited 0. The earlier protocol-stage build and all three later QA build captures are retained; the final build/source hashes match the final QA execution. Exact commands, run-specific source/build digests and raw log digests are in the aggregate and original metadata.

The PostgreSQL/API/worker, Blob storage, browser and native Word pipelines ran. Cross-entry models/materials and Integrity routes were synthetic, with the separate authorized historical parsing exception described above. The six default M4 scopes produced native document/preparation pairs through the real worker path with one settlement per scope. This evidence does not establish real merchant acceptance, real model quality, independent industry/full-text/rendering acceptance, PR #871 candidate integration or a complete Linux quality-gate run.

Task-owned PostgreSQL and Azurite services were restored for the added QA and annual-fact runs, then stopped after both owners closed their test pools and maintenance connections. Before the final smart PostgreSQL stop, no clone database or other client remained; `pg_ctl status` returned 3 and ports 55434 and 11066 refused connections. Both lifecycle cleanup records remain archived and local data directories are retained.

The environment file, connection strings, keys, original samples, generated Word/PDF/screenshots, browser binaries, database files and ledger payloads are excluded. Archived raw logs were scanned against configured local credentials without altering their bytes. [SHA256SUMS](SHA256SUMS) covers every other file in this directory.
