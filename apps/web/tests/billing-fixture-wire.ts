import type {Route,Request} from '@playwright/test';
import type {Static} from '@sinclair/typebox';
import {schemas,billingWireRoute,encodeBillingDto,validateBillingDto,decodeLegacyBillingRequest,SUBSCRIPTION_CATALOG_VERSION,SUBSCRIPTION_PLANS,OUTCOME_PRICE_VERSION} from '@bondbuddy/contracts';

/** Fixtures model domain values. Their HTTP boundary emits exactly the production string protocol. */
export type Dto<N extends keyof typeof schemas>=Static<(typeof schemas)[N]>;
export function fixtureBody(route:Route,body:unknown):unknown{
  const request=route.request(),entry=billingWireRoute(request.method(),new URL(request.url()).pathname);
  if(!entry?.response)return body;
  const wire=encodeBillingDto(entry.response,body);validateBillingDto(entry.response,wire);return wire;
}
export const fixtureJson=(route:Route,body:unknown):string=>JSON.stringify(fixtureBody(route,body));
/** Mock handlers validate the actual wire before adapting their small synthetic domain assertions. */
export function fixtureRequest(request:Request):any{
  const body=request.postDataJSON(),entry=billingWireRoute(request.method(),new URL(request.url()).pathname);
  if(!entry?.request)return body;
  validateBillingDto(entry.request,body);
  return decodeLegacyBillingRequest(entry.request,body);
}
/** Existing workflow fixtures exercise their own legacy quotes; the new navigation still reads these catalogs. */
export async function serveDisabledBillingCatalog(route:Route):Promise<boolean>{
  const request=route.request();if(request.method()!=='GET')return false;
  const path=new URL(request.url()).pathname.replace(/^\/api\/v1/,'');
  if(path==='/subscriptions/catalog'){
    await route.fulfill({status:200,contentType:'application/json',body:fixtureJson(route,{enabled:false,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:[],auto_renew_available:false})});return true;
  }
  if(path==='/commerce/catalog'){
    await route.fulfill({status:200,contentType:'application/json',body:fixtureJson(route,{enabled:false,currency:'CNY',version:OUTCOME_PRICE_VERSION,model:'pay_as_you_go',items:[],rules:[]})});return true;
  }
  return false;
}
