# Customer template and billing release integration

Status: integration in progress, not deployed, user acceptance not recorded.

## Current validation at 4da8b930

The integrated product source includes #814 `f818d860`, #804 `c7ba5c51` and
#815 `2aaf596f`. All three complete Linux images build successfully from an
export of 4,949 files individually verified against the pinned Git blobs.
The database template has 160 migrations. A separate synthetic historical
database was restored and upgraded from 148 to 160 migrations: counts and
hashes of ten core tables stayed identical, the source database stayed intact,
the billing audit was consistent, and rerunning migrations was a no-op.
This is not a production backup/restore result; that fixture has zero task
refund units and does not prove historical per-item refund migration.

- Local compilation and Vite passed; contracts 97/97, web unit 933/933,
  Fastify wire tests 6/6 with a mocked database, and 80/80 mocked-HTTP browser
  tests passed. The original cwd and Chromium launch failures remain recorded.
- Worker first run: 67/70 passed, no skips. Three fixtures still expected
  numeric HTTP money. The repaired files passed 14/14 targeted tests, including
  actual PostgreSQL reservations, Word extraction, partial delivery, maintenance,
  immutable original versions and owner isolation, with synthetic model output.
- API main run: 280/284 passed; supplemental run: 50/51 passed; no skips.
  The five failing files used the old numeric HTTP contract. Repaired files
  passed all 10 targeted tests, retaining strict assertions, legacy domain
  balances, native WeChat notification integers, and original-price coverage.
  The rechecks mounted only compiled test modules read-only into the fixed
  4da8b930 images. Product code and security guards were not changed.
- An additional Edge browser regression passed for mixed file generation:
  a 402 stores the original int64 request, the simulated funding return replays
  the identical body once, one batch is created, reload does not resubmit, and
  no payment request is sent. This uses mocked HTTP, not a real payment.

Initial failures and rechecks are separate runs and must not be added together
as independent tests or described as a clean first run. The complete CLI uses
real Linux sandbox/DOCX handling with a synthetic provider; private-original
model verification is still blocked by the prior approval rejection. No new
permission to transmit those files has arrived. Original-file model calls
remain zero. Full incremental semantic review, production compatibility
inventory, current production backup/restore and compatible rollback are
unfinished. There has been no production switch or feature-flag activation.

Current shared receipts: `images-4da8b930-receipt.json`,
`synthetic-upgrade-4da8b930-receipt.json`, `worker-4da8b930-exit.json`,
`worker-wire-repair-4da8b930-exit.json`, `api-4da8b930-exit.json`,
`api-supplement-4da8b930-exit.json`, `api-wire-repair-4da8b930-exit.json`,
and `browser-file-generation-funding.log`.

The release combines the real file preparation implementation in PR #815 with
source-format preservation in #804 and subscription billing in #814. Supporting
completed changes are #805, #807, #808, #809, #810, #811 and #812; #815 already
carries #806 and #813. The design prototype alone did not trigger this release.

## Pinned inputs and integration fixes

- #815: `2aaf596f19340962b9b4421fe0bd3e4790f60374`.
- #804: `c7ba5c51ba01202114b056ecd4e06cfcc3d88453`.
- #814 initially: `2d89ec9c04edc79a16eba19e8f9fc62a6f7f8c30`;
  subsequently updated to `f85702bba5e4eeaf0e4edf52aba8f42974b0ed4b`.
- Baseline master: `b68cf8a58ea3232ccb3a641c84624db5091e4504`;
  develop: `c7d0c42a58c467c999f9c565a7355aaef37079bf`.

Mixed file preparation now uses the applicable automatic tariff and original
request recovery while retaining the legacy path. File authoring retains both
source and template roles when the same material is selected for both. Docker
build context includes the required TypeScript declarations, test configuration
and subscription stylesheet. Python dependency installation supports an explicit
TLS-validated index without disabling certificate verification.

The latest #814 merge preserves catalogue preview, normalized legacy download
names and mixed-file recovery alongside per-file paid checks, immutable file
versions and billing-resume actions. Both legacy filename and unavailable-check
browser regressions are retained. The iframe fixture gives real screenshot and
post-capture checks 5 seconds instead of an insufficient accelerated 2.2 seconds;
production's 90-second observation budget and result assertions are unchanged.

## Validation before the latest #814 increment

The following evidence belongs to the integration through `75c14695`, with the
later iframe fixture correction `a12b035f`. It does not validate `f85702bb`.

