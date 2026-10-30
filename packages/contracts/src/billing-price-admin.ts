import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {AUTOMATIC_TASK_TARIFF,type AutomaticTaskSku} from './automatic-pricing.js';
import {Int64Schema} from './billing-integers.js';

export const AUTOMATIC_TASK_SKUS=Object.keys(AUTOMATIC_TASK_TARIFF) as AutomaticTaskSku[];
export const LEGACY_BASE_COST_VERSION='bb-standard-cost-20261029-incomplete';
const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const integer=Int64Schema;
const signed=Type.String({pattern:'^-?(0|[1-9][0-9]{0,18})$'});
const cost=Type.String({pattern:'^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,12})?$'});
const sha=Type.String({pattern:'^[a-f0-9]{64}$'});
const stamp=Type.String({format:'date-time'});
const nullable=<T extends TSchema>(s:T)=>Type.Union([s,Type.Null()]);
const sku=Type.Union(AUTOMATIC_TASK_SKUS.map(s=>Type.Literal(s)));
const source=Type.String({minLength:1,maxLength:2000});
const costRow=obj({sku,planned_cost_cny:nullable(cost),base_price_fen:integer,source});
const costVersion=obj({id,checksum:sha,complete:Type.Boolean(),created_at:stamp,created_by:id,change_reason:source,rows:Type.Array(costRow,{minItems:12,maxItems:12})});
const row=obj({sku,label:Type.String(),unit:Type.String(),planned_cost_cny:nullable(cost),base_price_fen:integer,previous_points:integer,points:integer,delta_points:signed});
const check=obj({code:id,passed:Type.Boolean(),message:Type.String()});
const version=obj({id,base_cost_version:id,base_cost_checksum:sha,multiplier_bps:integer,comparison_version:id,change_reason:source,
  state:Type.Union([Type.Literal('DRAFT'),Type.Literal('PUBLISHED')]),checksum:sha,validated_checksum:nullable(sha),validation_checks:Type.Array(check),
  effective_at:nullable(stamp),created_at:stamp,created_by:id,published_at:nullable(stamp),published_by:nullable(id),rollback_of:nullable(id),rows:Type.Array(row,{minItems:12,maxItems:12})});
export const billingPriceAdminSchemas={
  BillingCostVersionCreateRequest:obj({request_id:id,rows:Type.Array(obj({sku,planned_cost_cny:cost,source}),{minItems:12,maxItems:12}),change_reason:source}),
  BillingCostVersionResponse:obj({cost_version:costVersion}),
  BillingCostVersionsResponse:obj({items:Type.Array(costVersion)}),
  BillingPriceDraftCreateRequest:obj({request_id:id,base_cost_version:id,multiplier_bps:integer,change_reason:source,rollback_of:Type.Optional(id)}),
  BillingPriceValidateRequest:obj({expected_checksum:sha}),
  BillingPricePublishRequest:obj({effective_at:stamp,expected_checksum:sha}),
  BillingPriceVersionResponse:obj({version}),
  BillingPriceVersionsResponse:obj({current_version:id,items:Type.Array(version)}),
};
export type BillingCostVersion=Static<typeof costVersion>;
export type BillingPriceVersion=Static<typeof version>;
export type BillingCostVersionCreate=Static<typeof billingPriceAdminSchemas.BillingCostVersionCreateRequest>;
export type BillingPriceDraftCreate=Static<typeof billingPriceAdminSchemas.BillingPriceDraftCreateRequest>;
export type BillingPriceValidate=Static<typeof billingPriceAdminSchemas.BillingPriceValidateRequest>;
export type BillingPricePublish=Static<typeof billingPriceAdminSchemas.BillingPricePublishRequest>;

/** Planned attributable cost, not a supplier invoice. Each stage is independently rounded upward. */
export function standardCostBaseFen(costCny:string):string{
  if(typeof costCny!=='string'||!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,12})?$/.test(costCny))throw new RangeError('Invalid standard cost');
  const [whole,frac='']=costCny.split('.'),scale=10n**BigInt(frac.length),cost=BigInt(whole)*scale+BigInt(frac||'0');
  if(cost<=0n)throw new RangeError('Standard cost must be positive');
  return((cost*2120n+scale-1n)/scale).toString();
}
export function standardCostPoints(baseFen:string,multiplierBps:string):string{
  if(typeof baseFen!=='string'||typeof multiplierBps!=='string'||!/^[1-9][0-9]{0,18}$/.test(baseFen)||!/^[1-9][0-9]{0,6}$/.test(multiplierBps))throw new RangeError('Invalid price multiplier');
  const bps=BigInt(multiplierBps);if(bps>1000000n)throw new RangeError('Price multiplier exceeds 100x');
  const points=(BigInt(baseFen)*bps+9999n)/10000n;
  if(points>9223372036854775807n)throw new RangeError('Price exceeds int64');
  return points.toString();
}
