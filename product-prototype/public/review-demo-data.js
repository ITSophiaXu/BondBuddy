export const STORAGE='bondbuddy:m3-review-design:chuan-tech:v2';
export const findings=[
  {id:'F-001',category:'financial',categoryName:'财务数据',priority:'high',priorityName:'高优先级',status:'明确差异',title:'有息负债与审计附注相差 1,800 万元',location:'第八章 · 有息债务情况 · P86',quote:'截至 2025 年末，发行人有息负债余额为 126,800.00 万元。',source:'2025 年审计报告 · 附注六 · P112',value:'128,600.00 万元',suggestion:'先确认统计口径一致，再同步调整债务明细、偿债分析与摘要中的引用。',explanation:'募集书列示 126,800.00 万元，审计附注同口径合计为 128,600.00 万元，相差 1,800.00 万元。示例依据指向一笔未纳入合计的长期借款。建议同时核对摘要、债务表和偿债分析，避免只改一处。',ready:true},
  {id:'F-002',category:'financial',categoryName:'财务数据',priority:'medium',priorityName:'需关注',status:'口径待确认',title:'偿债分析引用了母公司口径',location:'第八章 · 偿债能力分析 · P92',quote:'流动比率为 1.42，较上年有所提升。',source:'2025 年审计报告 · 合并资产负债表 · P8',value:'合并口径 1.18；母公司口径 1.42',suggestion:'确认该段应使用合并还是母公司口径；补充说明前保持待确认。',explanation:'该段没有说明主体口径。示例中的 1.42 来自母公司报表，合并口径为 1.18。两者不能直接视为数字错误；需要先确认披露口径，再决定修改方式。',ready:false},
  {id:'F-003',category:'compliance',categoryName:'合规与格式',priority:'high',priorityName:'高优先级',status:'待补披露',title:'募集资金用途与债务明细不一致',location:'第三章 · 募集资金运用 · P34',quote:'本期募集资金全部用于偿还到期有息债务。',source:'募集书 · 拟偿还债务明细表 · P35',value:'用途表与正文的到期范围不同',suggestion:'补充拟偿还债务清单，并确认提前偿还部分的安排。',explanation:'正文将用途限定为“到期”债务，示例明细中却包含尚未到期的借款。需要先确认提前偿还安排及约定，再统一正文与明细，不能凭推测补写。',ready:false},
  {id:'F-004',category:'public',categoryName:'公开信息',priority:'medium',priorityName:'需关注',status:'待补证',title:'企业名称变更的披露依据待补充',location:'第五章 · 发行人基本情况 · P51',quote:'发行人名称为澄川科技股份有限公司。',source:'示例查询记录 · 主体登记变更',value:'需要发行人提供名称变更证明',suggestion:'补充登记变更证明，核对名称生效时间与报告期间。',explanation:'此处只演示公开来源与材料冲突的交互。需要名称变更证明及生效日期，才能判断文中不同名称是否属于历史表述。本原型没有进行真实公开查询。',ready:false},
  {id:'F-005',category:'compliance',categoryName:'合规与格式',priority:'low',priorityName:'一般',status:'格式差异',title:'两处二级标题样式不一致',location:'第四章、第五章 · P40 / P53',quote:'4.2 发行安排；5.3 经营情况',source:'募集书样式 · 标题 2',value:'2 处直接格式覆盖样式',suggestion:'按本文件已采用的二级标题样式统一，不作为监管违规判断。',explanation:'这是机构排版一致性问题。示例中两处标题直接设置了不同字体和间距，修订可统一为当前文档的二级标题样式；它不代表监管违规。',ready:true},
  {id:'F-006',category:'compliance',categoryName:'合规与格式',priority:'low',priorityName:'一般',status:'引用待更新',title:'风险提示中的章节引用未同步',location:'第二章 · 特别风险提示 · P18',quote:'详见本募集说明书第七章财务信息。',source:'募集书目录 · 财务信息章节',value:'财务信息实际位于第八章',suggestion:'统一更新交叉引用，导出前检查目录与页码。',explanation:'示例中财务章节已调整到第八章，风险提示仍引用第七章。建议同步更新相关交叉引用，并在导出时检查目录与页码。',ready:true},
];
export const initialMessages=[
  {id:'initial-user',role:'user',text:'请重点核对有息负债与审计附注，同时留意名称变更的披露。',time:'10:24',label:'已用于 R1'},
  {id:'initial-assistant',role:'assistant',text:'已记录这两项关注点，并用于 R1。\n\n左侧直接查看依据、补充材料和选择修订项；右侧任务卡记录这些操作的过程和结果。有特殊口径或不同意见时，补充说明后再核对重新核验的范围。',time:'10:32'},
];
export function freshState(){const initialState={schema:2,assistantOpen:false,tab:'results',phase:'complete',filter:'all',selected:'F-001',expanded:'F-001',reference:null,draft:'',report:'R1',input:'V1',nextInput:'V1',messages:structuredClone(initialMessages),notes:[{id:'n1',text:'重点核对有息负债与审计附注的一致性',target:'R1'},{id:'n2',text:'关注名称变更的披露与时点',target:'R1'}],files:[{name:'澄川科技_募集说明书_V1.docx',kind:'待复核募集书',size:'2.8 MB',sample:true},{name:'2025年度审计报告.pdf',kind:'审计报告及附注',size:'8.6 MB',sample:true},{name:'2025年度财务报表.xlsx',kind:'财务报表',size:'680 KB',sample:true},{name:'本期发行安排说明.docx',kind:'其他依据',size:'240 KB',sample:true}],plan:[],planInitialized:false,runs:[{id:'R1',kind:'review',input:'V1',title:'首次三维复核',status:'complete',report:'R1',notes:2,files:4,scope:'财务数据 · 合规与格式 · 公开信息',created:'2026.10.02 10:32'}],activeRun:null,latestRevision:null,disputes:[],recheckProposals:[],viewedTaskId:null,timeline:[{kind:'message',messageId:'initial-user'},{kind:'task',runId:'R1'},{kind:'message',messageId:'initial-assistant'}]};initialState.runs[0].fileSnapshot=structuredClone(initialState.files);initialState.runs[0].noteSnapshot=structuredClone(initialState.notes);return initialState;}

