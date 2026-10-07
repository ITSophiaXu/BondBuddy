-- Unbound natural-language requirements are adopted once when a document task is selected.
CREATE TABLE bb_m4_pending_requirements (
 owner_user_id text NOT NULL, topic_id text NOT NULL, requirement_id text NOT NULL, message_id text NOT NULL,
 message_version integer NOT NULL, text text NOT NULL, consumed_document_type text,
 consumed_draft_version integer, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(topic_id,requirement_id), FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
 FOREIGN KEY(owner_user_id,message_id) REFERENCES bb_m4_messages(owner_user_id,id),
 CHECK((consumed_document_type IS NULL)=(consumed_draft_version IS NULL)),
 CHECK(consumed_document_type IS NULL OR consumed_document_type IN ('init','private_summary'))
);
