import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { M4AssistantReplySchema,type M4AssistantReply,type M4QaManifest } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { m4UnavailableDocument,m4UnavailableLocalScope,m4UnavailableResearch,constrainFreeM4Reply } from '@bondbuddy/api/m4-workspace';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { codexModelStage,type RunStage,type StageContext } from './run-pipeline.js';
import { loadM4WorkerInput,type M4WorkerInput } from './m4-input.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { checkedM4File,prepareM4Files,verifyM4Originals,verifyM4Calculation } from './m4-file-workspace.js';
import { m4ModelGate,m4PinnedMethod } from './m4-method.js';
import { m4ActionObserver,recordM4Progress } from './m4-action-progress.js';

export type M4QaResult={version:'codex-m4-qa-v1';input_hash:string;skill_sha256:string;method_hash:string;reply:M4AssistantReply;
  calculation:Awaited<ReturnType<typeof verifyM4Calculation>>};
const same=(a:unknown,b:unknown)=>inputManifestHash(a)===inputManifestHash(b);
export function authorizedM4Reply(reply:unknown,input:M4WorkerInput):reply is M4AssistantReply {
  if (!Value.Check(M4AssistantReplySchema,reply) || input.manifest.kind!=='qa') return false;
  if(reply.assistant_action && !input.manifest.assistant_context)return false;
  if (reply.citations.some(c=>c.kind==='material'?!input.materials.some(m=>same(m.pin,c.ref)):!input.artifacts.some(a=>same(a.pin,c.ref))))return false;
  if (reply.intent==='cross_business' && !reply.target_business || reply.intent!=='cross_business' && reply.target_business!==null)return false;
  if (Object.keys(reply.fields).length && (!reply.document_type || !['draft','execute'].includes(reply.intent)))return false;
  if (reply.requirements.length && !['draft','execute'].includes(reply.intent))return false;
  if(reply.intent==='execute' && !reply.document_type)return false;
  return true;
}
export function validM4QaResult(value:unknown,ctx:StageContext,input?:M4WorkerInput):value is M4QaResult {
  const v=value as M4QaResult|null;
  return !!v && v.version==='codex-m4-qa-v1' && v.input_hash===ctx.run.input_hash.trim()
    && /^[a-f0-9]{64}$/.test(v.skill_sha256) && /^[a-f0-9]{64}$/.test(v.method_hash)
    && Value.Check(M4AssistantReplySchema,v.reply) && (!input || authorizedM4Reply(v.reply,input))
    && (!input||input.manifest.kind!=='qa'||same(v.reply,constrainFreeM4Reply(v.reply,input.manifest)))
    && (v.calculation===null || !!v.calculation && /^[a-f0-9]{64}$/.test(v.calculation.request_sha256)
      && v.calculation.result.version==='m4-finance-v1' && ['calculated','needs_confirmation'].includes(String(v.calculation.result.status)));
}