export function readDemoState(){
  const initial=freshState();
  try {
    const saved=JSON.parse(localStorage.getItem(STORAGE)||'null');
    if(saved?.schema===2 && ['messages','notes','runs','files'].every(key=>Array.isArray(saved[key]))){
      const state={...initial,...saved};
      state.messages=state.messages.map((message,index)=>({...message,id:message.id||`restored-message-${index}`}));
      const existingIds=new Set(state.messages.map(message=>message.id));
      const taskIds=new Set([...state.runs.map(run=>run.id),state.activeRun?.id].filter(Boolean));
      if(!Array.isArray(saved.timeline))state.timeline=[...state.messages.map(message=>({kind:'message',messageId:message.id})),...state.runs.map(run=>({kind:'task',runId:run.id})),...(state.activeRun?[{kind:'task',runId:state.activeRun.id}]:[])];
      state.recheckProposals=Array.isArray(saved.recheckProposals)?saved.recheckProposals:[];
      const proposalIds=new Set(state.recheckProposals.map(proposal=>proposal.id));
      if(Array.isArray(saved.timeline))state.timeline=saved.timeline.filter(item=>item?.kind==='message'?existingIds.has(item.messageId):item?.kind==='task'?taskIds.has(item.runId):item?.kind==='proposal'&&proposalIds.has(item.proposalId));
      state.viewedTaskId=taskIds.has(saved.viewedTaskId)?saved.viewedTaskId:null;
      if(state.tab==='versions')state.tab='results';
      return {state,storageOK:true};
    }
    return {state:initial,storageOK:true};
  }catch{return {state:initial,storageOK:false};}
}

export function demoRecordText(run){
  const revision=run.kind==='revision';
  const outcome=run.status!=='complete'?'演示已停止，未生成新结果':revision?'示例已修改':'仅演示重新核验，保留示例结论';
  return ['BondBuddy M3 交互原型 · 示例记录','此文件不是正式复核报告或 Word 成果。','未调用模型、未核验资料、未发生扣费。','',
    '项目：澄川科技（虚构示例）','任务：'+run.id+' / '+run.title,'输入：'+run.input,'范围：'+run.scope,
    '状态：'+(run.status==='complete'?'已完成的示例':'已停止的演示'),
    '材料信息：'+run.files+' 份；要求：'+run.notes+' 项',
    ...(run.findingIds?.length?['',revision?'示例修订清单：':'本轮关联复核项：',...run.findingIds.map(id=>id+' '+findings.find(f=>f.id===id)?.title+'：'+outcome),...(!revision?['其余 '+(findings.length-run.findingIds.length)+' 项沿用 '+run.sourceReport+'，本轮未重新核验。']:[])]:[])
  ].join('\n');
}
