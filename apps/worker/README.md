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

Blob insertion precedes the idempotent database insert. A crash or concurrent
winner can leave an unreferenced private object; storage-lifecycle cleanup
must cover those objects before the seam is wired into a production worker.
There is no live PostgreSQL/Azurite integration test in this slice, and the
current worker entry point still has no production processor. These unit tests
use synthetic adapters and do not establish #15 acceptance.

Build dependencies first, then run `npm test -w @bondbuddy/worker` from the
repository root.