/** The CLI labels semantic intent; it cannot create/charge a document run or mutate immutable input. */
export function constrainM4Reply(reply:M4AssistantReply,manifest:M4QaManifest):M4AssistantReply {
  return constrainFreeM4Reply(constrainM4TaskReply(reply,manifest),manifest);
}
function constrainM4TaskReply(reply:M4AssistantReply,manifest:M4QaManifest):M4AssistantReply {
  if(manifest.assistant_context){
    const discussOnly=/(?:先别|暂时不要|不要|不需要)(?:执行|开始|生成|制作|改稿|更新|复核)(?:[，。！\s]|募集|任务|$)|只是(?:讨论|问)|^(?:如何|怎么|怎样).*(?:生成|制作|更新|复核)/.test(manifest.content);
    const {assistant_action,...answer}=reply;
    return {...answer,...(!discussOnly&&assistant_action?{assistant_action}:{}),intent:!discussOnly&&assistant_action?'clarify':'answer',document_type:null,target_business:null,fields:{},requirements:[]};
  }
  const content=manifest.content;
  const clauses=content.split(/[，。；！？\n]/);
  if(m4UnavailableResearch(content))return {...reply,
    content:'M4 当前支持基础概念、已授权材料解读和常用确定性财务计算。实时公开查询、法规效力或适用性检索、深度研究及多期系统分析将在 M5 开放；本轮未执行外部检索，可继续讨论已有材料或准备已开放任务。',
    intent:'clarify',requirements:[],fields:{},document_type:null,target_business:null};
  if(m4UnavailableDocument(content)||m4UnavailableLocalScope(content))return {...reply,
    content:'M4 首发开放交易所普通私募单承销商的立项报告、主承销商核查意见、法律意见书、募集说明书摘要和申请书，以及交易商协会 PPN／中期票据推荐函与整份续改。你提出的范围包含尚未开放能力，当前资料与讨论会保留；请确认是否改为已开放的单项整份任务。',
    intent:'clarify',requirements:[],fields:{},document_type:null,target_business:null};
  const target=reply.document_type==='init'?/立项(?:报告)?/:reply.document_type==='private_summary'?/摘要/:reply.document_type==='underwriter'?/核查意见/:reply.document_type==='legal'?/法律意见/:reply.document_type==='application'?/申请书/:reply.document_type==='recommendation'?/推荐函/:null;
  // Guard explicit main-action denial/method questions. Local writing restrictions remain requirements.
  const denied=clauses.some(clause=>{
    const denial=/(?:暂时|目前|先)?(?:不要|不需要|先别|别)(?:直接|马上|现在|自动)?(?:生成|制作|执行|启动|复核|改稿)(.*)/.exec(clause);
    if(!denial)return false;
    return !denial[1]?.trim() || /^(?:任务|本次|这个|任何|了|。)/.test(denial[1]) || !!target?.test(denial[1]);
  });
  const method=/(?:如何|怎么|怎样)(?:[^，。；！？]{0,20})(?:生成|制作|执行|启动|复核|改稿)/.test(content)
    && !/(?:请|现在|马上|开始)(?:[^，。；！？]{0,8})(?:生成|制作|执行|启动|复核|改稿)/.test(content);
  if ((denied || method) && reply.intent==='execute') {
    const preparation=denied && !method && reply.requirements.length>0 && clauses.some(clause=>/要求|语气|风格|篇幅|保留|增加|补充|加入|记录|保存|采用|模板/.test(clause)
      && !/(?:不要|不需要|先别|别)(?:直接|马上|现在|自动)?(?:生成|制作|执行|启动|复核|改稿)/.test(clause));
    return {...reply,...(denied?{content:preparation?'已保留资料并记录本轮准备要求。当前不会启动正式制作。':'已保留本轮讨论和资料。你明确要求先不执行，本轮不会启动正式制作；可以继续向助手说明准备要求。'}:{}),
      intent:preparation?'draft':'answer',requirements:preparation?reply.requirements:[],fields:preparation?reply.fields:{},document_type:preparation?reply.document_type:null,target_business:null};
  }
  if(method && reply.intent==='draft')return {...reply,intent:'answer',requirements:[],fields:{},document_type:null,target_business:null};
  const unavailable=clauses.some(clause=>/(?:公募|DFI|多承销|多券商|组合|仅改.{0,15}(?:章节|段落)|只改.{0,15}(?:章节|段落))/.test(clause)
    && /生成|制作|编制|改稿|修改/.test(clause) && !/(?:不要|不需要|先别|别)(?:直接|马上|现在|自动)?(?:生成|制作|编制|改稿|修改)/.test(clause)) && !method;
  if(unavailable && ['execute','draft'].includes(reply.intent))
    return {...reply,content:'M4 首发开放交易所普通私募单承销商的立项报告、主承销商核查意见、法律意见书、募集说明书摘要和申请书，以及交易商协会 PPN／中期票据推荐函与整份续改。你提出的范围包含尚未开放能力，当前资料与讨论会保留；请确认是否改为已开放的单项整份任务。',
      intent:'clarify',requirements:[],fields:{},document_type:null,target_business:null};
  return reply;
}

function calculationReply(reply:M4AssistantReply,receipt:M4QaResult['calculation']):M4AssistantReply {
  if(!receipt || receipt.result.status!=='calculated')return {...reply,intent:'clarify',requirements:[],fields:{},document_type:null,target_business:null,
    content:'本次计算尚未得到可验证结果。请补充要计算的指标、准确期间、主体、合并或母公司口径、单位和带位置的源数值；零分母、存疑识别数字或不同口径需先确认。'};
  const result=receipt.result as {label:string;formula:string;periods:{period_start:string|null;period_end:string;scope:string;value:string;unit:string;
    operands:{name:string;raw_value:string;unit:string;source:{kind:'material'|'artifact';id:string;project_id:string;version:number;sha256:string;locator:string}}[]}[];
    comparison:null|{delta:string;delta_unit:string;relative_change_percent:string|null}};
  const lines=[`${result.label}，公式：${result.formula}`];
  const citations:M4AssistantReply['citations']=[];
  for(const period of result.periods){lines.push(`${period.period_start?`${period.period_start} 至 `:''}${period.period_end}（${period.scope==='consolidated'?'合并':'母公司'}）：${period.value}${period.unit==='percent'?'%':' 倍'}`);
    for(const item of period.operands){lines.push(`源值 ${item.name}：${item.raw_value}${item.unit}；${item.source.locator}`);
      const s=item.source;
      citations.push(s.kind==='material'?{kind:'material',ref:{source_project_id:s.project_id,material_id:s.id,material_version:s.version,sha256:s.sha256},locator:s.locator}
        :{kind:'artifact',ref:{source_project_id:s.project_id,artifact_id:s.id,artifact_version:s.version,sha256:s.sha256},locator:s.locator});}
  }
  if(result.comparison){const c=result.comparison;lines.push(`两期差额：${c.delta}${c.delta_unit==='percentage_points'?' 个百分点':' 倍'}；相对变动：${c.relative_change_percent===null?'前期基数非正，不计算相对增幅':`${c.relative_change_percent}%`}`);}
  lines.push('以上由固定授权源值进行确定性算术计算，源值提取的事实真实性待核；未进行公开检索。');
  return {...reply,content:lines.join('\n'),citations:[...new Map(citations.map(c=>[inputManifestHash(c),c])).values()],intent:'answer',requirements:[],fields:{},document_type:null,target_business:null};
}

