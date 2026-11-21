import type { Pool } from 'pg';

/** Read-only admission check for the consumer's actual database identity. */
export async function assertManagedDatabasePrivileges(pool: Pool): Promise<void> {
  const result = await pool.query<{ name: string }>(`
    SELECT name FROM (VALUES
      ('model_capacity_sequence', has_sequence_privilege(current_user,'public.bb_model_capacity_order','USAGE')),
      ('reservation_state', has_column_privilege(current_user,'public.bb_credit_reservations','state','UPDATE')),
      ('reservation_finalized_at', has_column_privilege(current_user,'public.bb_credit_reservations','finalized_at','UPDATE')),
      ('file_check_attempts', has_table_privilege(current_user,'public.bb_project_file_check_attempts','SELECT')),
      ('workpaper_paid_check_items', has_table_privilege(current_user,'public.bb_workpaper_paid_check_items','SELECT')),
      ('workpaper_execution_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_m4_executions',col,'INSERT'))
        FROM unnest(ARRAY['run_id','owner_user_id','topic_id','manifest','input_hash']) AS columns(col))),
      ('reservation_charged_points_insert', has_column_privilege(current_user,'public.bb_credit_reservations','charged_points','INSERT')),
      ('refund_unit_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_task_refund_units',col,'INSERT'))
        FROM unnest(ARRAY['owner_user_id','reservation_id','item_id','run_id','ordinal','source_item_key','label','points','scope_quote_id','evidence_kind','evidence']) AS columns(col))),
      ('refund_slice_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_task_refund_unit_slices',col,'INSERT'))
        FROM unnest(ARRAY['reservation_id','item_id','origin_lot_id','points']) AS columns(col))),
      ('platform_probe_owner', (SELECT bool_and(has_column_privilege(current_user,'public.bb_platform_principals',col,'SELECT'))
        FROM unnest(ARRAY['user_id','purpose']) AS columns(col))),
      ('evidence_gate_lock', has_function_privilege(current_user,to_regprocedure('public.bb_lock_evidence_gate(boolean)'),'EXECUTE')),
      ('model_activity_read', has_table_privilege(current_user,'public.bb_run_model_activity','SELECT')),
      ('model_activity_delete', has_table_privilege(current_user,'public.bb_run_model_activity','DELETE')),
      ('model_activity_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_run_model_activity',col,'INSERT'))
        FROM unnest(ARRAY['request_id','owner_user_id','run_id','job_id','lease_token','state']) AS columns(col))),
      ('model_activity_update', (SELECT bool_and(has_column_privilege(current_user,'public.bb_run_model_activity',col,'UPDATE'))
        FROM unnest(ARRAY['state','updated_at']) AS columns(col))),
      ('model_execution_config_write', has_table_privilege(current_user,'public.bb_model_attempt_execution_configs','INSERT')),
      ('model_result_failure_write', has_table_privilege(current_user,'public.bb_model_result_failure_diagnostics','INSERT')),
      ('workflow_session_version_write', has_column_privilege(current_user,'public.bb_execution_node_sessions','workflow_protocol_version','INSERT')),
      ('workflow_phase_read', has_column_privilege(current_user,'public.bb_jobs','execution_admission_phase','SELECT')),
      ('restore_quarantine_read', has_table_privilege(current_user,'public.bb_database_restore_quarantines','SELECT')),
      ('restore_reconciliation_read', has_table_privilege(current_user,'public.bb_database_restore_reconciliations','SELECT')),
      ('restore_fence_read', has_table_privilege(current_user,'public.bb_database_restore_fence_releases','SELECT')),
      ('restore_account_gate', has_function_privilege(current_user,to_regprocedure('public.bb_restore_account_permitted(text)'),'EXECUTE')),
      ('workflow_eligibility_gate', has_function_privilege(current_user,to_regprocedure('public.bb_workflow_run_eligible(text)'),'EXECUTE')),
      ('workflow_outline_gate', has_function_privilege(current_user,to_regprocedure('public.bb_workflow_preparation_calls_safe(text,jsonb)'),'EXECUTE')),
      ('capture_config_read', has_table_privilege(current_user,'public.bb_model_attempt_execution_configs','SELECT')),
      ('sealed_capture_read', has_table_privilege(current_user,'public.bb_sealed_model_captures','SELECT')),
      ('sealed_capture_write', (SELECT bool_and(has_column_privilege(current_user,'public.bb_sealed_model_captures',col,'INSERT'))
        FROM unnest(ARRAY['id','owner_user_id','project_id','run_id','job_id','attempt_id','logical_call_id','attempt_no','execution_node_id','execution_node_epoch','execution_session_id','lease_token','spool_id','manifest_sha256','call_exit_proof','raw_usage','raw_outcome','evidence_sha256']) AS columns(col))),
      ('recovered_capture_read', has_table_privilege(current_user,'public.bb_recovered_capture_evidence','SELECT')),
      ('recovered_capture_write', (SELECT bool_and(has_column_privilege(current_user,'public.bb_recovered_capture_evidence',col,'INSERT'))
        FROM unnest(ARRAY['id','owner_user_id','project_id','run_id','job_id','attempt_id','logical_call_id','attempt_no','original_node_id','original_epoch','original_session_id','recovery_session_id','capture_ref','capture_sha256','byte_size','manifest_sha256','evidence_sha256']) AS columns(col))),
      ('runtime_exit_capture_write', (SELECT bool_and(has_column_privilege(current_user,'public.bb_model_call_attempt_runtime',col,'INSERT'))
        FROM unnest(ARRAY['exit_capture_status','finish_reason_capture_status']) AS columns(col)))
    ) AS required(name,allowed) WHERE NOT COALESCE(allowed,false) ORDER BY name
  `);
  if (result.rows.length) throw Error('MANAGED_DATABASE_PRIVILEGES_MISSING:'+result.rows.map(row=>row.name).join(','));
}
