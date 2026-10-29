# 2026-10-29 question workflow release

Integrates completed PRs #795, #796, #797 and #798. The QA workspace keeps preparation and answer controls on one page, starts answering once, hides reference/knowledge controls, counts answer runs only, and uses the theme green for progress. Workpaper batches appear as one task with download feedback.

Existing tabs use strict response schemas. New clients opt into `answer_sequence` using `x-bb-qa-history: answer-sequence-v1`, and into task batch `total`/`completed` using `x-bb-task-counts: batch-counts-v1`. Absent or unknown capabilities retain the previous DTO fields. New fields remain optional so the new web client can read the previous API during a rolling change or rollback.

No database migrations, dependencies, worker execution logic or security configuration changes. Deploy API and web together, preserving workers and retained static assets. Production deployment must use the existing shared deployment lock and recheck the live baseline. User authorized this single automatic release; actual user acceptance has not been recorded.

Validation records and deployment results are maintained outside Git in `work/release-control/20261029-three-fixes/`. Local live tests use isolated PostgreSQL/storage/accounts and a synthetic model; they do not establish real model output quality. GitHub CI is blocked by account billing/spending limits, so local build, contract, browser, API and worker checks supply the validation evidence.
