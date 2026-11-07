import {Type,type Static} from '@sinclair/typebox';

/** Opaque change token: no document text, evidence, billing values or private identifiers. */
export const GenerationProgressSchema=Type.Object({
  revision:Type.String({pattern:'^[a-f0-9]{64}$'}),
  active:Type.Boolean()
},{additionalProperties:false});
export type GenerationProgress=Static<typeof GenerationProgressSchema>;
export const GenerationProgressQuerySchema=Type.Object({
  batch_id:Type.Optional(Type.String({minLength:1,maxLength:128}))
},{additionalProperties:false});

/** Paused queues only need refresh while an already-started item is settling. */
export function generationBatchActive(batch:{state:string;items:{state:string;run_id:string|null}[]}):boolean{
  return ['queued','running'].includes(batch.state)||batch.items.some(item=>!!item.run_id&&['queued','preparing','running','validating','delivering'].includes(item.state));
}
