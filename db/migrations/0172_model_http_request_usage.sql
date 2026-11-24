-- One content-free record per HTTP request observed by the local model gateway.
-- A Codex attempt can contain thousands of provider requests; its final usage can
-- be unknown after timeout even when earlier responses supplied measured usage.
CREATE TABLE bb_model_http_request_usage (
  attempt_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  job_id text NOT NULL,
  model_id text NOT NULL,
  started_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  path text NOT NULL,
  upstream_attempted boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed','client_closed','upstream_error','gateway_rejected')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  upstream_request_id text,
  response_id text,
  request_bytes bigint NOT NULL CHECK (request_bytes >= 0),
  response_bytes bigint CHECK (response_bytes >= 0),
  usage_parse text CHECK (usage_parse IN ('ok','skipped','incomplete')),
  input_tokens bigint CHECK (input_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  PRIMARY KEY (attempt_id,seq),
  FOREIGN KEY (owner_user_id,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,id),
  FOREIGN KEY (owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY (owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens),
  CHECK (reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens)
);
CREATE INDEX bb_model_http_request_usage_day_idx ON bb_model_http_request_usage(started_at,model_id);
CREATE INDEX bb_model_http_request_usage_run_idx ON bb_model_http_request_usage(run_id,started_at);

-- Review-assistant messages do not create bb_runs or bb_jobs. Keep their HTTP
-- evidence under the real assistant attempt instead of fabricating run IDs.
CREATE TABLE bb_review_assistant_http_request_usage (
  attempt_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  message_id text NOT NULL,
  model_id text NOT NULL,
  started_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('completed','client_closed','upstream_error','gateway_rejected')),
  upstream_attempted boolean NOT NULL,
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  upstream_request_id text,
  response_id text,
  input_tokens bigint CHECK (input_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  PRIMARY KEY (attempt_id,seq),
  FOREIGN KEY (attempt_id) REFERENCES bb_review_assistant_attempts(id),
  FOREIGN KEY (owner_user_id,project_id,message_id) REFERENCES bb_review_messages(owner_user_id,project_id,id),
  CHECK (cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens <= input_tokens),
  CHECK (reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens)
);
CREATE INDEX bb_review_assistant_http_request_day_idx ON bb_review_assistant_http_request_usage(started_at,model_id);
