import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {schemas} from '@bondbuddy/contracts';
import {missing,Problem} from './data.js';
import {audit,operatorRoles} from './log-ops.js';
import {parsePerformanceFilters,parsePerformancePage,readPerformanceRun,readPerformanceSummary} from './performance-data.js';
export function installPerformanceRoutes(app:FastifyInstance,deps:{db:()=>Pool;owner:(request:FastifyRequest)=>Promise<string>}){
 let active=0;
 async function read(request:FastifyRequest,reply:any,kind:'run'|'summary'){
  const actor=await deps.owner(request),pool=deps.db();
  if(!(await operatorRoles(pool,actor)).has('log_reader'))throw missing();
  const runId=kind==='run'?(request.params as {run_id:string}).run_id:null;
  const parsed=runId?parsePerformancePage(runId,request.query):parsePerformanceFilters(request.query);
  reply.header('cache-control','private, no-store');
  if(active>=2){reply.header('retry-after','2');throw new Problem(503,'ADMIN_INSPECTION_BUSY','Performance queries are busy');}
  active++;let c;
  try{
   c=await pool.connect();
   const auditId=await audit(c,{actorId:actor,role:'log_reader',purpose:runId?'performance_run_read':'performance_summary_read',filter:parsed,target:runId??undefined});
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout='10s'");await c.query("SET LOCAL lock_timeout='500ms'");
   const result=runId?await readPerformanceRun(c,runId,parsed as ReturnType<typeof parsePerformancePage>,auditId):await readPerformanceSummary(c,parsed as ReturnType<typeof parsePerformanceFilters>,auditId);
   await c.query('COMMIT');return result;
  }finally{if(c){await c.query('ROLLBACK').catch(()=>{});c.release();}active--;}
 }
 app.get('/api/v1/admin/performance/runs/:run_id',{schema:{response:{200:schemas.AdminPerformanceRunResponse}}},(r,p)=>read(r,p,'run'));
 app.get('/api/v1/admin/performance/summary',{schema:{response:{200:schemas.AdminPerformanceSummaryResponse}}},(r,p)=>read(r,p,'summary'));
}
