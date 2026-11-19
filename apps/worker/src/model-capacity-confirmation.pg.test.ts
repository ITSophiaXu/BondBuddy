import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type Socket} from 'node:net';
import {Pool} from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {PgModelCallBudget} from './model-call-budget.js';
import {isolatedTestDatabase} from './test-database.js';
const database=await isolatedTestDatabase(undefined,'capacity-confirmation');

// Real PG commits normally; only the transport response is withheld. The fresh
// confirmation uses a different backend PID through the same endpoint.
async function fixture(){
 const target=new URL(database!),sockets=new Set<Socket>(),blocked=new Set<Socket>();let blockNew=false,disconnect=false;
 const server=createServer(down=>{
  const up=connect({host:target.hostname,port:Number(target.port||5432)});sockets.add(down);sockets.add(up);
  if(blockNew)blocked.add(down);
  down.on('data',data=>up.write(data));
  up.on('data',data=>{if(blocked.has(down)){if(disconnect)down.destroy();return;}down.write(data);});
  down.on('error',()=>{});up.on('error',()=>down.destroy());
  down.on('close',()=>{up.destroy();sockets.delete(down);sockets.delete(up);});up.on('close',()=>down.destroy());
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const url=new URL(target);url.hostname='127.0.0.1';url.port=String(address.port);
 const pool=new Pool({connectionString:url.toString(),max:1,query_timeout:5000}),observer=new Pool({connectionString:database});
 const budget=new PgModelCallBudget(pool),permit=await budget.acquire(undefined,'confirmation:test');
 const row=(await observer.query("SELECT * FROM bb_model_capacity_holders WHERE scope='confirmation:test'")).rows[0];
 const interfere=(all=false,drop=false)=>{for(const socket of sockets)blocked.add(socket);blockNew=all;disconnect=drop;};
 return {pool,observer,budget,permit,row,interfere,async clean(){blockNew=false;blocked.clear();await permit.release();
  await (budget as unknown as {sessions:Pool}).sessions.end();await pool.end();await observer.end();
  for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
for(const drop of [false,true])test(`committed renewal ${drop?'disconnect':'delayed acknowledgment'} is confirmed on a new backend without cancellation`,{skip:!database,timeout:20000},async()=>{
 const f=await fixture();try{
  const before=Date.now();f.interfere(false,drop);const renewal=f.permit.renew();
  await delay(200);
  const committed=(await f.observer.query('SELECT renewed_at FROM bb_model_capacity_holders WHERE token=$1',[f.row.token])).rows[0];
  assert.ok(new Date(committed.renewed_at).getTime()>=before,'independent PG read proves commit before the withheld response');
  await Promise.all([renewal,f.permit.renew()]);assert.equal(f.permit.signal.aborted,false);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,1);
 }finally{await f.clean();}
});
test('lost holder is definitive and does not receive a grace retry',{skip:!database,timeout:15000},async()=>{
 const f=await fixture();try{await f.observer.query('DELETE FROM bb_model_capacity_holders WHERE token=$1',[f.row.token]);
  await assert.rejects(f.permit.renew());assert.equal(f.permit.signal.aborted,true);
 }finally{await f.clean();}
});
test('unavailable independent confirmation is bounded and keeps capacity until exit/release',{skip:!database,timeout:20000},async()=>{
 const f=await fixture();try{f.interfere(true);const started=Date.now();await assert.rejects(f.permit.renew());
  assert.equal(f.permit.signal.aborted,true);assert.ok(Date.now()-started<12000);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,1);
 }finally{await f.clean();}
});
