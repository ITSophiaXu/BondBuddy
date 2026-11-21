import { createHash } from 'node:crypto';
import { spawn } from './task-execution.js';
import { isAbsolute, resolve } from 'node:path';
import { open, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { classifyParserStderr, PARSER_STDERR_CAPTURE_BYTES, type ParserStderrDiagnostic } from './parser-diagnostics.js';

export const DOCUMENT_PARSE_REQUEST_VERSION = 'document-parse-request-v1' as const;
export const DOCUMENT_PARSE_RESPONSE_VERSION = 'document-parse-response-v1' as const;
export const DOCX_AUXILIARY_TARGETS_PARSER_VERSION = 'bondbuddy-document-parser-1.0.7' as const;
export const DOCX_OUTLINE_PARSER_VERSION = 'bondbuddy-document-parser-1.0.8' as const;
export const supportsDocxAuxiliaryTargets = (version: unknown): boolean =>
  version===DOCX_AUXILIARY_TARGETS_PARSER_VERSION || version===DOCX_OUTLINE_PARSER_VERSION;
export const DOCUMENT_PARSER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_PARSER_STREAM_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const DOCUMENT_PARSER_STREAM_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_PARSER_STREAM_VERSION = 'document-parse-stream-v1' as const;
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

export type DocxAuxiliaryTarget = {
  target_id: string;
  kind: 'header'|'footer'|'footnote'|'endnote'|'drawing'|'auxiliary_part';
  part_name: string;
  locator: Record<string, unknown>;
  scope: {
    kind: 'section_reference'|'note_reference'|'drawing_relationship'|'unknown';
    status: 'resolved'|'partially_resolved'|'unknown'|'unreferenced';
    relationship_part_sha256: string|null;
    relationships: Array<{relationship_id:string|null;relationship_id_sha256:string|null;
      relationship_type:'header'|'footer'|'footnotes'|'endnotes'|'image'|'other';
      mode:'internal'|'external'|'unknown';target_part:string|null;status:'resolved'|'external'|'missing'|'unsafe'|'unsupported'}>;
    section_references: Array<{section_index:number;reference_type:'default'|'first'|'even'|'unknown';
      relationship_id:string|null;relationship_id_sha256:string|null;section_stable_ref:string|null}>;
    unknown_sections: number[];
    body_references: Array<{note_id:string|null;note_id_sha256:string|null;stable_ref:string|null}>;
    reason: string|null;
    truncated: boolean;
  };
  part_sha256: string|null;
  target_sha256: string|null;
  locator_resolved: boolean;
  parseable: boolean;
  parse_status: 'parsed'|'empty'|'not_extracted'|'read_failed'|'parse_failed'|'unsafe_xml'|'size_limited'|'unrecognized_part'|
    'external_relationship'|'missing_relationship'|'unsafe_relationship'|'missing_reference_target';
  text_summary: {sha256:string;character_count:number;has_text:boolean}|null;
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
  document: Record<string, unknown> & {page_count:number|null;auxiliary_targets?:DocxAuxiliaryTarget[]};
  error: {code:string;message:string}|null;
};

type InvokeOutput = string|{stdout:string;stderr:Buffer;stderrBytes:number};
type Invoke = (serializedRequest:string, options:{pythonExecutable:string;repoRoot:string;timeoutMs:number;maxOutputBytes:number})=>Promise<InvokeOutput>;

export type DocumentParserError = Error & {code:string;diagnostic?:ParserStderrDiagnostic|null;stderr?:{captured:Buffer;bytes:number}};

function parserError(code:string, stderr?:{captured:Buffer;bytes:number}):DocumentParserError {
  const error=new Error(code) as DocumentParserError;
  error.name='DocumentParserError';
  error.code=code;
  if(stderr)error.stderr=stderr;
  return error;
}

function safeId(value:string):boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validateRequest(request:DocumentParseRequest):void {
  if(request.schema_version!==DOCUMENT_PARSE_REQUEST_VERSION || !safeId(request.request_id) || !safeId(request.material.material_id) ||
    !Number.isSafeInteger(request.material.material_version) || request.material.material_version<1 ||
    !DOCUMENT_PARSER_MEDIA_TYPES.includes(request.material.media_type) || !/^[a-f0-9]{64}$/.test(request.material.sha256) ||
    !isAbsolute(request.material.authorized_local_path) ||
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

function validDocxAuxiliaryScope(value:unknown):value is DocxAuxiliaryTarget['scope'] {
  if(!isObject(value) || !hasExactKeys(value,['kind','status','relationship_part_sha256','relationships','section_references',
    'unknown_sections','body_references','reason','truncated']) ||
    !['section_reference','note_reference','drawing_relationship','unknown'].includes(String(value.kind)) ||
    !['resolved','partially_resolved','unknown','unreferenced'].includes(String(value.status)) ||
    !(value.relationship_part_sha256===null || (typeof value.relationship_part_sha256==='string' && /^[a-f0-9]{64}$/.test(value.relationship_part_sha256))) ||
    !Array.isArray(value.relationships) || value.relationships.length>128 ||
    !Array.isArray(value.section_references) || value.section_references.length>128 ||
    !Array.isArray(value.unknown_sections) || value.unknown_sections.length>128 || !value.unknown_sections.every(positiveInteger) ||
    new Set(value.unknown_sections).size!==value.unknown_sections.length ||
    !Array.isArray(value.body_references) || value.body_references.length>128 ||
    !(value.reason===null || nonEmptyString(value.reason,128)) || typeof value.truncated!=='boolean') return false;
  const relationIds=new Set<string>();
  for(const relation of value.relationships) {
    if(!isObject(relation) || !hasExactKeys(relation,['relationship_id','relationship_id_sha256','relationship_type','mode','target_part','status']) ||
      !(relation.relationship_id===null || (typeof relation.relationship_id==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(relation.relationship_id))) ||
      !(relation.relationship_id_sha256===null || (typeof relation.relationship_id_sha256==='string' && /^[a-f0-9]{64}$/.test(relation.relationship_id_sha256))) ||
      (relation.relationship_id!==null && relation.relationship_id_sha256!==createHash('sha256').update(String(relation.relationship_id)).digest('hex')) ||
      !['header','footer','footnotes','endnotes','image','other'].includes(String(relation.relationship_type)) ||
      !['internal','external','unknown'].includes(String(relation.mode)) ||
      !(relation.target_part===null || (typeof relation.target_part==='string' &&
        /^word\/(?:header\d+|footer\d+|footnotes|endnotes|auxiliary-[a-f0-9]{64})\.xml$/.test(relation.target_part))) ||
      !['resolved','external','missing','unsafe','unsupported'].includes(String(relation.status)) ||
      (relation.status==='resolved' && (relation.mode!=='internal' || relation.target_part===null)) ||
      (relation.status==='external' && (relation.mode!=='external' || relation.target_part!==null)) ||
      (relation.status==='unsupported' && relation.target_part!==null) ||
      (relation.status!=='resolved' && relation.status!=='unsupported' && relation.target_part!==null)) return false;
    const key=relation.relationship_id??`hash:${relation.relationship_id_sha256??''}`;
    if(relationIds.has(key)) return false;
    relationIds.add(key);
  }
  const sectionKeys=new Set<string>();
  for(const reference of value.section_references) {
    if(!isObject(reference) || !hasExactKeys(reference,['section_index','reference_type','relationship_id','relationship_id_sha256','section_stable_ref']) ||
      !positiveInteger(reference.section_index) || !['default','first','even','unknown'].includes(String(reference.reference_type)) ||
      !(reference.relationship_id===null || (typeof reference.relationship_id==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(reference.relationship_id))) ||
      !(reference.relationship_id_sha256===null || (typeof reference.relationship_id_sha256==='string' && /^[a-f0-9]{64}$/.test(reference.relationship_id_sha256))) ||
      (reference.relationship_id!==null && reference.relationship_id_sha256!==createHash('sha256').update(String(reference.relationship_id)).digest('hex')) ||
      !(reference.section_stable_ref===null || (typeof reference.section_stable_ref==='string' && /^docx:[A-Za-z0-9:]+$/.test(reference.section_stable_ref)))) return false;
    const key=`${reference.section_index}:${reference.reference_type}:${reference.relationship_id??reference.relationship_id_sha256??''}`;
    if(sectionKeys.has(key)) return false;
    sectionKeys.add(key);
  }
  for(const reference of value.body_references) {
    if(!isObject(reference) || !hasExactKeys(reference,['note_id','note_id_sha256','stable_ref']) ||
      !(reference.note_id===null || (typeof reference.note_id==='string' && /^-?[0-9]{1,10}$/.test(reference.note_id))) ||
      !(reference.note_id_sha256===null || (typeof reference.note_id_sha256==='string' && /^[a-f0-9]{64}$/.test(reference.note_id_sha256))) ||
      (reference.note_id!==null && reference.note_id_sha256!==createHash('sha256').update(String(reference.note_id)).digest('hex')) ||
      !(reference.stable_ref===null || (typeof reference.stable_ref==='string' && /^docx:[A-Za-z0-9:]+$/.test(reference.stable_ref)))) return false;
  }
  if(value.kind==='section_reference' && value.status==='resolved' &&
      (!value.relationships.some(relation=>isObject(relation) && relation.status==='resolved') ||
       value.section_references.length===0 || value.unknown_sections.length>0)) return false;
  if(value.kind==='section_reference' && value.status==='partially_resolved' &&
      (!value.relationships.some(relation=>isObject(relation) && relation.status==='resolved') ||
       value.section_references.length===0 || value.unknown_sections.length===0)) return false;
  if(value.truncated && (value.status!=='unknown' || !nonEmptyString(value.reason,128))) return false;
  if(value.kind==='drawing_relationship' && (value.status!=='unknown' ||
    !['drawing_relationship_targets_not_extracted','scope_detail_limit_exceeded'].includes(String(value.reason)))) return false;
  if(value.status==='unreferenced' && value.kind!=='note_reference') return false;
  return true;
}

function validDocxAuxiliaryTargets(value:unknown):value is DocxAuxiliaryTarget[] {
  if(!Array.isArray(value) || value.length>10_000)return false;
  const ids=new Set<string>();
  for(const target of value) {
    if(!isObject(target) || !hasExactKeys(target,['target_id','kind','part_name','locator','scope','part_sha256','target_sha256',
      'locator_resolved','parseable','parse_status','text_summary']) ||
      typeof target.target_id!=='string' || !/^aux-[a-f0-9]{64}$/.test(target.target_id) || ids.has(target.target_id) ||
      !['header','footer','footnote','endnote','drawing','auxiliary_part'].includes(String(target.kind)) ||
      typeof target.part_name!=='string' || !/^word\/(?:header\d+|footer\d+|footnotes|endnotes|document|auxiliary-[a-f0-9]{64})\.xml$/.test(target.part_name) ||
      !isObject(target.locator) || typeof target.locator.part_name!=='string' || target.locator.part_name!==target.part_name ||
      !(target.part_sha256===null || (typeof target.part_sha256==='string' && /^[a-f0-9]{64}$/.test(target.part_sha256))) ||
      !(target.target_sha256===null || (typeof target.target_sha256==='string' && /^[a-f0-9]{64}$/.test(target.target_sha256))) ||
      typeof target.locator_resolved!=='boolean' || typeof target.parseable!=='boolean' ||
      !['parsed','empty','not_extracted','read_failed','parse_failed','unsafe_xml','size_limited','unrecognized_part',
        'external_relationship','missing_relationship','unsafe_relationship','missing_reference_target'].includes(String(target.parse_status)) ||
      !validDocxAuxiliaryScope(target.scope)) return false;
    ids.add(target.target_id);
    const locator=target.locator;
    if(target.kind==='drawing') {
      if(target.part_name!=='word/document.xml' || !hasExactKeys(locator,['part_name','drawing_index','parent_stable_ref','drawing_ids']) ||
        !positiveInteger(locator.drawing_index) || !(locator.parent_stable_ref===null || nonEmptyString(locator.parent_stable_ref,512)) ||
        !Array.isArray(locator.drawing_ids) || !locator.drawing_ids.every(item=>nonEmptyString(item,128)) ||
        target.parse_status!=='not_extracted' || target.parseable || !target.locator_resolved || target.text_summary!==null ||
        target.scope.kind!=='drawing_relationship' || target.scope.status!=='unknown') return false;
    } else if(target.kind==='header' || target.kind==='footer') {
      if(!/^word\/(?:header\d+|footer\d+)\.xml$/.test(target.part_name) ||
        (target.kind==='header' && !target.part_name.includes('/header')) ||
        (target.kind==='footer' && !target.part_name.includes('/footer')) ||
        !hasExactKeys(locator,['part_name','paragraph_index']) ||
        !(locator.paragraph_index===null || positiveInteger(locator.paragraph_index))) return false;
    } else if(target.kind==='footnote' || target.kind==='endnote') {
      if(target.part_name!==(target.kind==='footnote'?'word/footnotes.xml':'word/endnotes.xml') ||
        !hasExactKeys(locator,['part_name','note_id','paragraph_index']) || !nonEmptyString(locator.note_id,128) ||
        !(locator.paragraph_index===null || positiveInteger(locator.paragraph_index))) return false;
    } else if(target.kind==='auxiliary_part') {
      const unknownPart=/^word\/auxiliary-[a-f0-9]{64}\.xml$/.test(target.part_name);
      if(unknownPart) {
        if(!hasExactKeys(locator,['part_name','member_name_sha256']) || locator.member_name_sha256!==target.part_name.slice('word/auxiliary-'.length,-'.xml'.length)) return false;
      } else if(!hasExactKeys(locator,['part_name'])) return false;
    } else return false;

    const summary=target.text_summary;
    if(summary!==null && (!isObject(summary) || !hasExactKeys(summary,['sha256','character_count','has_text']) ||
      typeof summary.sha256!=='string' || !/^[a-f0-9]{64}$/.test(summary.sha256) ||
      !Number.isSafeInteger(summary.character_count) || Number(summary.character_count)<0 ||
      typeof summary.has_text!=='boolean')) return false;
    if(target.parseable!==(target.parse_status==='parsed'||target.parse_status==='empty') ||
      target.locator_resolved!==!['read_failed','parse_failed','unsafe_xml','size_limited','unrecognized_part','external_relationship',
        'missing_relationship','unsafe_relationship','missing_reference_target'].includes(String(target.parse_status)) ||
      (target.parseable && (!summary || target.part_sha256===null || target.target_sha256===null)) ||
      (target.parse_status==='not_extracted' && (target.kind!=='drawing' || target.part_sha256===null || target.target_sha256===null)) ||
      (target.parse_status==='read_failed' && (target.part_sha256!==null || target.target_sha256!==null || summary!==null)) ||
      (['parse_failed','unsafe_xml'].includes(String(target.parse_status)) &&
        (target.part_sha256===null || target.target_sha256===null || summary!==null)) ||
      (target.parse_status==='size_limited' && (target.part_sha256!==null || target.target_sha256!==null || summary!==null)) ||
      (target.parse_status==='unrecognized_part' && (target.kind!=='auxiliary_part' || target.part_sha256===null || target.target_sha256===null || summary!==null)) ||
      (['external_relationship','missing_relationship','unsafe_relationship'].includes(String(target.parse_status)) &&
        (target.kind!=='auxiliary_part' || target.part_sha256!==null || target.target_sha256!==null || summary!==null || target.locator_resolved)) ||
      (target.parse_status==='missing_reference_target' &&
        (!['footnote','endnote','auxiliary_part'].includes(String(target.kind)) || target.part_sha256!==null || target.target_sha256!==null || summary!==null || target.locator_resolved))) return false;
    if(target.kind==='header' || target.kind==='footer') {
      if(target.scope.kind!=='section_reference' || target.scope.relationships.some(relation=>
        relation.relationship_type!==target.kind || relation.status==='resolved' && relation.target_part!==target.part_name)) return false;
      const matchingRelations=target.scope.relationships.filter(relation=>relation.relationship_type===target.kind &&
        relation.status==='resolved' && relation.target_part===target.part_name);
      if(target.scope.section_references.some(reference=>!matchingRelations.some(relation=>
        relation.relationship_id!==null && reference.relationship_id===relation.relationship_id)) ||
        (target.scope.status==='resolved' && (!matchingRelations.length || !target.scope.section_references.length ||
          target.scope.unknown_sections.length>0)) ||
        (target.scope.status==='partially_resolved' && (!matchingRelations.length || !target.scope.section_references.length ||
          !target.scope.unknown_sections.length)) ||
        (['external_relationship','missing_relationship','unsafe_relationship'].includes(String(target.parse_status)) &&
          (target.scope.status!=='unknown' || !target.scope.relationships.some(relation=>
            relation.status===({external_relationship:'external',missing_relationship:'missing',unsafe_relationship:'unsafe'} as const)[target.parse_status as 'external_relationship'|'missing_relationship'|'unsafe_relationship'])))) return false;
    }
    if(target.kind==='footnote' || target.kind==='endnote') {
      if(target.scope.kind!=='note_reference' || target.scope.body_references.some(reference=>
        reference.note_id!==null && reference.note_id!==(target.locator as Record<string,unknown>).note_id)) return false;
      const expectedType=target.kind==='footnote'?'footnotes':'endnotes';
      if(target.scope.relationships.some(relation=>relation.relationship_type!==expectedType ||
        relation.status==='resolved' && relation.target_part!==target.part_name) ||
        (target.scope.status==='resolved' && (!target.scope.relationships.some(relation=>relation.status==='resolved' &&
          relation.target_part===target.part_name) || !target.scope.body_references.length)) ||
        (target.scope.status==='unreferenced' && (target.scope.body_references.length!==0 ||
          !target.scope.relationships.some(relation=>relation.status==='resolved' && relation.target_part===target.part_name)))) return false;
    }
    if(['external_relationship','missing_relationship','unsafe_relationship'].includes(String(target.parse_status))) {
      const requiredStatus=({external_relationship:'external',missing_relationship:'missing',unsafe_relationship:'unsafe'} as const)[
        target.parse_status as 'external_relationship'|'missing_relationship'|'unsafe_relationship'];
      if(target.kind!=='auxiliary_part' || target.scope.status!=='unknown' ||
        !target.scope.relationships.some(relation=>relation.status===requiredStatus)) return false;
    }
    if(target.parse_status==='missing_reference_target' && target.scope.status!=='unknown') return false;
  }
  return true;
}

function safeJson(value:unknown,authorizedPath:string):boolean {
  if(value===null || typeof value==='boolean' || typeof value==='number') return typeof value!=='number' || Number.isFinite(value);
  if(typeof value==='string') return !value.includes(authorizedPath);
  if(Array.isArray(value)) return value.every(item=>safeJson(item,authorizedPath));
  if(isObject(value)) return Object.entries(value).every(([key,item])=>
    !/(?:authorized_local_path|(?:file|dir|source|staging)_path$)/i.test(key) && safeJson(item,authorizedPath));
  return false;
}

const expectedLocatorTypes:Record<ParserMediaType,DocumentParseRecord['locator_type']>={
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx_block',
  'application/pdf':'pdf_bbox',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx_cell',
  'text/csv':'csv_cell',
  'text/plain':'text_line',
};
function expectedLocatorType(mediaType:ParserMediaType):DocumentParseRecord['locator_type'] { return expectedLocatorTypes[mediaType]; }

export function validateDocumentParseRecord(value:unknown,request:DocumentParseRequest,pageCount:number|null):DocumentParseRecord {
  if(!isObject(value) || !hasExactKeys(value,['record_id','material_id','material_version','content_hash','locator_type','locator','literal_quote','context','extraction_method','extractor_version','confidence','uncertainty','formatting']) ||
    typeof value.record_id!=='string' || !safeId(value.record_id) || value.material_id!==request.material.material_id ||
    value.material_version!==request.material.material_version || value.content_hash!==request.material.sha256 ||
    value.locator_type!==expectedLocatorType(request.material.media_type) || !isObject(value.locator) ||
    !validLocator(String(value.locator_type),value.locator,pageCount) || !nonEmptyString(value.literal_quote) ||
    typeof value.context!=='string' || value.context.length>16_384 || value.extraction_method!=='native_text' ||
    !validVersion(value.extractor_version) || !(value.confidence===null || (typeof value.confidence==='number' && Number.isFinite(value.confidence) && value.confidence>=0 && value.confidence<=1)) ||
    !Array.isArray(value.uncertainty) || !value.uncertainty.every(item=>nonEmptyString(item,1024)) || !isObject(value.formatting) ||
    !safeJson(value.locator,request.material.authorized_local_path) || !safeJson(value.formatting,request.material.authorized_local_path) ||
    [value.record_id,value.literal_quote,value.context,value.extractor_version].some(item=>typeof item==='string' && item.includes(request.material.authorized_local_path))) {
    throw parserError('INVALID_PARSE_RESPONSE');
  }
  return value as unknown as DocumentParseRecord;
}

export function validateDocumentParseSummary(value:unknown,request:DocumentParseRequest,recordCount:number,hasUncertainty:boolean):Omit<DocumentParseResponse,'records'> {
  if(!isObject(value) || !hasExactKeys(value,['schema_version','request_id','parser_version','status','material','warnings','document','error']) ||
    !Number.isSafeInteger(recordCount) || recordCount<0 || typeof hasUncertainty!=='boolean') throw parserError('INVALID_PARSE_RESPONSE');
  const candidate={...value,records:[]} as unknown;
  if(!isObject(candidate) || candidate.schema_version!==DOCUMENT_PARSE_RESPONSE_VERSION || candidate.request_id!==request.request_id) {
    throw parserError('INVALID_PARSE_RESPONSE');
  }
  // Reuse the full envelope checks while supplying the streamed record facts instead of materializing records.
  const summary={...candidate,records:recordCount>0?[{
    record_id:'stream-summary-record', material_id:request.material.material_id, material_version:request.material.material_version,
    content_hash:request.material.sha256, locator_type:expectedLocatorType(request.material.media_type),
    locator:request.material.media_type==='application/pdf'
      ? {page:1,line:1,bbox:{x0:0,top:0,x1:1,bottom:1},stable_ref:'pdf:p0001:l0001'}
      : request.material.media_type==='text/plain' ? {line:1,stable_ref:'text:l000001'}
        : request.material.media_type==='text/csv' ? {row:1,column:1,stable_ref:'csv:r000001:c0001'}
          : request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ? {sheet:'S',cell:'A1',merged_range:null,stable_ref:'xlsx:S:cell:A1'}
            : {path:[{paragraph:1}],stable_ref:'docx:p0001'},
    literal_quote:'stream summary',context:'',extraction_method:'native_text',extractor_version:String(candidate.parser_version),
    confidence:null,uncertainty:hasUncertainty?['streamed uncertainty']:[],formatting:{},
  }]:[]};
  const validated=validateDocumentParseResponse(summary,request);
  if(recordCount===0 && validated.status!=='failed') throw parserError('INVALID_PARSE_RESPONSE');
  if(validated.status==='failed' && recordCount!==0) throw parserError('INVALID_PARSE_RESPONSE');
  if(validated.status==='parsed' && hasUncertainty) throw parserError('INVALID_PARSE_RESPONSE');
  if(validated.status==='needs_confirmation' && validated.warnings.length===0 && !hasUncertainty) throw parserError('INVALID_PARSE_RESPONSE');
  const {records:_records,...result}=validated;
  return result;
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
      ? (value.status==='failed'?['page_count']:supportsDocxAuxiliaryTargets(value.parser_version)
        ? ['page_count','revision_summary','auxiliary_targets']:['page_count','revision_summary'])
      : request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ? ['page_count','worksheet_count','missing_formula_results','cached_formula_results']
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
    const hasAuxiliaryTargets=supportsDocxAuxiliaryTargets(value.parser_version);
    if(!hasExactKeys(value.document,hasAuxiliaryTargets?['page_count','revision_summary','auxiliary_targets']:['page_count','revision_summary']) ||
      (hasAuxiliaryTargets && !validDocxAuxiliaryTargets(value.document.auxiliary_targets)) ||
      !isObject(value.document.revision_summary) || !hasExactKeys(value.document.revision_summary,['insertions','deletions']) ||
      !Number.isSafeInteger(value.document.revision_summary.insertions) || Number(value.document.revision_summary.insertions)<0 ||
      !Number.isSafeInteger(value.document.revision_summary.deletions) || Number(value.document.revision_summary.deletions)<0) throw parserError('INVALID_PARSE_RESPONSE');
  } else if(request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    if(!positiveInteger(value.document.worksheet_count) || !Number.isSafeInteger(value.document.missing_formula_results) || Number(value.document.missing_formula_results)<0 ||
      !Number.isSafeInteger(value.document.cached_formula_results) || Number(value.document.cached_formula_results)<0 ||
      (Number(value.document.cached_formula_results)>0 && (value.status!=='needs_confirmation' ||
        !value.warnings.some(warning=>isObject(warning) && warning.code==='XLSX_FORMULA_CACHE_UNVERIFIED')))) throw parserError('INVALID_PARSE_RESPONSE');
  } else if(!nonEmptyString(value.document.encoding,64) || (request.material.media_type==='text/csv' && !nonEmptyString(value.document.delimiter,1))) throw parserError('INVALID_PARSE_RESPONSE');

  for(const warning of value.warnings) {
    if(!isObject(warning) || !hasExactKeys(warning,['code','message']) || typeof warning.code!=='string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(warning.code) ||
      !nonEmptyString(warning.message,4096)) throw parserError('INVALID_PARSE_RESPONSE');
  }
  if(value.status!=='failed' && request.material.media_type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    supportsDocxAuxiliaryTargets(value.parser_version)) {
    const targets=value.document.auxiliary_targets as DocxAuxiliaryTarget[];
    const hasAuxiliary=targets.some(target=>target.kind!=='drawing');
    const hasDrawings=targets.some(target=>target.kind==='drawing');
    if(hasAuxiliary!==value.warnings.some(warning=>warning.code==='DOCX_AUXILIARY_PARTS') ||
      hasDrawings!==value.warnings.some(warning=>warning.code==='DOCX_DRAWINGS')) throw parserError('INVALID_PARSE_RESPONSE');
  }
  const recordIds=new Set<string>();
  const pageCount=value.document.page_count as number|null;
  let cachedFormulaRecords=0;
  for(const record of value.records) {
    const validated=validateDocumentParseRecord(record,request,pageCount);
    if(recordIds.has(validated.record_id)) throw parserError('INVALID_PARSE_RESPONSE');
    recordIds.add(validated.record_id);
    if(request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
      Object.hasOwn(validated.formatting,'cached_formula_result')) {
      cachedFormulaRecords++;
      if(!validated.uncertainty.includes('formula_cached_result_unverified')) throw parserError('INVALID_PARSE_RESPONSE');
    }
  }
  if(value.status!=='failed' && request.material.media_type==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' &&
    cachedFormulaRecords!==value.document.cached_formula_results) throw parserError('INVALID_PARSE_RESPONSE');
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
    env:{...process.env,PYTHONPATH:resolve(repoRoot,'python'),PYTHONIOENCODING:'utf-8'},
    stdio:['pipe','pipe','pipe'],
  });
  const stdout:Buffer[]=[];
  const stderr:Buffer[]=[];
  let stdoutBytes=0;
  let stderrBytes=0;
  let capturedStderr=0;
  let settled=false;
  const stderrSnapshot=()=>({captured:Buffer.concat(stderr),bytes:stderrBytes});
  const stop=(code:string)=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    reject(parserError(code,stderrSnapshot()));
  };
  const timer=setTimeout(()=>stop('DOCUMENT_PARSER_TIMEOUT'),timeoutMs);
  child.stdout.on('data',(chunk:Buffer)=>{
    stdoutBytes+=chunk.length;
    if(stdoutBytes>maxOutputBytes)return stop('DOCUMENT_PARSER_OUTPUT_LIMIT');
    stdout.push(chunk);
  });
  // Stderr never decides the outcome. Keep the first 64 KiB for the diagnostic and count the rest.
  child.stderr.on('data',(chunk:Buffer)=>{
    stderrBytes+=chunk.length;
    const room=PARSER_STDERR_CAPTURE_BYTES-capturedStderr;
    if(room>0){const kept=chunk.subarray(0,room);stderr.push(kept);capturedStderr+=kept.length;}
  });
  child.on('error',()=>stop('DOCUMENT_PARSER_UNAVAILABLE'));
  child.on('close',(code,signal)=>{
    if(settled)return;
    settled=true;
    clearTimeout(timer);
    // We only SIGKILL after settling, so a SIGKILL here came from the kernel: the container memory limit.
    if(signal==='SIGKILL')return reject(parserError('DOCUMENT_PARSER_MEMORY_LIMIT',stderrSnapshot()));
    if(code!==0)return reject(parserError('DOCUMENT_PARSER_PROCESS_FAILED',stderrSnapshot()));
    resolveOutput({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr),stderrBytes});
  });
  child.stdin.on('error',()=>stop('DOCUMENT_PARSER_PROCESS_FAILED'));
  child.stdin.end(serializedRequest);
});

