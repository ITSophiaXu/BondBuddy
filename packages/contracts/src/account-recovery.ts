import { Type, type TSchema } from '@sinclair/typebox';
const obj = <T extends Record<string, TSchema>>(properties:T) => Type.Object(properties,{additionalProperties:false});
const nullable = <T extends TSchema>(schema:T) => Type.Union([schema,Type.Null()]);
const id = Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'});
const time = Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'});
const password = Type.String({minLength:12,maxLength:128});
const token = Type.String({pattern:'^[A-Za-z0-9_-]{43}$'});
export const RECOVERY_POLICY = { linkMinutes:30, bindingRequestHours:24, ticketHours:24, contactMaxLength:200, codeLength:12 } as const;
export const RECOVERY_CHANNEL_KINDS = ['email','support_chat'] as const;
export const RECOVERY_EVENT_TYPES = ['recovery.binding_requested','recovery.binding_viewed','recovery.binding_code_issued','recovery.binding_confirmed','recovery.binding_rejected','recovery.ticket_created','recovery.ticket_viewed','recovery.link_issued','recovery.password_reset'] as const;
export const RECOVERY_ROLE = 'account_recovery' as const;
const kind = Type.Union(RECOVERY_CHANNEL_KINDS.map(v=>Type.Literal(v)));
const channel = obj({binding_id:id,kind,contact_masked:Type.String(),verified_at:nullable(time),expires_at:nullable(time),code_issued:Type.Boolean()});
export const recoverySchemas = {
  RecoveryInfoResponse:obj({enabled:Type.Boolean(),support_contact:nullable(Type.String()),link_minutes:Type.Literal(RECOVERY_POLICY.linkMinutes)}),
  RecoveryAccountResponse:obj({enabled:Type.Boolean(),support_operator:Type.Boolean(),current:nullable(channel),pending:nullable(channel)}),
  RecoveryBindingRequest:obj({kind,contact:Type.String({minLength:3,maxLength:RECOVERY_POLICY.contactMaxLength,pattern:'^[^\\u0000-\\u001f\\u007f]+$'}),current_password:Type.String({minLength:1,maxLength:512})}),
  RecoveryBindingResponse:obj({binding_id:id,status:Type.Literal('pending'),expires_at:time}),
  RecoveryConfirmRequest:obj({code:Type.String({pattern:'^[A-Za-z0-9_-]{12}$'})}),
  RecoveryTicketRequest:obj({username:Type.String({pattern:'^[A-Za-z][A-Za-z0-9_]{2,31}$'})}),
  RecoveryTicketResponse:obj({ticket_id:id,status:Type.Literal('received')}),
  RecoveryResetRequest:obj({token,new_password:password}),
  RecoveryResetResponse:obj({status:Type.Literal('password_reset'),sessions_revoked:Type.Integer({minimum:0})}),
  RecoverySupportBindingResponse:obj({binding_id:id,username:Type.String(),kind,contact:Type.String(),requested_at:time}),
  RecoverySupportCodeResponse:obj({code:Type.String(),expires_at:time,contact:Type.String(),kind}),
  RecoverySupportTicketResponse:obj({ticket_id:id,username:Type.String(),binding_id:id,kind,contact:Type.String(),verified_at:time,requested_at:time,status:Type.Union([Type.Literal('open'),Type.Literal('issued'),Type.Literal('completed')])}),
  RecoveryIssueRequest:obj({binding_id:id,confirmed_original_channel:Type.Literal(true)}),
  RecoveryLinkResponse:obj({reset_path:Type.String(),expires_at:time})
};
export const RECOVERY_OPERATIONS = [
  ['get','/auth/recovery/info','RecoveryInfoResponse'],
  ['post','/auth/recovery/requests','RecoveryTicketResponse','RecoveryTicketRequest'],
  ['post','/auth/recovery/reset','RecoveryResetResponse','RecoveryResetRequest'],
  ['get','/account/recovery','RecoveryAccountResponse'],
  ['post','/account/recovery/bindings','RecoveryBindingResponse','RecoveryBindingRequest'],
  ['post','/account/recovery/bindings/{binding_id}/confirm','RecoveryAccountResponse','RecoveryConfirmRequest'],
  ['get','/admin/account-recovery/bindings/{binding_id}','RecoverySupportBindingResponse'],
  ['post','/admin/account-recovery/bindings/{binding_id}/code','RecoverySupportCodeResponse'],
  ['get','/admin/account-recovery/tickets/{ticket_id}','RecoverySupportTicketResponse'],
  ['post','/admin/account-recovery/tickets/{ticket_id}/issue','RecoveryLinkResponse','RecoveryIssueRequest']
] as const;
