# M1 document parser (#13)

This directory is the versioned Python subprocess boundary for native DOCX, PDF, XLSX, CSV and TXT parsing. It does not implement OCR (#14), facts (#15), model calls, database writes, Blob authorization, or public HTTP routes.

The trusted Node worker must first download an owner-authorized immutable material version into a private staging directory. It then starts the parser with that absolute path as `material.authorized_local_path`; this field is internal and must never be accepted from an HTTP client. The parser re-hashes the bytes before reading them and returns no local path.

Run it from the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python/requirements-dev.txt
PYTHONPATH=python .venv/bin/python -m unittest discover -s python/tests -v
PYTHONPATH=python .venv/bin/python -m bondbuddy_document_parser < request.json
```

Input uses `document-parse-request-v1`:

```json
{
  "schema_version": "document-parse-request-v1",
  "request_id": "parse-example",
  "material": {
    "material_id": "material-example",
    "material_version": 1,
    "media_type": "application/pdf",
    "sha256": "<64 lowercase hex characters>",
    "authorized_local_path": "/private/worker-stage/material-example"
  },
  "options": {"max_pages": 1500}
}
```

Output uses `document-parse-response-v1`. Each record repeats the immutable material ID/version/hash, keeps a literal quote and a structured native locator. PDF records use a one-based page, line/word coordinate boxes and extracted font evidence; DOCX records use paragraph/table/cell paths and never invent page numbers; spreadsheets and CSV use sheet/cell or row/column positions. Extraction warnings produce `needs_confirmation`; unreadable, encrypted, unsupported, hash-mismatched, or over-limit input produces a structured `failed` result without a partial-success claim.

PDF parsing produces source text and coordinate evidence, not a reconstructed Word baseline. A later PDF-to-Word workflow must version its page-to-paragraph mapping and explicitly disclose layout, table, font, field, and prior-revision fidelity limits; these native records alone cannot establish a faithful editable Word layout or an original Word revision history.

## Isolated no-history draft renderer (#33)

`bondbuddy_no_history_word` is an internal, standalone structural writer for `no-history-manuscript-draft-v1`. It reads one versioned JSON request from stdin and writes `no-history-manuscript-draft.docx` into the existing private directory named by `BONDBUDDY_WORD_OUTPUT_DIR`:

```bash
PYTHONPATH=python BONDBUDDY_WORD_OUTPUT_DIR=/private/worker-stage/draft python3 -m bondbuddy_no_history_word < request.json
```

The request wraps the exact model draft in `draft` and carries `allowed_target_fact_ids` separately as a trusted input. The writer validates claim IDs against that allow-list but does not emit citations or anchor claims to evidence in the DOCX; fact claims and IDs remain validation metadata and are not rendered. It emits editable headings/body and visible `【待人工确认：…】` paragraphs, and returns only a bounded summary with the output hash and size. The configured output directory is worker-only configuration, never model/request input; ancestor symlinks resolve to a canonical path, and the final staging directory must be owned by the worker user with no group/other permissions on POSIX. It does not receive reference body text or issuer identity, create tracked revisions, select reference material, verify factual leakage, check Word/WPS fidelity or professional quality, or install into the production worker/runtime. Its deterministic synthetic tests establish only structural behavior. It remains a non-installed renderer pending content/fact-leakage and evidence-anchoring, Word, and professional acceptance before any delivery integration.

For DOCX, parser version `bondbuddy-document-parser-1.0.3` treats inline `w:ins` and `w:moveTo` content as current text and formatting evidence, and excludes `w:del` and `w:moveFrom` content without changing the source bytes. Formatting summaries follow effective run order, including accepted revision runs; adjacent runs with the same resolved style are combined. Revision range markers and table/property revision markers are not resolved; their presence produces `needs_confirmation` and marks every extracted DOCX record with `docx_revision_effective_text_unresolved`. Headers, footers, notes, text boxes, drawings and other uncovered parts are reported explicitly. PDF image content is not OCR processed in this slice. XLSX formula expressions remain the literal quotes; non-empty cached results are retained under `formatting.cached_formula_result` and marked `formula_cached_result_unverified` because cache freshness and calculation correctness cannot be established. Formulas without cached results remain marked `formula_result_not_cached` and are never converted to zero.
