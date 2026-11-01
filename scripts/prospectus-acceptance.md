# Real-model prospectus acceptance evidence

`BB_PROSPECTUS_ACCEPTANCE_FILE` points to private JSON supplied by a controlled CI job or release operator after a real model run and independent human review. Keep it and its artifacts outside Git, for example in `.local/acceptance/`. The verifier never generates a passing record. Missing, synthetic or incomplete evidence blocks a release; mechanical tests alone do not authorize release.

The operator and CI access controls are the trust boundary. This verifier checks file bytes, source bindings, numerical comparisons and review completeness. It does **not** authenticate a natural person, verify a provider's digital signature, or replace professional financial/legal judgement. Do not copy model-authored claims into human-review fields. Do not upload client documents as CI artifacts.

Run with the same Python environment as the document tests:

```sh
BB_PROSPECTUS_ACCEPTANCE_FILE=/private/acceptance/evidence.json \
  node scripts/verify-prospectus-acceptance.mjs
```

The only successful output is `PROSPECTUS_ACCEPTANCE_RESULT=` followed by hashes and a compact summary. Failures print a fixed code without private text. Evidence must bind the current clean `HEAD` commit, complete Git tree, and `pipelineFingerprint()` exported by the verifier. **Any source-tree change, including documentation, requires a new run and review.** Store evidence externally so adding it does not change that tree. Review must follow the model run and be no more than seven days old.

The required JSON shape is described below. These are field definitions, not an approved record or a runnable passing example.

| Object | Required fields |
| --- | --- |
| Root | `schema_version: prospectus-acceptance-v1`, `synthetic: false`, `status: passed`, `commit`, `tree`, `prompt_tools_sha256`, `reviewer`, `findings`, `cases` |
| `reviewer` | `actor_type: human`, real `id` and `name`, `independent_from_model: true`, `generated_by_model: false`, ISO `reviewed_at` |
| `findings[]` | `severity: minor/major/critical`, `status: open/resolved`, `description`; every major/critical finding must be resolved |
| `cases[0]` | Exactly the authorized `case_id: rq-202509`, `task_kind: full_update`, actual `run_id`, `input_hash`, `source_cutoff: 2025-06-30`, `target_cutoff: 2025-09-30`, `materials`, `artifacts`, `chapters`, `financial_checks` |
| `materials[]` | All three files in `tests/samples/2026-09-25/manifest.json` for this case: `file_id`, local `path`, registered `sha256` |
| `artifacts` | References named `input`, `provider_record`, `source`, `tracked`, `clean`, `quality_report`, `source_pdf`, `tracked_pdf`, `clean_pdf`, `render_report`, `review_record`; each has local `path` and `sha256` |

Local artifact paths are resolved relative to the evidence file. Each must be a readable regular file with matching bytes; symlinks are rejected. The source must match the authorized historical DOCX. `input` is the actual locked `codex-file-input-v1` input JSON with the same input hash, source hash, issuer, target period and material hashes. Do not recreate input from a later project revision.

`provider_record` is an operator export of the actual durable execution record, containing the same commit/tree/tool fingerprint plus `synthetic: false`, `real_call: true`, `provider: codex`, actual `request_id` (provider request or captured CLI thread/call ID), machine `actor_id`, `run_id`, configured `model`, `input_hash`, `tracked_sha256`, `clean_sha256`, ISO `started_at`/`finished_at`, and `usage`. Usage requires `status: measured` and positive integer `input_tokens`, `output_tokens`, `total_tokens`, with total equal to input plus output. Preserve original runtime evidence behind that export. An unavailable real identifier or usage measurement is a missing prerequisite, not permission to invent one.

`quality_report` is the independent `word-quality-v1` report: `status: passed`, empty `issues`, and matching `baseline_sha256`, `tracked_sha256`, `clean_sha256`.

`chapters[]` must cover `preamble` and every actual source level-zero heading exactly once. A heading ID is `p:<zero-based paragraph index>:<SHA256 of UTF-8 heading text>`, using `bondbuddy_file_authoring.source_outline.outline`. Each row includes `chapter_id`, the human `reviewer_id`, `status: passed`, `disposition: updated/retained`, `content_retention: passed`, `tables: passed`, `required_updates: passed`, a concrete `note`, and nonempty `output_locators`. Review required updates even for retained chapters; absence of changes needs a substantive reason.

