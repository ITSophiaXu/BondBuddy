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

For DOCX, parser version `bondbuddy-document-parser-1.0.1` treats inline `w:ins` and `w:moveTo` content as current text, and excludes `w:del` and `w:moveFrom` content without changing the source bytes. Revision range markers and table/property revision markers are not resolved; their presence produces `needs_confirmation` and marks every extracted DOCX record with `docx_revision_effective_text_unresolved`. Headers, footers, notes, text boxes, drawings and other uncovered parts are reported explicitly. PDF image content is not OCR processed in this slice. XLSX formulas without cached results remain formulas with uncertainty and are never converted to zero.