| Check | Result and boundary |
|---|---|
| Workspace build | Passed after build-context corrections |
| Full original API Dockerfile | Passed at `75c14695`; image `sha256:9718d6817f5aeab4e5098c0859137c59676f92bad1f47ad1746a278d8f2750c0` |
| Contracts | 72 passed: 32 + 29 + 11 |
| Web unit | Initial 912 passed, 2 fixture failures; repaired targeted 12 passed, overlapping the original suite |
| API and file/billing integration | Initial 62 passed, 1 synthetic-user FK fixture failure; repaired mixed-file group 2/2 passed |
| Additional historical/payment billing | 47 passed with isolated PostgreSQL and synthetic payment responses |
| Browser UI | Initial 172 passed, 3 failed, 5 optional skipped; 3 corrected regressions passed |
| Worker | Initial 50 passed, 1 dual-role material failure, 11 opt-in skipped; repaired affected group 27/27 passed |
| Full authoring CLI | 5/5 passed in Linux with sandbox protection and real DOCX processing; provider responses synthetic |
| Python original-document checks | Original 12 executions included 2 opt-in skips; both authorized-original checks then passed with opt-in enabled |
| Integrity Chromium | First 149/153 passed (2 failing leaves and their parent tests); unchanged diagnostic rerun 72/74; corrected affected suites 74/74 passed |

Overlapping reruns and parent tests are not added together as unique scenarios.
The slow captcha fixture passed unchanged on both diagnostic and final reruns.
The iframe diagnostic showed a discarded capture after its test observation
deadline; the adjusted test retained the actual screenshot and every assertion.
These website responses and recognizer outputs are synthetic, not live-site QA.

## Latest #814 validation

The latest increment adds Alipay, payment reconciliation, original-consideration
refund recovery, paid workpaper checks and migrations 0135–0144. Its six conflict
files have been resolved in `8647fda4`. The fresh full workspace build, contracts
(72 tests), Web unit suite (926 test executions, including nested tests) and
44 targeted browser regressions passed. Browser cases cover the merged routes,
legacy downloads, paid checks, subscriptions and file preparation using mocked
HTTP responses; they do not validate the new backend implementation.

The full API and web Dockerfile targets passed at `1ae0d1d3`. The first worker
image attempt failed downloading the public Codex package because the official
npm endpoint rejected its TLS handshake. A public npm mirror was checked with
TLS verification enabled; the unchanged Dockerfile is being rebuilt with that
registry and still checks the pinned Codex SHA-512. No file sandbox guard or
package integrity assertion was removed.

Latest API tests initially passed 174 of 177 executions. Two upload cases lacked
the writable spool setting in the read-only test container; both passed with a
private test spool. The remaining refund case shared merchant-wide statement
coverage with earlier refund fixtures, producing 27 legitimate coverage gaps.
Its complete-statement fixture now uses a separate database; the full six-case
refund rerun passed after recompilation, with the corrected test file mounted
read-only into the fixed API image. Production payment code was unchanged.
Together the initial suite and affected reruns validate all 177 executions;
overlapping cases are not added as new tests. An initial local
rebuild could not find npm.cmd, and an unchanged compiled-test rerun reproduced
the same failure; these are retained and not counted as passing validation.

The new empty database migrated through 0144 (148 migration records). A snapshot
of the completed synthetic model database was restored into another isolated
database and upgraded from 138 to 148 records. Accounts, projects, materials,
artifact versions, runs, credit lots/allocations/events/reservations and model
attempts retained identical counts and content digests. Exactly one genuine
workpaper acquired a file binding; the missing-original explanation did not.
Repeating migrations was a no-op. The first rehearsal referenced a nonexistent
bb_artifacts table; the corrected snapshot uses the actual artifact-version
table and resumed the same restored database. This is synthetic-data upgrade
evidence, not a production backup or production rollback rehearsal.

Deployment configuration checks passed 11 tests; financial recomputation and
price-table agreement passed 953 and 23 checks respectively. These do not
establish actual revenue, costs or merchant acceptance.

Latest worker/CLI validation and final production restore/rollback preparation
are still required. The PR's REQUIREMENT-AUDIT.md documents broader unfinished payment
and administration requirements; neither this integration nor synthetic payment
tests establish real merchant capability or complete business acceptance.

The complete worker, API and web Dockerfile targets subsequently built from
`8610ee7f`. All 4,725 exported files were checked against raw Git blobs, avoiding
Windows line-ending conversion. OCR, file sandbox, TLS and pinned-package
integrity guards remained enabled. The complete worker/CLI suite passed 62/62
and the complete API suite passed 177/177, with no skips. These use real isolated
Linux/PostgreSQL and DOCX processing with synthetic provider responses.

Review found that Fastify executes close hooks in reverse registration order:
the owned database pool closed before pending payment reconciliation drained.
The pool hook is now registered first so it executes last. An isolated PostgreSQL
regression starts the actual API with its own pool, holds a synthetic provider
query during shutdown, and verifies one paid order, one credit lot, 10,000 test
points and no business run. It failed on the original server (pending instead of
paid); the repaired complete reconciliation suite passed all eight tests with
the rebuilt server/test mounted read-only into the existing API image. TypeScript
compilation and diff checks passed. The final images must include this repair;
the earlier `8610ee7f` images do not contain it.

The next compatibility regression reproduced an included automatic repair
pausing when provider usage arrives late. Provider observation, durable-result
reuse and queue recovery only recognized the older commerce scope binding.
They now also recognize an owned automatic scope binding with a zero accepted
amount and a stored automatic price. Ordinary unbound trial runs still require
usage reconciliation; included Word repairs still require both delivery files.
The regression creates the paid check and included repair through the actual
API, reclaims an expired lease, reuses the same model attempt and result, and
verifies late measured/duplicate observations plus no additional hold.

