# M1 worker boundaries

Free source-preflight parse/OCR attempts record measured document/page quantity and
processing time in the parse job checkpoint and one transactional
`platform.processing_cost` outbox event per `(job_id, stage, attempt)`. OCR pages
that could not be measured after a failed subprocess remain `null`; price remains
`unknown`, and these events never reserve or deduct user credits.

## Running the tests

`npm test -w @bondbuddy/worker` builds and runs every `dist/*.test.js` with the
default parallel `node --test` (one process per file). Database-bound suites
skip unless a migrated PostgreSQL 16 database is configured. Point
`BB_TEST_DATABASE_URL` at a disposable, fully migrated database; it is used
**only as a template**. Each test file clones it (`CREATE DATABASE … TEMPLATE`,
see `src/test-database.ts`) and drops the clone with `WITH (FORCE)` when the file
ends. Suites that assert global outbox/job counts or install `bb_outbox`
triggers therefore cannot race each other. Requirements: the role needs
`CREATEDB`, the server must expose the `postgres` maintenance database, and
nothing else may hold a session on the template. Don't run the API or migrations against it
while the tests run. Suite-specific variables (`FACT_DECISION_TEST_DATABASE_URL`,
`BB_TEST_CODEX_DATABASE_URL`, …) still work and override the template for that
suite. Azurite suites also need `BB_TEST_AZURITE_CONNECTION_STRING`.

```sh
createdb bb_worker_template && DATABASE_URL=postgresql://…/bb_worker_template npm run migrate:api
BB_TEST_DATABASE_URL=postgresql://…/bb_worker_template \
BB_TEST_AZURITE_CONNECTION_STRING=UseDevelopmentStorage=true npm test -w @bondbuddy/worker
```

The #76 authorized PostgreSQL regression is separately opt-in. It reads only
the four `historical` DOCX paths and one manifest-registered financial file per
case, checks byte counts and SHA-256, then uses the Python parser, durable parse
job, profile repository, and API-owned difficulty repository against a cloned
database. Set `BB_RUN_AUTHORIZED_SAMPLE_PG_E2E=1`, `BB_TEST_DATABASE_URL` (or
`AUTHORIZED_SAMPLE_PG_TEST_DATABASE_URL`), and optionally `BB_PYTHON` when the
repository `.venv` is not available. The registered historical documents are
DOCX, so this regression records the platform-paid native parse event; it does
not exercise scan OCR or establish OCR accuracy or professional acceptance.

```sh
BB_RUN_AUTHORIZED_SAMPLE_PG_E2E=1 \
BB_TEST_DATABASE_URL=postgresql://…/bb_worker_template \
BB_PYTHON=/path/to/python \
npm run build && \
node --test apps/worker/dist/authorized-sample-pg-e2e.test.js
```

#31 的内部历史稿修改计划、锁定材料/事实读取入口、#34 消费约定及未完成验收项见 [HISTORICAL-UPDATE-HANDOFF.md](HISTORICAL-UPDATE-HANDOFF.md)。本切片不开放生产任务或生成 Word 成功成果。

`historical-native-recognition.ts` is a conservative #76 native-text
recognition seam. Given a trusted, immutable parser response and explicit
profile version, it derives source market/offering and evidenced financial
periods in the existing `@bondbuddy/contracts` Recognition shape. It requires
two distinct source passages in different sections/pages for market and
offering, keeps ambiguous or conflicting values pending, and never uses a
filename, cover/issuance date or rule citation as a financial cutoff. Its
provenance includes both the recognition and parser versions. OCR/model
assistance, API/UI, free-precheck cost logging and authorized real-material
acceptance remain #76 work.

