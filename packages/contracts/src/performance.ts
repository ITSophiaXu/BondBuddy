import {Type,type Static,type TSchema} from '@sinclair/typebox';
const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const fields=<const K extends readonly string[],T extends TSchema>(keys:K,schema:T)=>Object.fromEntries(keys.map(key=>[key,schema])) as {[P in K[number]]:T};
const nullable=<T extends TSchema>(s:T)=>Type.Union([s,Type.Null()]);
const id=Type.String({pattern:'^[A-Za-z0-9_-]{1,128}$'}), code=Type.String({pattern:'^[A-Za-z0-9_.:-]{1,128}$'});
const utc=Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'}), count=Type.Integer({minimum:0}), ms=Type.Number({minimum:0});
export const PERFORMANCE_FILTERS=['from','to','owner_user_id','project_id','task_kind','run_state','channel','stage','step_key','span_status','model_provider','model_id','release_sha'] as const;
export type PerformanceFilters=Partial<Record<typeof PERFORMANCE_FILTERS[number],string>>;
export const PERFORMANCE_SPAN_STATUSES=['running','succeeded','failed','cancelled','paused','reused','interrupted'] as const;
export type PerformanceSpanStatus=typeof PERFORMANCE_SPAN_STATUSES[number];
export const PERFORMANCE_ATTRIBUTE_CODES=['chapter_id','spool_id','execution_node_id','execution_node_epoch','execution_session_id','original_execution_node_epoch','original_execution_session_id','lease_token_sha256','stage','wait_reason','error_code','logical_call_id','parent_logical_call_id','fallback_reason','call_id','model_id','model_provider','adapter','adapter_version','model_config_version','reasoning_effort','cache_status','cache_kind','cache_reason','tool_type','tool_name','tool_server','event_kind','result_status','business_mode','material_id','artifact_id','source_sha256','content_sha256','operation','format','kind','outcome','measurement_source','ttft_availability','resource_scope','resource_availability','gateway_measurement_source','batch_id','group_id','work_item_id','parent_job_id','producer_run_id','author_run_id','producer_span_id','producer_item_id','reused_from_span_id','object_ref','artifact_kind','repair_reason','status','service_role','worker_instance_id','release_sha','image_digest','host_id','process_session_id'] as const;
export const PERFORMANCE_ATTRIBUTE_COUNTS=['attempt_no','item_attempt','repair_round','batch_index','material_index','item_index','bytes','byte_size','bytes_expected','bytes_read','bytes_written','input_bytes','output_bytes','page_count','file_count','table_count','image_count','item_count','input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','tool_count','tool_attempts','tool_missing_start_count','tool_missing_end_count','tool_omitted_count','tool_observed_start_count','tool_measured_count','tool_measured_duration_sum_ms','tool_measured_busy_union_ms','tool_tracking_overflow_count','tool_active_count','gateway_request_count','gateway_request_duration_sum_ms','gateway_response_headers_ms','gateway_first_byte_ms','cgroup_cpu_usage_usec','cgroup_cpu_throttled_usec','cgroup_memory_bytes','cgroup_process_count','worker_process_active_codex','resource_sample_count','resource_sample_error_count','poll_count','retry_count','max_parallel','exit_code','first_stdout_ms','first_event_ms','first_agent_message_observed_ms','tool_busy_union_ms','tool_duration_sum_ms','idle_since_last_event_ms','read_count','write_count','duration_ms','elapsed_ms'] as const;
export const PERFORMANCE_ATTRIBUTE_FLAGS=['cache_hit','reused','schema_reask','snapshot_reused','timing_complete','end_missing','tool_timing_complete','tool_aggregate_timing_complete','tool_dedup_uncertain','owns_worker_slot','cancel_requested'] as const;
export const PerformanceAttributesSchema=obj({
 ...fields(PERFORMANCE_ATTRIBUTE_CODES,Type.Optional(code)),
 ...fields(PERFORMANCE_ATTRIBUTE_COUNTS,Type.Optional(nullable(ms))),
 ...fields(PERFORMANCE_ATTRIBUTE_FLAGS,Type.Optional(Type.Boolean())),
 ttft_ms:Type.Optional(nullable(ms)),
});
export type PerformanceAttributes=Record<string,string|number|boolean|null>;
export const PerformanceSpanSchema=obj({
 span_id:id,parent_span_id:nullable(id),session_id:id,run_execution_id:id,trace_id:id,run_id:id,job_id:nullable(id),
 stage:nullable(code),step_key:code,step_version:Type.Literal(1),
 status:Type.Union(PERFORMANCE_SPAN_STATUSES.map(s=>Type.Literal(s))),
 started_at:utc,ended_at:nullable(utc),duration_ms:nullable(ms),last_activity_at:utc,
 clock_source:Type.Union([Type.Literal('monotonic'),Type.Literal('database_event_interval'),Type.Literal('wall_clock_observation')]),
 attributes:PerformanceAttributesSchema,span_links:Type.Array(id,{maxItems:16}),
});
export type PerformanceSpan=Static<typeof PerformanceSpanSchema>;
export const PerformanceSessionSchema=obj({
 session_id:id,run_execution_id:id,service_role:nullable(code),worker_instance_id:nullable(id),release_sha:nullable(code),
 started_at:utc,ended_at:nullable(utc),last_flush_at:nullable(utc),closed:Type.Boolean(),
 generated:count,acknowledged:count,dropped:count,invalid_attributes:count,flush_errors:count,last_sequence:count,complete:Type.Boolean(),purged_at:nullable(utc),purged_span_count:count,purge_reason:nullable(code),purge_policy_version:nullable(code),
});
export type PerformanceSession=Static<typeof PerformanceSessionSchema>;
export const PerformanceCoverageSchema=obj({
 run_count:count,instrumented_run_count:count,uninstrumented_run_count:count,session_count:count,
 complete_session_count:count,purged_session_count:count,purged_span_count:count,span_count:count,unfinished_span_count:count,dropped_spans:count,invalid_attributes:count,flush_errors:count,complete:Type.Boolean(),
});
export type PerformanceCoverage=Static<typeof PerformanceCoverageSchema>;
export const PerformanceSummaryRowSchema=obj({
 task_kind:code,stage:nullable(code),step_key:code,step_version:Type.Literal(1),span_status:Type.Union(PERFORMANCE_SPAN_STATUSES.map(s=>Type.Literal(s))),
 model_provider:nullable(code),model_id:nullable(code),release_sha:nullable(code),run_state:code,
 span_count:count,run_count:count,completed_count:count,timed_count:count,running_count:count,failed_count:count,missing_duration_count:count,
 mean_ms:nullable(ms),p50_ms:nullable(ms),p90_ms:nullable(ms),p95_ms:nullable(ms),max_ms:nullable(ms),
});
export type PerformanceSummaryRow=Static<typeof PerformanceSummaryRowSchema>;
export const AdminPerformanceRunResponseSchema=obj({
 schema_version:Type.Literal(1),captured_at:utc,snapshot_at:utc,audit_id:id,run_id:id,trace_id:id,
 run:obj({created_at:utc,state:code,started_at:nullable(utc),ended_at:nullable(utc)}),
 items:Type.Array(PerformanceSpanSchema,{maxItems:500}),next_cursor:nullable(Type.String({maxLength:16384})),total:count,
 coverage:PerformanceCoverageSchema,sessions:Type.Array(PerformanceSessionSchema),
});
export const AdminPerformanceSummaryResponseSchema=obj({
 schema_version:Type.Literal(1),captured_at:utc,audit_id:id,
 scope:obj({from:nullable(utc),to:nullable(utc),filters:Type.Record(Type.String(),Type.String()),full_filtered_scope:Type.Literal(true)}),
 coverage:PerformanceCoverageSchema,items:Type.Array(PerformanceSummaryRowSchema),
});
export type AdminPerformanceRunResponse=Static<typeof AdminPerformanceRunResponseSchema>;
export type AdminPerformanceSummaryResponse=Static<typeof AdminPerformanceSummaryResponseSchema>;
export const performanceSchemas={AdminPerformanceRunResponse:AdminPerformanceRunResponseSchema,AdminPerformanceSummaryResponse:AdminPerformanceSummaryResponseSchema};
