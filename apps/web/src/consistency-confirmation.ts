import {Type} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {schemas,ProjectFileCheckSchema,ProjectFileSourceSchema,ProjectFileVersionSchema,ProjectFileAssetSchema,
  ProjectDocumentTypeSchema,type ProjectFileCheck,type ProjectFileSource,type ProjectFileVersion,type ProjectFileAsset} from '@bondbuddy/contracts';
import type {Dto} from './api.js';

export type ConfirmationBinding={owner?:string;project:string;checkId:string;body:Dto<'ProjectFileUpdateRequest'>;filenames:string[]};
export type ConfirmationSnapshot={version:1;binding:ConfirmationBinding;projectName:string;createdAt:string;source:ProjectFileSource;
  files:Array<{fileId:string;versionId:string;filename:string;sequence:number;documentType:ProjectFileVersion['document_type']|null;
    asset:ProjectFileAsset|null;automatic:number;manual:number;manualUnlisted:boolean}>};

const obj=<T extends Parameters<typeof Type.Object>[0]>(properties:T)=>Type.Object(properties,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const filename=Type.String({maxLength:200});
const count=Type.Integer({minimum:0,maximum:2000});
const sequence=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER});
const bindingSchema=obj({owner:Type.Optional(id),project:id,checkId:id,body:schemas.ProjectFileUpdateRequest,
  filenames:Type.Array(filename,{minItems:1,maxItems:200})});
const snapshotSchema=obj({version:Type.Literal(1),binding:bindingSchema,projectName:Type.String({maxLength:200}),
  createdAt:Type.String({minLength:24,maxLength:24}),source:ProjectFileSourceSchema,
  files:Type.Array(obj({fileId:id,versionId:id,filename,sequence,
    documentType:Type.Union([ProjectDocumentTypeSchema,Type.Literal('workpaper'),Type.Null()]),asset:Type.Union([ProjectFileAssetSchema,Type.Null()]),
    automatic:count,manual:count,manualUnlisted:Type.Boolean()}),{minItems:1,maxItems:200})});
const validId=(value:string)=>!!value.trim()&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
function validBinding(value:unknown):value is ConfirmationBinding{
  if(!Value.Check(bindingSchema,value))return false;
  const binding=value as ConfirmationBinding;
  return [binding.project,binding.checkId,binding.body.request_id,...binding.body.files.map(file=>file.file_version_id),
    ...(binding.owner===undefined?[]:[binding.owner])].every(validId)&&binding.filenames.length===binding.body.files.length&&
    new Set(binding.body.files.map(file=>file.file_version_id)).size===binding.body.files.length;
}
function sameBinding(a:ConfirmationBinding,b:ConfirmationBinding){
  return a.owner===b.owner&&a.project===b.project&&a.checkId===b.checkId&&
    a.body.request_id===b.body.request_id&&a.body.expected_check_sha256===b.body.expected_check_sha256&&
    a.body.price_version===b.body.price_version&&a.body.expected_points===b.body.expected_points&&
    a.body.files.length===b.body.files.length&&a.body.files.every((file,index)=>file.file_version_id===b.body.files[index].file_version_id&&file.scope_quote_id===b.body.files[index].scope_quote_id&&a.filenames[index]===b.filenames[index]);
}
function validAsset(asset:ProjectFileAsset){
  const pin=asset.pin,version=asset.kind==='material'?asset.pin.material_version:asset.pin.artifact_version;
  return Value.Check(ProjectFileAssetSchema,asset)&&validId(pin.source_project_id)&&
    validId(asset.kind==='material'?asset.pin.material_id:asset.pin.artifact_id)&&Number.isSafeInteger(version);
}
function validSource(source:ProjectFileSource){
  // A retained update workspace can legitimately own the source of another project.
  return Value.Check(ProjectFileSourceSchema,source)&&validId(source.project_id)&&validId(source.version_id)&&
    Number.isSafeInteger(source.sequence)&&Number.isSafeInteger(source.selection_revision)&&validAsset(source.asset)&&
    source.project_id===source.asset.pin.source_project_id;
}
function cloneBinding(binding:ConfirmationBinding):ConfirmationBinding{
  return {...(binding.owner===undefined?{}:{owner:binding.owner}),project:binding.project,checkId:binding.checkId,
    body:{request_id:binding.body.request_id,expected_check_sha256:binding.body.expected_check_sha256,
      price_version:binding.body.price_version,expected_points:binding.body.expected_points,
      files:binding.body.files.map(file=>({file_version_id:file.file_version_id,...(file.scope_quote_id?{scope_quote_id:file.scope_quote_id}:{})}))},filenames:[...binding.filenames]};
}
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
function copySnapshot(snapshot:ConfirmationSnapshot):ConfirmationSnapshot{
  // Only the bounded metadata is copied; findings, coverage and full registry rows stay out.
  return freeze({version:1,binding:cloneBinding(snapshot.binding),projectName:snapshot.projectName,createdAt:snapshot.createdAt,
    source:structuredClone(snapshot.source),files:snapshot.files.map(file=>({...file,asset:file.asset?structuredClone(file.asset):null}))});
}

