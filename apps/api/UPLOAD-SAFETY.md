# M1 upload content safety (bounded implementation slice)

This note records the local, deterministic checks used by the Fastify material upload path. It is a format/readability gate before a material is registered, not OCR, malware detection, professional review, or full #8 acceptance.

## Accepted formats and upload behavior

The implementation follows the seven MIME types in `packages/contracts`: PDF, DOCX, XLSX, CSV, UTF-8 text, PNG, and JPEG. PPTX is not in that contract; a PPTX package presented as DOCX/XLSX is rejected with `415 MATERIAL_FORMAT_UNSUPPORTED`. No public enum, error code, migration, or UI contract changed.

The API checks bytes and their declared SHA-256 before inspection. Inspection runs in a parser worker with a 45-second deadline, 192 MiB old-generation heap, 32 MiB young-generation heap, and 4 MiB stack. One inspection runs per API process; additional inspections wait in a bounded queue and can receive retryable `503 DATA_UNAVAILABLE` when the queue deadline expires. A parser error, worker error, crash, or timeout fails closed. The first successful `PUT` is inspected before its Blob write; `complete` re-reads the private Blob object, rechecks size/hash and inspects it again before creating the immutable material version. Repeated `PUT` and `complete` requests keep their existing retry/idempotency behavior. OpenAPI declares the additive retryable `503` response for this capacity backpressure using the existing `DATA_UNAVAILABLE` code; no MIME enum or error code was added. A `persisted` material means these checks passed and bytes are stored; it does not mean parsing/OCR or business preflight passed.

## Deterministic checks and limits

| Format | Local checks |
| --- | --- |
| PDF | PDF.js must parse the document and every page operator list; encrypted files, unreadable pages, JavaScript actions, embedded files, form fields/XFA, external/unsafe annotations and selected active-action markers are rejected. Maximum 1,500 pages. |
| DOCX/XLSX | ZIP directory, local headers, paths, duplicate names, compression method, expanded sizes, CRCs, XML parts, content types, main document part and internal relationships are checked. Password-protected CFB Office files and encrypted ZIP entries are rejected. Maximum 1,024 entries, 32 MiB per entry, 128 MiB total expanded data, 100:1 per-entry/aggregate compression ratio, 32 path segments, and 16 MiB per XML part. ZIP64, symlinks, recognized nested ZIP/CFB/RAR/7z/gzip/bzip2/xz/zstd/lz4/tar/CAB signatures, macros, OLE/ActiveX/custom UI/external links, unsafe external relationships, Word `altChunk`/external field instructions, and spreadsheet external or active formula functions are rejected. A DOCX Word XML part may have an external relationship only when its type is exactly the OOXML hyperlink type and its target is a strictly checked absolute HTTP, HTTPS, or mailto link; inspection never follows the link. All XLSX external relationships and DOCX external templates, images, embedded parts, relative targets, local-file schemes, script schemes, ambiguous URIs and control characters remain rejected. Accepted links remain in the source document and could be opened later by a user. Declared part content types are normalized for case and parameters and checked independently of part filenames; this rejects SVG, HTML/XHTML, script, and MHTML types even when `[Content_Types].xml` maps them to a neutral extension such as `.bin`. Expanded parts also receive a bounded 8 KiB prefix check for leading SVG/HTML/XML markup or MHTML headers. Referenced parts with detected active payloads are rejected, including generic `application/octet-stream` image targets under neutral names; markup with an image relationship is rejected. Prefix sniffing does not prove arbitrary binary data benign, and is not a recursive or exhaustive file-type classifier. The nested-container check recognizes listed signatures at expanded part start and known archive-like part extensions; it is not recursive or exhaustive. |
| CSV | UTF-8 and quoted-field structure are checked with row/cell limits (1,000,000 rows, 100,000 cells per row, 2,000,000 cells total). Formula-leading `=`, `+`, `@`, and non-numeric `-` values are rejected after leading Unicode/ASCII whitespace and a UTF-8 BOM are handled. |
| TXT | UTF-8 is checked incrementally; NUL and binary signatures are rejected. |
| PNG | Signature, chunk ordering and CRC, dimensions, pixel limit, IDAT deflate stream, expanded scanline size, and row filters are checked. Interlaced/animated PNG is rejected. Maximum 16,384 pixels per dimension, 16 million pixels, and 64 MiB decoded scanlines. |
| JPEG | Signature, frame dimensions, and full decode are checked with a pixel and decoder-memory cap. Maximum 16,384 pixels per dimension, 16 million pixels, and 96 MiB decoder memory. |

The existing error contract is retained:

- `422 MATERIAL_CONTENT_MISMATCH`: bytes do not match the declared type or text encoding, or upload hash/size differs.
- `422 MATERIAL_ENCRYPTED`: a password/encryption marker is detected.
- `422 MATERIAL_UNREADABLE`: a required structure is corrupt or unreadable, or the parser fails.
- `415 MATERIAL_FORMAT_UNSUPPORTED`: the package contains unsupported/active content or exceeds a local inspection limit.
- `503 DATA_UNAVAILABLE`: both per-process parser worker slots are already occupied; retry the upload request.

## Release limits and scanner decision

No antivirus engine or signature database is installed or called. The API does not claim malware detection, exploit detection, safe-document certification, or comprehensive PDF/Office schema validation. Local checks do not scan decoded text for arbitrary malware, identify malicious image payloads, safely emulate every PDF viewer or Office version, or prove that a syntactically valid document is benign. PDF action extraction depends on the selected PDF.js parser surface; compressed or malformed features that it does not expose may remain undetected. CSV formula detection covers the comma-delimited syntax and formula prefixes listed above; it is not a spreadsheet sandbox. The worker's V8 heap limits do not cap all native or external memory allocations, so deployment-level memory limits remain necessary. The parser dependencies themselves remain part of the trusted computing base.

The production scanner, operating mode, integration boundary, scanner outage policy, supported formats, operational alerting, and live acceptance remain an explicit CTO release decision. Until that decision is made and verified in the target environment, this slice must not be described as antivirus scanning or complete production content safety. Structural parser failures/timeouts are rejected, but the local structural gate alone is not evidence that a file is free of malware.

Verification covers generated synthetic controls and the authorized `rq-202509-01` historical DOCX by manifest hash through both memory and spooled-file inspection. PostgreSQL/Azurite exercises upload ownership, rejected-byte non-persistence, and retry/idempotency behavior; it does not mutate production data or prove production scanner integration.