export function m4QaStage(options:{model?:typeof codexModelStage;load?:typeof loadM4WorkerInput;config?:ReturnType<typeof loadCodexAdapterConfig>}={}):RunStage {
  return {name:'model_generation',replay:true,run:async ctx=>{
    const input=await (options.load??loadM4WorkerInput)(ctx);if(input.manifest.kind!=='qa')return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
    const manifest=input.manifest;
    const config=options.config??loadCodexAdapterConfig(),skill=loadM4RuntimeSkill(manifest.assistant_context?'global-project-assistant':'m4-project-qa');
    const gate=await m4ModelGate(ctx,config);if(gate)return gate;
    const pinned=await m4PinnedMethod(ctx,'qa',skill,config);if(pinned.gate)return pinned.gate;
    let originals=new Map<string,string>();const observer=m4ActionObserver(ctx,'qa');
    const prepare=async(cwd:string)=>{await recordM4Progress(ctx,'m4_reading_materials');originals=await prepareM4Files(ctx,input,skill,cwd,M4AssistantReplySchema);};
    const collect=async(cwd:string):Promise<M4QaResult>=>{
      await verifyM4Originals(cwd,originals);
      const raw=JSON.parse((await checkedM4File(join(cwd,'output'),'reply.json',1024*1024)).toString('utf8'));
      if(!authorizedM4Reply(raw,input))throw Error('M4_REPLY_NOT_AUTHORIZED');
      let reply=constrainM4Reply(raw,manifest);
      const calculation=await verifyM4Calculation(ctx,cwd);
      const pureFormula=/(?:如何计算|怎么计算|怎样计算|公式是什么|解释.{0,20}公式|介绍.{0,20}公式|说明.{0,20}公式)/.test(manifest.content)
        && !/(?:并计算|计算一下|请计算|帮我计算)/.test(manifest.content);
      const pureComparisonMethod=/(?:如何|怎么|怎样).{0,30}(?:比较|对比|分析|评估)|(?:解释|介绍|说明).{0,30}(?:方法|思路|口径|概念)/.test(manifest.content)
        && !/(?:请|帮我|并|同时).{0,15}(?:计算|比较|对比|分析|评估)|比较一下|对比一下|具体数值/.test(manifest.content);
      const financialComparison=manifest.billing_task==='m4_Q04' && /偿债|财务|比率|资产|负债|利润|现金流|偿付|利息|流动性|收入|毛利|净利|盈利|增幅|同比|环比|差额/.test(manifest.content)
        && !pureComparisonMethod;
      const reportedMetricNumber=manifest.billing_task==='m4_Q04' && /[-+]?\d+(?:\.\d+)?\s*(?:%|％|亿元|万元|倍|个百分点)/.test(reply.content);
      const requiresCalculation=manifest.billing_task==='m4_Q03' && !pureFormula || financialComparison || reportedMetricNumber;
      if(['m4_Q03','m4_Q04'].includes(manifest.billing_task) && reply.intent==='answer' && (calculation?.result.status==='calculated' || requiresCalculation))
        reply=calculationReply(reply,calculation);
      if(!authorizedM4Reply(reply,input))throw Error('M4_REPLY_NOT_AUTHORIZED');
      return {version:'codex-m4-qa-v1',input_hash:ctx.run.input_hash.trim(),skill_sha256:skill.sha256,method_hash:pinned.hash,reply,calculation};
    };
    try{return await (options.model??codexModelStage)({name:'m4_qa_v1',logicalCallId:'m4-qa-v1',
      config:{...config,work_root:join(process.env.BB_PARSE_STAGING_DIR??config.work_root,'m4-qa')},
      buildPrompt:async()=>`${skill.content}\n\n完整读取固定 input.json。仅本轮材料、明确正在阅读的成果和固定历史上下文可作为证据；write output/reply.json，符合reply_schema。请求计算时写 output/calculation-request.json，并运行 python -B finance.py --input output/calculation-request.json --output output/calculation-result.json。固定方法：${pinned.hash}。`,
      schema:{},validate:value=>validM4QaResult(value,ctx,input),resultSchemaVersion:'codex-m4-qa-v1',templateVersion:`m4-qa-${pinned.hash}`,
      onActivity:event=>observer.onEvent(event),fileWorkspace:{prepare,collect}}).run(ctx);
    }finally{await observer.drain();}
  }};
}
export function m4QaDeliveryStage():RunStage {
  return {name:'word_delivery',replay:true,run:async ctx=>{
    const input=await loadM4WorkerInput(ctx),value=ctx.values.get('model_generation');
    if(input.manifest.kind!=='qa' || !validM4QaResult(value,ctx,input))return {kind:'fail',code:'VALIDATION_FAILED'};
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    return {kind:'qa_deliver',reply:value.reply};
  }};
}
