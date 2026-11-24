import {Type} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {QaAnswerSchema,type QaAnswer,type QaResult} from '@bondbuddy/contracts';
import {QA_REPLY_POLICY,qaReplyIssues,qaReplyFeedback} from './project-qa-reply.js';

export const QA_REFERENCE_PROTOCOL='project-qa-evidence-refs-v2';
const LEGACY_REFERENCE_PROTOCOL='project-qa-evidence-refs-v1';
const {citations,...answerProperties}=QaAnswerSchema.properties;
/** Internal model wire format. Persisted answers still use the public citation contract. */
export const QaModelAnswerSchema=Type.Object({...answerProperties,evidence_refs:Type.Array(Type.String({minLength:1,maxLength:80}),{maxItems:200,uniqueItems:true})},{additionalProperties:false});

export function qaEvidenceParts(asset:number,index:number,text:string){
 const parts:{ref:string;quote:string}[]=[];
 for(let start=0;start<text.length;){
  let end=Math.min(start+4000,text.length);
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
  parts.push({ref:`a${asset}s${index}c${start}`,quote:text.slice(start,end)});start=end;
 }
 return parts.length?parts:[{ref:`a${asset}s${index}c0`,quote:''}];
}

/** Select the wire protocol from the *saved* prompt, not today's template version.
 * Verify its reference catalogue against the bound immutable evidence before calling a model.
 * This keeps pre-upgrade prompts/replays on their original exact-quotation protocol. */
