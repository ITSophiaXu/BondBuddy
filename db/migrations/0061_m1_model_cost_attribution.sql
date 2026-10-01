-- #79: versioned, exact supplier rates. No unverified prices are seeded.
-- Rates are entered through a reviewed, append-only migration after #16 verification.

CREATE TABLE bb_model_cost_rates (
 rate_ref text PRIMARY KEY CHECK (rate_ref ~ '^[A-Za-z0-9._-]{1,128}$'),
 provider text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,64}$'),
 model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9._-]{1,128}$'),
 effective_from timestamptz NOT NULL,
 effective_until timestamptz,
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 input_per_million numeric(24,10) NOT NULL CHECK (input_per_million >= 0),
 cached_input_per_million numeric(24,10) NOT NULL CHECK (cached_input_per_million >= 0),
 output_per_million numeric(24,10) NOT NULL CHECK (output_per_million >= 0),
 reasoning_output_per_million numeric(24,10) NOT NULL CHECK (reasoning_output_per_million >= 0),
 verified_source_ref text NOT NULL CHECK (length(verified_source_ref) BETWEEN 1 AND 512),
 recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 128),
 recorded_reason text NOT NULL CHECK (length(recorded_reason) BETWEEN 1 AND 512),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK (effective_until IS NULL OR effective_until > effective_from),
 UNIQUE (provider,model_id,effective_from)
);
CREATE TRIGGER bb_model_cost_rates_immutable BEFORE UPDATE OR DELETE ON bb_model_cost_rates
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE OR REPLACE VIEW bb_platform_cost_ledger AS
SELECT a.id attempt_id,a.owner_user_id,a.job_id,j.run_id,a.logical_call_id,a.attempt_no,
 a.model_id,a.status call_status,
 e.usage_status,e.input_tokens,e.output_tokens,e.cached_input_tokens,e.reasoning_tokens,
 rt.duration_ms,
 CASE WHEN a.status='confirmed_not_sent' OR e.usage_status<>'measured' OR a.model_id IS NULL OR rt.model_provider IS NULL THEN 'unknown'
      WHEN rate.rate_ref IS NULL THEN 'rate_missing' ELSE 'priced' END pricing_status,
 a.created_at,
 rt.model_provider,
 (a.status <> 'confirmed_not_sent') billable,'platform'::text cost_bearer,
 rate.rate_ref,
 CASE WHEN a.status<>'confirmed_not_sent' AND e.usage_status='measured' AND rate.rate_ref IS NOT NULL THEN rate.currency END currency,
 CASE WHEN a.status<>'confirmed_not_sent' AND e.usage_status='measured' AND rate.rate_ref IS NOT NULL THEN
   round((
     (e.input_tokens-COALESCE(e.cached_input_tokens,0))*rate.input_per_million +
     COALESCE(e.cached_input_tokens,0)*rate.cached_input_per_million +
     (e.output_tokens-COALESCE(e.reasoning_tokens,0))*rate.output_per_million +
     COALESCE(e.reasoning_tokens,0)*rate.reasoning_output_per_million
   )/1000000,10) END cost_amount
FROM bb_model_call_attempts a
JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id
JOIN bb_call_usage_effective e ON e.attempt_id=a.id
LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id
LEFT JOIN LATERAL (
 SELECT r.* FROM bb_model_cost_rates r
 WHERE r.provider=rt.model_provider AND r.model_id=a.model_id
   AND a.created_at>=r.effective_from AND (r.effective_until IS NULL OR a.created_at<r.effective_until)
 ORDER BY r.effective_from DESC LIMIT 1
) rate ON true;
