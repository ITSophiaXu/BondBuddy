import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstatSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const VERSION='release-artifact-structure-v1';
const WORD='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const OFFICE_REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL='http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES='http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const RELS_TYPE='application/vnd.openxmlformats-package.relationships+xml';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
const xmlPart=name=>/\.(?:xml|rels)$/i.test(name);
const hashPattern=/^[a-f0-9]{64}$/;

/** Use the installed, fixed application ZIP reader. The streaming=true switch
 * already exists for large templates: 32 MiB/part, 64 MiB total XML, 128 MiB
 * total expansion, 64 MiB archive, 2048 entries and 200:1 ratio. No limit changes.
 */
export async function loadInspectorDependencies(apiRoot='/app'){
 const root=resolve(apiRoot),require=createRequire(resolve(root,'package.json'));
 const {readBoundedZipParts}=await import(pathToFileURL(resolve(root,'apps/api/dist/docx-inspector.js')).href);
 const {SaxesParser}=require('saxes');
 return {readBoundedZipParts,SaxesParser};
}

function partName(value){
 let name;try{name=decodeURIComponent(value);}catch{fail('DOCX_PART_NAME_INVALID');}
 if(!name||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||/[\u0000-\u001f\u007f]/.test(name)||/%(?:2f|5c)/i.test(value)||
  name.split('/').some(part=>!part||part==='.'||part==='..'))fail('DOCX_PART_NAME_INVALID');
 return name;
}
function sourceFor(name){
 if(name==='_rels/.rels')return null;
 const match=/^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
 if(!match)fail('DOCX_RELATIONSHIP_PART_INVALID');
 return (match[1]??'')+match[2];
}
function relationshipPartFor(source){
 const i=source.lastIndexOf('/');return source.slice(0,i+1)+'_rels/'+source.slice(i+1)+'.rels';
}
function internalTarget(value,source){
 if(!value||value.includes('\\')||/%(?:2f|5c)/i.test(value)||/[?#]/.test(value))fail('DOCX_RELATIONSHIP_TARGET_INVALID');
 let decoded;try{decoded=decodeURIComponent(value);}catch{fail('DOCX_RELATIONSHIP_TARGET_INVALID');}
 if(decoded.includes('\\')||/[\u0000-\u001f\u007f]/.test(decoded))fail('DOCX_RELATIONSHIP_TARGET_INVALID');
 const absolute=decoded.startsWith('/'),relative=absolute?decoded.slice(1):decoded;
 if(!relative||relative.split('/').some(p=>!p))fail('DOCX_RELATIONSHIP_TARGET_INVALID');
 const stack=absolute||!source?[]:source.split('/').slice(0,-1);
 for(const part of relative.split('/')){
  if(part==='.')continue;
  if(part==='..'){if(!stack.length)fail('DOCX_RELATIONSHIP_TARGET_INVALID');stack.pop();}
  else stack.push(part);
 }
 if(!stack.length)fail('DOCX_RELATIONSHIP_TARGET_INVALID');
 return stack.join('/');
}

function scanXml(name,raw,SaxesParser){
 const parser=new SaxesParser({xmlns:true}),metadata={root:null,children:[],references:new Set(),bodyCount:0,bodyBlocks:0,bodyCharacters:0};
 const catalog=name==='[Content_Types].xml'||name.endsWith('.rels');
 let depth=0,bodyDepth=0,textDepth=0,deletedDepth=0;
 parser.on('doctype',()=>fail('DOCX_XML_DTD_FORBIDDEN'));
 parser.on('error',()=>fail('DOCX_XML_MALFORMED'));
 parser.on('opentag',tag=>{
  depth++;
  if(depth===1)metadata.root={local:tag.local,uri:tag.uri};
  if(catalog&&depth>2)fail('DOCX_XML_STRUCTURE_INVALID');
  if(catalog&&depth===2){
   const attrs={};for(const attr of Object.values(tag.attributes))if(!attr.uri)attrs[attr.local]=attr.value;
   metadata.children.push({local:tag.local,uri:tag.uri,attrs});
  }
  for(const attr of Object.values(tag.attributes))if(attr.uri===OFFICE_REL&&['id','embed','link'].includes(attr.local))metadata.references.add(attr.value);
  if(name==='word/document.xml'){
   if(depth===2&&tag.local==='body'){
    if(tag.uri!==WORD)fail('DOCX_WORD_DOCUMENT_INVALID');
    metadata.bodyCount++;bodyDepth=depth;
   }
   if(bodyDepth&&depth===bodyDepth+1&&tag.uri===WORD&&['p','tbl'].includes(tag.local))metadata.bodyBlocks++;
   if(bodyDepth&&tag.uri===WORD){
    if(!deletedDepth&&['del','moveFrom'].includes(tag.local))deletedDepth=depth;
    if(tag.local==='t')textDepth=depth;
   }
  }
 });
 const text=value=>{
  if(catalog&&value.trim())fail('DOCX_XML_STRUCTURE_INVALID');
  if(bodyDepth&&textDepth&&!deletedDepth)metadata.bodyCharacters+=value.replace(/\s/gu,'').length;
 };
 parser.on('text',text);parser.on('cdata',text);
 parser.on('closetag',()=>{
  if(textDepth===depth)textDepth=0;if(deletedDepth===depth)deletedDepth=0;if(bodyDepth===depth)bodyDepth=0;depth--;
 });
 let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('DOCX_XML_ENCODING_INVALID');}
 for(let offset=0;offset<xml.length;offset+=65536)parser.write(xml.slice(offset,offset+65536));
 parser.close();
 if(!metadata.root)fail('DOCX_XML_MALFORMED');
 return metadata;
}

/** Complete XML, content-type and relationship traversal without a document DOM.
 * Caller must provide ALL ordinary parts from the bounded CRC-validating reader.
 */
export function inspectDocxParts(parts,{SaxesParser}){
 if(!(parts instanceof Map))fail('DOCX_PARTS_INVALID');
 for(const name of ['[Content_Types].xml','_rels/.rels','word/document.xml'])if(!parts.has(name))fail('DOCX_REQUIRED_PART_MISSING');
 const xml=new Map();for(const [name,bytes] of parts)if(xmlPart(name))xml.set(name,scanXml(name,bytes,SaxesParser));
 const types=xml.get('[Content_Types].xml'),defaults=new Map(),overrides=new Map();
 if(types.root.local!=='Types'||types.root.uri!==TYPES)fail('DOCX_CONTENT_TYPES_INVALID');
 for(const child of types.children){
  const {attrs,local,uri}=child,type=attrs.ContentType;
  if(uri!==TYPES||!['Default','Override'].includes(local)||!type)fail('DOCX_CONTENT_TYPES_INVALID');
  if(/macroEnabled|vbaProject/i.test(type))fail('DOCX_MACROS_FORBIDDEN');
  if(local==='Default'){
   const extension=attrs.Extension?.toLowerCase();
   if(!extension||!/^[a-z0-9]+$/.test(extension)||defaults.has(extension))fail('DOCX_CONTENT_TYPES_INVALID');
   defaults.set(extension,type);
  }else{
   if(!attrs.PartName?.startsWith('/'))fail('DOCX_CONTENT_TYPES_INVALID');
   const name=partName(attrs.PartName.slice(1)).toLowerCase();
   if(overrides.has(name))fail('DOCX_CONTENT_TYPES_INVALID');overrides.set(name,type);
  }
 }
 if(defaults.get('rels')!==RELS_TYPE||overrides.get('word/document.xml')!==MAIN_TYPE)fail('DOCX_REQUIRED_CONTENT_TYPE_MISSING');
 const folded=new Set([...parts.keys()].map(name=>name.toLowerCase()));
 for(const name of overrides.keys())if(!folded.has(name))fail('DOCX_CONTENT_TYPE_TARGET_MISSING');
 for(const name of parts.keys()){
  if(name==='[Content_Types].xml')continue;
  const type=overrides.get(name.toLowerCase())??defaults.get(name.split('/').at(-1).split('.').at(-1).toLowerCase());
  if(!type)fail('DOCX_PART_CONTENT_TYPE_MISSING');
  if(/macroEnabled|vbaProject/i.test(type)||/(?:^|\/)vbaproject\.bin$/i.test(name))fail('DOCX_MACROS_FORBIDDEN');
  if(name.endsWith('.rels')&&type!==RELS_TYPE)fail('DOCX_CONTENT_TYPES_INVALID');
 }
 const relationships=new Map();let relationshipCount=0;
 for(const [name,document] of xml){
  if(!name.endsWith('.rels'))continue;
  if(document.root.local!=='Relationships'||document.root.uri!==PACKAGE_REL)fail('DOCX_RELATIONSHIPS_INVALID');
  const source=sourceFor(name);if(source&&!parts.has(source))fail('DOCX_RELATIONSHIP_SOURCE_MISSING');
  const rels=new Map();
  for(const {local,uri,attrs} of document.children){
   const id=attrs.Id,type=attrs.Type,target=attrs.Target,mode=attrs.TargetMode;
   if(local!=='Relationship'||uri!==PACKAGE_REL||!id||!/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(id)||rels.has(id)||!/^https?:\/\//.test(type??'')||!target||
    (mode!==undefined&&!['Internal','External'].includes(mode)))fail('DOCX_RELATIONSHIPS_INVALID');
   const external=mode==='External';let resolved;
   if(external){
    if(!type.endsWith('/hyperlink'))fail('DOCX_EXTERNAL_RELATIONSHIP_FORBIDDEN');
    let url;try{url=new URL(target);}catch{fail('DOCX_RELATIONSHIP_TARGET_INVALID');}
    if(!['http:','https:','mailto:'].includes(url.protocol)||url.username||url.password||target.length>2048)fail('DOCX_RELATIONSHIP_TARGET_INVALID');
   }else{resolved=internalTarget(target,source);if(!parts.has(resolved))fail('DOCX_RELATIONSHIP_TARGET_MISSING');}
   rels.set(id,{type,external,resolved});relationshipCount++;
  }
  relationships.set(name,rels);
 }
 const roots=[...relationships.get('_rels/.rels').values()].filter(rel=>rel.type.endsWith('/officeDocument')&&!rel.external);
 if(roots.length!==1||roots[0].resolved!=='word/document.xml')fail('DOCX_OFFICE_DOCUMENT_RELATIONSHIP_INVALID');
 for(const [name,document] of xml){
  if(name==='[Content_Types].xml'||name.endsWith('.rels'))continue;
  const rels=relationships.get(relationshipPartFor(name));
  for(const id of document.references)if(!rels?.has(id))fail('DOCX_RELATIONSHIP_REFERENCE_MISSING');
 }
 const body=xml.get('word/document.xml');
 if(body.root.local!=='document'||body.root.uri!==WORD||body.bodyCount!==1)fail('DOCX_WORD_DOCUMENT_INVALID');
 if(!body.bodyBlocks||!body.bodyCharacters)fail('DOCX_WORD_DOCUMENT_EMPTY');
 return {status:'passed',failureCodes:[],checks:{zip_structure:'passed',entry_integrity:'passed',xml_well_formedness:'passed',ooxml_relationships:'passed',word_document:'passed'},
  fileParts:parts.size,xmlParts:xml.size,relationshipCount,bodyCharacters:body.bodyCharacters};
}

function expectedMapping(expected){
 if(!Array.isArray(expected)||expected.length!==5)fail('WORKPAPER_EXPECTED_FIVE_REQUIRED');
 const ids=new Set(),paths=new Set(),folders=new Set();
 for(const item of expected){
  if(!item||typeof item.entryId!=='string'||!item.entryId||ids.has(item.entryId)||typeof item.cataloguePath!=='string'||!item.cataloguePath||!hashPattern.test(item.sha256??''))fail('WORKPAPER_MAPPING_INVALID');
  ids.add(item.entryId);
  const folder=item.disposition==='generated'?'可生成文件':item.disposition==='explanation'?'不适用说明':null;
  if(!folder||item.disposition==='generated'&&item.decisionStatus!=='generate'||item.disposition==='explanation'&&!['not_applicable','missing_information','external_evidence'].includes(item.decisionStatus))fail('WORKPAPER_MAPPING_INVALID');
  const name=partName(item.archivePath??'');
  if(name!==item.archivePath||!name.startsWith(folder+'/')||!name.endsWith('.docx')||paths.has(name)||name.split('/').some(p=>/[<>:"|?*]/.test(p)||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('WORKPAPER_PATH_INVALID');
  paths.add(name);folders.add(folder);
 }
 if(folders.size!==2)fail('WORKPAPER_TWO_FOLDERS_REQUIRED');
 return new Map(expected.map(item=>[item.archivePath,item]));
}

export function inspectArtifactBytes(bytes,request,deps){
 const result={schema:VERSION,kind:request.kind,sha256:sha256(bytes),bytes:bytes.length,status:'failed',failureCodes:[],
  validator:'installed-bounded-zip-and-streaming-ooxml-v1',xmlMode:'streaming_existing_limits',contentReview:'not_claimed',visualReview:'not_claimed'};
 try{
  if(!hashPattern.test(request.expectedSha256??'')||result.sha256!==request.expectedSha256||result.bytes!==request.expectedBytes)fail('ARTIFACT_HASH_MISMATCH');
  if(!['docx','workpaper_zip'].includes(request.kind))fail('ARTIFACT_KIND_INVALID');
  const parts=deps.readBoundedZipParts(bytes,()=>true,true);
  if(request.kind==='docx')Object.assign(result,inspectDocxParts(parts,deps));
  else{
   const mapping=expectedMapping(request.expectedWorkpapers);
   result.regularFiles=parts.size;result.members=[];
   if(parts.size!==5||[...parts.keys()].some(name=>!mapping.has(name)))fail('WORKPAPER_FILE_SET_MISMATCH');
   for(const [name,content] of parts){
    const item=mapping.get(name),digest=sha256(content);
    if(digest!==item.sha256)fail('WORKPAPER_MEMBER_HASH_MISMATCH');
    const inspection=inspectDocxParts(deps.readBoundedZipParts(content,()=>true,true),deps);
    result.members.push({archivePath:name,entryId:item.entryId,disposition:item.disposition,decisionStatus:item.decisionStatus,sha256:digest,bytes:content.length,inspection});
   }
   result.checks={zip_structure:'passed',entry_integrity:'passed',mapping:'passed',all_docx:'passed'};result.status='passed';
  }
 }catch(error){const code=error?.code??error?.message;result.failureCodes=[typeof code==='string'&&/^[A-Z][A-Z0-9_]+$/.test(code)?code:'ARTIFACT_INSPECTION_FAILED'];}
 return result;
}

// Metadata arrives on stdin; the sole input file is mounted read-only by run.mjs.
// This CLI does not extract files, start services or invoke models/renderers.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),fileIndex=args.indexOf('--file'),rootIndex=args.indexOf('--api-root');
  if(fileIndex<0||!args[fileIndex+1])fail('ARTIFACT_INPUT_REQUIRED');
  const raw=readFileSync(0);if(raw.length>65536)fail('ARTIFACT_REQUEST_TOO_LARGE');
  const request=JSON.parse(raw.toString('utf8')),path=args[fileIndex+1],stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>64*1024*1024)fail('ARTIFACT_FILE_INVALID');
  const deps=await loadInspectorDependencies(rootIndex<0?'/app':args[rootIndex+1]);
  const result=inspectArtifactBytes(readFileSync(path),request,deps);
  process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='passed'?0:1;
 }catch(error){
  const code=error?.code??error?.message;
  process.stdout.write(JSON.stringify({schema:VERSION,status:'failed',failureCodes:[typeof code==='string'&&/^[A-Z][A-Z0-9_]+$/.test(code)?code:'ARTIFACT_INSPECTION_FAILED']})+'\n');process.exitCode=1;
 }
}
