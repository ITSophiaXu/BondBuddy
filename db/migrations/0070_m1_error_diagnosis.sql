-- #79: bounded diagnostics and indexed root-cause lookup. Existing evidence remains immutable.
ALTER TABLE bb_observability_errors
  ADD COLUMN provider_error_type text CHECK (provider_error_type IS NULL OR provider_error_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD COLUMN safe_message text CHECK (safe_message IS NULL OR octet_length(safe_message) <= 1024),
  ADD COLUMN safe_stack text CHECK (safe_stack IS NULL OR octet_length(safe_stack) <= 2048),
  ADD CONSTRAINT bb_error_provider_status_range CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599);
CREATE INDEX bb_errors_category_code_fingerprint_idx ON bb_observability_errors(category,code,fingerprint,created_at DESC);
