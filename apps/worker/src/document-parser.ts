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

function hasExactKeys(value:Record<string,unknown>,keys:string[]):boolean {
  return Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
}

function nonEmptyString(value:unknown,max=16_384):value is string {
  return typeof value==='string' && value.trim().length>0 && value.length<=max;
}

function validVersion(value:unknown):value is string {
  return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function positiveInteger(value:unknown):value is number {
  return Number.isSafeInteger(value) && Number(value)>0;
}

function validCell(value:unknown):value is string {
  return typeof value==='string' && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(value);
}

function pythonQuote(value:string):string {
  return encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function validLocator(type:string,locator:Record<string,unknown>,pageCount:number|null):boolean {
  if(type==='docx_block') {
    if(!hasExactKeys(locator,['path','stable_ref']) || !Array.isArray(locator.path) || locator.path.length===0 || !nonEmptyString(locator.stable_ref,512)) return false;
    const refs:string[]=[];
    for(const part of locator.path) {
      if(!isObject(part)) return false;
      if(hasExactKeys(part,['paragraph']) && positiveInteger(part.paragraph)) refs.push(`p${String(part.paragraph).padStart(4,'0')}`);
      else if(hasExactKeys(part,['table','row','column']) && positiveInteger(part.table) && positiveInteger(part.row) && positiveInteger(part.column)) {
        refs.push(`t${String(part.table).padStart(3,'0')}:r${String(part.row).padStart(3,'0')}:c${String(part.column).padStart(3,'0')}`);
      } else return false;
    }
    return locator.stable_ref===`docx:${refs.join(':')}`;
  }
  if(type==='pdf_bbox') {
    if(!hasExactKeys(locator,['page','line','bbox','stable_ref']) || !positiveInteger(locator.page) || !positiveInteger(locator.line) ||
      pageCount===null || locator.page>pageCount || !isObject(locator.bbox) || !hasExactKeys(locator.bbox,['x0','top','x1','bottom'])) return false;
    const {x0,top,x1,bottom}=locator.bbox;
    // PDF coordinates can be negative for text outside a crop box; ordering and finiteness still make the anchor checkable.
    return [x0,top,x1,bottom].every(item=>typeof item==='number' && Number.isFinite(item)) &&
      Number(x1)>Number(x0) && Number(bottom)>Number(top) && locator.stable_ref===`pdf:p${String(locator.page).padStart(4,'0')}:l${String(locator.line).padStart(4,'0')}`;
  }
  if(type==='xlsx_cell') {
    if(!hasExactKeys(locator,['sheet','cell','merged_range','stable_ref']) || !nonEmptyString(locator.sheet,256) || !validCell(locator.cell) ||
      !(locator.merged_range===null || (typeof locator.merged_range==='string' && /^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(locator.merged_range)))) return false;
    return locator.stable_ref===`xlsx:${pythonQuote(locator.sheet)}:cell:${locator.cell}`;
  }
  if(type==='csv_cell') return hasExactKeys(locator,['row','column','stable_ref']) && positiveInteger(locator.row) && positiveInteger(locator.column) &&
    locator.stable_ref===`csv:r${String(locator.row).padStart(6,'0')}:c${String(locator.column).padStart(4,'0')}`;
  if(type==='text_line') return hasExactKeys(locator,['line','stable_ref']) && positiveInteger(locator.line) &&
    locator.stable_ref===`text:l${String(locator.line).padStart(6,'0')}`;
  return false;
}

function safeJson(value:unknown,authorizedPath:string):boolean {
  if(value===null || typeof value==='boolean' || typeof value==='number') return typeof value!=='number' || Number.isFinite(value);
  if(typeof value==='string') return !value.includes(authorizedPath);
  if(Array.isArray(value)) return value.every(item=>safeJson(item,authorizedPath));
  if(isObject(value)) return Object.entries(value).every(([key,item])=>
    !/(?:authorized_local_path|(?:file|dir|source|staging)_path$)/i.test(key) && safeJson(item,authorizedPath));
  return false;
}

export function validateDocumentParseResponse(value:unknown, request:DocumentParseRequest):DocumentParseResponse {
  if(!isObject(value) || !hasExactKeys(value,['schema_version','request_id','parser_version','status','material','records','warnings','document','error']) ||
    value.schema_version!==DOCUMENT_PARSE_RESPONSE_VERSION || value.request_id!==request.request_id ||
    !validVersion(value.parser_version) || !['parsed','needs_confirmation','failed'].includes(String(value.status)) ||
    !Array.isArray(value.records) || !Array.isArray(value.warnings) || !isObject(value.document)) {
    throw parserError('INVALID_PARSE_RESPONSE');
  }
  if(!isObject(value.material) || !hasExactKeys(value.material,['material_id','material_version','media_type','sha256']) || value.material.material_id!==request.material.material_id ||
    value.material.material_version!==request.material.material_version || value.material.media_type!==request.material.media_type ||
    value.material.sha256!==request.material.sha256) {
    throw parserError('PARSE_MATERIAL_IDENTITY_MISMATCH');
  }
  if(!hasExactKeys(value.document,value.status==='failed'?['page_count']:request.material.media_type==='application/pdf'
    ? ['page_count','pages_without_native_text','pages_with_images']
    : request.material.media_type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ? (value.status==='failed'?['page_count']:['page_count','revision_summary'])
      : request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ? (value.status==='failed'?['page_count']:['page_count','worksheet_count','missing_formula_results'])
        : request.material.media_type==='text/csv'
          ? (value.status==='failed'?['page_count']:['page_count','encoding','delimiter'])
          : (value.status==='failed'?['page_count']:['page_count','encoding'])) ||
    !(value.document.page_count===null || positiveInteger(value.document.page_count)) ||
    (value.status!=='failed' && request.material.media_type==='application/pdf' && !positiveInteger(value.document.page_count)) ||
    (request.material.media_type!=='application/pdf' && value.document.page_count!==null)) throw parserError('INVALID_PARSE_RESPONSE');
  if(value.status==='failed') {
    if(!hasExactKeys(value.document,['page_count'])) throw parserError('INVALID_PARSE_RESPONSE');
  } else if(request.material.media_type==='application/pdf') {
    const pageCount=Number(value.document.page_count);
    if(pageCount>(request.options.max_pages??1500)) throw parserError('INVALID_PARSE_RESPONSE');
    for(const key of ['pages_without_native_text','pages_with_images']) {
      const pages=value.document[key];
      if(!Array.isArray(pages) || !pages.every(page=>positiveInteger(page) && page<=pageCount)) throw parserError('INVALID_PARSE_RESPONSE');
    }
  } else if(request.material.media_type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if(!isObject(value.document.revision_summary) || !hasExactKeys(value.document.revision_summary,['insertions','deletions']) ||
      !Number.isSafeInteger(value.document.revision_summary.insertions) || Number(value.document.revision_summary.insertions)<0 ||
      !Number.isSafeInteger(value.document.revision_summary.deletions) || Number(value.document.revision_summary.deletions)<0) throw parserError('INVALID_PARSE_RESPONSE');
  } else if(request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    if(!positiveInteger(value.document.worksheet_count) || !Number.isSafeInteger(value.document.missing_formula_results) || Number(value.document.missing_formula_results)<0) throw parserError('INVALID_PARSE_RESPONSE');
  } else if(!nonEmptyString(value.document.encoding,64) || (request.material.media_type==='text/csv' && !nonEmptyString(value.document.delimiter,1))) throw parserError('INVALID_PARSE_RESPONSE');

  for(const warning of value.warnings) {
    if(!isObject(warning) || !hasExactKeys(warning,['code','message']) || typeof warning.code!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(warning.code) ||
      !nonEmptyString(warning.message,4096)) throw parserError('INVALID_PARSE_RESPONSE');
  }
  const recordIds=new Set<string>();
  const expectedLocatorType:Record<ParserMediaType,DocumentParseRecord['locator_type']>={
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx_block',
    'application/pdf':'pdf_bbox',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx_cell',
    'text/csv':'csv_cell',
    'text/plain':'text_line',
  };
  for(const record of value.records) {
    if(!isObject(record) || !hasExactKeys(record,['record_id','material_id','material_version','content_hash','locator_type','locator','literal_quote','context','extraction_method','extractor_version','confidence','uncertainty','formatting']) ||
      typeof record.record_id!=='string' || !safeId(record.record_id) || recordIds.has(record.record_id) || record.material_id!==request.material.material_id ||
      record.material_version!==request.material.material_version || record.content_hash!==request.material.sha256 ||
      record.locator_type!==expectedLocatorType[request.material.media_type] ||
      !isObject(record.locator) || !validLocator(String(record.locator_type),record.locator, value.document.page_count as number|null) ||
      !nonEmptyString(record.literal_quote) || typeof record.context!=='string' || record.extraction_method!=='native_text' ||
      !validVersion(record.extractor_version) || !(record.confidence===null || (typeof record.confidence==='number' && Number.isFinite(record.confidence) && record.confidence>=0 && record.confidence<=1)) ||
      !Array.isArray(record.uncertainty) || !record.uncertainty.every(item=>nonEmptyString(item,1024)) || !isObject(record.formatting) ||
      !safeJson(record.formatting,request.material.authorized_local_path)) {
      throw parserError('INVALID_PARSE_RESPONSE');
    }
    recordIds.add(record.record_id);
  }
  if([value.parser_version,...value.warnings.flatMap(warning=>isObject(warning)?[warning.message]:[]),
    ...value.records.flatMap(record=>isObject(record)?[record.literal_quote,record.context,record.extractor_version]:[]),
    ...(isObject(value.error)?[value.error.message]:[])].some(item=>typeof item==='string' && item.includes(request.material.authorized_local_path))) {
    throw parserError('INVALID_PARSE_RESPONSE');
  }
  if(value.status==='failed') {
    if(value.records.length!==0 || value.warnings.length!==0 || value.document.page_count!==null || !isObject(value.error) ||
      !hasExactKeys(value.error,['code','message']) || typeof value.error.code!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.error.code) ||
      !nonEmptyString(value.error.message,4096)) throw parserError('INVALID_PARSE_RESPONSE');
  } else {
    if(value.error!==null || value.records.length===0 || (value.status==='parsed' && (value.warnings.length>0 || value.records.some(record=>Array.isArray(record.uncertainty) && record.uncertainty.length>0))) ||
      (value.status==='needs_confirmation' && value.warnings.length===0 && !value.records.some(record=>Array.isArray(record.uncertainty) && record.uncertainty.length>0))) throw parserError('INVALID_PARSE_RESPONSE');
  }
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
