import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {BILLING_PERMISSIONS} from '@bondbuddy/contracts';
import {billingPermissions,grantBillingPermission,installBillingPermissions,requireBillingPermission,revokeBillingPermission} from './billing-permissions.js';
import {Problem,transaction} from './data.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'billing-permissions');
const denied=(e:unknown)=>e instanceof Problem&&e.status===404;
test('billing permissions authenticate before looking up database and expose no public grant route',async()=>{
  const app=Fastify();let databaseRead=false;
  app.setErrorHandler((e,_q,r)=>r.code(e instanceof Problem?e.status:500).send({error:e instanceof Error?e.message:'Unknown error'}));
  installBillingPermissions(app,{db:()=>{databaseRead=true;throw Error('must not read');},owner:async()=>{throw new Problem(401,'UNAUTHENTICATED','Session required');}});
  try{assert.equal((await app.inject('/api/v1/billing/permissions')).statusCode,401);assert.equal(databaseRead,false);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/billing/permissions',payload:{permission:'price_publish'}})).statusCode,404);
  }finally{await app.close();}
});

test('synthetic PG: independent billing grants, immutable history and transaction authorization',{skip:!connection},async t=>{
  const pool=new Pool({connectionString:connection});
  const locked=new Pool({connectionString:connection,options:'-c lock_timeout=100ms'});
  const owner='synthetic-billing-operator',other='synthetic-ungranted';
  const grant=(requestId:string,permission:typeof BILLING_PERMISSIONS[number],userId=owner)=>({requestId,userId,permission,actor:'synthetic trusted operations',reason:'Synthetic permission regression'});
  try{
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$3),($2,$4)',[owner,other,'+8613800000611','+8613800000612']);
    await t.test('default deny and exact permission separation',async()=>{
      assert.deepEqual([...await billingPermissions(pool,owner)],[]);
      for(const permission of BILLING_PERMISSIONS)await assert.rejects(transaction(pool,c=>requireBillingPermission(c,owner,permission)),denied);
      await grantBillingPermission(pool,grant('synthetic-draft','price_draft'));
      assert.deepEqual([...await billingPermissions(pool,owner)],['price_draft']);
      assert.ok(await transaction(pool,c=>requireBillingPermission(c,owner,'price_draft')));
      for(const permission of BILLING_PERMISSIONS.filter(p=>p!=='price_draft'))await assert.rejects(transaction(pool,c=>requireBillingPermission(c,owner,permission)),denied);
      await assert.rejects(transaction(pool,c=>requireBillingPermission(c,other,'price_draft')),denied);
    });
    await t.test('grant retries preserve identity; changed or duplicate original inputs conflict',async()=>{
      const input=grant('synthetic-publish','price_publish');const id=await grantBillingPermission(pool,input);
      assert.equal(await grantBillingPermission(pool,input),id);
      await assert.rejects(grantBillingPermission(pool,{...input,reason:'changed'}),e=>e instanceof Problem&&e.status===409);
      await assert.rejects(grantBillingPermission(pool,{...input,requestId:'second-publish'}),e=>e instanceof Problem&&e.status===409);
      assert.equal((await pool.query("SELECT count(*) FROM bb_billing_operator_grants WHERE user_id=$1 AND permission='price_publish'",[owner])).rows[0].count,'1');
    });
    await t.test('history cannot be altered, deleted or reopened after revocation',async()=>{
      const id=await grantBillingPermission(pool,grant('synthetic-refund','task_refund_approve'));
      await assert.rejects(pool.query('UPDATE bb_billing_operator_grants SET reason=$2 WHERE id=$1',[id,'rewrite']),/immutable/);
      await assert.rejects(pool.query('DELETE FROM bb_billing_operator_grants WHERE id=$1',[id]),/immutable/);
      const input={requestId:'synthetic-revoke',grantId:id,actor:'synthetic trusted operations',reason:'Synthetic revoke'};
      await revokeBillingPermission(pool,input);await revokeBillingPermission(pool,input);
      await assert.rejects(revokeBillingPermission(pool,{...input,reason:'changed'}),e=>e instanceof Problem&&e.status===409);
      await assert.rejects(pool.query('UPDATE bb_billing_operator_grants SET revoked_at=NULL WHERE id=$1',[id]),/immutable/);
      await assert.rejects(transaction(pool,c=>requireBillingPermission(c,owner,'task_refund_approve')),denied);
      const replacement=await grantBillingPermission(pool,grant('synthetic-refund-new','task_refund_approve'));assert.notEqual(replacement,id);
    });
    await t.test('in-flight authority locks synchronize with revoke and user deactivation',async()=>{
      const id=await grantBillingPermission(pool,grant('synthetic-repair','billing_repair'));
      const input={requestId:'synthetic-repair-revoke',grantId:id,actor:'synthetic trusted operations',reason:'Synthetic revoke racing action'};
      const c=await pool.connect();await c.query('BEGIN');
      try{
        assert.equal(await requireBillingPermission(c,owner,'billing_repair'),id);
        await assert.rejects(revokeBillingPermission(locked,input),e=>(e as {code?:string}).code==='55P03');
        await assert.rejects(locked.query("UPDATE bb_users SET status='disabled' WHERE id=$1",[owner]),e=>(e as {code?:string}).code==='55P03');
      }finally{await c.query('COMMIT');c.release();}
      await revokeBillingPermission(pool,input);
      await assert.rejects(transaction(pool,c=>requireBillingPermission(c,owner,'billing_repair')),denied);
    });
    await t.test('disabled accounts lose all effective permissions without deleting audit history',async()=>{
      await pool.query("UPDATE bb_users SET status='disabled' WHERE id=$1",[owner]);
      assert.equal((await billingPermissions(pool,owner)).size,0);
      await assert.rejects(transaction(pool,c=>requireBillingPermission(c,owner,'price_publish')),denied);
      await assert.rejects(grantBillingPermission(pool,grant('inactive-adjust','credit_adjust_approve')),denied);
      assert.ok(Number((await pool.query('SELECT count(*) FROM bb_billing_operator_grants WHERE user_id=$1',[owner])).rows[0].count)>0);
      await pool.query("UPDATE bb_users SET status='active' WHERE id=$1",[owner]);
    });
    await t.test('authenticated route returns only this account permissions and prevents caching',async()=>{
      const app=Fastify();installBillingPermissions(app,{db:()=>pool,owner:async()=>other});
      try{const result=await app.inject('/api/v1/billing/permissions');assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{permissions:[]});assert.equal(result.headers['cache-control'],'private, no-store');}finally{await app.close();}
    });
  }finally{await locked.end();await pool.end();}
});
