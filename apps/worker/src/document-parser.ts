import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export const DOCUMENT_PARSE_REQUEST_VERSION = 'document-parse-request-v1' as const;
export const DOCUMENT_PARSE_RESPONSE_VERSION = 'document-parse-response-v1' as const;
export const DOCUMENT_PARSER_MEDIA_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
] as const;

type ParserMediaType = typeof DOCUMENT_PARSER_MEDIA_TYPES[number];

export type DocumentParseRequest = {
  schema_version: typeof DOCUMENT_PARSE_REQUEST_VERSION;
  request_id: string;
  material: {
    material_id: string;
    material_version: number;
    media_type: ParserMediaType;
    sha256: string;
    /** Trusted worker staging path. Never populate this from an HTTP request. */
    authorized_local_path: string;
  };
  options: { max_pages?: number };
};

export type DocumentParseRecord = {
  record_id: string;
  material_id: string;
  material_version: number;
  content_hash: string;
  locator_type: 'docx_block'|'pdf_bbox'|'xlsx_cell'|'csv_cell'|'text_line';
  locator: Record<string, unknown>;
  literal_quote: string;
  context: string;
  extraction_method: 'native_text';
  extractor_version: string;
  confidence: number|null;
  uncertainty: string[];
  formatting: Record<string, unknown>;
};

export type DocumentParseResponse = {
  schema_version: typeof DOCUMENT_PARSE_RESPONSE_VERSION;
  request_id: string|null;
  parser_version: string;
  status: 'parsed'|'needs_confirmation'|'failed';
  material: {
    material_id: string;
    material_version: number;
    media_type: ParserMediaType;
    sha256: string;
  }|null;
  records: DocumentParseRecord[];
  warnings: Array<{code:string;message:string}>;
  document: Record<string, unknown> & {page_count:number|null};
  error: {code:string;message:string}|null;
};

type Invoke = (serializedRequest:string, options:{pythonExecutable:string;repoRoot:string;timeoutMs:number;maxOutputBytes:number})=>Promise<string>;

function parserError(code:string):Error {
  const error=new Error(code);
  error.name='DocumentParserError';
  return error;
}

function safeId(value:string):boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validateRequest(request:DocumentParseRequest):void {
  if(request.schema_version!==DOCUMENT_PARSE_REQUEST_VERSION || !safeId(request.request_id) || !safeId(request.material.material_id) ||
    !Number.isSafeInteger(request.material.material_version) || request.material.material_version<1 ||
    !DOCUMENT_PARSER_MEDIA_TYPES.includes(request.material.media_type) || !/^[a-f0-9]{64}$/.test(request.material.sha256) ||
    !request.material.authorized_local_path.startsWith('/') ||
    (request.options.max_pages!==undefined && (!Number.isSafeInteger(request.options.max_pages) || request.options.max_pages<1 || request.options.max_pages>1500))) {
    throw parserError('INVALID_PARSE_REQUEST');
  }
}

function isObject(value:unknown):value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value);
}

