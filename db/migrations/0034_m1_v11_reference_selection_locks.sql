-- #33/#77: v1.1 reference-selection locks retain the reviewed profile version and
-- accepted source->target chapter mapping used during selection. Existing v1 locks
-- remain valid with a null mapping id and their original query schema label.
ALTER TABLE bb_library_selection_locks
  ADD COLUMN chapter_mapping_version_id text REFERENCES bb_library_chapter_mapping_versions(id),
  ADD CONSTRAINT bb_library_selection_lock_query_schema_check
    CHECK (query_schema_version IN ('reference-library-query-v1','reference-library-query-v1.1')
      AND (query_schema_version <> 'reference-library-query-v1' OR chapter_mapping_version_id IS NULL));

COMMENT ON COLUMN bb_library_selection_locks.chapter_mapping_version_id IS
  'The exact accepted #77 chapter-mapping version validated for a v1.1 selection; null for same-scope selections and legacy v1 locks.';
