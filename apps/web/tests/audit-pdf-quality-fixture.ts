import {expect,type Route} from '@playwright/test';
import {PDF_QUALITY_VERSION,schemas,isAuditPdf} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {fixtureJson,type Dto} from './billing-fixture-wire';
/** Explicit synthetic passing measurement for existing authoring journeys.
 * Actual low/pending/incomplete paths and real inspection have their own tests. */
export async function serveAuditPdfQuality(route:Route,projectId:string,materials:Dto<'MaterialResponse'>[]) {
  const request=route.request(),path=new URL(request.url()).pathname;
  if(request.method()!=='POST')return false;
  const m=materials.find(m=>isAuditPdf(m)&&path==='/api/v1/projects/'+projectId+'/materials/'+m.material_id+'/pdf-quality');
  if(!m)return false;
  expect(Value.Check(schemas.AuditPdfQualityCheckRequest,request.postDataJSON())).toBe(true);
  const result:Dto<'MaterialParseJobResponse'>={job_id:'quality-'+m.material_id,job_type:'parse',subtype:'material_parse',project_id:projectId,
    material_id:m.material_id,material_version:m.material_version,material_sha256:m.sha256,parser_version:PDF_QUALITY_VERSION,
    state:'succeeded',stage:'succeeded',completed_stages:[],attempts:1,max_attempts:3,error_code:null,outcome:null,parse_status:null,
    profile_version:null,pending_capabilities:[],updated_at:m.persisted_at,
    pdf_quality:{version:'pdf-raster-quality-2',status:'complete',page_count:1,checked_pages:1,low_resolution_pages:[]}};
  expect(Value.Check(schemas.MaterialParseJobResponse,result)).toBe(true);
  await route.fulfill({contentType:'application/json',body:fixtureJson(route,result)});return true;
}