/** A display record for one exact request, never an execution authority or a live projection. */
export function restoreConfirmationSnapshot(value:unknown,binding:ConfirmationBinding):ConfirmationSnapshot|undefined{
  try{
    if(!validBinding(binding)||!Value.Check(snapshotSchema,value))return;
    const snapshot=value as ConfirmationSnapshot;
    if(!validBinding(snapshot.binding)||!sameBinding(snapshot.binding,binding)||!validSource(snapshot.source)||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.createdAt)||
      new Date(snapshot.createdAt).toISOString()!==snapshot.createdAt||snapshot.files.length!==binding.body.files.length||
      new Set(snapshot.files.map(file=>file.fileId)).size!==snapshot.files.length)return;
    if(snapshot.files.some((file,index)=>!validId(file.fileId)||file.versionId!==binding.body.files[index].file_version_id||
      file.filename!==binding.filenames[index]||(file.documentType===null)!==(file.asset===null)||
      !!file.asset&&!validAsset(file.asset)||file.automatic+file.manual>2000||file.manualUnlisted&&file.manual!==0))return;
    return copySnapshot(snapshot);
  }catch{return undefined;}
}

/** Freeze counts supplied by the original selection; accepted updates must not recalculate them. */
export function createConfirmationSnapshot(binding:ConfirmationBinding,check:ProjectFileCheck,registry:ProjectFileVersion[],
  automaticCounts:number[],projectName:string):ConfirmationSnapshot|undefined{
  try{
    if(!validBinding(binding)||!Value.Check(ProjectFileCheckSchema,check)||!check.result||check.files.length>200||
      check.run_id!==binding.checkId||check.sha256!==binding.body.expected_check_sha256||!validSource(check.source)||
      !Array.isArray(registry)||!Array.isArray(automaticCounts)||automaticCounts.length!==binding.body.files.length)return;
    const files:ConfirmationSnapshot['files']=[];
    for(const [index,requested] of binding.body.files.entries()){
      const checked=check.files.filter(file=>file.file_version_id===requested.file_version_id),
        results=check.result.files.filter(file=>file.file_version_id===requested.file_version_id);
      if(checked.length!==1||results.length!==1||checked[0].filename!==binding.filenames[index])return;
      const file=checked[0],result=results[0],automatic=automaticCounts[index],
        manual=result.findings.filter(finding=>finding.kind==='manual'||finding.replacement===null).length,
        available=result.findings.filter(finding=>finding.kind==='conflict'&&finding.replacement!==null).length;
      if(!Number.isSafeInteger(automatic)||automatic<0||automatic>available)return;
      const matches=registry.filter(version=>version.version_id===file.file_version_id),version=matches[0],
        exact=matches.length===1&&Value.Check(ProjectFileVersionSchema,version)&&version.file_id===file.file_id&&
          version.sequence===file.sequence&&version.filename===file.filename&&validAsset(version.asset);
      files.push({fileId:file.file_id,versionId:file.file_version_id,filename:file.filename,sequence:file.sequence,
        documentType:exact?version.document_type:null,asset:exact?version.asset:null,automatic,manual,
        manualUnlisted:result.status==='manual'&&manual===0});
    }
    return restoreConfirmationSnapshot({version:1,binding:cloneBinding(binding),projectName,createdAt:new Date().toISOString(),source:check.source,files},binding);
  }catch{return undefined;}
}
