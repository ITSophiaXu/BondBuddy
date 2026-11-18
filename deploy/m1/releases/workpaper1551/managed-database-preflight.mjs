/** Read-only admission check for the consumer's actual database identity. */
export async function assertManagedDatabasePrivileges(pool) {
    const result = await pool.query(`
    SELECT name FROM (VALUES
      ('model_capacity_sequence', has_sequence_privilege(current_user,'public.bb_model_capacity_order','USAGE')),
      ('reservation_state', has_column_privilege(current_user,'public.bb_credit_reservations','state','UPDATE')),
      ('reservation_finalized_at', has_column_privilege(current_user,'public.bb_credit_reservations','finalized_at','UPDATE')),
      ('file_check_attempts', has_table_privilege(current_user,'public.bb_project_file_check_attempts','SELECT')),
      ('workpaper_paid_check_items', has_table_privilege(current_user,'public.bb_workpaper_paid_check_items','SELECT')),
      ('workpaper_execution_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_m4_executions',col,'INSERT'))
        FROM unnest(ARRAY['run_id','owner_user_id','topic_id','manifest','input_hash']) AS columns(col))),
      ('reservation_charged_points_insert', has_column_privilege(current_user,'public.bb_credit_reservations','charged_points','INSERT')),
      ('platform_probe_owner', (SELECT bool_and(has_column_privilege(current_user,'public.bb_platform_principals',col,'SELECT'))
        FROM unnest(ARRAY['user_id','purpose']) AS columns(col))),
      ('evidence_gate_lock', has_function_privilege(current_user,to_regprocedure('public.bb_lock_evidence_gate(boolean)'),'EXECUTE')),
      ('model_activity_read', has_table_privilege(current_user,'public.bb_run_model_activity','SELECT')),
      ('model_activity_delete', has_table_privilege(current_user,'public.bb_run_model_activity','DELETE')),
      ('model_activity_insert', (SELECT bool_and(has_column_privilege(current_user,'public.bb_run_model_activity',col,'INSERT'))
        FROM unnest(ARRAY['request_id','owner_user_id','run_id','job_id','lease_token','state']) AS columns(col))),
      ('model_activity_update', (SELECT bool_and(has_column_privilege(current_user,'public.bb_run_model_activity',col,'UPDATE'))
        FROM unnest(ARRAY['state','updated_at']) AS columns(col)))
    ) AS required(name,allowed) WHERE NOT COALESCE(allowed,false) ORDER BY name
  `);
    if (result.rows.length)
        throw Error('MANAGED_DATABASE_PRIVILEGES_MISSING:' + result.rows.map(row => row.name).join(','));
}
