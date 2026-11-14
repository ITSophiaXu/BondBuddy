import { Type, type Static } from '@sinclair/typebox';

export const RUN_RETRY_MODES = ['resume','restore_checkpoint','restart_materials','blocked'] as const;
export type RetryMode = typeof RUN_RETRY_MODES[number];
export const RUN_RETRY_REASON_CODES = ['user_paused','checkpoint_available','restart_confirmation_required','not_paused','unsupported_task',
  'provider_evidence_unresolved','active_attempt','provider_result_present','provider_evidence_conflict','billing_not_ready','credits_exhausted',
  'retry_limit_reached','checkpoint_unavailable','user_pause_pending','checkpoint_capacity_exceeded','checkpoint_storage_failed',
  'checkpoint_integrity_failed','checkpoint_capture_incomplete'] as const;
const id=Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'});
export const RunRetryResponseSchema=Type.Object({run_id:id,mode:Type.Union(RUN_RETRY_MODES.map(v=>Type.Literal(v))),
  attempt_id:Type.Union([id,Type.Null()]),reason_code:Type.Union(RUN_RETRY_REASON_CODES.map(v=>Type.Literal(v)))},{additionalProperties:false});
export const RunRetryRequestSchema=Type.Object({request_id:id,attempt_id:id,
  mode:Type.Union([Type.Literal('restore_checkpoint'),Type.Literal('restart_materials')]),confirmed_restart:Type.Optional(Type.Boolean())},{additionalProperties:false});
export type RunRetryResponse=Static<typeof RunRetryResponseSchema>;
export type RunRetryRequest=Static<typeof RunRetryRequestSchema>;
