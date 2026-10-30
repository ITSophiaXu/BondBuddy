/** Browser contracts use the current string wire. Persisted server manifests keep their original schema. */
export * from '@bondbuddy/contracts';
import * as domain from '@bondbuddy/contracts';
import type {Static,TSchema} from '@sinclair/typebox';
import {billingDtoSchema,Int64Schema,type BillingWireDto,type BillingWireDtoName} from '@bondbuddy/contracts';
type WireSchema<S extends TSchema,F extends BillingWireDtoName>=TSchema&{static:BillingWireDto<Static<S>,F>};
function wireSchema<S extends TSchema,F extends BillingWireDtoName>(s:S,f:F):WireSchema<S,F>{return billingDtoSchema(s,f,Int64Schema) as WireSchema<S,F>;}
const schemaFamilies={CreditBalanceResponse:'creditBalance',FixedQuoteResponse:'fixedQuoteResponse',RunCreditChargeResponse:'creditCharge',
 RechargeConfigResponse:'rechargeConfig',RechargeOrderResponse:'rechargeOrder',CreditConsumptionHistoryResponse:'consumptionHistory',RechargeHistoryResponse:'rechargeHistory',
 CommerceCatalogResponse:'commerceCatalog',CommerceAccountResponse:'commerceAccount',CommerceTopupRequest:'topupRequest',
 CommerceScopeQuotationResponse:'scopeQuotationResponse',CommerceScopeQuotationsResponse:'scopeQuotationList',
 PaymentRefundRequest:'refundRequest',PaymentRefundResponse:'refund',PaymentRefundEligibilityResponse:'refundEligibility',
 QaQuoteResponse:'qaQuote',QaAnswerRequest:'qaAnswerRequest',QaWorkspaceResponse:'qaWorkspace',
 IntegrityQuoteResponse:'integrityQuote',IntegrityRunRequest:'integrityRunRequest',IntegrityWorkspaceResponse:'integrityWorkspace',
 ProjectFileBatchRequest:'projectFileBatchRequest',ProjectFileBatchQuoteResponse:'projectFileBatchQuote',ProjectFileCheckRequest:'projectFileCheckRequest',ProjectFileCheckQuoteResponse:'projectFileCheckQuote',ProjectFileUpdateRequest:'projectFileUpdateRequest',ProjectFileUpdateQuoteResponse:'projectFileUpdateQuote',
 SubscriptionCatalogResponse:'subscriptionCatalog',SubscriptionAccountResponse:'subscriptionAccount',SubscriptionCheckoutResponse:'subscriptionCheckout',SubscriptionResponse:'subscription',SubscriptionAutoRenewResponse:'subscriptionAutoRenew'} as const satisfies Record<string,BillingWireDtoName>;