The original regression failed with pending_reconcile instead of completed.
A provider-only repair still failed queue reclaim. The next run exposed an
incorrect test query (model attempts belong to a job, not a run column), with
the following fixture cascading; correcting that query retained all assertions.
The complete automatic-file and scope-standard suites then passed 11/11 with
no skips. Compiled repair and test modules were mounted read-only into the
fixed `8610ee7f` API image; final images must still include this code. This test
uses synthetic observations and isolated PostgreSQL, with no real model or
payment calls.

The latest #814 full Git diff contains 309 changed files. Semantic review is
ongoing. A separate compatibility gate concerns old nonterminal file-check runs
with a completed model response but no newly required coverage evidence. The
new delivery check can reject their replay. A read-only inventory query is ready,
but has not yet been run against production; the historical count of 27 paused
runs cannot exclude exposure. Before migration, establish whether affected runs
exist and validate any needed compatibility path without inventing evidence,
repeating completed model calls or altering customer run state.

## Complete ac1 image validation and history fixtures

All three original Dockerfile targets built successfully from the byte-verified
`ac1a2ac56763aec4a8cdf5e5a1aab045132e9a11` export. Its complete worker/CLI suite
passed 62/62 and the main API suite passed 178/178, without skips. The worker
proxy regression passed 1/1 on actual Node 22.23.2 using synthetic loopback
servers. Providers in these suites were synthetic; databases and storage were
isolated from production.

Six additional changed API suites were also run. Their first pass was 32/51:
19 cases stopped because two strict history-test SQL fixtures did not include
the new `AND NOT internal_template` filter. Only those two exact expected SQL
strings were corrected. Production code, query restrictions and all existing
assertions were retained. TypeScript compilation passed; all six suites then
passed 51/51 with the two rebuilt test modules mounted read-only into the ac1
API image. This is not an unmodified-image result for those two fixtures.
Initial invocation and failing test logs are retained alongside the successful
rerun. No further production code changed in this fixture repair.

## Real-model and release gates

A separate database, storage and test account contain only a newly generated
synthetic prospectus and three newly generated synthetic Word templates. Actual
page upload/adoption, catalogue confirmation, individual template mappings,
structure/layout previews and one-click submission passed. The original
three-file batch completed through the real model without resubmission: one
substantive workpaper, one missing-original explanation and one annual report
were downloaded. Three durable model attempts completed, each at attempt 1.
The annual report settled 7,965 synthetic points and the workpaper settled 3,458;
the explanation released its 3,458-point reservation. Total charged was 11,423,
with one final event per reservation. All seven rendered pages were inspected
and had no clipping, overlap or missing glyphs. Both substantive documents kept
the synthetic template styles and section properties; expanded tables contain
the disclosed three-year financial detail. The model outputs were not manually
edited. The Windows renderer lacked bundled LibreOffice, so the documents were
rendered with the isolated Linux worker's LibreOffice and bundled Poppler.

This real-model run used the earlier integration runtime, before the latest
#814 increment; it is not relabeled as final-version validation. No production
account was created, credited or charged.

Original private templates are a separate unmet gate. Automatic approval review
rejected transmitting them to GitHub Copilot Enterprise because they contain
historical personnel and due-diligence records without explicit authorization
for that sensitive payload and destination. No original-template model call
was made. The exact three-template request is recorded locally; it must not be
retried without new human authorization. Synthetic tests cannot satisfy this
original-template gate.
The exact payload/destination permission question has been asked; no human
answer has been received. Automated heartbeats do not grant that permission.

`BB_SUBSCRIPTION_BILLING_ENABLED` remains off for production until an applicable
configuration decision is validated. No real signing, automatic debit, payment,
refund or customer recharge is authorized by this release's test execution.
The synthetic environment explicitly enables billing for isolated tests only.

Production has not changed. Read-only preflight observed master `b68cf8a5`, API
`0b680c77`, no active runs and 27 paused runs; this is historical evidence and
must be refreshed before any deployment. No deployment lock is held. The owned
temporary SSH rule and Cloud Shell were deleted; Cloud Shell readback was 404.
The ephemeral key was removed with the console; no local key copy was created.

Before deployment, recheck active releases and the shared server lock, resources,
current data and Blob inventory; refresh offsite backups and verify an isolated
restore. Never signal a worker that still has model work. Migration 0144 changes
an old table to a compatibility view that cannot accept an old worker's
`INSERT ON CONFLICT`; old and new workers must not overlap. Any rollback must
also understand controlled-docx-v1 durable operation logs and avoid replaying
completed model work. Migration/rollback rehearsal remains outstanding. The
complete ac1 image results above supersede earlier pending image checks; the
final merged production version must still be identified and verified.

GitHub source-PR CI was previously prevented by account billing/usage limits;
local evidence above is not a claim that GitHub CI passed. No production release
PR or switch should occur until these gates are actually met.
