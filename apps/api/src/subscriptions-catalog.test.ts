import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {SUBSCRIPTION_CATALOG_VERSION,SUBSCRIPTION_PLANS} from '@bondbuddy/contracts';
import {installSubscriptions} from './subscriptions.js';

for(const enabled of [true,false])test(`subscription catalog keeps billing mode ${enabled} independent of unavailable payment channels`,async()=>{
  const app=Fastify();let authenticated=0;
  const pool={query:()=>{throw new Error('Catalog must not need a database or payment call');}} as unknown as Pool;
  installSubscriptions(app,pool,async()=>{authenticated++;return 'synthetic-catalog-owner';},enabled,[]);
  try{
    const response=await app.inject({method:'GET',url:'/api/v1/subscriptions/catalog'});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{enabled,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:[],auto_renew_available:false});
    assert.equal(authenticated,1);
  }finally{await app.close();}
});
