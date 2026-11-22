import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { reportingWindow } from '@bondbuddy/contracts';
import { digest } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';

/** Real upload/adoption/declaration for synthetic authoring tests; starts no work. */
export async function uploadSyntheticReference(app: FastifyInstance, project: string) {
  const origin = 'http://bondbuddy.test', path = `/api/v1/projects/${project}`;
  const send = (method: string, url: string, payload?: unknown, headers: Record<string,string> = {}) =>
    app.inject({method: method as any, url, payload: payload as any, headers: {origin, ...headers}});
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


/** Synthetic non-PDF audit material used by the PDF quality gate test. */
export async function uploadSyntheticAudit(app: FastifyInstance, project: string) {
  const origin='http://bondbuddy.test',path='/api/v1/projects/'+project;
  const bytes=Buffer.from('Synthetic issuer audit report'),metadata={byte_size:bytes.length,sha256:digest(bytes)};
  const send=(method:string,url:string,payload:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...headers}});
  const upload=await send('POST',path+'/materials/uploads',{...metadata,filename:'synthetic-audit.txt',media_type:'text/plain',role:'audit'});
  assert.equal(upload.statusCode,201,upload.body);
  assert.equal((await send('PUT',upload.json().upload_url,bytes,{'content-type':'application/octet-stream'})).statusCode,204);
  const completed=await send('POST',path+'/materials/uploads/'+upload.json().upload_id+'/complete',metadata);
  assert.equal(completed.statusCode,200,completed.body);
  return {material_id:completed.json().material_id,material_version:completed.json().material_version as number};
}
