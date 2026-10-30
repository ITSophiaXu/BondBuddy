# Project Q&A answer review

Status: development and targeted self-tests complete; real-model validation and user acceptance pending. Code is not deployed and must go through the designated integration/release workflow.

## Problem and behavior

Verbatim citations do not prove that an answer converts an amount correctly, retains the cited business scope, or answers every part of a compound question. For example, a source can say `123,456.78万元` while a draft incorrectly says `123.46亿元`, or a subsidiary-specific disclosure can become an unsupported group-wide conclusion.

Each new question now has two separately journalled stages. The first produces a grounded draft; the second receives the original question, pinned evidence selection, draft, and exact decimal conversion hints from explicitly denominated cited amounts. It returns a complete answer after checking units, accounting scope, entity/business scope, contract terms versus actual performance, and all requested subparts. Known facts remain in the answer; only unresolved parts belong in the existing `missing_materials` fields.

The amount hints are exact decimal shifts, not a semantic proof or automatic correction. Bare table cells do not acquire inferred units. The review remains a model judgment; its real-world correction rate has not been measured for this change.

Only a completed, citation-validated review reaches the per-question answer checkpoint and Word export. A paused, failed, or stopped review never falls back to the draft. Resume reuses the draft prompt and durable result. Already persisted question answers and completed runs retain existing replay semantics and are not rewritten.

New answer/table/citation paragraphs opt out of an inherited document grid. New table rows cannot split across pages; repeated table headers remain enabled. Original questions and package headers/footers are preserved.

## Validation

- Rebuilt contracts, domain, rule-pack registry, rule-applicability context, API and worker in an isolated local test image.
- 14/14 targeted worker tests: evidence selection, citation handling, decimal shifts, two-stage input/output, and review failure/pause/stop propagation.
- 1/1 complete project-Q&A backend scenario against private local PostgreSQL and Azurite: real API, queue, immutable inputs, prompt snapshots and durable journal, wallet, Python Word generation, authorized download, ownership isolation, versions, failure refunds and unreadable-prospectus handling. Model replies were **synthetic**.
- The backend scenario pauses after the draft, verifies zero final question-answer rows, resumes without a second draft charge/call, and proves that Word uses the synthetic reviewed amount rather than the deliberately incorrect draft. Two questions use four completed draft/review calls while the product still settles the existing two-question fixed price.
- 9/9 Python project-Q&A tests passed in the Linux test image, including legacy DOC conversion. Windows initially ran 9 with 1 converter-dependent skip; the Linux run covers it.
- Local render comparison of the same existing answer text: 28 pages before and 16 after; all pages inspected. All four answer tables retain their cell contents. This is an export replay, **not a new model answer**. Long citations and inherited source-template pagination remain usability limitations. The source template itself reproduces the same cached-field footer display in LibreOffice, so this change does not claim native Word/WPS page-number validation.

Initial test-environment attempts failed because the runtime image omitted package tsconfigs and `/usr/bin/python3` lacked python-docx. Retried after copying the checked-out tsconfigs and selecting the existing `/opt/venv/bin/python3`; final backend and Python runs passed. The failures were not hidden or represented as passing runs.

Private source documents, original answers, screenshots, logs and render files are retained outside this Git worktree. None are part of this PR. Real-model replay of the customer sample has **not run** because the separate model destination requires explicit authorization; synthetic tests and export replay do not establish semantic improvement on that sample. No new browser acceptance test was performed for this backend/export change.

## Integration notes

- Base: `c7d0c42a58c467c999f9c565a7355aaef37079bf` on develop.
- No new dependency, database migration, API contract, product price, or production configuration change.
- Each newly generated question adds one model review call, increasing internal inference cost and latency. Existing timeout, usage journalling and fixed-price settlement remain in force.
- A review failure/pause is surfaced through existing run behavior and does not export an unreviewed fallback. Deployment should follow the existing job-drain and fixed-version release procedure.
- Before acceptance, run authorized real-model examples and inspect correctness, specific local gaps, citations and Word output. Do not declare production quality fixed based solely on this synthetic regression.

代码完成，尚未部署，待统一发布。真实模型复验与用户验收尚未完成。