export type DocumentParseSummary=Omit<DocumentParseResponse,'records'>;
export type StreamedDocumentParse={response:DocumentParseSummary;recordsPath:string;recordCount:number;outputBytes:number};

function parseStreamEvent(line:Buffer):unknown {
  try { return JSON.parse(line.toString('utf8')) as unknown; }
  catch { throw parserError('INVALID_PARSE_RESPONSE'); }
}

async function writeAll(handle:Awaited<ReturnType<typeof open>>,bytes:Buffer):Promise<void> {
  let offset=0;
  while(offset<bytes.length) {
    const result=await handle.write(bytes,offset,bytes.length-offset);
    if(result.bytesWritten<1)throw parserError('DOCUMENT_PARSER_SPOOL_FAILED');
    offset+=result.bytesWritten;
  }
}

/** Runs the Python NDJSON protocol with bounded stdout memory and spools validated evidence rows to disk. */
export async function runDocumentParserToFile(request:DocumentParseRequest,recordsPath:string,options:{
  pythonExecutable?:string;
  repoRoot?:string;
  timeoutMs?:number;
  maxOutputBytes?:number;
  onDiagnostic?:(diagnostic:ParserStderrDiagnostic|null)=>void;
}={}):Promise<StreamedDocumentParse> {
  validateRequest(request);
  if(request.material.media_type!=='application/pdf' && request.material.media_type!=='text/plain')throw parserError('INVALID_PARSE_RUNNER_OPTIONS');
  const timeoutMs=options.timeoutMs??5*60_000;
  const maxOutputBytes=options.maxOutputBytes??DOCUMENT_PARSER_STREAM_MAX_OUTPUT_BYTES;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30*60_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<1024 || maxOutputBytes>1024*1024*1024) throw parserError('INVALID_PARSE_RUNNER_OPTIONS');
  const repoRoot=options.repoRoot??process.cwd();
  const privatePaths=[request.material.authorized_local_path,resolve(request.material.authorized_local_path,'..'),repoRoot];
  const serialized=JSON.stringify(request);
  const child=spawn(options.pythonExecutable??'python3',['-m','bondbuddy_document_parser','--stream'],{
    cwd:repoRoot,env:{...process.env,PYTHONPATH:resolve(repoRoot,'python'),PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe'],
  });
  const stderr:Buffer[]=[];
  let stderrBytes=0,capturedStderr=0,outputBytes=0,textBytes=0,recordCount=0,hasUncertainty=false,pageCount:number|null=null;
  let started=false,terminal=false,settledCode:string|null=null,streamParserVersion:string|null=null;
  let diagnostic:ParserStderrDiagnostic|null=null;
  const stderrSnapshot=()=>({captured:Buffer.concat(stderr),bytes:stderrBytes});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolveClose,rejectClose)=>{
    child.once('error',()=>rejectClose(parserError('DOCUMENT_PARSER_UNAVAILABLE',stderrSnapshot())));
    child.once('close',(code,signal)=>resolveClose({code,signal}));
  });
  const timer=setTimeout(()=>{settledCode='DOCUMENT_PARSER_TIMEOUT';child.kill('SIGKILL');},timeoutMs);
  child.stdin.on('error',()=>{});
  child.stderr.on('data',(chunk:Buffer)=>{
    stderrBytes+=chunk.length;
    const room=PARSER_STDERR_CAPTURE_BYTES-capturedStderr;
    if(room>0){const kept=chunk.subarray(0,room);stderr.push(kept);capturedStderr+=kept.length;}
  });
  let spool:Awaited<ReturnType<typeof open>>|undefined;
  let response:DocumentParseSummary|undefined;
  const processLine=async(line:Buffer)=>{
    if(line.length===0 || line.length>300*1024 || terminal)throw parserError('INVALID_PARSE_RESPONSE');
    const event=parseStreamEvent(line);
    if(!isObject(event) || typeof event.type!=='string')throw parserError('INVALID_PARSE_RESPONSE');
    if(event.type==='start') {
      if(started || !hasExactKeys(event,['type','schema_version','request_id','parser_version','material','document']) ||
        event.schema_version!==DOCUMENT_PARSER_STREAM_VERSION || event.request_id!==request.request_id || !validVersion(event.parser_version) ||
        !isObject(event.material) || !hasExactKeys(event.material,['material_id','material_version','sha256','media_type']) ||
        event.material.material_id!==request.material.material_id || event.material.material_version!==request.material.material_version ||
        event.material.sha256!==request.material.sha256 || event.material.media_type!==request.material.media_type || !isObject(event.document) ||
        !Object.hasOwn(event.document,'page_count') || !(event.document.page_count===null || positiveInteger(event.document.page_count))) {
        throw parserError('INVALID_PARSE_RESPONSE');
      }
      if(request.material.media_type==='application/pdf' && (!positiveInteger(event.document.page_count) || Number(event.document.page_count)>(request.options.max_pages??1500)) ||
        request.material.media_type!=='application/pdf' && event.document.page_count!==null)throw parserError('INVALID_PARSE_RESPONSE');
      pageCount=event.document.page_count as number|null;
      streamParserVersion=event.parser_version;
      started=true;
      return;
    }
    if(event.type==='failure') {
      if(!hasExactKeys(event,['type','response']))throw parserError('INVALID_PARSE_RESPONSE');
      const failed=validateDocumentParseResponse(event.response,request);
      if(failed.status!=='failed')throw parserError('INVALID_PARSE_RESPONSE');
      if(spool)await spool.truncate(0);
      recordCount=0;
      response=(({records:_records,...meta})=>meta)(failed);
      terminal=true;
      return;
    }
    if(!started)throw parserError('INVALID_PARSE_RESPONSE');
    if(event.type==='record') {
      if(!hasExactKeys(event,['type','record']))throw parserError('INVALID_PARSE_RESPONSE');
      const record=validateDocumentParseRecord(event.record,request,pageCount);
      textBytes+=Buffer.byteLength(record.literal_quote,'utf8')+Buffer.byteLength(record.context,'utf8');
      if(textBytes>DOCUMENT_PARSER_STREAM_MAX_TEXT_BYTES)throw parserError('DOCUMENT_PARSER_TEXT_LIMIT');
      const bytes=Buffer.from(`${JSON.stringify(record)}\n`,'utf8');
      if(bytes.length>256*1024)throw parserError('DOCUMENT_PARSER_OUTPUT_LIMIT');
      if(!spool)throw parserError('DOCUMENT_PARSER_SPOOL_FAILED');
      await writeAll(spool,bytes);
      recordCount++;
      hasUncertainty=hasUncertainty||record.uncertainty.length>0;
      return;
    }
    if(event.type==='end') {
      if(!hasExactKeys(event,['type','record_count','has_uncertainty','response']) || event.record_count!==recordCount ||
        event.has_uncertainty!==hasUncertainty || recordCount===0 || !isObject(event.response) ||
        event.response.parser_version!==streamParserVersion || !isObject(event.response.document) || event.response.document.page_count!==pageCount)throw parserError('INVALID_PARSE_RESPONSE');
      response=validateDocumentParseSummary(event.response,request,recordCount,hasUncertainty);
      terminal=true;
      return;
    }
    throw parserError('INVALID_PARSE_RESPONSE');
  };
  let pending=Buffer.alloc(0);
  try {
    spool=await open(recordsPath,'wx',0o600);
    child.stdin.end(serialized);
    for await(const chunk of child.stdout) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      outputBytes+=bytes.length;
      if(outputBytes>maxOutputBytes){settledCode='DOCUMENT_PARSER_OUTPUT_LIMIT';child.kill('SIGKILL');break;}
      pending=pending.length===0?Buffer.from(bytes):Buffer.concat([pending,bytes]);
      let newline:number;
      let from=0;
      while((newline=pending.indexOf(0x0a,from))>=0) {
        const line=pending.subarray(from,newline);
        await processLine(line);
        from=newline+1;
      }
      pending=Buffer.from(pending.subarray(from));
      if(pending.length>300*1024){settledCode='DOCUMENT_PARSER_OUTPUT_LIMIT';child.kill('SIGKILL');break;}
    }
    const result=await closed;
    clearTimeout(timer);
    if(settledCode)throw parserError(settledCode,stderrSnapshot());
    if(result.signal==='SIGKILL')throw parserError('DOCUMENT_PARSER_MEMORY_LIMIT',stderrSnapshot());
    if(result.code!==0 || pending.length!==0 || !terminal || !response)throw parserError('INVALID_PARSE_RESPONSE',stderrSnapshot());
    await spool.sync();
    await spool.close();
    spool=undefined;
    diagnostic=classifyParserStderr(stderrSnapshot().captured,stderrBytes,privatePaths);
    return {response,recordsPath,recordCount,outputBytes};
  } catch(error) {
    clearTimeout(timer);
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    try{await closed;}catch{/* retain the original parser boundary error */}
    if(spool){try{await spool.close();}catch{/* best effort */}}
    try{await rm(recordsPath,{force:true});}catch{/* best effort */}
    const failure=(error instanceof Error && error.name==='DocumentParserError')?error as DocumentParserError:parserError('DOCUMENT_PARSER_PROCESS_FAILED');
    if(failure.stderr)diagnostic=classifyParserStderr(failure.stderr.captured,failure.stderr.bytes,privatePaths);
    delete failure.stderr;
    failure.diagnostic=diagnostic;
    throw failure;
  } finally {
    options.onDiagnostic?.(diagnostic);
  }
}

