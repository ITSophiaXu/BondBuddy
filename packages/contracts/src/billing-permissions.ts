import {Type,type Static} from '@sinclair/typebox';

/** Billing authority is separate from log access, marketing grants and the model. */
export const BILLING_PERMISSIONS=['price_draft','price_publish','task_refund_approve','billing_repair','credit_adjust_approve'] as const;
export type BillingPermission=typeof BILLING_PERMISSIONS[number];
export const BillingPermissionSchema=Type.Union(BILLING_PERMISSIONS.map(value=>Type.Literal(value)));
export const billingPermissionSchemas={
  BillingPermissionsResponse:Type.Object({permissions:Type.Array(BillingPermissionSchema,{uniqueItems:true})},{additionalProperties:false}),
};
export type BillingPermissionsResponse=Static<typeof billingPermissionSchemas.BillingPermissionsResponse>;
