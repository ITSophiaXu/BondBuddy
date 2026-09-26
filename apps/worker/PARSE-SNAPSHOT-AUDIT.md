# Read-only parse snapshot audit (#13)

This CLI reports de-identified metrics for already completed PostgreSQL material parse jobs. It opens one `BEGIN READ ONLY` transaction and runs parameterized `SELECT` queries against `bb_jobs`, `bb_material_versions`, `bb_parse_snapshots`, and `bb_parse_evidence`. It does not update, enqueue, or repair records. The URL and job IDs are read from environment variables and are never included in output or error messages.

Build from the repository root with `npm run build` (the worker imports workspace packages that must be built first). On the preproduction host, provide the PostgreSQL URL through the deployment's secret environment mechanism and exact completed job IDs through `BB_PARSE_AUDIT_TARGETS_JSON`, then run:

```sh
node apps/worker/dist/parse-snapshot-audit.js
```

`BB_PARSE_AUDIT_TARGETS_JSON` must be a JSON object with `docx_a_job_id`, `docx_b_job_id`, `anchor_docx_job_id`, and `xlsx_job_id`. The first two identify the DOCX parse jobs being compared; `anchor_docx_job_id` must be the completed `rq-202506-01` job; `xlsx_job_id` must identify the authorized XLSX job. IDs can be reused when the two jobs are replays of the same immutable material/parser binding. The utility validates media type, job state, parser binding, snapshot state, record count and contiguous ordinal order; missing or ambiguous inputs fail closed.

The `ordered_records_sha256` is independently computed from the complete records array ordered by `ordinal`, reconstructing the persisted record fields (`record_id`, material identity/version, content hash, locator, quote, context, extraction method/version, confidence, uncertainty, and formatting). JSON object keys are sorted recursively, array order is preserved, JSON is compact UTF-8, and SHA-256 is computed over those bytes. This matches the parser regression's canonical `json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":"))` semantics for parser-produced records. `stored_response_sha256` is reported separately: it hashes the complete parse response excluding `request_id`, so it is not a records-only digest.

Anchor output reports only locator counts for p[4], p[65], and p[249] with table 2 / row 28 / cell 3. It explicitly reports `source_quote_independent_check: "not_performed"`: a locator present in PostgreSQL does not prove that it matches the original OOXML paragraph or that the source quote is correct. Do not describe locator presence alone as anchor acceptance.

The XLSX metric compares `document.cached_formula_results`, evidence rows carrying cached results, their `formula_cached_result_unverified` uncertainty marker, the `XLSX_FORMULA_CACHE_UNVERIFIED` warning, and `needs_confirmation`. It emits counts/status only. Cached values remain unverified; a consistent status is not a financial fact verification.

The JSON output deliberately excludes source text, record IDs, material/project/user IDs, snapshot IDs, job IDs, locators beyond fixed anchor names, credentials, and raw database errors. The records are read into process memory to calculate the canonical digest. The CLI does not read Blob objects or source documents. It does not establish full-document coverage, professional acceptance, or production readiness.

Pure helper coverage uses only synthetic values: same-job replay stability, a changed-record comparison negative case, object-key canonicalization versus array order, de-identified output properties, locator presence semantics, XLSX cached-result status, and ordinal completeness.