`historical-material-precheck.ts` composes the authorized historical-role
parser, #13 parse-snapshot persistence and native recognition append. The
recognition write checks every cited field/period anchor against evidence rows
from the exact owner, project, material version and parser snapshot; period
extractor versions must also match the snapshot parser version and evidence
rows. Mixed-version snapshots fail closed. Non-empty correction
references are checked against the same material version and source parser
snapshot, while remaining `user_asserted` and `needs_confirmation`. Recognition
retries deduplicate by the trusted native-recognition/parser version, and the
composition reuses a profile only when its deployment parser version and parse
options match the stored snapshot. Failed parser snapshots with zero anchors
remain failed. Parser failure, OCR gaps and ambiguous native evidence remain
non-ready. The separate `recognizePersistedHistoricalOcr` path reads only the
latest private OCR review for the active owner/project/material version. It
retains OCR record IDs as anchors and binds `extractor_version` to both the
immutable OCR snapshot ID and result SHA-256. Before append, the repository
rereads and hash-checks that exact snapshot inside a transaction, verifies each
reference and recomputes recognition to reject caller-supplied values.
OCR-derived fields and periods always remain `needs_confirmation`; OCR user
corrections stay `user_asserted` in their own append-only records and are not
treated as recognized source facts. OCR profile corrections likewise append
as `user_asserted` and cannot make the profile ready. This is still an internal
function, not an upload-triggered job: it does not dispatch OCR, record
platform precheck cost or expose the source-profile API. A stored upload role
is not independent proof that a document belongs to this issuer; that still
needs evidence review.

`historical-profile-repository.ts` is the internal append-only #76 storage
seam. Migration `0013_m1_historical_profiles.sql` binds snapshots to an
owner/project/historical material version. Recognition retries are idempotent
by request and by native parser version; changed results for the same parser
version fail closed. Corrections append a new version with actor, reason and
evidence references, and an outbox event commits in the same transaction.
Existing market/offering callers remain valid; callers can omit either source
field and may instead provide a full replacement `reporting_periods` list with
per-period evidence references. Native-text references are checked against
the exact owner's original material-version/parser snapshot; OCR references
are checked against the hash-verified OCR result bound in provenance. A period correction
also replaces the derived latest cutoff, taking the maximum valid period end
only; corrected periods and cutoff remain `user_asserted` with uncertainty even
when anchors exist, and the profile remains `needs_confirmation`. Same-request
replay, stale profile versions and late-recognition protection remain in force.
No API route or UI is included; upload-triggered job activation, OCR/cost
logging and authorized real-material acceptance remain open.

`material-parser.ts` adds an internal #13 bridge from an owner/project-scoped,
immutable material version to the versioned Python parser. It verifies private
Blob bytes against the database size and SHA-256, stages them with restricted
permissions, rejects unsupported media and mismatched parser output, and removes
staged bytes even on failure. It is not a public upload/parse endpoint. Its
owner and material IDs must come from a trusted job context, not an HTTP body.
The bridge alone does not queue uploaded materials. The separate evidence
repository below persists parsed records; scanned images and PDF OCR remain
#14 work.

`no-history-word-bridge.ts` is a guarded #33 seam to the existing deterministic
`bondbuddy_no_history_word` renderer. It accepts only the versioned
`no-history-manuscript-draft-v1` model shape and a separately supplied target
fact-ID set derived from a trusted, same-run facts snapshot; IDs present only in
model JSON cannot authorize themselves. The renderer runs with stdin JSON in a
private `0700` temporary directory, bounded output buffers and a timeout. The
bridge reads only its fixed output name, verifies the strict summary schema,
writer version, counts, size, DOCX signature and SHA-256, then removes the
staging directory. It returns bytes and metadata pinned to the active run's
owner/project/input revision/hash, while explicitly recording that factual
correctness and delivery checks are still false. It is not installed in the
runtime pipeline and does not promote an artifact or mark a run successful.

The parser response validator now rejects malformed version/status fields,
duplicate evidence IDs, unlocatable or wrong-media anchors, fabricated DOCX
pages, out-of-range PDF pages, and incomplete warnings or uncertainty. The
bridge checks raw results for private Blob/staging references before schema
validation so a leak remains a distinct fail-closed error. Synthetic boundary
tests and a real Python subprocess contract test cover this seam; they do not
replace authorized customer-material acceptance for #13.