`financial_checks[]` covers each of `total_assets`, `total_liabilities`, `net_assets`, `net_profit`, `operating_cash_flow` for both `consolidated` and `parent`. Each row has `metric`, `scope`, human `reviewer_id`, and `status`, `amount`, `unit`, `reporting_period`, `entity_scope`, `repeated_values`, all `passed`. It also contains:

- `source`: `file_id: rq-202509-02`, matching registered `sha256`, actual Excel `locator` such as `合并资产负债表!D8`, decimal-string `value`, `unit`, `scope`, `start`, `end`.
- `output`: decimal-string `value`, `unit`, `decimal_places` from 0 to 6, `scope`, `start`, `end`, all distinct precise location objects in `locators` where that value occurs.
- `expected_occurrences`: the number of independently identified output occurrences, equal to the locator count. At least three consolidated metrics need two or more checked occurrences.

Units are `CNY`, `CNY_10K`, or `CNY_100M`. Amounts are compared with exact decimal arithmetic and half-away-from-zero rounding at the declared output precision. Stock metrics use start/end `2025-09-30`; flow metrics use `2025-01-01` through `2025-09-30`. The verifier independently reads the real XLSX cached cell and all cited clean-DOCX locations. Missing cells, formula caches or output values fail. Financial sources outside the fixed XLSX are unsupported and cannot silently pass. Human review must additionally check the sheet's entity, period and unit headers.

DOCX locator strings use `word/document.xml//w:p[N]` for the one-based paragraph index across the complete story, including table paragraphs, or `word/document.xml#table=T,row=R,cell=C` with one-based physical table/row/cell indices. Header/footer/footnote/endnote story filenames are also supported. Financial output `locators` cannot be bare strings or merely contain an equal number somewhere in the paragraph.

For narrative text, each location object requires `locator`, a unique exact `quote` copied from that location, and `start`/`end` Unicode-code-point offsets selecting the **whole numeric token within that quote** (start inclusive, end exclusive). The quote must contain exactly one actual target reporting period, a recognized label for the selected metric, and exactly one amount outside the reporting date. The selected span must be that amount, never the year/month/date digits. Percentages and parenthesized accounting amounts are unsupported and fail; signed negative amounts must use an explicit minus sign. Mixed historical/current periods or multiple metrics/amounts require a narrower unambiguous quote; an equal historical comparison number cannot stand in for the target number. Each location also needs `scope_anchor: {locator, quote}` identifying actual unique text containing `合并` or `母公司` for the reviewed scope.

For a pure numeric table cell, omit `quote`/offsets and supply `locator` in canonical `#table=T,row=R,cell=C` form. The **entire cell** must equal the reviewed decimal value. Supply `period_anchor`, `scope_anchor`, and `metric_anchor`, each `{locator, quote}`, all within that same physical table: the period header must be in the amount column above its row; the metric label must be in the same row to the left of the amount; the scope label must be in a preceding row. These anchors are read from the actual clean DOCX. Arbitrary distant paragraphs cannot be presented as table headers. Complex merged headers, implicit scope in a table-external caption, or ambiguous layouts are currently unsupported and fail; they need a separately implemented and tested mapping before release acceptance can rely on them.

`render_report` contains `status: passed`, actual `renderer`, human `reviewer_id`, and `template_fidelity`, `headers_footers`, `tables`, `no_clipping`, `no_missing_glyphs`, all `passed`, plus a concrete `pagination_note`. Its `documents` array has exactly `source`, `tracked`, and `clean` variants, each with matching PDF `sha256`, corresponding original `docx_sha256`, actual `pages`, and ordered `inspected_pages: [1, ..., pages]`. The verifier independently counts PDF pages. A clean PDF below 80% of original pages blocks this fixed regression case; this does not prove pagination or visual quality without the human inspection record.

`review_record` is a separate private JSON record with `reviewer_id`, `generated_by_model: false`, `facts_verified_by_human: true`, the same `reviewed_at`, source/tracked/clean hashes, `render_report_sha256`, exact ordered `chapter_ids`, all `financial_check_keys` in `scope:metric` form, and at least 64 characters of substantive `notes`. It preserves the independent review behind the summary. Never substitute a model response or mechanical report for it.
