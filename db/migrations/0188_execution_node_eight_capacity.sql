-- Raise runtime admission only. Frozen batch manifests/max_parallel stay intact.
ALTER TABLE bb_execution_capacity_policy DROP CONSTRAINT bb_execution_capacity_policy_node_model_limit_check;
ALTER TABLE bb_execution_capacity_policy ADD CONSTRAINT bb_execution_capacity_policy_node_model_limit_check CHECK(node_model_limit IN (4,8));
ALTER TABLE bb_model_capacity_holders DROP CONSTRAINT bb_model_capacity_holders_node_slot_check;
ALTER TABLE bb_model_capacity_holders ADD CONSTRAINT bb_model_capacity_holders_node_slot_check CHECK(node_slot BETWEEN 1 AND 8);
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('bb_execution_claim_context()'::regprocedure) INTO definition;
 IF position('IF occupied>=4 THEN' in definition)=0 THEN RAISE EXCEPTION 'Unexpected execution claim capacity'; END IF;
 EXECUTE replace(definition,'IF occupied>=4 THEN','IF occupied>=policy.node_model_limit THEN');
 SELECT pg_get_functiondef('bb_execution_guard_capacity()'::regprocedure) INTO definition;
 IF position('execution_node_id=n.id)>=4' in definition)=0 THEN RAISE EXCEPTION 'Unexpected execution model capacity'; END IF;
 EXECUTE replace(definition,'execution_node_id=n.id)>=4','execution_node_id=n.id)>=p.node_model_limit OR NEW.node_slot>p.node_model_limit');
 SELECT pg_get_functiondef('bb_batch_child_identity(text,text,integer,text,text)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,'''4''::text','')))/length('''4''::text')<>3 THEN RAISE EXCEPTION 'Unexpected batch admission capacity'; END IF;
 EXECUTE replace(definition,'''4''::text','''8''::text');
END $$;
