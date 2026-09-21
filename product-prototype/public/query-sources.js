import { planQueries, hasExternalData } from './query-policy.js';

export function querySourcesUI({state,draft,esc,icon,document=globalThis.document}) {
  function plan(kind='generate') {
    return planQueries({kind,prompt:kind==='generate'?state.chatDraft:draft(kind).reviewNotes,connectors:state.connectors,webAvailable:state.health.webConfigured,registryAvailable:state.health.registryConfigured,externalDataAllowed:hasExternalData(state.billing?.seat.quota)});
  }
  const projectIssuer=()=>state.jobs.find(j=>j.id===state.projectId)?.context?.issuer||'';
  function needsIssuer() {
    const selection=plan();
    return !projectIssuer()&&state.connectors.some(c=>c.purpose==='bonds'&&selection.connectorIds.includes(c.id));
  }
  function status(kind='generate') {
    const content=statusContent(plan(kind));
    return `<div class="auto-query-status" ${kind==='generate'?'id="auto-query-status"':''} ${content?'':'hidden'} aria-live="polite">${content}</div>`;
  }
  function statusContent(selection){
    if(selection.requiresProfessional)return `${icon('globe')}<span>工商、Wind 等外部查询需要专业版。<a href="#billing">查看套餐 →</a></span>`;
    const external=selection.web||selection.registry||selection.connectorIds.length;
    if(!external&&selection.limitations.some(text=>/未连接|未获得|未执行联网/.test(text)))return `${icon('globe')}<span>查询服务暂不可用，可先分析材料</span>`;
    return '';
  }
  function panel(kind) {
    const selection=plan(kind),external=selection.web||selection.registry||selection.connectorIds.length;
    return `<div class="auto-query-note">${icon('check')}<p>${external?'结合上传材料与平台数据进行核验，查询结果会注明来源。':selection.requiresProfessional?'直接上传材料即可。个人版依据材料处理；专业版另含工商及债券数据查询。':'直接上传材料即可。未能完成外部核验的事项，会在结果中注明。'}</p></div>`;
  }
  function issuer() {
    const needed=needsIssuer();
    return `<div id="chat-query-subject" class="chat-query-subject" ${needed?'':'hidden'}><label for="query-issuer">查询公司</label><input id="query-issuer" value="${esc(state.queryIssuer)}" placeholder="发行人全称，例如：某某股份有限公司" maxlength="200" ${needed?'required':'disabled'}><small>补充公司全称，即可自动查询；关联项目后无需重复填写。</small></div>`;
  }
  function refresh() {
    const el=document.querySelector('#auto-query-status');
    if(el){const content=statusContent(plan());el.innerHTML=content;el.hidden=!content;}
    const subject=document.querySelector('#chat-query-subject'),input=document.querySelector('#query-issuer'),needed=needsIssuer();
    if(subject)subject.hidden=!needed;
    if(input){input.disabled=!needed;input.required=needed;}
  }
  return {status,panel,issuer,refresh};
}
