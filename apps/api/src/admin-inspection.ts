import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {schemas} from '@bondbuddy/contracts';
import {missing,Problem} from './data.js';
import {audit,operatorRoles} from './log-ops.js';
import {collectAdminInspection} from './admin-inspection-data.js';

export function installAdminInspectionRoutes(app:FastifyInstance,deps:{db:()=>Pool;owner:(r:FastifyRequest)=>Promise<string>}){
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
    const client=await pool.connect();
    try{
      await audit(client,{actorId:actor,role:'log_reader',purpose:'admin_inspection_snapshot',filter:{run_limit:1000}});
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='15s'");
      const snapshot=await collectAdminInspection(client,'live_database',process.env.BB_RELEASE_SHA??null);
      await client.query('COMMIT');
      return snapshot;
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  });
}
