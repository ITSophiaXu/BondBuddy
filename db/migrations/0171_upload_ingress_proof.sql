-- A same-origin PUT is hashed and inspected by the API before it writes Blob.
-- Bind that trusted ingress result to the exact stored object version so
-- completion can use a HEAD probe instead of downloading the bytes again.
ALTER TABLE bb_uploads
 ADD COLUMN received_etag text,
 ADD COLUMN received_media_type text,
 ADD COLUMN received_signature_assessment jsonb,
 ADD COLUMN received_inspection_excepted boolean NOT NULL DEFAULT false;

ALTER TABLE bb_uploads ADD CONSTRAINT bb_upload_received_etag_length
 CHECK (received_etag IS NULL OR length(received_etag) BETWEEN 1 AND 512);