export function qaAnswerOutput(prompt:string,evidence:QaResult['evidence']){
 const referencesV2=prompt.startsWith(QA_REFERENCE_PROTOCOL+'\n');
 if(!referencesV2&&!prompt.startsWith(LEGACY_REFERENCE_PROTOCOL+'\n'))return {schema:QaAnswerSchema,
  validationFeedback:()=> 'Check question_id and every citations entry against the supplied material. Quotes must be verbatim; copy the exact span_id, including for repeated numbers. Return the complete answer JSON.'};
 const block=/\n<<BB-DATA-([a-f0-9]{24}) ref=project-qa-input\n([\s\S]*)\nBB-DATA-\1>>$/.exec(prompt);
 if(!block)throw Error('INPUT_REVISION_CONFLICT');
 const data:unknown=JSON.parse(block[2]);
 const replyPolicy=prompt.startsWith(QA_REFERENCE_PROTOCOL+'\n'+QA_REPLY_POLICY+'\n');
 const question=replyPolicy&&data&&typeof data==='object'&&'question' in data?data.question:null;
 if(replyPolicy&&(!question||typeof question!=='object'||!('question' in question)||typeof question.question!=='string'))throw Error('INPUT_REVISION_CONFLICT');
 const questionText=question&&typeof question==='object'&&'question' in question?String(question.question):'';
 const replyIssues=(value:typeof QaModelAnswerSchema.static)=>replyPolicy?qaReplyIssues(value,questionText):[];
 const known=new Map<string,{location:string;citation:QaAnswer['citations'][number]}>();
 evidence.forEach((asset,asset_index)=>asset.snapshot.spans.forEach((span,index)=>{
  for(const part of qaEvidenceParts(asset_index,index,span.text))known.set(part.ref,{location:span.location,citation:{asset_index,span_id:span.id,quote:part.quote}});
 }));
 const selected=new Map<string,QaAnswer['citations'][number]>(),seen=new Set<string>();
 const blankLocations=new Set([...known.values()].filter(item=>!item.citation.quote.trim()).map(item=>JSON.stringify([item.citation.asset_index,item.location,item.citation.quote])));
 if(!data||typeof data!=='object'||!('materials' in data)||!Array.isArray(data.materials))throw Error('INPUT_REVISION_CONFLICT');
 for(const material of data.materials){
  if(!material||!Number.isInteger(material.asset_index)||!Array.isArray(material.spans))throw Error('INPUT_REVISION_CONFLICT');
  for(const tuple of material.spans){
   if(!Array.isArray(tuple)||tuple.length!==3)throw Error('INPUT_REVISION_CONFLICT');
   const [ref,location,text]=tuple;
   // Blank structure remains visible for table/period interpretation, but has no
   // selectable source ID. Validate the placeholder against the immutable source.
   if(referencesV2&&ref===null){
    const key=JSON.stringify([material.asset_index,location,text]);
    if(typeof text!=='string'||text.trim()||!blankLocations.has(key)||seen.has(key))throw Error('INPUT_REVISION_CONFLICT');
    seen.add(key);continue;
   }
   const item=known.get(ref);
   if(!item||seen.has(ref)||item.citation.asset_index!==material.asset_index||item.location!==location||item.citation.quote!==text)throw Error('INPUT_REVISION_CONFLICT');
   seen.add(ref);if(text.trim())selected.set(ref,item.citation);
  }
 }
 const blank=(ref:string)=>known.has(ref)&&!known.get(ref)!.citation.quote.trim();
 // A model can return the extracted span ID without the chunk suffix. Resolve it
 // only when the immutable source contains exactly one nonblank chunk and that
 // chunk was selected in the frozen prompt.
 // A split span remains ambiguous and must be answered again with an exact ID.
 const spanChunks=new Map<string,string[]>();
 for(const [ref,item] of known){
  if(!item.citation.quote.trim())continue;
  const span=ref.replace(/c\d+$/,'');
  const chunks=spanChunks.get(span)??[];chunks.push(ref);spanChunks.set(span,chunks);
 }
 const resolveReference=(ref:string)=>{
  if(selected.has(ref)||blank(ref))return ref;
  const chunks=spanChunks.get(ref);
  return chunks?.length===1&&selected.has(chunks[0])?chunks[0]:null;
 };
 const resolvedReferences=(refs:string[])=>refs.map(resolveReference);
 const invalidReferences=(refs:string[])=>{
  const resolved=resolvedReferences(refs),seenRefs=new Set<string>();
  return resolved.flatMap((ref,i)=>{
   if(ref===null||seenRefs.has(ref))return [i];
   seenRefs.add(ref);return [];
  });
 };
 return {schema:QaModelAnswerSchema,
  normalize:(value:unknown):unknown=>{
   if(!Value.Check(QaModelAnswerSchema,value)||invalidReferences(value.evidence_refs).length||replyIssues(value).length)return null;
   const {evidence_refs,...answer}=value;
   // Empty source positions contribute no evidence. Drop only exact, known
   // blanks; unknown IDs and omitted nonblank text still fail closed. Never
   // turn a blank-only factual answer into an apparently grounded answer.
   const valid=resolvedReferences(evidence_refs).filter((ref):ref is string=>ref!==null&&selected.has(ref));
   if(evidence_refs.length&&!valid.length)return null;
   return {...answer,citations:valid.map(ref=>({...selected.get(ref)!}))};
  },
  validationFeedback:(value:unknown)=>{
   if(!Value.Check(QaModelAnswerSchema,value))return 'The output must match the answer schema, including an evidence_refs array of at most 200 distinct source IDs. Return the complete JSON, without citations or copied quotations.';
   const invalid=invalidReferences(value.evidence_refs).slice(0,12);
   // Only host-generated positions/codes enter trusted retry instructions, never source/model text.
   if(invalid.length)return `Unknown or blank evidence reference at evidence_refs indexes ${invalid.join(', ')}. Copy IDs only from the first tuple element in the supplied materials. Do not invent IDs or infer them from paragraph numbers. Return the complete JSON.`;
   const issues=replyIssues(value);if(issues.length)return qaReplyFeedback(issues);
   return 'Check question_id and include nonblank supporting evidence_refs for the factual answer. Null table placeholders and empty paragraphs cannot support an answer. An unanswered item must have status missing and specific missing_materials. Return the complete JSON.';
  }};
}