`parse-evidence-repository.ts` adds an internal #13 persistence seam. It
revalidates the parser response, rechecks the active owner/project/material
version and SHA inside the transaction, and stores response metadata plus
bounded per-record quote/locator/uncertainty rows. Immutable snapshots dedupe
by owner/project/material/version/parser version; request aliases with changed
options or changed parser output fail closed. Snapshot/evidence/request alias
and outbox event commit atomically. Reads require the exact owner, project,
material version and snapshot ID, and hide soft-deleted material. The
`parseAndPersistAuthorizedMaterial` composition still is not attached to an
upload queue or production job. PostgreSQL 16 integration uses synthetic
fixtures in an outer transaction and rolls them back. Migration 0014 was tested
after current `develop` migrations 0001–0010 and 0012–0013; after PR #116 adds
0011, repeat fresh and existing-upgrade migration validation.

`parse-cache.ts` is an internal #15 cache repository seam, not a production
processor or HTTP endpoint. Its caller must supply an owner ID from an
authenticated, trusted job and a material version already authorized for that
owner. The module never accepts client-supplied ownership as authorization.

Only complete `parsed` or `needs_confirmation` parser responses are cacheable.
Limited-page parses are rejected because `max_pages` is not part of the cache
identity. Lookups require the same owner, file SHA-256, parser version, OCR
version, and basis-correction version. A cache hit verifies the private Blob
length/hash and source response, then rebinds request and material IDs to the
current authorized material before returning it. A missing or corrupt Blob is
an error, not a successful miss. Staging paths are never stored.

The authorized material bridge optionally composes this cache after it checks
the current owned material metadata and private bytes. The production worker
runtime now installs that composition for parse jobs using its private Azure
Blob container and PostgreSQL pool. Cache Blob keys use a hashed owner
namespace, and lookups also require the exact owner in `bb_parse_cache`. A
same-owner, same-content parse can skip the Python subprocess when the
filename, project or material ID changes; a hit is rebound to the new request.
The parser identity comes from the shared `documentParserVersion()` setting
used by parse jobs (`BB_DOCUMENT_PARSER_VERSION`, with its shared code
default). Parse-enabled runtime startup requires `BB_PARSE_CACHE_OCR_VERSION`
and `BB_PARSE_CACHE_BASIS_VERSION`. The deployment template starts with
`bondbuddy-ocr-1.0.0` (the current OCR processor version) and
`evidence-basis-v1`; bump these for OCR engine/language-data or evidence-basis
logic changes. These versions are required because those components currently
have no shared version configuration contract. Cache reads are bounded to the
parser's 64 MiB output limit. Cache failures are fail-closed rather than
treated as misses. Failed and page-limited parses are not cached. Synthetic bridge
tests cover same-account rename reuse, account isolation and corruption; when
`MATERIAL_CACHE_TEST_DATABASE_URL` points to a disposable migrated PostgreSQL
16 database and `.venv` is installed, a test also runs the actual Python
subprocess against synthetic material. Its Blob adapter remains in-memory.
An additional real-material regression is opt-in with
`BB_RUN_AUTHORIZED_SAMPLE_TESTS=1`. It reads the `rq-202509-01` historical DOCX
from the authorized sample manifest, verifies its declared byte count and
SHA-256, then exercises the actual Python subprocess and same-owner renamed
cache hit plus cross-owner isolation using in-memory cache repository/Blob
adapters. This is parser/cache regression evidence only; extracted text is not
logged and the test does not assert industry acceptance. The test also needs
the repository `.venv`.

Blob insertion precedes the idempotent database insert. A concurrent loser
removes only its own object after a conflict. If an insert fails ambiguously,
the worker checks whether its object key was committed before deleting; if the
database check itself is unavailable, the private object is left for
storage-lifecycle cleanup rather than risking deletion of a referenced cache.
`fact-repository.ts` is another internal #15 seam. It stores each fact source
as a separate immutable candidate, with an exact account/entity/scope/period/
currency/unit/basis/version key. Inserts require a material version in the
trusted owner/project scope whose SHA-256 matches the cited evidence; listing
is owner/project-scoped. Template and reference sources cannot become issuer
facts. Source-anchor review metadata and OCR uncertainty remain explicit.
The existing migration has no dedicated confidence column, so candidate
confidence is round-tripped in the per-anchor evidence JSON; a future schema
change should make it first-class before adding generic fact queries.

