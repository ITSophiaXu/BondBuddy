ALTER TABLE bb_m4_topics ADD COLUMN surface text NOT NULL DEFAULT 'materials'
  CHECK (surface IN ('materials','assistant'));

CREATE TABLE bb_assistant_cards (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES bb_users(id),
  topic_id text NOT NULL REFERENCES bb_m4_topics(id),
  project_id text NOT NULL REFERENCES bb_projects(id),
  execution_request_id text NOT NULL,
  request jsonb NOT NULL,
  request_hash char(64) NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,execution_request_id)
);
CREATE INDEX bb_assistant_cards_topic ON bb_assistant_cards(owner_user_id,topic_id,created_at);

CREATE TABLE bb_project_creation_requests (
 owner_user_id text NOT NULL REFERENCES bb_users(id), request_id text NOT NULL,
 project_id text NOT NULL REFERENCES bb_projects(id), request_hash char(64) NOT NULL,
 PRIMARY KEY(owner_user_id,request_id)
);