export async function runDocumentParser(request:DocumentParseRequest, options:{
  pythonExecutable?:string;
  repoRoot?:string;
  timeoutMs?:number;
  maxOutputBytes?:number;
  invoke?:Invoke;
  /** Receives the redacted stderr diagnostic (or null) for every attempt, successful or not. */
  onDiagnostic?:(diagnostic:ParserStderrDiagnostic|null)=>void;
}={}):Promise<DocumentParseResponse> {
  validateRequest(request);
  const timeoutMs=options.timeoutMs??15*60_000;
  const maxOutputBytes=options.maxOutputBytes??DOCUMENT_PARSER_MAX_OUTPUT_BYTES;
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30*60_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<1024 || maxOutputBytes>256*1024*1024) throw parserError('INVALID_PARSE_RUNNER_OPTIONS');
  const serialized=JSON.stringify(request);
  const privatePaths=[request.material.authorized_local_path,resolve(request.material.authorized_local_path,'..'),options.repoRoot??process.cwd()];
  let diagnostic:ParserStderrDiagnostic|null=null;
  try {
    let output:InvokeOutput;
    try {
      output=await (options.invoke??invokePython)(serialized,{
        pythonExecutable:options.pythonExecutable??'python3',
        repoRoot:options.repoRoot??process.cwd(),
        timeoutMs,
        maxOutputBytes,
      });
    } catch(error) {
      const failure=(error instanceof Error && error.name==='DocumentParserError')?error as DocumentParserError:parserError('DOCUMENT_PARSER_PROCESS_FAILED');
      if(failure.stderr)diagnostic=classifyParserStderr(failure.stderr.captured,failure.stderr.bytes,privatePaths);
      delete failure.stderr;
      failure.diagnostic=diagnostic;
      throw failure;
    }
    const stdout=typeof output==='string'?output:output.stdout;
    if(typeof output!=='string')diagnostic=classifyParserStderr(output.stderr,output.stderrBytes,privatePaths);
    if(Buffer.byteLength(stdout,'utf8')>maxOutputBytes)throw withDiagnostic(parserError('DOCUMENT_PARSER_OUTPUT_LIMIT'),diagnostic);
    let parsed:unknown;
    try {parsed=JSON.parse(stdout);} catch {throw withDiagnostic(parserError('INVALID_PARSE_RESPONSE'),diagnostic);}
    try {return validateDocumentParseResponse(parsed,request);}
    catch(error) {throw withDiagnostic(error as DocumentParserError,diagnostic);}
  } finally {
    options.onDiagnostic?.(diagnostic);
  }
}

function withDiagnostic(error:DocumentParserError,diagnostic:ParserStderrDiagnostic|null):DocumentParserError {
  error.diagnostic=diagnostic;
  return error;
}
