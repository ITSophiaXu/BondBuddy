import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Value} from '@sinclair/typebox/value';
import {QaAnswerSchema,QaResultSchema,qaSearchTerms,qaSameAsset,type QaAnswer,type QaInput,type QaResult,type QaQuestion} from '@bondbuddy/contracts';
import {digest,transaction} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {readProjectFileAsset} from '@bondbuddy/api/project-file-storage';
import {codexModelStage,type RunStage,type StageContext} from './run-pipeline.js';
import {composeContainedPrompt,loadCodexAdapterConfig} from './codex-adapter.js';
import {loadProjectQaInput} from './project-qa-input.js';
import {projectFilesRoot} from './project-file-tools.js';
import {qaModelEvidenceContext,qaAnswerInstructions} from './project-qa-evidence.js';
export {qaPromptEvidence} from './project-qa-evidence.js';
const prefix=(ctx:StageContext)=>`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/qa/`;
const max=100*1024*1024;
async function python(ctx:StageContext,args:string[]){await promisify(execFile)(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B','-m','bondbuddy_file_authoring.project_qa',...args],{cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:180000,maxBuffer:2*1024*1024});}
async function store(ctx:StageContext,path:string){const bytes=await readFile(path);if(!bytes.length||bytes.length>max)throw Error('FILE_OUTPUT_STORE_FAILED');const sha256=digest(bytes),key=prefix(ctx)+sha256+'/document.docx';await ctx.blobs.put(key,bytes,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');const readback=await ctx.blobs.getIfExistsBounded(key,max);if(!readback||digest(readback)!==sha256)throw Error('FILE_OUTPUT_STORE_FAILED');return {key,sha256,byte_size:bytes.length};}
async function sourceBytes(ctx:StageContext,asset:QaInput['source']['asset']){const row=await readProjectFileAsset(ctx.pool,ctx.run.owner_user_id,asset),bytes=await ctx.blobs.getIfExistsBounded(row.object_key,max);if(!bytes||digest(bytes)!==asset.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');return {bytes,media:row.media_type};}
async function lock(ctx:StageContext,c:import('pg').PoolClient){const row=await c.query("SELECT 1 FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2 AND j.id=$3 AND j.lease_token=$4 AND j.state='running' AND j.lease_until>now() AND NOT r.state=ANY($5::text[]) FOR UPDATE OF r,j",[ctx.run.id,ctx.run.owner_user_id,ctx.lease.jobId,ctx.lease.token,['cancelled','failed','succeeded']]);if(!row.rowCount)throw Error('LEASE_LOST');}
function resolvedQaCitations(proposal:QaAnswer,evidence:QaResult['evidence']){
 return proposal.citations.flatMap(c=>{
  if(!c.quote.trim())return [];
  const spans=evidence[c.asset_index]?.snapshot.spans??[];
  if(spans.some(s=>s.id===c.span_id&&s.text.includes(c.quote)))return [c];
  // The extractor labels p0 as "段落 1". A model can copy that display number
  // into span_id. Repair only this exact, verifiable alias in the same asset;
  // never select a nearby paragraph or an arbitrary repeated table value.
  const displayNumber=/^p([1-9]\d*)$/.exec(c.span_id)?.[1];
  if(displayNumber&&Number.isSafeInteger(Number(displayNumber))){
   const aliases=spans.filter(s=>s.id===`p${Number(displayNumber)-1}`&&s.location===`段落 ${displayNumber}`&&s.text.includes(c.quote));
   if(aliases.length===1)return [{...c,span_id:aliases[0].id}];
  }
  // Repair a wrong paragraph ID only for a unique verbatim quote in the same asset.
  // A locator typo is not a reason to ask the user to supply facts already disclosed.
  const matches=spans.filter(s=>s.text.includes(c.quote));
  return matches.length===1?[{...c,span_id:matches[0].id}]:[];
 });
}
/** A model-authored quotation error is a generation error, not missing issuer material.
 * Reject it at model validation so the existing durable schema re-ask can repair it. */
export function qaHasGroundedCitations(proposal:QaAnswer,evidence:QaResult['evidence']){
 return proposal.citations.length>0&&resolvedQaCitations(proposal,evidence).length===proposal.citations.length;
}
function qaUnanswered(proposal:QaAnswer){
 return proposal.status==='missing'&&!proposal.citations.length&&proposal.missing_materials.some(item=>item.trim());
}
export function groundedQaAnswer(proposal:QaAnswer,q:QaQuestion,input:QaInput,evidence:QaResult['evidence']):QaAnswer{
 const valid=resolvedQaCitations(proposal,evidence),cases=proposal.case_ids.filter(id=>input.cases.some(c=>c.id===id));
 const unreliable=valid.length!==proposal.citations.length||!valid.length;
 const missing=[...proposal.missing_materials];
 const hasReadableEvidence=evidence.some(e=>e.snapshot.spans.some(s=>s.text.trim()));
 if((unreliable||proposal.status==='missing')&&!missing.length)missing.push(...(unreliable&&hasReadableEvidence
  ?['本题答复的引文未能在已提供材料中准确定位，请核对对应的募集说明书段落或表格；不代表该事项未披露。']
  :qaMissingMaterials(q.question)));
 return {...proposal,question_id:q.id,citations:valid,case_ids:cases,status:unreliable||missing.length||proposal.status==='missing'?'missing':'draft',
  answer:qaUnanswered(proposal)?'【暂无法形成有依据的回答】本题尚缺可准确引用的对应信息，请仅补充下列具体事项。':unreliable?(hasReadableEvidence?'【待确认：回答依据】本题答复的引文未能在已提供材料中准确定位，需核对对应原文；不能据此认定募集说明书未披露相关事实。':'【暂无法形成有依据的回答】当前没有可准确引用的项目材料。请提供本题对应的募集说明书内容或可读材料。'):proposal.answer,
  missing_materials:missing};
}
/** Recovery suggestions describe evidence to request, never facts about the issuer. */
export function qaMissingMaterials(question:string):string[]{
 const requests:[RegExp,string][]=[
  [/偿债|偿付|回款|现金流|流动性/,'请提供本题偿付安排、资金来源或现金流的可读披露内容，保留相关期间和金额。'],
  [/募集资金|募集用途|发行规模/,'请提供本题发行规模及募集资金用途的可读披露内容，保留金额和用途明细。'],
  [/收入|利润|财务|资产|负债|报告期|成本/,'请提供本题涉及报告期的财务数据及变动原因原文，保留单位和会计口径。'],
  [/关联|占款|往来|定价/,'请提供本题关联交易、往来或定价说明的可读披露内容，保留相关期间和明细。'],
  [/担保|诉讼|仲裁|处罚|合规/,'请提供本题相关事项及进展的可读披露内容，保留主体、金额和日期。']
 ];
 const matched=requests.filter(([rule])=>rule.test(question)).map(([,request])=>request);
 return matched.length?matched:[`请提供“${question.slice(0,200)}”对应的可读披露内容或具体说明，仅需本题尚无法确定的信息。`];
}
export function projectQaModelStage(options:{model?:typeof codexModelStage;config?:typeof loadCodexAdapterConfig}={}):RunStage{
 return {name:'model_generation',replay:true,run:async ctx=>{
  const input=await loadProjectQaInput(ctx),old=(await ctx.pool.query('SELECT result,result_hash FROM bb_project_qa_runs WHERE owner_user_id=$1 AND run_id=$2',[ctx.run.owner_user_id,ctx.run.id])).rows[0];
  if(old?.result){if(!Value.Check(QaResultSchema,old.result)||inputManifestHash(old.result)!==old.result_hash.trim())throw Error('INPUT_REVISION_CONFLICT');return {kind:'done',value:old.result};}
  const dir=await mkdtemp(join(tmpdir(),'bb-project-qa-'));
  try{
   let result:QaResult;
   if(input.operation==='prepare'){
    const source=await sourceBytes(ctx,input.source.asset),path=join(dir,source.media==='application/pdf'?'source.pdf':source.media==='application/msword'?'source.doc':'source.docx');await writeFile(path,source.bytes,{mode:0o600});
    await python(ctx,['prepare',path,join(dir,'prepared.docx'),join(dir,'prepared.json')]);
    const parsed=JSON.parse(await readFile(join(dir,'prepared.json'),'utf8'));
    result={version:'project-qa-result-v1',input_hash:ctx.run.input_hash.trim(),document:await store(ctx,join(dir,'prepared.docx')),snapshot:parsed.snapshot,questions:parsed.questions,answers:[],warnings:parsed.warnings,evidence:[]};
   }else{
    const prepared=(await ctx.pool.query('SELECT result FROM bb_project_qa_runs WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[ctx.run.owner_user_id,ctx.run.project_id,input.preparation_id])).rows[0].result as QaResult;
    const bytes=await ctx.blobs.getIfExistsBounded(prepared.document.key,max);if(!bytes||digest(bytes)!==prepared.document.sha256)throw Error('INPUT_REVISION_CONFLICT');await writeFile(join(dir,'source.docx'),bytes,{mode:0o600});
    const evidence:QaResult['evidence']=[],warnings=[...prepared.warnings];
    for(const [i,material] of input.materials.entries()){
     const source=await sourceBytes(ctx,material.asset),ext=source.media==='application/pdf'?'.pdf':source.media==='application/msword'?'.doc':source.media.includes('spreadsheet')?'.xlsx':source.media.includes('wordprocessingml')?'.docx':'.unsupported',path=join(dir,'evidence-'+i+ext);
     await writeFile(path,source.bytes,{mode:0o600});
     try{await python(ctx,['evidence',path,join(dir,'evidence.json')]);const snapshot=JSON.parse(await readFile(join(dir,'evidence.json'),'utf8'));evidence.push({filename:material.filename,snapshot});warnings.push(...snapshot.warnings.map((w:string)=>material.filename+'：'+w));}
     catch(e){if(ctx.signal?.aborted)return {kind:'stopped'};const warning=material.filename+'：未能提取可引用文本，请提供可检索文件或补充对应业务说明。';warnings.push(warning);evidence.push({filename:material.filename,snapshot:{version:'project-file-text-v1',format:'docx',sha256:material.asset.pin.sha256,spans:[],warnings:[warning],coverage:'partial'}});}
    }
    const prospectusIndex=input.prospectus?input.materials.findIndex(m=>qaSameAsset(m.asset,input.prospectus!.asset)):-1;
    if(input.prospectus&&(prospectusIndex<0||!evidence[prospectusIndex]?.snapshot.spans.some(s=>s.text.trim())))return {kind:'fail',code:'MATERIAL_UNREADABLE'};
    const projectContext={prospectus:input.prospectus?{filename:input.prospectus.filename,version:input.prospectus.sequence,asset_index:prospectusIndex}:null,files:evidence.map((e,asset_index)=>({asset_index,filename:e.filename,coverage:e.snapshot.coverage,paragraphs:e.snapshot.spans.length})),introduction:prospectusIndex<0?[]:evidence[prospectusIndex].snapshot.spans.filter(s=>s.text.trim()).slice(0,12).map(s=>({span_id:s.id,text:s.text.slice(0,1200)}))};
    const answers:QaAnswer[]=[];
    for(const question of input.questions){
     const saved=(await ctx.pool.query('SELECT answer,sha256 FROM bb_project_qa_answers WHERE owner_user_id=$1 AND run_id=$2 AND question_id=$3',[ctx.run.owner_user_id,ctx.run.id,question.id])).rows[0];
     if(saved){if(inputManifestHash(saved.answer)!==saved.sha256.trim()||!Value.Check(QaAnswerSchema,saved.answer))throw Error('INPUT_REVISION_CONFLICT');answers.push(saved.answer);continue;}
     const terms=new Set(qaSearchTerms(question.question));
     const questionCases=input.cases.map(c=>({c,score:qaSearchTerms(Object.values(c.content).join(' ')).filter(t=>terms.has(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(x=>x.c);
     // Question IDs may contain punctuation and exceed the checkpoint's 64-character limit.
     // Keep the durable logical call ID unchanged; reserve room for the `_prompt` suffix.
     const outcome=await (options.model??codexModelStage)({name:'qa_'+digest(question.id).slice(0,48),logicalCallId:'qa-'+question.id,templateVersion:'project-qa-direct-answer-v5',resultSchemaVersion:'project-qa-answer-v1',schema:QaAnswerSchema,
      // An explicit unanswered question can finish without a citation. Its model
      // prose is discarded by groundedQaAnswer; invented quotations still re-ask.
      validate:(v):v is QaAnswer=>Value.Check(QaAnswerSchema,v)&&v.question_id===question.id&&(qaHasGroundedCitations(v,evidence)||qaUnanswered(v)),
      config:()=>({...((options.config??loadCodexAdapterConfig)()),web_search:'disabled',timeout_ms:600000}),
      buildPrompt:async()=>composeContainedPrompt({instructions:qaAnswerInstructions,materials:[{ref:'project-qa-input',text:JSON.stringify({project:input.project_name,project_context:projectContext,question,requirements:input.requirements,...qaModelEvidenceContext(question,evidence,prospectusIndex),extraction_warnings:warnings,cases:questionCases.map(c=>({id:c.id,...c.content})),coverage:'优先读取募集说明书；正文、完整表格及相邻说明按字符预算选入，不按单元格数截断。selection 中区分提取限制与选文遗漏。项目概况仅帮助理解主体，结论引用 materials 的原文；先写充分的事实答复，仅标注本题真正无法确定的部分。'})}]})}).run(ctx);
     if(outcome.kind!=='done')return outcome;
     const answer=groundedQaAnswer(outcome.value as QaAnswer,question,{...input,cases:questionCases},evidence);
     await transaction(ctx.pool,async c=>{await lock(ctx,c);await c.query('INSERT INTO bb_project_qa_answers(owner_user_id,run_id,question_id,answer,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ctx.run.owner_user_id,ctx.run.id,question.id,answer,inputManifestHash(answer)]);});answers.push(answer);
    }
    await writeFile(join(dir,'fill.json'),JSON.stringify({source_sha256:prepared.document.sha256,questions:input.questions,answers,evidence,cases:input.cases,warnings}),{mode:0o600});
    await python(ctx,['fill',join(dir,'source.docx'),join(dir,'fill.json'),join(dir,'filled.docx')]);
    result={version:'project-qa-result-v1',input_hash:ctx.run.input_hash.trim(),document:await store(ctx,join(dir,'filled.docx')),snapshot:prepared.snapshot,questions:input.questions,answers,evidence,warnings};
   }
   if(!Value.Check(QaResultSchema,result))throw Error('QA_RESULT_INVALID');
   await transaction(ctx.pool,async c=>{await lock(ctx,c);await c.query('UPDATE bb_project_qa_runs SET result=$3,result_hash=$4 WHERE owner_user_id=$1 AND run_id=$2 AND result IS NULL',[ctx.run.owner_user_id,ctx.run.id,result,inputManifestHash(result)]);});
   return {kind:'done',value:result};
  }finally{await rm(dir,{recursive:true,force:true});}
 }};
}
export function projectQaDeliveryStage():RunStage{return {name:'word_delivery',replay:true,run:async ctx=>{
 await loadProjectQaInput(ctx);const r=ctx.values.get('model_generation') as QaResult;
 if(!Value.Check(QaResultSchema,r)||r.input_hash!==ctx.run.input_hash.trim()||r.document.key!==prefix(ctx)+r.document.sha256+'/document.docx')return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
 const bytes=await ctx.blobs.getIfExistsBounded(r.document.key,max);if(!bytes||bytes.length!==r.document.byte_size||digest(bytes)!==r.document.sha256)throw Error('FILE_OUTPUT_STORE_FAILED');
 return {kind:'deliver',bytes,deliveryPolicy:'generated_review_v1'};
}};}
