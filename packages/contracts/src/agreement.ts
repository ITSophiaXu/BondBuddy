import { Type, type Static } from '@sinclair/typebox';

// #7 registration UI: the public, unauthenticated agreement the browser shows before POST /auth/register.
// terms_version is the exact value register requires as accepted_terms_version.
export const AGREEMENT_TITLE = 'BondBuddy 用户协议与数据保存说明' as const;
export const AGREEMENT_SUMMARY_PATH = '/#/data-policy' as const;
export const agreementSchemas = {
  AgreementResponse: Type.Object({
    terms_version: Type.String({ minLength: 1, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    summary_url_or_path: Type.String({ minLength: 1, maxLength: 2048, description: 'Same-origin path or https URL of the agreement and data-policy summary.' }),
    support_contact: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])
  }, { additionalProperties: false })
};
export type AgreementResponse = Static<typeof agreementSchemas.AgreementResponse>;
export function agreementOpenApiPaths(ref: (name: 'AgreementResponse' | 'Error') => unknown) {
  return {
    '/api/v1/auth/agreement': { get: { summary: 'Read the current registration agreement version (public, briefly cacheable)', 'x-implementation-status': 'implemented; public', security: [], responses: {
      '200': { description: 'Current agreement', content: { 'application/json': { schema: ref('AgreementResponse') } } },
      '503': { description: 'CAPABILITY_NOT_READY: no agreement version is configured, so registration is closed', content: { 'application/json': { schema: ref('Error') } } } } } }
  };
}
