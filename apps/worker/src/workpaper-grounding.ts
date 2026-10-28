import type {WorkpaperDecision,WorkpaperEntry,ProjectFileText} from '@bondbuddy/contracts';
/** Quote existence is checked against the exact supplied spans, never against a newer prospectus. */
export function groundWorkpaperDecision(d:WorkpaperDecision,entry:WorkpaperEntry,spans:ProjectFileText['spans']):WorkpaperDecision{
 const citations=d.citations.filter(c=>spans.some(s=>s.id===c.span_id&&s.text.includes(c.quote))).map(c=>({...c,location:spans.find(s=>s.id===c.span_id)!.location}));
 const ungrounded=citations.length!==d.citations.length||!citations.length;
 const original=/营业执照|许可证|原件|原始凭证|签章|签字|访谈记录|函证回函|银行流水|征信报告/.test(entry.title+' '+entry.instructions)
   && !/提纲|清单|模板|分析/.test(entry.title);
 if(original&&d.status==='generate')return {...d,item_id:entry.id,status:'external_evidence',citations,reason:'该项需要原始证据，募集说明书披露不能替代原件或已实施核查记录。',missing_materials:['请补充对应原件或实际执行形成的记录。']};
 if(ungrounded&&['generate','not_applicable'].includes(d.status))return {...d,item_id:entry.id,status:'missing_information',citations,reason:'现有资料不足以形成该项文件，亦不能确认该业务不适用。',missing_materials:['该项对应的项目披露及支持材料']};

 return {...d,item_id:entry.id,citations,...(d.status!=='generate'&&d.status!=='not_applicable'&&!d.missing_materials.length?{missing_materials:['请补充该项原始资料及业务适用性说明。']}: {})};
}