export function validateDocumentParseResponse(value:unknown, request:DocumentParseRequest):DocumentParseResponse {
  if(!isObject(value) || value.schema_version!==DOCUMENT_PARSE_RESPONSE_VERSION || value.request_id!==request.request_id ||
    typeof value.parser_version!=='string' || !['parsed','needs_confirmation','failed'].includes(String(value.status)) ||
    !Array.isArray(value.records) || !Array.isArray(value.warnings) || !isObject(value.document)) {
    throw parserError('INVALID_PARSE_RESPONSE');
  }
  if(!isObject(value.material) || value.material.material_id!==request.material.material_id ||
    value.material.material_version!==request.material.material_version || value.material.media_type!==request.material.media_type ||
    value.material.sha256!==request.material.sha256 || 'authorized_local_path' in value.material) {
    throw parserError('PARSE_MATERIAL_IDENTITY_MISMATCH');
  }
  for(const record of value.records) {
    if(!isObject(record) || typeof record.record_id!=='string' || record.material_id!==request.material.material_id ||
      record.material_version!==request.material.material_version || record.content_hash!==request.material.sha256 ||
      !['docx_block','pdf_bbox','xlsx_cell','csv_cell','text_line'].includes(String(record.locator_type)) ||
      !isObject(record.locator) || typeof record.literal_quote!=='string' || record.extraction_method!=='native_text' ||
      typeof record.extractor_version!=='string' || !Array.isArray(record.uncertainty) || !isObject(record.formatting)) {
      throw parserError('INVALID_PARSE_RESPONSE');
    }
  }
  if(value.status==='failed') {
    if(value.records.length!==0 || !isObject(value.error) || typeof value.error.code!=='string' || typeof value.error.message!=='string') throw parserError('INVALID_PARSE_RESPONSE');
  } else if(value.error!==null || value.records.length===0) throw parserError('INVALID_PARSE_RESPONSE');
  return value as DocumentParseResponse;
}

const invokePython:Invoke = (serializedRequest,{pythonExecutable,repoRoot,timeoutMs,maxOutputBytes}) => new Promise((resolveOutput,reject)=>{
  const child=spawn(pythonExecutable,['-m','bondbuddy_document_parser'],{
    cwd:repoRoot,
    env:{...process.env,PYTHONPATH:resolve(repoRoot,'python')},
    stdio:['pipe','pipe','pipe'],
  });
  const stdout:Buffer[]=[];
  const stderr:Buffer[]=[];
  let stdoutBytes=0;
  let stderrBytes=0;
  let settled=false;
  const stop=(error:Error)=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    reject(error);
  };
  const timer=setTimeout(()=>stop(parserError('DOCUMENT_PARSER_TIMEOUT')),timeoutMs);
  child.stdout.on('data',(chunk:Buffer)=>{
    stdoutBytes+=chunk.length;
    if(stdoutBytes>maxOutputBytes)return stop(parserError('DOCUMENT_PARSER_OUTPUT_LIMIT'));
    stdout.push(chunk);
  });
  child.stderr.on('data',(chunk:Buffer)=>{
    stderrBytes+=chunk.length;
    if(stderrBytes<=64*1024)stderr.push(chunk);
  });
  child.on('error',()=>stop(parserError('DOCUMENT_PARSER_UNAVAILABLE')));
  child.on('close',code=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);
    if(code!==0)return reject(parserError('DOCUMENT_PARSER_PROCESS_FAILED'));
    if(stderrBytes>0)return reject(parserError('DOCUMENT_PARSER_STDERR'));
    resolveOutput(Buffer.concat(stdout).toString('utf8'));
  });
  child.stdin.on('error',()=>stop(parserError('DOCUMENT_PARSER_PROCESS_FAILED')));
  child.stdin.end(serializedRequest);
});

export async function runDocumentParser(request:DocumentParseRequest, options:{
  pythonExecutable?:string;
  repoRoot?:string;
  timeoutMs?:number;
  maxOutputBytes?:number;
  invoke?:Invoke;
}={}):Promise<DocumentParseResponse> {
  validateRequest(request);
  const timeoutMs=options.timeoutMs??5*60_000;
  const maxOutputBytes=options.maxOutputBytes??64*1024*1024;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30*60_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<1024 || maxOutputBytes>256*1024*1024) throw parserError('INVALID_PARSE_RUNNER_OPTIONS');
  const serialized=JSON.stringify(request);
  const output=await (options.invoke??invokePython)(serialized,{
    pythonExecutable:options.pythonExecutable??'python3',
    repoRoot:options.repoRoot??process.cwd(),
    timeoutMs,
    maxOutputBytes,
  });
  let parsed:unknown;
  try {parsed=JSON.parse(output);} catch {throw parserError('INVALID_PARSE_RESPONSE');}
  return validateDocumentParseResponse(parsed,request);
}
