# M1 worker boundaries

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

The authorized material bridge now optionally composes this cache after it
checks the current owned material metadata and private bytes. A same-owner,
same-content parse can therefore skip the Python subprocess even when the
filename, project or material ID changes; a hit is rebound to the new request.
The caller must pass deployment-controlled parser/OCR/basis versions, and a
cache failure is fail-closed rather than treated as a miss. Failed and
page-limited parses are not cached. This integration is exercised with
synthetic adapters and, when `MATERIAL_CACHE_TEST_DATABASE_URL` points to a
disposable migrated PostgreSQL 16 database and `.venv` is installed, an
actual Python subprocess plus database test. Its private Blob adapter remains
in-memory; the production worker has not yet installed this optional
composition.

Blob insertion precedes the idempotent database insert. A crash or concurrent
winner can leave an unreferenced private object; storage-lifecycle cleanup
must cover those objects before the seam is wired into a production worker.
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

Build dependencies first, then run `npm test -w @bondbuddy/worker` from the
repository root.
