import {createHash} from 'node:crypto';

const limits={maxItems:64,maxItemCharacters:12000,maxTotalCharacters:48000,maxFindings:24} as const;
const internalDetails=[
  ['internal_file', /\b(?:input\.json|operations?\.json|template-manifest\.json|format-report\.json|delivery\.md|task\.md|fixed-edit\.md|read_material\.py|word_patch\.py)\b|工作记录\.md/i],
  ['internal_path', /\b(?:scratch|output|materials|knowledge)[\\/]|\b[A-Z]:[\\/]|\/(?:opt|tmp|home|workspace|workspaces)\//i],
  ['internal_identifier', /\b(?:input_hash|node_id|run_id|call_id|sha[-_]?256|hash|format_tools)\b|哈希|散列值|(?<![a-z0-9])[a-f0-9]{64}(?![a-z0-9])/i],
  ['tool_command', /\b(?:apply|inspect|no_changes|replace_text|replace_cell_text|insert_row|insert_column|insert_paragraph|add_comment|bondbuddy_file_authoring(?:\.[a-z_]+)?|fixed_edit)\b|\b(?:python3?|node)\s+(?:-[a-z][\w-]*\s+)+/i],
  ['tool_capability_code', /\bWORD_(?:EDIT|FORMAT|REVISION)_[A-Z0-9_*]+\b/i],
] as const;

export interface RealSampleDeliveryNotesCheck {
  schema:'real-sample-user-delivery-notes-check-v1';
  status:'passed'|'failed';
  scope:'bounded-internal-execution-details-only';
  businessCompleteness:'manual_review_required';
  factualAccuracy:'manual_review_required';
  rawSummaryIncluded:false;
  summaryItems:number|null;
  inspectedCharacters:number;
  summarySha256:string|null;
  limits:typeof limits;
  findings:{code:string;itemIndex:number|null;offset:number|null}[];
  findingsTruncated:boolean;
}

/** Detect, never redact. Reports contain no matched text, customer facts, URLs or credentials. */
export function checkRealSampleDeliveryNotes(value:unknown):RealSampleDeliveryNotesCheck {
  const result:RealSampleDeliveryNotesCheck={schema:'real-sample-user-delivery-notes-check-v1',status:'failed',
    scope:'bounded-internal-execution-details-only',businessCompleteness:'manual_review_required',
    factualAccuracy:'manual_review_required',rawSummaryIncluded:false,summaryItems:Array.isArray(value)?value.length:null,
    inspectedCharacters:0,summarySha256:null,limits,findings:[],findingsTruncated:false};
  const reject=(code:string)=>{result.findings.push({code,itemIndex:null,offset:null});return result;};
  if(value===undefined||value===null||Array.isArray(value)&&value.length===0)return reject('missing_summary');
  if(!Array.isArray(value))return reject('invalid_summary_shape');
  if(value.length>limits.maxItems)return reject('summary_limit_exceeded');
  if(value.some(item=>typeof item!=='string'))return reject('invalid_summary_shape');
  if(value.some(item=>item.length>limits.maxItemCharacters))return reject('summary_limit_exceeded');
  const characters=value.reduce((total,item)=>total+item.length,0);
  if(characters>limits.maxTotalCharacters)return reject('summary_limit_exceeded');
  if(value.every(item=>!item.trim()))return reject('missing_summary');
  result.summarySha256=createHash('sha256').update(JSON.stringify(value)).digest('hex');
  result.inspectedCharacters=characters;
  for(const [itemIndex,item] of value.entries())for(const [code,pattern] of internalDetails){
    // One location per rule/item is sufficient to fail this acceptance check; never log excerpts.
    const match=pattern.exec(item);
    if(!match)continue;
    if(result.findings.length===limits.maxFindings){result.findingsTruncated=true;continue;}
    result.findings.push({code,itemIndex,offset:match.index});
  }
  result.status=result.findings.length?'failed':'passed';
  return result;
}
