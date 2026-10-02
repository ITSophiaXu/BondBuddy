import type { ReviewEvidenceContext } from './review-evidence.js';

export type DocxFontRun = {
  latin_font:string|null;east_asia_font:string|null;half_points:string|null;
  latin_theme:string|null;east_asia_theme:string|null;resolved:boolean;characters:number;
};
/** Metadata contains hashes and native OOXML positions, never auxiliary text or invented body records. */
export interface DocxDocumentFormatting {
  schema_version:'docx-formatting-v1';body_part_sha256:string;
  headers:{status:'complete'|'unresolved';parts:{part_name:string;part_sha256:string;
    text_sha256:string;paragraph_count:number;status:'complete'|'unresolved';
    relationship_part_sha256:string;sections:{section_index:number;reference_type:'default'|'first'|'even'}[];runs:DocxFontRun[]}[]};
  toc:{status:'complete'|'unresolved';fields:{field_index:number;kind:'simple'|'complex';
    start_paragraph:number;end_paragraph:number;complete:boolean;instruction_sha256:string;
    result_sha256:string;result_characters:number;dirty:boolean|null;locked:boolean|null}[]};
}
export interface ReviewFormattedDocument {
  owner_user_id:string;project_id:string;material_id:string;material_version:number;material_sha256:string;
  parse_snapshot_id:string;parse_response_sha256:string;parser_version:string;formatting:DocxDocumentFormatting;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).length===expected.length&&expected.every(k=>Object.hasOwn(v,k));
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min;
const status=(v:unknown)=>v==='complete'||v==='unresolved';
const nullableText=(v:unknown)=>v===null||typeof v==='string'&&v.length>0&&v.length<=200;
export function validDocxDocumentFormatting(v:unknown):v is DocxDocumentFormatting {
  if(!object(v)||!keys(v,['schema_version','body_part_sha256','headers','toc'])||v.schema_version!=='docx-formatting-v1'||!hash(v.body_part_sha256)
    ||!object(v.headers)||!keys(v.headers,['status','parts'])||!status(v.headers.status)||!Array.isArray(v.headers.parts)||v.headers.parts.length>100
    ||!object(v.toc)||!keys(v.toc,['status','fields'])||!status(v.toc.status)||!Array.isArray(v.toc.fields)||v.toc.fields.length>1000)return false;
  const parts=new Set<string>();
  for(const p of v.headers.parts){
    if(!object(p)||!keys(p,['part_name','part_sha256','text_sha256','paragraph_count','status','relationship_part_sha256','sections','runs'])
      ||typeof p.part_name!=='string'||!/^word\/header\d+\.xml$/.test(p.part_name)||parts.has(p.part_name)||!hash(p.part_sha256)||!hash(p.text_sha256)
      ||!hash(p.relationship_part_sha256)||!integer(p.paragraph_count)||!status(p.status)||!Array.isArray(p.sections)||p.sections.length>1000
      ||!p.sections.length||!p.sections.every(s=>object(s)&&keys(s,['section_index','reference_type'])&&integer(s.section_index,1)&&['default','first','even'].includes(String(s.reference_type)))
      ||!Array.isArray(p.runs)||p.runs.length>10000)return false;
    parts.add(p.part_name);
    const scopes=p.sections.map(s=>JSON.stringify(s));if(new Set(scopes).size!==scopes.length)return false;
    for(const r of p.runs)if(!object(r)||!keys(r,['latin_font','east_asia_font','half_points','latin_theme','east_asia_theme','resolved','characters'])
      ||!['latin_font','east_asia_font','half_points','latin_theme','east_asia_theme'].every(k=>nullableText(r[k]))||typeof r.resolved!=='boolean'||!integer(r.characters,1))return false;
  }
  if(v.headers.status==='complete'&&v.headers.parts.some(p=>p.status!=='complete'))return false;
  const fields=new Set<number>();
  for(const f of v.toc.fields){
    if(!object(f)||!keys(f,['field_index','kind','start_paragraph','end_paragraph','complete','instruction_sha256','result_sha256','result_characters','dirty','locked'])
      ||!integer(f.field_index,1)||fields.has(Number(f.field_index))||!['simple','complex'].includes(String(f.kind))||!integer(f.start_paragraph,1)
      ||!integer(f.end_paragraph,Number(f.start_paragraph))||typeof f.complete!=='boolean'||!hash(f.instruction_sha256)||!hash(f.result_sha256)||!integer(f.result_characters)
      ||![f.dirty,f.locked].every(flag=>flag===null||typeof flag==='boolean')||v.toc.status==='complete'&&(!f.complete||f.dirty===null||f.locked===null))return false;
    fields.add(Number(f.field_index));
  }
  return true;
}
/** Verify source ownership and the exact parser snapshot already represented by trusted source records. */
export function validFormattedDocument(d:ReviewFormattedDocument,ctx:ReviewEvidenceContext):boolean {
  if(d.owner_user_id!==ctx.owner_user_id||d.project_id!==ctx.project_id||d.material_id!==ctx.source_material.material_id
    ||d.material_version!==ctx.source_material.material_version||d.material_sha256!==ctx.source_material.sha256
    ||d.parser_version!=='bondbuddy-document-parser-1.0.8'||!validDocxDocumentFormatting(d.formatting))return false;
  const records=ctx.records.filter(r=>r.owner_user_id===ctx.owner_user_id&&r.project_id===ctx.project_id&&r.material_id===d.material_id&&r.material_version===d.material_version);
  return records.length>0&&records.every(r=>r.material_sha256===d.material_sha256&&r.parse_snapshot_id===d.parse_snapshot_id&&r.parse_response_sha256===d.parse_response_sha256
    &&r.locator_type==='docx_block'&&r.extraction_method==='native_text'&&!r.uncertainty.length);
}
export const documentFormattingProperty=(property:string)=>/^header_(?:text_sha256|latin_font|east_asia_font|half_points)$/.test(property)||property==='toc_field'||property==='toc_generated';
export function checkDocumentFormatting(property:string,expected:string,d:ReviewFormattedDocument):{outcome:'pass'|'issue'|'uncovered';reason:string} {
  const m=d.formatting,pin=`material=${d.material_id}@${d.material_version};material_sha256=${d.material_sha256};parse_snapshot=${d.parse_snapshot_id};parse_response_sha256=${d.parse_response_sha256}`;
  const body=`part=word/document.xml;part_sha256=${m.body_part_sha256}`;
  if(property.startsWith('header_')){
    const h=m.headers;
    if(h.status!=='complete')return {outcome:'uncovered',reason:`页眉部件、分节引用或内容未完整解析，不能判定缺失或通过。${pin};${body}`};
    if(!h.parts.length)return {outcome:'issue',reason:`已完整检查原生分节引用，未发现页眉，不符合已保存的页眉要求。${pin};${body}`};
    const locations=h.parts.map(p=>`part=${p.part_name};part_sha256=${p.part_sha256};rels_sha256=${p.relationship_part_sha256};sections=${p.sections.map(s=>`${s.section_index}:${s.reference_type}`).join(',')};paragraphs=1..${p.paragraph_count}`);
    // Keep every actual location or mark uncovered, never silently drop report provenance.
    if(locations.join(';').length>8000)return {outcome:'uncovered',reason:`页眉位置数量超过单项报告容量，未截断后宣称已验证。${pin};${body}`};
    let unknown=false,bad=false;
    for(const p of h.parts){
      if(property==='header_text_sha256'){if(!hash(expected))unknown=true;else if(p.text_sha256!==expected)bad=true;continue;}
      const key=property.slice('header_'.length) as 'latin_font'|'east_asia_font'|'half_points';
      if(!p.runs.length)unknown=true;
      for(const r of p.runs){
        if(!r.resolved||!r[key]||key==='latin_font'&&r.latin_theme||key==='east_asia_font'&&r.east_asia_theme)unknown=true;
        else if(r[key]!==expected)bad=true;
      }
    }
    return {outcome:unknown?'uncovered':bad?'issue':'pass',reason:`页眉${property==='header_text_sha256'?'精确内容（段落间以换行连接）':'原生字体/字号'}检查：${unknown?'存在缺失属性、未解析样式或主题字体；未覆盖':bad?'与已保存要求不一致':'与已保存要求一致'}。文档级位置仅用于覆盖明细，不产生正文批注或文本修订。${pin};${locations.join(';')}`};
  }
  const toc=m.toc,locations=toc.fields.map(f=>`field=${f.field_index}:${f.kind};paragraphs=${f.start_paragraph}..${f.end_paragraph};instruction_sha256=${f.instruction_sha256};result_sha256=${f.result_sha256};result_characters=${f.result_characters};dirty=${f.dirty};locked=${f.locked}`);
  if(toc.status!=='complete'||locations.join(';').length>8000)return {outcome:'uncovered',reason:`目录域结构、修订或位置清单不完整，不能判定已生成目录。${pin};${body};${locations.join(';').length<=8000?locations.join(';'):'位置清单超过单项容量'}`};
  const outcome=expected!=='present'?'uncovered':!toc.fields.length?(property==='toc_field'?'issue':'uncovered')
    :property==='toc_generated'&&toc.fields.some(f=>f.result_characters===0||f.dirty||f.locked)?'uncovered':'pass';
  return {outcome,reason:`${property==='toc_field'?'TOC 域存在性':'已生成目录内容'}检查：${!toc.fields.length?'未发现完整 TOC 域；静态目录存在性未验证':toc.fields.some(f=>f.result_characters===0)?'存在完整 TOC 域，但含尚无可读取结果的空域':toc.fields.some(f=>f.dirty||f.locked)?'存在缓存结果，但域标记需更新或已锁定，目录内容待核':'存在完整 TOC 域及可读取缓存结果'}。检查不证明缓存结果为最新、目录条目完整、页码已刷新或视觉分页正确；无正文锚点时不生成批注或修订。${pin};${body};${locations.join(';')}`};
}
