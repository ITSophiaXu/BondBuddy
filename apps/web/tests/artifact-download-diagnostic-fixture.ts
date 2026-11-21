import {createHash} from 'node:crypto';
import {expect} from '@playwright/test';
import {BROWSER_ERROR_LIMIT,schemas} from '@bondbuddy/contracts';
import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from './billing-fixture-wire';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function checked(name:'BrowserErrorReportRequest',value:unknown):asserts value is Dto<'BrowserErrorReportRequest'>{
  expect(Value.Check(schemas[name],value),name+': '+JSON.stringify([...Value.Errors(schemas[name],value)])).toBe(true);
}

const diagnosticId=Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'});
const diagnosticPhase=Type.Union(['metadata','headers','body','assembly','hash'].map(phase=>Type.Literal(phase)));
const diagnosticEvent=Type.Union(['verified','auto_save_requested','save_link_clicked'].map(event=>Type.Literal(event)));
const downloadProgressSchema=Type.Object({
  download_id:Type.String({pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}),
  artifact_id:diagnosticId,run_id:Type.Optional(diagnosticId),version:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),
  phase:Type.Literal('hash'),received_bytes:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),
  elapsed_ms:Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER}),
  completed:Type.Array(diagnosticPhase,{minItems:4,maxItems:5,uniqueItems:true}),
  request_ids:Type.Object({metadata:Type.Optional(Type.String({pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'})),
    headers:Type.Optional(Type.String({pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'}))},{additionalProperties:false}),
  event:diagnosticEvent,code:diagnosticEvent,
},{additionalProperties:false});
export type DownloadProgressDiagnostic={report:Dto<'BrowserErrorReportRequest'>;detail:Static<typeof downloadProgressSchema>};

/** A separate, closed diagnostic lane; arbitrary browser errors are not business-free POSTs. */
export function checkedDownloadProgress(body:unknown):DownloadProgressDiagnostic{
  checked('BrowserErrorReportRequest',body);
  expect(Buffer.byteLength(JSON.stringify(body),'utf8')).toBeLessThanOrEqual(BROWSER_ERROR_LIMIT.bodyBytes);
  expect(body.error_type).toBe('ArtifactDownloadProgress');expect(body.route_id).toBe('artifact_download');
  expect(body.job_id).toBeUndefined();expect(typeof body.message).toBe('string');
  const detail:unknown=JSON.parse(body.message!);
  expect(Value.Check(downloadProgressSchema,detail),'Bounded artifact download progress: '+JSON.stringify([...Value.Errors(downloadProgressSchema,detail)])).toBe(true);
  const message=detail as Static<typeof downloadProgressSchema>;
  expect(message.code).toBe(message.event);
  expect(message.completed).toEqual(message.completed.includes('metadata')?['metadata','headers','body','assembly','hash']:['headers','body','assembly','hash']);
  expect(body.fingerprint).toBe(hash(`${body.frontend_version}:${message.download_id}:${message.phase}:${message.code}:${message.artifact_id}`));
  return {report:structuredClone(body),detail:structuredClone(message)};
}

export function assertDownloadProgress(diagnostics:DownloadProgressDiagnostic[]){
  const attempts=new Map<string,DownloadProgressDiagnostic[]>();
  for(const entry of diagnostics){
    const previous=attempts.get(entry.detail.download_id)??[],first=previous[0],last=previous.at(-1);
    expect(previous.some(value=>value.detail.event===entry.detail.event),'Each download emits a controlled progress event once.').toBe(false);
    if(first){
      expect({...entry.detail,event:undefined,code:undefined,elapsed_ms:undefined}).toEqual({...first.detail,event:undefined,code:undefined,elapsed_ms:undefined});
      expect(entry.detail.elapsed_ms).toBeGreaterThanOrEqual(last!.detail.elapsed_ms);expect(entry.detail.event).not.toBe('verified');
    }else expect(entry.detail.event).toBe('verified');
    previous.push(entry);attempts.set(entry.detail.download_id,previous);
  }
  for(const events of attempts.values())expect(events.map(value=>value.detail.event)).toEqual(
    events.some(value=>value.detail.event==='save_link_clicked')?['verified','auto_save_requested','save_link_clicked']:['verified','auto_save_requested']);
}
