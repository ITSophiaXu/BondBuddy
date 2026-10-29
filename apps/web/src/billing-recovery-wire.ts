import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {schemas,CommercePriceMetadataSchema,WorkpaperStartSchema,Int64Schema,billingDtoSchema,
  BILLING_WIRE_HEADER,LEGACY_BILLING_WIRE_VERSION,type BillingWireDto,type BillingWireDtoName} from '@bondbuddy/contracts';

// Only persisted requests use these schemas. New HTTP requests still require
// int64 strings. Legacy requests retain both their original numbers and limits.
type RecoveryValue<T,F extends BillingWireDtoName>={[K in keyof T]:K extends keyof BillingWireDto<T,F>?T[K]|BillingWireDto<T,F>[K]:T[K]};
function recoverySchema<S extends TSchema,F extends BillingWireDtoName>(schema:S,family:F){
  const legacy=Type.Intersect([schema,billingDtoSchema(schema,family,Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})) as TSchema]);
  const current=billingDtoSchema(schema,family,Int64Schema) as TSchema;
  return Type.Union([current,legacy]) as TSchema&{static:RecoveryValue<Static<S>,F>};
}
export const billingRecoverySchemas={
  QaAnswerRequest:recoverySchema(schemas.QaAnswerRequest,'qaAnswerRequest'),
  IntegrityRunRequest:recoverySchema(schemas.IntegrityRunRequest,'integrityRunRequest'),
  ProjectFileBatchRequest:recoverySchema(schemas.ProjectFileBatchRequest,'projectFileBatchRequest'),
  ProjectFileCheckRequest:recoverySchema(schemas.ProjectFileCheckRequest,'projectFileCheckRequest'),
  ProjectFileUpdateRequest:recoverySchema(schemas.ProjectFileUpdateRequest,'projectFileUpdateRequest'),
  ProjectFileUpdateQuoteResponse:recoverySchema(schemas.ProjectFileUpdateQuoteResponse,'projectFileUpdateQuote'),
  CommercePriceMetadata:recoverySchema(CommercePriceMetadataSchema,'commerceMetadata'),
  WorkpaperStart:recoverySchema(WorkpaperStartSchema,'workpaperStart'),
};
export type BillingRecoveryDto<K extends keyof typeof billingRecoverySchemas>=Static<(typeof billingRecoverySchemas)[K]>;
type RequestName=Exclude<keyof typeof billingRecoverySchemas,'ProjectFileUpdateQuoteResponse'|'CommercePriceMetadata'>;
/** Call only when replaying a validated pending request, never for arbitrary API bodies. */
export function billingRecoveryHeaders(kind:RequestName,body:unknown):Record<string,string>{
  if(!Value.Check(billingRecoverySchemas[kind],body))throw new Error('Invalid persisted billing request');
  return typeof (body as {expected_points?:unknown}).expected_points==='number'?{[BILLING_WIRE_HEADER]:LEGACY_BILLING_WIRE_VERSION}:{};
}