type WireSchemaSet<S extends Record<string,TSchema>>={[K in keyof S]:K extends keyof typeof schemaFamilies?WireSchema<S[K],typeof schemaFamilies[K]>:S[K]};
function wireSchemas<S extends Record<string,TSchema>>(set:S):WireSchemaSet<S>{return Object.fromEntries(Object.entries(set).map(([k,s])=>[k,k in schemaFamilies?wireSchema(s,schemaFamilies[k as keyof typeof schemaFamilies]):s])) as WireSchemaSet<S>;}
export const schemas=wireSchemas(domain.schemas);
export const qaSchemas=wireSchemas(domain.qaSchemas);
export const integritySchemas=wireSchemas(domain.integritySchemas);
export const projectFileSchemas=wireSchemas(domain.projectFileSchemas);
export const subscriptionSchemas=wireSchemas(domain.subscriptionSchemas);
export const QaWorkspaceSchema=wireSchema(domain.QaWorkspaceSchema,'qaWorkspace');
export const IntegrityWorkspaceSchema=wireSchema(domain.IntegrityWorkspaceSchema,'integrityWorkspace');
export const QaRunSchema=wireSchema(domain.QaRunSchema,'qaRun');
export const CommercePriceMetadataSchema=wireSchema(domain.CommercePriceMetadataSchema,'commerceMetadata');
export const ProjectFileCheckSchema=wireSchema(domain.ProjectFileCheckSchema,'projectFileCheck');
export const IntegrityRoundSchema=wireSchema(domain.IntegrityRoundSchema,'integrityRun');
export const WorkpaperStartSchema=wireSchema(domain.WorkpaperStartSchema,'workpaperStart');
export type CreditBalance=BillingWireDto<domain.CreditBalance,'creditBalance'>;
export type FixedQuote=BillingWireDto<domain.FixedQuote,'fixedQuote'>;
export type AuthoringProgress=BillingWireDto<domain.AuthoringProgress,'authoringProgress'>;
export type CommercePriceMetadata=BillingWireDto<domain.CommercePriceMetadata,'commerceMetadata'>;
export type CommerceCatalog=BillingWireDto<domain.CommerceCatalog,'commerceCatalog'>;
export type CommerceAccount=BillingWireDto<domain.CommerceAccount,'commerceAccount'>;
export type CommerceTopup=BillingWireDto<domain.CommerceTopup,'topupRequest'>;
export type SubscriptionCatalog=BillingWireDto<domain.SubscriptionCatalog,'subscriptionCatalog'>;
export type SubscriptionAccount=BillingWireDto<domain.SubscriptionAccount,'subscriptionAccount'>;
export type SubscriptionCheckout=BillingWireDto<domain.SubscriptionCheckout,'subscriptionCheckout'>;
export type Subscription=BillingWireDto<domain.Subscription,'subscription'>;
export type SubscriptionAutoRenew=BillingWireDto<domain.SubscriptionAutoRenew,'subscriptionAutoRenew'>;
export type SubscriptionPeriod=SubscriptionAccount['periods'][number];
export type PaymentRefund=BillingWireDto<domain.PaymentRefund,'refund'>;
export type PaymentRefundRequest=BillingWireDto<domain.PaymentRefundRequest,'refundRequest'>;
export type PaymentRefundEligibility=BillingWireDto<domain.PaymentRefundEligibility,'refundEligibility'>;
export type M4Quote=BillingWireDto<domain.M4Quote,'fixedQuote'>;
export type M4QuoteResponse=BillingWireDto<domain.M4QuoteResponse,'m4QuoteResponse'>;
export type M4CreditCharge=BillingWireDto<domain.M4CreditCharge,'creditCharge'>;
export type M4Task=BillingWireDto<{tasks:domain.M4Task[]},'m4Workspace'>['tasks'][number];
export type M4Workspace=BillingWireDto<domain.M4Workspace,'m4Workspace'>;
export type AssistantCard=BillingWireDto<domain.AssistantCard,'assistantCard'>;
export type QaRun=BillingWireDto<domain.QaRun,'qaRun'>;
export type QaWorkspace=BillingWireDto<domain.QaWorkspace,'qaWorkspace'>;
export type IntegrityRound=BillingWireDto<domain.IntegrityRound,'integrityRun'>;
export type IntegrityWorkspace=BillingWireDto<domain.IntegrityWorkspace,'integrityWorkspace'>;
export type ProjectFileCheck=BillingWireDto<domain.ProjectFileCheck,'projectFileCheck'>;
export type ProjectFileWorkspace=BillingWireDto<domain.ProjectFileWorkspace,'projectFileWorkspace'>;
export type WorkpaperStart=BillingWireDto<domain.WorkpaperStart,'workpaperStart'>;
export type WorkpaperBatch=BillingWireDto<domain.WorkpaperBatch,'workpaperBatch'>;
export type WorkpaperWorkspace=BillingWireDto<domain.WorkpaperWorkspace,'workpaperWorkspace'>;
export type WorkpaperPaidCheckRequest=BillingWireDto<domain.WorkpaperPaidCheckRequest,'workpaperPaidCheckRequest'>;
export type WorkpaperPaidCheckQuote=BillingWireDto<domain.WorkpaperPaidCheckQuote,'workpaperPaidCheckQuote'>;
export type WorkpaperPaidCheckBatch=BillingWireDto<domain.WorkpaperPaidCheckBatch,'workpaperPaidCheckBatch'>;
export type WorkpaperLibrary=BillingWireDto<domain.WorkpaperLibrary,'workpaperLibrary'>;
