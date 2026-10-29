import {projectFileSchemas,ProjectDocumentTypeSchema,PROJECT_DOCUMENT_CATALOG,type ProjectDocumentType} from './billing-types.js';
import type {Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';

type BatchBody=Static<typeof projectFileSchemas.ProjectFileBatchRequest>;
export type FileGenerationBatchRequest=Readonly<Omit<BatchBody,'documents'>>&{
  readonly documents:ReadonlyArray<Readonly<BatchBody['documents'][number]>>;
};
export type FileGenerationNoteOperation={
  readonly note:string;
  readonly documents:ReadonlyArray<{
    readonly document_type:ProjectDocumentType;
    readonly before:string;
    readonly after:string;
  }>;
};
export type FileGenerationCacheStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type FileGenerationEntryState={status:'ok';selection?:readonly ProjectDocumentType[];pending?:FileGenerationBatchRequest;note?:string;noteOperation?:FileGenerationNoteOperation}|{status:'unknown'};
type Kind='selection'|'pending'|'note'|'note-operation';
const version='file-generation-cache-v1';
// Twelve before/after pairs can contain JSON-escaped control characters.
const maxRecordLength=(kind:Kind)=>kind==='note-operation'?2000000:80000;
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validSelection(value:unknown):value is ProjectDocumentType[]{
  return Array.isArray(value)&&value.length<=PROJECT_DOCUMENT_CATALOG.length&&value.every(item=>Value.Check(ProjectDocumentTypeSchema,item))&&new Set(value).size===value.length;
}
function validPending(value:unknown):value is BatchBody{
  if(!Value.Check(projectFileSchemas.ProjectFileBatchRequest,value))return false;
  return validId(value.request_id)&&validId(value.source_version_id)&&Number.isSafeInteger(value.expected_selection_revision)&&
    value.documents.every(item=>Number.isSafeInteger(item.draft_version))&&new Set(value.documents.map(item=>item.document_type)).size===value.documents.length;
}
function validNoteOperation(value:unknown):value is FileGenerationNoteOperation{
  if(!exact(value,['note','documents'])||typeof value.note!=='string'||!value.note.trim()||value.note.length>12000||
    !Array.isArray(value.documents)||!value.documents.length||value.documents.length>PROJECT_DOCUMENT_CATALOG.length)return false;
  return value.documents.every(item=>exact(item,['document_type','before','after'])&&Value.Check(ProjectDocumentTypeSchema,item.document_type)&&
    typeof item.before==='string'&&item.before.length<=12000&&typeof item.after==='string'&&item.after.length<=12000)&&
    new Set(value.documents.map(item=>item.document_type)).size===value.documents.length;
}
function session():FileGenerationCacheStorage|undefined{
  try{return globalThis.sessionStorage;}catch{return undefined;}
}

/** A tab-local hint scoped to the API resource project, never the navigation return project. */
export class FileGenerationCache{
  private storage?:FileGenerationCacheStorage;
  private namespace?:string;
  constructor(private ownerId:string,private resourceProjectId:string,storage?:FileGenerationCacheStorage){
    if(!validId(ownerId)||!validId(resourceProjectId))return;
    this.namespace='bondbuddy:file-generation:'+encodeURIComponent(ownerId)+':'+encodeURIComponent(resourceProjectId)+':';
    this.storage=storage??session();
  }
  private read(kind:Kind):unknown{
    if(!this.namespace||!this.storage)return undefined;
    try{
      const raw=this.storage.getItem(this.namespace+kind);if(raw===null||raw.length>maxRecordLength(kind))return undefined;
      const record:unknown=JSON.parse(raw);
      if(!exact(record,['version','owner','project','value'])||record.version!==version||record.owner!==this.ownerId||record.project!==this.resourceProjectId)return undefined;
      return record.value;
    }catch{return undefined;}
  }
  private save(kind:Kind,value:unknown):boolean{
    if(!this.namespace||!this.storage)return false;
    try{const raw=JSON.stringify({version,owner:this.ownerId,project:this.resourceProjectId,value});if(raw.length>maxRecordLength(kind))return false;this.storage.setItem(this.namespace+kind,raw);return true;}catch{return false;}
  }
  private clear(kind:Kind):boolean{
    if(!this.namespace||!this.storage)return false;
    try{this.storage.removeItem(this.namespace+kind);return true;}catch{return false;}
  }
  /** Entry decisions must distinguish an absent record from an unreadable original operation. */
  readForEntry():FileGenerationEntryState{
    if(!this.namespace||!this.storage)return {status:'unknown'};
    try{
      const values:Partial<Record<Kind,unknown>>={};
      for(const kind of ['selection','pending','note','note-operation'] as const){
        const raw=this.storage.getItem(this.namespace+kind);if(raw===null)continue;
        if(raw.length>maxRecordLength(kind))return {status:'unknown'};
        const record:unknown=JSON.parse(raw);
        if(!exact(record,['version','owner','project','value'])||record.version!==version||record.owner!==this.ownerId||record.project!==this.resourceProjectId)return {status:'unknown'};
        const value=record.value,valid=kind==='selection'?validSelection(value):kind==='pending'?validPending(value):kind==='note'?typeof value==='string'&&value.length<=12000:validNoteOperation(value);
        if(!valid)return {status:'unknown'};values[kind]=value;
      }
      const pending=values.pending as BatchBody|undefined,operation=values['note-operation'] as FileGenerationNoteOperation|undefined;
      return {status:'ok',selection:values.selection===undefined?undefined:Object.freeze([...(values.selection as ProjectDocumentType[])]),
        pending:pending?Object.freeze({...pending,documents:Object.freeze(pending.documents.map(item=>Object.freeze({...item})))}):undefined,
        note:values.note as string|undefined,noteOperation:operation?Object.freeze({note:operation.note,documents:Object.freeze(operation.documents.map(item=>Object.freeze({...item})))}):undefined};
    }catch{return {status:'unknown'};}
  }
  readSelection():readonly ProjectDocumentType[]|undefined{
    const selection=this.read('selection');return validSelection(selection)?Object.freeze([...selection]):undefined;
  }
  saveSelection(selection:readonly ProjectDocumentType[]):boolean{return validSelection(selection)&&this.save('selection',[...selection]);}
  clearSelection():boolean{return this.clear('selection');}
  readPending():FileGenerationBatchRequest|undefined{
    const pending=this.read('pending');
    if(!validPending(pending))return undefined;
    return Object.freeze({...pending,documents:Object.freeze(pending.documents.map(item=>Object.freeze({...item})))});
  }
  savePending(pending:FileGenerationBatchRequest):boolean{return validPending(pending)&&this.save('pending',pending);}
  clearPending():boolean{return this.clear('pending');}
  readNote():string|undefined{const note=this.read('note');return typeof note==='string'&&note.length<=12000?note:undefined;}
  saveNote(note:string):boolean{return typeof note==='string'&&note.length<=12000&&this.save('note',note);}
  clearNote():boolean{return this.clear('note');}
  readNoteOperation():FileGenerationNoteOperation|undefined{
    const operation=this.read('note-operation');if(!validNoteOperation(operation))return undefined;
    return Object.freeze({note:operation.note,documents:Object.freeze(operation.documents.map(item=>Object.freeze({...item})))});
  }
  saveNoteOperation(operation:FileGenerationNoteOperation):boolean{return validNoteOperation(operation)&&this.save('note-operation',operation);}
  clearNoteOperation():boolean{return this.clear('note-operation');}
}
