import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {M4KnowledgeSnapshotSchema,type M4KnowledgeSnapshot,type M4DocumentType} from '@bondbuddy/contracts';

const root=resolve(fileURLToPath(import.meta.url),'../../../..');
const sha=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
/** Only the API selects bundled knowledge. Snapshot bytes are retained for old runs. */
export function loadM4Knowledge(market:'sse'|'szse',type:M4DocumentType):M4KnowledgeSnapshot {
  const catalog=JSON.parse(readFileSync(resolve(root,'knowledge/material-drafting/2026-10-07/catalog.json'),'utf8')) as
    {packs:(Omit<M4KnowledgeSnapshot,'content'> & {path:string})[]};
  const pin=catalog.packs.find(p=>p.market===market&&p.document_type===type);
  if(!pin || pin.path!==`knowledge/material-drafting/2026-10-07/packs/${market}-${type}.md`)throw Error('M4_KNOWLEDGE_UNAVAILABLE');
  const {path,...metadata}=pin,content=readFileSync(resolve(root,path),'utf8'),snapshot={...metadata,content};
  if(!validM4Knowledge(snapshot,market,type))throw Error('M4_KNOWLEDGE_CHANGED');
  return snapshot;
}
export function validM4Knowledge(value:unknown,market:string,type:M4DocumentType):value is M4KnowledgeSnapshot {
  return Value.Check(M4KnowledgeSnapshotSchema,value)&&value.market===market&&value.document_type===type
    && sha(value.content)===value.sha256;
}
