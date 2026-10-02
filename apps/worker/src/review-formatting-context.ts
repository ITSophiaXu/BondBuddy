import { createHash } from 'node:crypto';
import type { ReviewRuleRef } from '../../../packages/contracts/dist/review-results.js';
import type { ReviewFormattingRequirement } from '../../../packages/domain/dist/review-compliance-checks.js';
import { reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';

type Result={rules:ReviewRuleRef[];formatting_requirements:ReviewFormattingRequirement[];limitations:string[]};
type Standard={index:number;text:string;scope:'正文'|'正文段落'|'表格';property:ReviewFormattingRequirement['property'];expected:string;record_ids:string[]};
const namedSizes:Record<string,number>={初号:84,小初:72,一号:52,小一:48,二号:44,小二:36,三号:32,小三:30,四号:28,小四:24,五号:21,小五:18,六号:15,小六:13,七号:11,八号:10};
const fontNames=new Set(['宋体','黑体','楷体','仿宋','微软雅黑','等线','华文宋体','华文中宋','华文仿宋','华文楷体','Arial','Times New Roman','Calibri','Cambria','Microsoft YaHei','SimSun','SimHei','FangSong','KaiTi','DengXian']);
function fontName(value:string):string|null{
  if(fontNames.has(value))return value;
  const quoted=/^(?:"([^"\r\n]+)"|“([^”\r\n]+)”)$/.exec(value);const name=quoted?.[1]??quoted?.[2];
  return name&&/^[\p{L}\p{N} _.-]{1,80}$/u.test(name)?name:null;
}
function halfPoints(value:string):string|null{
  if(namedSizes[value])return String(namedSizes[value]);
  const match=/^(\d+(?:\.5)?)\s*(?:磅|pt)$/i.exec(value);if(!match)return null;
  const size=Number(match[1])*2;return Number.isInteger(size)&&size>=2&&size<=3276?String(size):null;
}
const table=(record:ReviewAnalysisRecord)=>Array.isArray(record.locator.path)&&record.locator.path.some(part=>typeof part?.table==='number');
/** Only explicit saved user standards, never inferred from documents, discussion or unpublished rules. */
export function loadExplicitReviewFormatting(input:{input_hash:string;input_revision:number;requirements:readonly string[];records:readonly ReviewAnalysisRecord[]}):Result{
  const result:Result={rules:[],formatting_requirements:[],limitations:[]};const standards:Standard[]=[];
  const current=input.records.filter(r=>r.source_kind==='disclosure'&&r.locator_type==='docx_block');
  for(const [index,text] of input.requirements.entries()){
    const match=/^(?:格式要求\s*[：:]\s*)?(正文段落|正文|表格)\s*(中文字体|西文字体|字号)\s*(?:为|[：:])\s*(.+?)[。.]?$/u.exec(text.trim());
    if(!match){if(/字体|字号|页眉|页脚|目录|行距|分页|标题层级/.test(text))result.limitations.push(`输入要求 ${index+1} 的格式范围或标准未能明确解析，本轮未自动检查该要求；支持逐条明确正文/正文段落/表格的中文字体、西文字体或字号。`);continue;}
    const scope=match[1] as Standard['scope'],property=match[2]==='字号'?'half_points':match[2]==='中文字体'?'east_asia_font':'latin_font',value=match[3]!.trim();
    const expected=property==='half_points'?halfPoints(value):fontName(value);
    if(!expected){result.limitations.push(`输入要求 ${index+1} 的字体或字号值不明确，不选择其中一个候选标准。`);continue;}
    const record_ids=current.filter(r=>scope==='正文'||(scope==='表格'?table(r):!table(r))).map(r=>r.record_id);
    standards.push({index,text,scope,property,expected,record_ids});
  }
  const conflicting=new Set<number>();
  for(const [i,a] of standards.entries())for(const b of standards.slice(i+1))if(a.property===b.property&&a.expected!==b.expected){
    const ids=new Set(a.record_ids);const overlapping=a.scope==='正文'||b.scope==='正文'||a.scope===b.scope||b.record_ids.some(id=>ids.has(id));
    if(overlapping){conflicting.add(a.index);conflicting.add(b.index);}
  }
  for(const standard of standards){
    if(conflicting.has(standard.index)){result.limitations.push(`输入要求 ${standard.index+1} 与其他要求在相同范围内存在格式标准冲突，未据此判定格式错误。`);continue;}
    const identity=reviewContentHash([input.input_hash,standard.index,standard.text]);
    const rule:ReviewRuleRef={rule_id:`user-format:${identity.slice(0,24)}`,rule_version:'review-user-format-v1',pack_id:'review-input-format',pack_version:input.input_hash,pack_sha256:input.input_hash,
      source_id:`saved-requirement-${standard.index+1}`,source_version:input.input_hash,source_sha256:createHash('sha256').update(standard.text,'utf8').digest('hex'),quote:standard.text,
      locator:`已保存执行输入 revision ${input.input_revision} / requirements[${standard.index}]；用户指定格式标准，非监管规则`,effective_from:null,effective_to:null,applicability:'applicable',authority:'internal_method'};
    result.rules.push(rule);
    // Limit public report anchors per check; every record is retained across explicit batches.
    const chunks:string[][]=[];for(let offset=0;offset<standard.record_ids.length;offset+=500)chunks.push(standard.record_ids.slice(offset,offset+500));
    if(!chunks.length)chunks.push([]);
    for(const [batch,record_ids] of chunks.entries())result.formatting_requirements.push({check_id:`user-format:${identity.slice(0,24)}:${batch}`,record_ids,rule_ref:rule,property:standard.property,expected:standard.expected});
  }
  if(standards.length)result.limitations.push('用户格式标准仅核对本次已解析的原生 DOCX 正文；“正文”含正文表格，“正文段落”不含表格。页眉页脚、目录域、标题层级及实际视觉分页尚未覆盖，格式发现仅供报告和批注，不能通过文本修订改变字体或字号。');
  return result;
}
