import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {schemas} from '@bondbuddy/contracts';
import {missing,Problem} from './data.js';
import {audit,operatorRoles} from './log-ops.js';
import {collectAdminInspection} from './admin-inspection-data.js';
import {Readable} from 'node:stream';
import type {AdminInspectionSnapshot} from '@bondbuddy/contracts';

/** Stream the curated DTO without building a second, whole-snapshot JSON string. */
export function adminInspectionBody(snapshot:AdminInspectionSnapshot){
  function* chunks(){
    const {tables,...metadata}=snapshot;
    yield JSON.stringify(metadata).slice(0,-1)+',"tables":[';
    for(let i=0;i<tables.length;i++){
      const {rows,...table}=tables[i];
      yield (i?',':'')+JSON.stringify(table).slice(0,-1)+',"rows":[';
      for(let offset=0;offset<rows.length;offset+=128){
        yield (offset?',':'')+rows.slice(offset,offset+128).map(row=>JSON.stringify(row)).join(',');
      }
      yield ']}';
    }
    yield ']}';
  }
  return Readable.from(chunks(),{objectMode:false,highWaterMark:64*1024});
}

export function installAdminInspectionRoutes(app:FastifyInstance,deps:{db:()=>Pool;owner:(r:FastifyRequest)=>Promise<string>}){
  // Keep the large metadata export within the API container's memory budget.
  // Hold until the response is sent, including serialization and slow clients.
  let exporting=false;
  app.get('/api/v1/admin/inspection/access',{schema:{response:{200:schemas.AdminInspectionAccessResponse}}},async(request,reply)=>{
    const actor=await deps.owner(request);
    reply.header('cache-control','private, no-store');
    return {allowed:(await operatorRoles(deps.db(),actor)).has('log_reader')};
  });
  app.get('/api/v1/admin/inspection/snapshot',{schema:{response:{200:schemas.AdminInspectionSnapshotResponse}}},async(request,reply)=>{
    const actor=await deps.owner(request),pool=deps.db();
    if(!(await operatorRoles(pool,actor)).has('log_reader'))throw missing();
    if(Object.keys(request.query as object).length)throw new Problem(422,'VALIDATION_FAILED','Inspection snapshot accepts no query parameters');
    reply.header('cache-control','private, no-store');
    if(exporting){reply.header('retry-after','5');throw new Problem(503,'ADMIN_INSPECTION_BUSY','An inspection export is already in progress');}
    exporting=true;
    let released=false;
    const releaseExport=()=>{if(!released){released=true;exporting=false;}};
    reply.raw.once('finish',releaseExport);reply.raw.once('close',releaseExport);
    let client;
    try{
      client=await pool.connect();
      await audit(client,{actorId:actor,role:'log_reader',purpose:'admin_inspection_snapshot',filter:{run_limit:1000}});
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='15s'");
      const snapshot=await collectAdminInspection(client,'live_database',process.env.BB_RELEASE_SHA??null);
      await client.query('COMMIT');
      return reply.type('application/json; charset=utf-8').send(adminInspectionBody(snapshot));
    }catch(error){releaseExport();throw error;}
    finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}}
  });
}
