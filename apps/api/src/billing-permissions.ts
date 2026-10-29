import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {BILLING_PERMISSIONS,billingPermissionSchemas,type BillingPermission} from '@bondbuddy/contracts';
import {missing,Problem,transaction,uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';

const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const validText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const validPermission=(v:unknown):v is BillingPermission=>BILLING_PERMISSIONS.includes(v as BillingPermission);
const invalid=()=>new Problem(422,'VALIDATION_FAILED','A registered billing permission, original request, actor and business reason are required');
const conflict=()=>new Problem(409,'IDEMPOTENCY_CONFLICT','Billing permission request conflicts with its recorded history');

export async function billingPermissions(db:Pool|PoolClient,user:string):Promise<Set<BillingPermission>>{
  const rows=await db.query(`SELECT g.permission FROM bb_billing_operator_grants g JOIN bb_users u ON u.id=g.user_id
    WHERE g.user_id=$1 AND g.revoked_at IS NULL AND u.status='active' ORDER BY g.permission`,[user]);
  return new Set(rows.rows.map(row=>row.permission as BillingPermission));
}

/** Call inside the SAME transaction as the privileged mutation. Revocation waits
 * for an already-authorized transaction; a revoked grant cannot admit a new one. */
export async function requireBillingPermission(c:PoolClient,user:string,permission:BillingPermission):Promise<string>{
  if(!validPermission(permission))throw missing();
  const row=(await c.query(`SELECT g.id FROM bb_billing_operator_grants g JOIN bb_users u ON u.id=g.user_id
    WHERE g.user_id=$1 AND g.permission=$2 AND g.revoked_at IS NULL AND u.status='active' FOR SHARE OF g,u`,[user,permission])).rows[0];
  if(!row)throw missing();return row.id as string;
}

type GrantInput={requestId:string;userId:string;permission:BillingPermission;actor:string;reason:string};
/** Trusted deployment/operations only. There is intentionally no public grant endpoint. */
export async function grantBillingPermission(pool:Pool,input:GrantInput):Promise<string>{
  if(!validId(input.requestId)||!validId(input.userId)||!validPermission(input.permission)||!validText(input.actor,200)||!validText(input.reason,2000))throw invalid();
  const hash=inputManifestHash(input);
  return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`billing-permission:${input.userId}:${input.permission}`]);
    const prior=(await c.query('SELECT * FROM bb_billing_operator_grants WHERE request_id=$1',[input.requestId])).rows[0];
    if(prior){if(prior.request_hash.trim()!==hash)throw conflict();return prior.id as string;}
    if(!(await c.query("SELECT 1 FROM bb_users WHERE id=$1 AND status='active'",[input.userId])).rowCount)throw missing();
    if((await c.query('SELECT 1 FROM bb_billing_operator_grants WHERE user_id=$1 AND permission=$2 AND revoked_at IS NULL',[input.userId,input.permission])).rowCount)throw conflict();
    const id=uid();await c.query(`INSERT INTO bb_billing_operator_grants(id,user_id,permission,request_id,request_hash,granted_by,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.userId,input.permission,input.requestId,hash,input.actor,input.reason]);return id;
  });
}

export async function revokeBillingPermission(pool:Pool,input:{requestId:string;grantId:string;actor:string;reason:string}):Promise<void>{
  if(!validId(input.requestId)||!validId(input.grantId)||!validText(input.actor,200)||!validText(input.reason,2000))throw invalid();
  const hash=inputManifestHash(input);
  return transaction(pool,async c=>{
    const original=(await c.query('SELECT user_id,permission FROM bb_billing_operator_grants WHERE id=$1',[input.grantId])).rows[0];if(!original)throw missing();
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`billing-permission:${original.user_id}:${original.permission}`]);
    const row=(await c.query('SELECT * FROM bb_billing_operator_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
    if(row.revoked_at){if(row.revocation_request_id!==input.requestId||row.revocation_hash.trim()!==hash)throw conflict();return;}
    if((await c.query('SELECT 1 FROM bb_billing_operator_grants WHERE revocation_request_id=$1',[input.requestId])).rowCount)throw conflict();
    await c.query('UPDATE bb_billing_operator_grants SET revoked_at=now(),revoked_by=$2,revocation_reason=$3,revocation_request_id=$4,revocation_hash=$5 WHERE id=$1',
      [row.id,input.actor,input.reason,input.requestId,hash]);
  });
}

export function installBillingPermissions(app:FastifyInstance,deps:{db:()=>Pool;owner:(request:FastifyRequest)=>Promise<string>}){
  app.get('/api/v1/billing/permissions',{schema:{response:{200:billingPermissionSchemas.BillingPermissionsResponse}}},async(request,reply)=>{const user=await deps.owner(request);reply.header('cache-control','private, no-store');return{permissions:[...await billingPermissions(deps.db(),user)]};});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
  const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{
    const [command,file]=process.argv.slice(2);if(!file)throw Error('Use grant FILE or revoke FILE; trusted billing authority operations only');
    const input=JSON.parse(readFileSync(file,'utf8'));
    if(command==='grant')process.stdout.write(JSON.stringify({grant_id:await grantBillingPermission(pool,input)})+'\n');
    else if(command==='revoke'){await revokeBillingPermission(pool,input);process.stdout.write('Revoked; history retained.\n');}
    else throw Error('Use grant FILE or revoke FILE; no public grant endpoint exists');
  }finally{await pool.end();}
}
