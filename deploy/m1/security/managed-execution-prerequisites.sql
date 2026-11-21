-- Apply after 0190, once for each reviewed authoring/review consumer. Preserve
-- the captured base ACL; this is the explicit delta, not a blanket role grant.
-- psql -v ON_ERROR_STOP=1 -v runtime_role=<reviewed role> -f <this file>
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
GRANT USAGE ON SEQUENCE public.bb_model_capacity_order TO :"runtime_role";
GRANT UPDATE(state,finalized_at)
 ON public.bb_credit_reservations TO :"runtime_role";
GRANT SELECT ON public.bb_project_file_check_attempts TO :"runtime_role";
-- bb_m3_project_run_mutex reads these immutable batch identities as the caller.
GRANT SELECT ON public.bb_workpaper_paid_check_items TO :"runtime_role";
-- Both run/job INSERT guards check the reserved platform identity.
GRANT SELECT(user_id,purpose) ON public.bb_platform_principals TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.bb_lock_evidence_gate(boolean) TO :"runtime_role";
-- The progressive consumer creates the child execution and its reservation.
GRANT INSERT(run_id,owner_user_id,topic_id,manifest,input_hash)
 ON public.bb_m4_executions TO :"runtime_role";
GRANT INSERT(charged_points) ON public.bb_credit_reservations TO :"runtime_role";
-- Deferred acceptance capture runs at COMMIT under the consumer identity.
-- It records immutable refund evidence; it does not approve or issue a refund.
GRANT INSERT(owner_user_id,reservation_id,item_id,run_id,ordinal,source_item_key,
             label,points,scope_quote_id,evidence_kind,evidence)
 ON public.bb_task_refund_units TO :"runtime_role";
GRANT INSERT(reservation_id,item_id,origin_lot_id,points)
 ON public.bb_task_refund_unit_slices TO :"runtime_role";
-- Full-source workers also contain the 0182 activity writer.
GRANT SELECT, DELETE ON public.bb_run_model_activity TO :"runtime_role";
GRANT INSERT(request_id,owner_user_id,run_id,job_id,lease_token,state),
      UPDATE(state,updated_at)
 ON public.bb_run_model_activity TO :"runtime_role";
-- Fixed evidence only; no prompt, environment map, raw output or exception text.
GRANT INSERT ON public.bb_model_attempt_execution_configs TO :"runtime_role";
GRANT INSERT ON public.bb_model_result_failure_diagnostics TO :"runtime_role";
GRANT INSERT(exit_capture_status,finish_reason_capture_status)
 ON public.bb_model_call_attempt_runtime TO :"runtime_role";
-- v1 enrollment and immutable candidate evidence. This grants neither cloud
-- mutation nor provider-completed/settlement authority for an expired lease.
GRANT INSERT(workflow_protocol_version) ON public.bb_execution_node_sessions TO :"runtime_role";
GRANT SELECT ON public.bb_model_attempt_execution_configs,public.bb_execution_cloud_operations,
 public.bb_sealed_model_captures,public.bb_recovered_capture_evidence TO :"runtime_role";
GRANT INSERT(id,owner_user_id,project_id,run_id,job_id,attempt_id,logical_call_id,attempt_no,
 execution_node_id,execution_node_epoch,execution_session_id,lease_token,spool_id,manifest_sha256,
 call_exit_proof,raw_usage,raw_outcome,evidence_sha256)
 ON public.bb_sealed_model_captures TO :"runtime_role";
GRANT INSERT(id,owner_user_id,project_id,run_id,job_id,attempt_id,logical_call_id,attempt_no,
 original_node_id,original_epoch,original_session_id,recovery_session_id,capture_ref,capture_sha256,
 byte_size,manifest_sha256,evidence_sha256)
 ON public.bb_recovered_capture_evidence TO :"runtime_role";
-- Normal consumers can verify recovery scope, never manufacture control receipts.
GRANT SELECT ON public.bb_database_restore_quarantines,public.bb_database_restore_reconciliations,
 public.bb_database_restore_fence_releases TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.bb_restore_account_permitted(text),public.bb_workflow_run_eligible(text),
 public.bb_workflow_preparation_calls_safe(text,jsonb) TO :"runtime_role";
COMMIT;
