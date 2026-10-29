import {test,expect,type Route,type Request} from '@playwright/test';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

const request=(path:string,body?:unknown)=>({method:()=>body===undefined?'GET':'POST',url:()=>`http://fixture.invalid/api/v1${path}`,postDataJSON:()=>body}) as Request;
test('fixture responses encode registered money paths and retain precise existing strings and business numbers',()=>{
  const route={request:()=>request('/credits/balance')} as Route;
  expect(fixtureBody(route,{available:'9007199254740993',frozen:0,revision:7})).toEqual({available:'9007199254740993',frozen:'0',revision:7});
  const project={request:()=>request('/projects/p')} as Route;
  expect(fixtureBody(project,{reporting_year:2026,sequence:3})).toEqual({reporting_year:2026,sequence:3});
});
test('fixture request adapter validates the string wire before safe synthetic-domain decoding',()=>{
  const body={request_id:'q',expected_revision:7,expected_points:'1218',price_version:'v'};
  expect(fixtureRequest(request('/projects/p/qa/runs',body))).toEqual({...body,expected_points:1218});
  expect(body.expected_points).toBe('1218');
  expect(()=>fixtureRequest(request('/projects/p/qa/runs',{...body,expected_points:1218}))).toThrow();
});
