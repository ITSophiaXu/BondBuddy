-- User-visible draft sequence is distinct from the immutable storage artifact version.
ALTER TABLE bb_m4_artifacts ADD COLUMN revision_number integer CHECK(revision_number>0);
CREATE UNIQUE INDEX bb_m4_document_revision_number ON bb_m4_artifacts(topic_id,document_type,revision_number) WHERE kind='document';
