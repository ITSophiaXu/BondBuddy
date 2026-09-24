# M1 worker boundaries

`material-parser.ts` adds an internal #13 bridge from an owner/project-scoped,
immutable material version to the versioned Python parser. It verifies private
Blob bytes against the database size and SHA-256, stages them with restricted
permissions, rejects unsupported media and mismatched parser output, and removes
staged bytes even on failure. It is not a public upload/parse endpoint. Its
owner and material IDs must come from a trusted job context, not an HTTP body.
The bridge does not yet turn uploaded materials into queued parse jobs or store
evidence records; scanned images and PDF OCR remain #14 work.

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

The fact repository has an optional live PostgreSQL 16 test. After applying
the repository migrations to a disposable database, set
`FACT_REPOSITORY_TEST_DATABASE_URL` when running the worker tests. Fixtures are
synthetic and rolled back. The current worker entry point still has no
production parse/fact processor, and #14 OCR plus authorized sample validation
remain outside this slice; it does not establish #15 acceptance.

Build dependencies first, then run `npm test -w @bondbuddy/worker` from the
repository root.
