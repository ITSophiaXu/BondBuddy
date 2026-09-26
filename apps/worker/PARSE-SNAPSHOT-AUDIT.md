# Read-only parse snapshot audit (#13)

This CLI reports de-identified metrics for already completed PostgreSQL material parse jobs. It opens one `BEGIN READ ONLY` transaction and runs parameterized `SELECT` queries against `bb_jobs`, `bb_material_versions`, `bb_parse_snapshots`, and `bb_parse_evidence`. It does not update, enqueue, or repair records. The URL and job IDs are read from environment variables and are never included in output or error messages.

Build from the repository root with `npm run build` (the worker imports workspace packages that must be built first). On the preproduction host, provide the PostgreSQL URL through the deployment's secret environment mechanism and exact completed job IDs through `BB_PARSE_AUDIT_TARGETS_JSON`, then run:

```sh
node apps/worker/dist/parse-snapshot-audit.js
```

`BB_PARSE_AUDIT_TARGETS_JSON` must be a JSON object with `docx_a_job_id`, `docx_b_job_id`, `anchor_docx_job_id`, and `xlsx_job_id`. The first two identify distinct DOCX parse jobs; using one job ID twice is rejected because that only proves a trivial replay. `anchor_docx_job_id` must be the completed `rq-202506-01` job; `xlsx_job_id` must identify the authorized XLSX job. The anchor job must have the same source SHA-256 and parser version as both DOCX comparison jobs. A mismatch is emitted as `audit_status: "failed_anchor_binding"`, the locator check is marked skipped, and the CLI exits nonzero. The utility validates media type, job state, parser binding, snapshot state, record count and contiguous ordinal order; missing or ambiguous inputs fail closed.

`audit_status: "reported_not_source_verified"` means only that the database metrics were produced. Read the separate DOCX comparison, locator, and XLSX status fields; a successful CLI exit is not an acceptance verdict or an independent check against the original document.

The `ordered_records_sha256` is independently computed from the complete records array ordered by `ordinal`, reconstructing the persisted record fields (`record_id`, material identity/version, content hash, locator, quote, context, extraction method/version, confidence, uncertainty, and formatting). JSON object keys are sorted recursively, array order is preserved, JSON is compact UTF-8, and SHA-256 is computed over those bytes using the canonicalization semantics in `apps/worker/src/parse-evidence-repository.ts`. `ordered_content_sha256` uses that same algorithm after excluding only `material_id`, `material_version`, and `content_hash` from each record; it lets separate bindings of the same source be compared without treating binding identity as parsed content. The tool compares these normalized digests only when the two DOCX snapshots have the same source `content_sha256` and `parser_version`. Different source bytes or parser versions are reported as `not_comparable`. `stored_response_sha256` is reported separately: it hashes the complete parse response excluding `request_id`, so it is not a records-only digest. Cross-language JSON number formatting can differ; this tool reports the repository's Node canonical digest and does not claim byte-for-byte equivalence to Python JSON serialization.

When the anchor binding matches, anchor output reports only locator counts for p[4], p[65], and p[249] with table 2 / row 28 / cell 3. It explicitly reports `source_quote_independent_check: "not_performed"`: a locator present in PostgreSQL does not prove that it matches the original OOXML paragraph or that the source quote is correct. Do not describe locator presence alone as anchor acceptance.

The XLSX metric compares `document.cached_formula_results`, evidence rows carrying cached results, their `formula_cached_result_unverified` uncertainty marker, the `XLSX_FORMULA_CACHE_UNVERIFIED` warning, and `needs_confirmation`. It emits counts/status only. Cached values remain unverified; a consistent status is not a financial fact verification.

The JSON output deliberately excludes source text, record IDs, material/project/user IDs, snapshot IDs, job IDs, locators beyond fixed anchor names, credentials, and raw database errors. The records are read into process memory to calculate the canonical digest. The CLI does not read Blob objects or source documents. It does not establish full-document coverage, professional acceptance, or production readiness.

Pure helper coverage uses only synthetic values: binding-sensitive full-record hashes, binding-normalized content hashes across two distinct jobs, changed-record comparison, not-comparable source/parser cases, same-job replay marked trivial, anchor source/parser binding checks, object-key canonicalization versus array order, de-identified output properties, locator presence semantics, XLSX cached-result status, and ordinal completeness.

An opt-in integration regression also runs the registered `rq-202506-01` DOCX in two separate synthetic project/material scopes and the registered `rq-202509-02` XLSX through real Python-to-Node durable parse jobs in a disposable, migrated PostgreSQL 16 database. It checks each original against the authorized sample manifest before parsing, then runs this read-only audit against the three completed jobs. It does not exercise the public upload endpoint or Azure Blob, and it cannot substitute for the audit of preproduction job IDs requested in #13.

Build first, then set the variables on the test command itself (`BB_PYTHON` may be omitted when this worktree has a suitable `.venv`):

```sh
npm run build
BB_RUN_AUTHORIZED_PARSE_SNAPSHOT_AUDIT=1 \
BB_TEST_DATABASE_URL=postgresql://…/bb_worker_template \
BB_PYTHON=/path/to/python \
node --test apps/worker/dist/parse-snapshot-audit.authorized-samples.integration.test.js
```

The database URL must name a disposable, fully migrated template; the test clones and drops its private database and requires a role with `CREATEDB`. No customer material, audit output, or credentials should be committed.
