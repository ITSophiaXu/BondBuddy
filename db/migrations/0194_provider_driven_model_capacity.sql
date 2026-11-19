-- Keep the provider, approval and legacy-mode constraints from 0181.
-- The positive integer range is the storage type, not a capacity tier.
ALTER TABLE bb_execution_capacity_policy
 DROP CONSTRAINT bb_execution_capacity_policy_global_model_limit_check,
 DROP CONSTRAINT bb_execution_capacity_policy_provider_concurrency_limit_check,
 ADD CONSTRAINT bb_execution_capacity_policy_global_model_limit_check CHECK(global_model_limit>0),
 ADD CONSTRAINT bb_execution_capacity_policy_provider_concurrency_limit_check CHECK(provider_concurrency_limit>0);

ALTER TABLE bb_model_capacity_holders
 DROP CONSTRAINT bb_model_capacity_global_slot_check,
 ADD CONSTRAINT bb_model_capacity_global_slot_check CHECK(slot>0);
