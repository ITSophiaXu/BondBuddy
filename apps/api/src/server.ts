import Fastify, { type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { M1_UPLOAD_MIME_TYPES, openApiDocument, schemas, type Market, type Offering } from '@bondbuddy/contracts';
import { azureBlobs, canonical, checkedPair, conflict, date, digest, inputDto, material, materialDto, missing, Problem, project, projectDto, run, runDto, transaction, uid, unavailable, verifiedMedia, type PrivateBlobs } from './data.js';
import { installAuth, principal as sessionPrincipal, type AuthConfig } from './auth.js';
import { action as queueAction, enqueue } from './queue.js';
import { recordOperation, rejectOperation } from './observability.js';

export type Principal = { userId: string; csrfVerified: boolean };
export type Settings = { pool?: Pool; blobs?: PrivateBlobs; principal?: (request: FastifyRequest) => Promise<Principal | null>; allowedOrigin?: string; auth?: Omit<AuthConfig,'pool'|'allowedOrigin'>; enableRunStaging?: boolean; enableSyntheticQueue?: boolean };
const param = (request: FastifyRequest, name: string) => (request.params as Record<string,string>)[name];
const body = <T>(request: FastifyRequest) => request.body as T;
const now = () => new Date().toISOString();
const MAX_BYTES = 104857600;
const [DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, XLSX_MEDIA_TYPE, CSV_MEDIA_TYPE, TEXT_MEDIA_TYPE, PNG_MEDIA_TYPE, JPEG_MEDIA_TYPE] = M1_UPLOAD_MIME_TYPES;

export function createServer(settings: Settings = {}) {
  // Trust only an explicitly configured reverse proxy for client source addresses.
  const app = Fastify({ logger: false, trustProxy: process.env.BB_TRUSTED_PROXY_CIDR ?? false, bodyLimit: MAX_BYTES + 1024 });
  const pool = settings.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  const allowedOrigin=settings.allowedOrigin ?? process.env.BB_ALLOWED_ORIGIN;
  const auth:AuthConfig={pool,allowedOrigin,termsVersion:settings.auth?.termsVersion ?? process.env.BB_TERMS_VERSION};
  const blobs = settings.blobs ?? (process.env.AZURE_STORAGE_CONNECTION_STRING ? azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING) : null);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_request, value, done) => done(null, value));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Problem) return reply.code(error.status).send({ code: error.code, message: error.message, retryable: error.status === 503, field_errors: [], correlation_id: request.id });
    if (error instanceof Error && 'validation' in error && error.validation) return reply.code(422).send({ code: 'VALIDATION_FAILED', message: 'Request validation failed', retryable: false, field_errors: [], correlation_id: request.id });
    request.log.error(error);
    return reply.code(500).send({ code: 'DATA_UNAVAILABLE', message: 'Internal error', retryable: true, field_errors: [], correlation_id: request.id });
  });
  installAuth(app,auth);
  async function owner(request: FastifyRequest) {
    const principal = await (settings.principal ? settings.principal(request) : sessionPrincipal(request,auth));
    if (!principal?.userId || !/^[A-Za-z0-9_-]{1,128}$/.test(principal.userId)) throw new Problem(401,'UNAUTHENTICATED','Trusted session required');
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      if (!principal.csrfVerified || !allowedOrigin || request.headers.origin !== allowedOrigin) throw new Problem(403,'CSRF_DENIED','CSRF or Origin check failed');
    }
    return principal.userId;
  }
  function db() { if (!process.env.DATABASE_URL && !settings.pool) throw unavailable(); return pool; }
  function blob() { if (!blobs) throw unavailable(); return blobs; }
  app.get('/health', { schema: { response: { 200: schemas.HealthResponse } } }, async () => ({ status: 'ok' as const, service: 'bondbuddy-m1-api-skeleton' as const, implementation: 'health-and-contract-only' as const }));
  app.get('/openapi.json', async () => openApiDocument());
  app.get('/api/v1/projects', async request => {
    const user = await owner(request); const cursor = (request.query as {cursor?:string}).cursor;
    const rows = await db().query('SELECT * FROM bb_projects WHERE owner_user_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 51',[user,cursor ?? null]);
    const items = rows.rows.slice(0,50).map(p => ({project_id:p.id,name:p.name,draft_revision:p.draft_revision,updated_at:date(p.updated_at)}));
    return { items, page:{has_more:rows.rows.length>50,next_cursor:rows.rows.length>50 ? items.at(-1)?.project_id : null} };
  });
  app.post('/api/v1/projects',{schema:{body:schemas.ProjectCreateRequest}},async (request,reply) => {
    const user=await owner(request), b=body<{name:string;kind:string;issuer_name:string|null;market:Market|null;offering:Offering|null}>(request);
    checkedPair(b.market,b.offering);
    const id=uid(), value=await transaction(db(),async client=>{
      const row=await client.query('INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,user,b.name,b.kind,b.issuer_name,b.market,b.offering]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.created',{project_id:id}]);
      return projectDto(row.rows[0]);
    });
    return reply.code(201).send(value);
  });
  app.get('/api/v1/projects/:project_id',async request=>projectDto(await project(db(),await owner(request),param(request,'project_id'))));
  app.patch('/api/v1/projects/:project_id',{schema:{body:schemas.ProjectPatchRequest}},async request=>{
    const user=await owner(request), id=param(request,'project_id'), expected=Number(request.headers['if-match']);
    if (!Number.isInteger(expected)||expected<1) throw new Problem(422,'VALIDATION_FAILED','If-Match draft revision required');
    return transaction(db(),async client=>{
      const old=await project(client,user,id,true);
      if(old.draft_revision!==expected) throw conflict('INPUT_REVISION_CONFLICT','Draft revision changed');
      const b=body<Record<string,unknown>>(request);
      const next={name:b.name ?? old.name,issuer_name:'issuer_name' in b?b.issuer_name:old.issuer_name,market:'market' in b?b.market:old.market,offering:'offering' in b?b.offering:old.offering};
      checkedPair(next.market as Market|null,next.offering as Offering|null);
      const result=await client.query('UPDATE bb_projects SET name=$3,issuer_name=$4,market=$5,offering=$6,draft_revision=draft_revision+1,updated_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING *',[user,id,next.name,next.issuer_name,next.market,next.offering]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.draft_updated',{project_id:id,draft_revision:result.rows[0].draft_revision}]);
      return projectDto(result.rows[0]);
    });
  });
  app.post('/api/v1/projects/:project_id/input-revisions',{schema:{body:schemas.InputRevisionCreateRequest}},async (request,reply)=>{
    const user=await owner(request), id=param(request,'project_id');
    const b=body<{draft_revision:number;material_versions:{material_id:string;material_version:number}[];requirement_message_ids:string[]}>(request);
    if(b.requirement_message_ids.length) throw unavailable(); // #7/#conversation persistence must authenticate these associations.
    const result=await transaction(db(),async client=>{
      const p=await project(client,user,id,true);
      if(p.draft_revision!==b.draft_revision) throw conflict('INPUT_REVISION_CONFLICT','Draft revision changed');
      const refs=[...b.material_versions].sort((a,z)=>a.material_id.localeCompare(z.material_id)||a.material_version-z.material_version);
      if(new Set(refs.map(r=>r.material_id)).size!==refs.length) throw new Problem(422,'VALIDATION_FAILED','Duplicate material IDs');
      const resolved=[];
      for(const ref of refs){const q=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL',[user,id,ref.material_id,ref.material_version]);if(!q.rows[0])throw missing();resolved.push({material_id:ref.material_id,material_version:ref.material_version,role:q.rows[0].role,sha256:q.rows[0].sha256.trim()});}
      const revision=(p.latest_input_revision??0)+1;
      const manifest={draft_revision:p.draft_revision,name:p.name,kind:p.kind,issuer_name:p.issuer_name,market:p.market,offering:p.offering,materials:resolved,requirement_message_ids:[],rule_pack_version:null,template_version:null,reference_release:null};
      const hash=digest(canonical(manifest));
      const q=await client.query('INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,revision,user,p.draft_revision,hash,manifest,JSON.stringify(refs),'[]']);
      await client.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'project',id,'project.input_locked',{project_id:id,input_revision:revision,input_hash:hash}]);
      return inputDto(q.rows[0]);
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/projects/:project_id/input-revisions/:input_revision',async request=>{
    const user=await owner(request),id=param(request,'project_id');await project(db(),user,id);
    const q=await db().query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,id,Number(param(request,'input_revision'))]);
    if(!q.rows[0])throw missing();return inputDto(q.rows[0]);
  });
  app.post('/api/v1/projects/:project_id/materials/uploads',{schema:{body:schemas.UploadCreateRequest}},async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),b=body<{filename:string;media_type:string;byte_size:number;sha256:string;role:string}>(request);
    await project(db(),user,id);blob();
    if(b.byte_size>MAX_BYTES)throw new Problem(422,'VALIDATION_FAILED','Upload exceeds limit');
    const suffix=b.filename.toLowerCase().split('.').at(-1);
    const expectedExtensions:Record<string,string[]>={[PDF_MEDIA_TYPE]:['pdf'],[DOCX_MEDIA_TYPE]:['docx'],[XLSX_MEDIA_TYPE]:['xlsx'],[CSV_MEDIA_TYPE]:['csv'],[TEXT_MEDIA_TYPE]:['txt'],[PNG_MEDIA_TYPE]:['png'],[JPEG_MEDIA_TYPE]:['jpg','jpeg']};
    if(!suffix || !expectedExtensions[b.media_type]?.includes(suffix))throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Filename extension and declared type differ');
    const uploadId=uid(),key=`users/${user}/projects/${id}/uploads/${uploadId}`,expires=new Date(Date.now()+15*60_000);
    await transaction(db(),async client=>{
      await client.query('INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[uploadId,user,id,b.filename,b.media_type,b.byte_size,b.sha256,b.role,key,expires]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'upload',uploadId,'upload.created',{project_id:id}]);
    });
    return reply.code(201).send({upload_id:uploadId,state:'uploading',upload_url:`/api/v1/projects/${id}/materials/uploads/${uploadId}/bytes`,expires_at:expires.toISOString(),max_bytes:MAX_BYTES});
  });
  app.put('/api/v1/projects/:project_id/materials/uploads/:upload_id/bytes',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),uploadId=param(request,'upload_id');await project(db(),user,id);
    const bytes=request.body;if(!Buffer.isBuffer(bytes))throw new Problem(422,'VALIDATION_FAILED','Binary upload required');
    await transaction(db(),async client=>{
      const q=await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,uploadId]);const u=q.rows[0];if(!u)throw missing();
      if(u.state==='completed')throw conflict('IDEMPOTENCY_CONFLICT','Upload already completed');
      if(u.state!=='uploading'&&u.state!=='received')throw missing();
      if(new Date(u.expires_at).getTime()<Date.now())throw new Problem(422,'VALIDATION_FAILED','Upload expired');
      if(bytes.length!==Number(u.byte_size)||digest(bytes)!==u.sha256.trim())throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Bytes or hash mismatch');
      await verifiedMedia(bytes,u.declared_media_type);
      if(u.state==='received'){
        if(u.received_sha256?.trim()!==digest(bytes)||Number(u.received_bytes)!==bytes.length)throw new Problem(503,'DATA_UNAVAILABLE','Stored upload receipt is inconsistent');
        const stored=await blob().getIfExists(u.object_key);
        if(stored===null||stored.length!==bytes.length||digest(stored)!==u.sha256.trim()){
          await blob().put(u.object_key,bytes,u.declared_media_type);
          const restored=await blob().get(u.object_key);
          if(restored.length!==bytes.length||digest(restored)!==u.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Upload bytes could not be restored');
        }
        return;
      }
      // The upload row lock is shared with completion and orphan cleanup. Keep it until Blob and DB state agree.
      await blob().put(u.object_key,bytes,u.declared_media_type);
      const updated=await client.query("UPDATE bb_uploads SET state='received',received_sha256=$4,received_bytes=$5 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND state='uploading'",[user,id,uploadId,digest(bytes),bytes.length]);
      if(updated.rowCount!==1)throw new Problem(503,'DATA_UNAVAILABLE','Upload state changed before bytes were recorded');
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'upload',uploadId,'upload.received',{project_id:id,byte_size:bytes.length}]);
    });
    return reply.code(204).send();
  });
  app.post('/api/v1/projects/:project_id/materials/uploads/:upload_id/complete',{schema:{body:schemas.UploadCompleteRequest}},async request=>{
    const user=await owner(request),id=param(request,'project_id'),uploadId=param(request,'upload_id'),b=body<{byte_size:number;sha256:string}>(request);
    return transaction(db(),async client=>{
      await project(client,user,id);
      const q=await client.query('SELECT * FROM bb_uploads WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,uploadId]);const u=q.rows[0];if(!u)throw missing();
      if(Number(u.byte_size)!==b.byte_size||u.sha256.trim()!==b.sha256)throw conflict('IDEMPOTENCY_CONFLICT','Upload declaration changed');
      if(u.state==='completed'){const existing=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=$2 AND deleted_at IS NULL',[user,uploadId]);if(!existing.rows[0])throw missing();return materialDto(existing.rows[0]);}
      if(u.state==='deleting'||u.state==='purged')throw missing();
      if(u.state!=='received')throw new Problem(422,'MATERIAL_UNREADABLE','Upload bytes not received');
      const bytes=await blob().get(u.object_key);
      if(bytes.length!==b.byte_size||digest(bytes)!==b.sha256)throw new Problem(422,'MATERIAL_CONTENT_MISMATCH','Stored bytes or hash mismatch');
      const media=await verifiedMedia(bytes,u.declared_media_type);
      const materialId=uid();
      const inserted=await client.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'persisted') RETURNING *",[materialId,user,id,uploadId,u.role,u.filename,media,b.byte_size,b.sha256,u.object_key]);
      await client.query("UPDATE bb_uploads SET state='completed' WHERE owner_user_id=$1 AND id=$2",[user,uploadId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.persisted',{material_id:materialId,material_version:1,project_id:id}]);
      return materialDto(inserted.rows[0]);
    });
  });
  app.get('/api/v1/projects/:project_id/materials/:material_id',async request=>materialDto(await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'))));
  app.get('/api/v1/projects/:project_id/materials/:material_id/download',async (request,reply)=>{
    const m=await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'));
    const bytes=await blob().get(m.object_key);if(digest(bytes)!==m.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Stored material failed integrity check');
    return reply.header('content-type',m.media_type).header('x-content-type-options','nosniff').header('cache-control','private, no-store').send(bytes);
  });
  app.delete('/api/v1/projects/:project_id/materials/:material_id',async (request,reply)=>{
    const user=await owner(request),id=param(request,'project_id'),materialId=param(request,'material_id');
    await transaction(db(),async client=>{
      // Snapshot creation takes this same project lock, so a new immutable reference cannot race deletion.
      await project(client,user,id,true);
      const found=await client.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 ORDER BY version DESC FOR UPDATE',[user,id,materialId]);
      if(!found.rows.length)throw missing();
      const live=found.rows.filter(row=>row.deleted_at===null);
      if(!live.length)return; // Owned repeat deletion is idempotent and emits no duplicate side effects.
      const deleted=await client.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING *',[user,id,materialId]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'material',materialId,'material.deleted',{project_id:id,versions:deleted.rows.length}]);
    });
    return reply.code(204).send();
  });
  app.get('/api/v1/projects/:project_id/events',async request=>{await project(db(),await owner(request),param(request,'project_id'));throw unavailable();});
  app.post('/api/v1/runs/execute',{schema:{body:schemas.ExecuteRequest}},async (request,reply)=>{
    const user=await owner(request);
    const b=body<{execution_request_id:string;project_id:string;input_revision:number;input_hash:string;task_kind:string;input_manifest_ref:string;storage_origin:string;workspace_id:string}>(request);
    const traceId=uid();
    if(!settings.enableRunStaging && !settings.enableSyntheticQueue){
      const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[user,b.project_id]);
      await rejectOperation(db(),{owner:user,projectId:owned.rowCount?b.project_id:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:'CAPABILITY_NOT_READY',inputRevision:owned.rowCount?b.input_revision:undefined,inputHash:owned.rowCount?b.input_hash:undefined});
      throw unavailable();
    }
    let result;
    try {result=await transaction(db(),async client=>{
      const requestHash=digest(canonical({project_id:b.project_id,input_revision:b.input_revision,input_hash:b.input_hash,task_kind:b.task_kind,input_manifest_ref:b.input_manifest_ref,storage_origin:b.storage_origin,workspace_id:b.workspace_id}));
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${user}:${b.execution_request_id}`]);
      const old=await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,b.execution_request_id]);
      if(old.rows[0]){if(old.rows[0].request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','Request key is bound to another input');await recordOperation(client,{owner:user,projectId:b.project_id,runId:old.rows[0].id,requestId:request.id,traceId:old.rows[0].id,kind:'execute',status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash});return runDto(old.rows[0]);}
      await project(client,user,b.project_id);
      const input=await client.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[user,b.project_id,b.input_revision]);
      if(!input.rows[0])throw missing();
      if(input.rows[0].input_hash.trim()!==b.input_hash)throw conflict('INPUT_REVISION_CONFLICT','Input hash changed');
      const runId=uid(),trace=uid(),eventId=uid();
      const q=await client.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,event_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0) RETURNING *",[runId,user,b.project_id,b.input_revision,b.input_hash,b.execution_request_id,b.task_kind,requestHash,settings.enableSyntheticQueue?'queued':'paused']);
      await recordOperation(client,{owner:user,projectId:b.project_id,runId,requestId:request.id,traceId:runId,kind:'execute',status:'submitted',inputRevision:b.input_revision,inputHash:b.input_hash});
      if(settings.enableSyntheticQueue) {
        await enqueue(client,q.rows[0]);
        return runDto({...q.rows[0],state:'queued',stage:'queued',event_cursor:1,updated_at:new Date()});
      }
      await client.query("UPDATE bb_runs SET event_cursor=1 WHERE id=$1",[runId]);
      await client.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,payload) VALUES($1,$2,$3,1,$4,'run.state_changed','paused',$5)",[eventId,user,runId,trace,{reason:'capability_not_ready'}]);
      await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6)',[uid(),user,'run',runId,'run.staged',{run_id:runId,event_id:eventId}]);
      return runDto({...q.rows[0],event_cursor:1});
    });} catch(error) {
      if(error instanceof Problem){
        const owned=await db().query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2',[user,b.project_id]);
        await rejectOperation(db(),{owner:user,projectId:owned.rowCount?b.project_id:null,requestId:request.id,traceId,kind:'execute',status:'rejected',errorCode:error.code,inputRevision:owned.rowCount?b.input_revision:undefined,inputHash:owned.rowCount?b.input_hash:undefined});
      }
      throw error;
    }
    return reply.code(202).send(result);
  });
  app.get('/api/v1/runs/:run_id',async request=>runDto(await run(db(),await owner(request),param(request,'run_id'))));
  app.get('/api/v1/runs/:run_id/events',async request=>{
    const user=await owner(request),id=param(request,'run_id');await run(db(),user,id);
    const after=Number((request.query as {after?:string}).after??0);if(!Number.isSafeInteger(after)||after<0)throw new Problem(422,'VALIDATION_FAILED','Invalid cursor');
    const q=await db().query('SELECT * FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT 100',[user,id,after]);
    const items=q.rows.map(e=>({event_id:e.id,schema_version:1,trace_id:e.trace_id,run_id:e.run_id,seq:e.seq,occurred_at:date(e.occurred_at),stage:e.stage,type:e.type,state:e.state,payload:e.payload}));
    return {items,next_cursor:items.length?items.at(-1)!.seq:after};
  });
  for(const kind of ['cancel','resume'] as const) app.post(`/api/v1/runs/:run_id/${kind}`,{schema:{body:schemas.RunActionRequest}},async request=>{
    const user=await owner(request),id=param(request,'run_id');await run(db(),user,id);
    if(!settings.enableSyntheticQueue)throw unavailable();
    return queueAction(db(),user,id,kind);
  });
  app.get('/api/v1/artifacts/:artifact_id',async request=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query("SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=$2 AND quality_status='passed' AND delivery_status='available' ORDER BY version DESC LIMIT 1",[user,id]);
    if(!q.rows[0])throw missing();const a=q.rows[0];const bytes=await blob().get(a.object_key);if(digest(bytes)!==a.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed');
    const grant=uid(),expires=new Date(Date.now()+5*60_000);
    await db().query('INSERT INTO bb_artifact_download_grants(token_hash,owner_user_id,artifact_id,artifact_version,expires_at) VALUES($1,$2,$3,$4,$5)',[digest(grant),user,id,a.version,expires]);
    return {artifact_id:a.id,run_id:a.run_id,version:a.version,media_type:a.media_type,sha256:a.sha256.trim(),quality_status:a.quality_status,delivery_status:a.delivery_status,download_url:`/api/v1/artifacts/${id}/download?grant=${grant}`,expires_at:expires.toISOString()};
  });
  app.get('/api/v1/artifacts/:artifact_id/download',async (request,reply)=>{
    const user=await owner(request),id=param(request,'artifact_id');
    const q=await db().query("SELECT * FROM bb_artifact_versions WHERE owner_user_id=$1 AND id=$2 AND quality_status='passed' AND delivery_status='available' ORDER BY version DESC LIMIT 1",[user,id]);
    if(!q.rows[0])throw missing();const a=q.rows[0],grant=(request.query as {grant?:string}).grant;
    if(!grant)throw missing();const g=await db().query('SELECT 1 FROM bb_artifact_download_grants WHERE token_hash=$1 AND owner_user_id=$2 AND artifact_id=$3 AND artifact_version=$4 AND expires_at>now()',[digest(grant),user,id,a.version]);if(!g.rows[0])throw missing();
    const bytes=await blob().get(a.object_key);if(digest(bytes)!==a.sha256.trim())throw new Problem(503,'DATA_UNAVAILABLE','Artifact integrity check failed');
    return reply.header('content-type',a.media_type).header('cache-control','private, no-store').send(bytes);
  });
  const sourceProfile='/api/v1/projects/:project_id/materials/:material_id/source-profile';
  app.get(sourceProfile,async request=>{await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'));throw unavailable();});
  app.patch(sourceProfile,async request=>{await material(db(),await owner(request),param(request,'project_id'),param(request,'material_id'));throw unavailable();});
  app.post('/api/v1/projects/:project_id/preflight',async request=>{await project(db(),await owner(request),param(request,'project_id'));throw unavailable();});
  app.post('/api/v1/conversations/:conversation_id/messages',async request=>{await owner(request);throw unavailable();});
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app=createServer(),port=Number(process.env.PORT??'3000');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  app.listen({host:process.env.HOST??'127.0.0.1',port}).catch(error=>{app.log.error(error);process.exitCode=1;});
}
