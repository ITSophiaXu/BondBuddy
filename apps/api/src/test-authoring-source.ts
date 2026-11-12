import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';
import { grantCredits } from './billing.js';
import { digest, transaction, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';

/** Real upload/adoption/declaration for synthetic authoring tests; starts no work. */
export async function uploadSyntheticReference(app: FastifyInstance, project: string, requestHeaders: Record<string,string> = {}) {
  const origin = 'http://bondbuddy.test', path = `/api/v1/projects/${project}`;
  const send = (method: string, url: string, payload?: unknown, headers: Record<string,string> = {}) =>
    app.inject({method: method as any, url, payload: payload as any, headers: {origin, ...requestHeaders, ...headers}});
  const bytes = makeSyntheticDocxFixture({text:'Synthetic reference issuer prospectus'});
  const digestFields = {byte_size:bytes.length, sha256:digest(bytes)};
  const upload = await send('POST', path+'/materials/uploads', {...digestFields, filename:'synthetic-reference.docx',
    media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', role:'historical'});
  assert.equal(upload.statusCode,201,upload.body);
  assert.equal((await send('PUT',upload.json().upload_url,bytes,{'content-type':'application/octet-stream'})).statusCode,204);
  const completed = await send('POST',path+`/materials/uploads/${upload.json().upload_id}/complete`,digestFields);
  assert.equal(completed.statusCode,200,completed.body);
  const ref = {material_id:completed.json().material_id, material_version:1};
  const current = await send('GET',path); assert.equal(current.statusCode,200,current.body);
  const saved = await send('PATCH',path,{update_details:{...current.json().update_details,source_prospectuses:[{
    ...ref,sha256:digestFields.sha256,issuer_name:'Synthetic reference issuer',relation:'similar_business',
    market:'sse',offering:'private',reporting_periods:reportingWindow('sse','private','2025-12-31'),status:'user_asserted'
  }]}},{'if-match':String(current.json().draft_revision)});
  assert.equal(saved.statusCode,200,saved.body);
  const versions = await send('GET',path+'/prospectus-versions'); assert.equal(versions.statusCode,200,versions.body);
  if(current.json().kind==='update')assert.ok(versions.json().current_version_id,'uploaded reference is adopted');
  return {draft_revision:saved.json().draft_revision,prospectus_selection_revision:versions.json().selection_revision,
    material_versions:[ref],requirement_message_ids:[]};
}

/** Owned in-memory bytes for API mechanics tests that do not exercise Azure. */
export function syntheticAuthoringBlobs(): PrivateBlobs {
  const files = new Map<string,Buffer>();
  return {
    put: async (key, bytes) => { files.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes=files.get(key); assert.ok(bytes,'Synthetic source bytes exist'); return bytes; },
    getIfExists: async key => files.get(key) ?? null,
    getIfExistsBounded: async (key, limit) => {
      const bytes=files.get(key); if(bytes && bytes.length>limit)throw new Error('Synthetic Blob exceeds read bound'); return bytes ?? null;
    },
    exists: async key => files.has(key),
    delete: async key => { files.delete(key); }
  };
}

/** Prepare current mandatory source/input prerequisites; create no run or payment. */
export async function lockSyntheticAuthoringInput(app: FastifyInstance, project: string, requestHeaders: Record<string,string> = {}) {
  const headers={origin:'http://bondbuddy.test',...requestHeaders},path='/api/v1/projects/'+project;
  const current=await app.inject({method:'GET',url:path,headers});
  assert.equal(current.statusCode,200,current.body);
  const value=current.json();
  const saved=await app.inject({method:'PATCH',url:path,headers:{...headers,'if-match':String(value.draft_revision)},payload:{
    issuer_name:value.issuer_name ?? 'Synthetic issuer',market:value.market ?? 'sse',offering:value.offering ?? 'private',
    update_details:{...emptyUpdateDetails(),...value.update_details,authoring_mode:'unified_v1',reporting_cutoff:value.update_details?.reporting_cutoff ?? '2026-09-30'}
  }});
  assert.equal(saved.statusCode,200,saved.body);
  const source=await uploadSyntheticReference(app,project,headers);
  const locked=await app.inject({method:'POST',url:path+'/input-revisions',headers,payload:source});
  assert.equal(locked.statusCode,201,locked.body);
  return locked;
}

/** Obtain the actual current quote and fund only its synthetic shortage; starts no run. */
export async function quoteSyntheticAuthoringRun(app: FastifyInstance, pool: Pool, owner: string, project: string,
  input: {input_revision:number;input_hash:string}, requestHeaders: Record<string,string> = {}) {
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[owner,'admission_'+digest(owner).slice(0,20)]);
  const quoted=await app.inject({method:'POST',url:'/api/v1/projects/'+project+'/credit-quote',
    headers:{origin:'http://bondbuddy.test',...requestHeaders},payload:{input_revision:input.input_revision,input_hash:input.input_hash}});
  assert.equal(quoted.statusCode,200,quoted.body);
  const {quote,shortage}=quoted.json();
  assert.equal(quote.quote_status,'ready');
  assert.ok(quote.quote_id && quote.scope_quote_id,'Current quote retains its scope binding');
  assert.match(shortage,/^\d+$/,'Billing wire shortage is an exact integer string');
  if(BigInt(shortage)>0n)await transaction(pool,client=>grantCredits(client,{owner,points:shortage,key:randomUUID(),source:'purchase',
    expiresAt:null,actor:'synthetic-admission-fixture',reason:'Synthetic funds for API mechanics regression only'}));
  return quote.quote_id as string;
}