`fact-decision-repository.ts` is an internal append-only #15 conflict audit
seam. A trusted actor can record a versioned choice of an exact owner/project/
fact-key candidate or leave the group unresolved; the candidates and their
source statuses remain unchanged. Same-request retries return the same
decision, while a decision and its outbox event commit or roll back together.
Migration `0012_m1_fact_decisions.sql` rejects decision edits and freezes a
candidate once selected. A decision is not audit verification or permission to
generate; no public fact-resolution API or production processor uses it yet.
Its live PostgreSQL test uses synthetic candidates and a disposable database.

`credit-facility-supplement-repository.ts` is a separate internal #15 seam for
user-supplied total/used/unused credit assertions. It calls the existing domain
validator, preserves each opaque source statement ID and date (including
incomplete values needing confirmation), and records only `user_asserted`,
`needs_confirmation`, or `conflicted`; even arithmetic agreement is never
verified or manuscript-ready here. The trusted caller must resolve and verify
that each source ID belongs to the authenticated owner/project and represents
the stated user message before invoking this repository. This storage layer
does not invent material evidence anchors or expose a public read API. Same
request retries are idempotent only for the same payload, and the append plus
outbox event is atomic. Migration `0015_m1_credit_facility_supplements.sql`
keeps these snapshots immutable. Its optional live PostgreSQL 16 test uses
synthetic owner/project fixtures and a disposable database; set
`CREDIT_FACILITY_SUPPLEMENT_TEST_DATABASE_URL` after applying migrations.

The fact repository has an optional live PostgreSQL 16 test. After applying
the repository migrations to a disposable database, set
`FACT_REPOSITORY_TEST_DATABASE_URL` when running the worker tests. Fixtures are
synthetic and rolled back. The current worker entry point still has no
production parse/fact processor, and #14 OCR plus authorized sample validation
remain outside this slice; it does not establish #15 acceptance.

`rule-pack-release-ledger.ts` is an internal #19 persistence seam with an
append-only, hash-bound event history for test-channel release, withdrawal and
rollback. It only calls the domain publication gate with `channel: test`; it
cannot publish or select a production capability. Reviewer IDs and sample
classification remain untrusted fixture metadata until a trusted operator and
professional reviewer identity boundary is connected. Rollback binds to an
older event for the same pack and rechecks pack/source effective dates at the
rollback timestamp. Migration `0018_m1_rule_pack_release_ledger.sql` stores
each snapshot and its outbox event in one transaction. The optional live
PostgreSQL 16 test uses synthetic bundles and rolls its outer transaction back;
set `RULE_PACK_LEDGER_TEST_DATABASE_URL` after applying migrations.

Build dependencies first, then run `npm test -w @bondbuddy/worker` from the
repository root.

## #16 contained Codex adapter

`src/codex-adapter.ts` runs `codex exec --json` per attempt with an isolated `CODEX_HOME`, an empty cwd, a read-only sandbox and tool features disabled. It fails closed on any tool item (see `docs/M1-TECH-ARCHITECTURE.md`). It is not installed in `runOnce`. Unit tests replay the synthetic JSONL fixtures in `test-fixtures/codex/` through a fake `codex`. The durable test `codex-durable.test.ts` claims jobs globally, so it needs its own fresh, migrated database: `BB_TEST_CODEX_DATABASE_URL=... BB_TEST_AZURITE_CONNECTION_STRING=... npm test -w @bondbuddy/worker`.

Operator probe for the authorized host (in-memory journal, synthetic prompts only; prints the redacted attempt record):

```
BB_CODEX_BIN=/path/to/codex BB_CODEX_AUTH_FILE=/abs/auth.json npm run -w apps/worker probe:codex -- --prompt-file prompt.txt [--schema-file schema.json] [--material-file material.txt] [--timeout-ms 60000]
```

Use `BB_CODEX_CREDENTIAL_ENV=<NAME>` instead of `BB_CODEX_AUTH_FILE` when the key is provided by env. Point `BB_CODEX_BIN` at the real codex binary, not at a wrapper script that overrides `CODEX_HOME`.
