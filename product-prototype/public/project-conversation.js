import { OPTIONAL_GROUPS,normaliseOptional } from './project-fields.js';

// Only used to recover drafts created by the earlier guided conversation UI.
const previousTopics=[['funding','资金用途',3],['issuance','发行安排',0],['agencies','参与机构',1],['rating','评级与增信',2],['company','企业情况',4]].map(([id,title,index])=>({id,title,fields:OPTIONAL_GROUPS[index].fields}));
const topicText=(topic,values)=>{
  const lines=topic.fields.filter(f=>(!f.when||values[f.when[0]]===f.when[1])&&values[f.key]).map(f=>`${f.label}：${values[f.key]}`);
  return lines.length?`【${topic.title}】\n`+lines.join('\n'):'';
};

export function projectConversation({state,draft,saveDraft,esc,icon,render,invalidate,document=globalThis.document}){
  function changed(kind){invalidate(kind);saveDraft(kind);if(state.step===3)state.step=2;}
  function migrate(kind){
    const d=draft(kind);
    if(d.informationLayout==='expanded')return;
    const original=normaliseOptional(d),messages=d.projectMessages||[];
    let dirty=false,next=[...messages];
    for(const topic of previousTopics){
      const priorText=topicText(topic,original),pending=d.conversationDrafts?.[topic.id];
      let values=original;
      if(pending){
        values=normaliseOptional({...original,...pending});
        const key=topic.id==='issuance'?'trancheTerms':topic.id==='agencies'?'underwritingArrangements':'';
        if(key&&pending.variant){const prefix=pending.variant==='多个品种'?'多品种安排':pending.variant;values[key]=values[key]?`${prefix}：${values[key].replace(/^(多品种安排|单一品种|一家主承销商|多家承销商)：/,'')}`:`${prefix}，具体安排待定。`;}
      }
      if(kind==='update'){
        // The form is the single editable copy of these structured details.
        if(priorText&&next.some(m=>m.text===priorText)){next=next.filter(m=>m.text!==priorText);dirty=true;}
        for(const f of topic.fields)if(values[f.key]!==original[f.key]){d[f.key]=values[f.key];dirty=true;}
      }else{
        // Keep previously supplied review information as optional notes, without hidden form values.
        const text=topicText(topic,values),previousIndex=priorText?next.findIndex(m=>m.text===priorText):-1;
        const notes=text.match(/[\s\S]{1,3000}/g)?.map(text=>({text}))||[];
        if(next.length-(previousIndex>=0?1:0)+notes.length>50){
          // Preserve older values if all note slots are occupied.
          for(const f of topic.fields)if(values[f.key]!==original[f.key]){d[f.key]=values[f.key];dirty=true;}
          continue;
        }
        if(previousIndex>=0)next.splice(previousIndex,1,...notes);else next.push(...notes);
        for(const f of topic.fields)if(d[f.key]){d[f.key]='';dirty=true;}
        if(text!==priorText||text&&previousIndex<0)dirty=true;
      }
    }
    for(const key of ['term','secondTerm','trancheOneOptionTerms','trancheTwoOptionTerms','trancheOneSpecialType','leadUnderwriter','coUnderwriters','bookrunner','trustee'])delete d[key];
    d.projectMessages=next;d.informationLayout='expanded';delete d.conversationTopic;delete d.conversationDrafts;
    if(dirty){delete d.messageEditIndex;changed(kind);}else saveDraft(kind);
  }
  function prompts(kind){
    const labels=kind==='review'?['财务疑点','合规关注','公开信息线索','补充信息']:['授信情况','修改要求','补充信息'];
    return `<div class="cowork-prompts">${labels.map(label=>`<button type="button" data-action="project-prompt" data-value="${label}">${label}</button>`).join('')}</div>`;
  }
  function composer(kind,d){
    if(kind==='update')return `<form id="project-message-form" class="cowork-composer"><textarea id="project-message" aria-label="补充募集书更新说明" maxlength="3000" rows="3" placeholder="如有额外的募集书更新要求，可在此补充">${esc(d.messageDraft||'')}</textarea><div class="supplement-footer"><div class="supplement-feedback"></div><div class="supplement-save-actions">${d.projectId?'<p class="cowork-footnote" id="note-autosave-status" role="status">输入后自动保存</p>':'<p class="cowork-footnote">随项目一起保存。</p>'}</div></div></form>`;
    const label=kind==='review'?'补充核验线索或特别关注事项':'补充募集书更新说明（选填）';
    const placeholder=kind==='review'?'例如：第86页的有息负债金额与审计附注不一致，请结合两处来源核对；公司最近变更了名称，相关公告稍后补充。':'请输入额外的募集书更新说明';
    return `<form id="project-message-form"><label class="field"><span>${label}</span><textarea id="project-message" maxlength="3000" rows="4" placeholder="${esc(placeholder)}">${esc(d.messageDraft||'')}</textarea></label>${d.projectId ? '<button type="submit" class="btn primary small">保存补充说明</button>' : '<p class="cowork-footnote">随项目一起保存。</p>'}</form>`;
  }
  function saveFree(kind,text){
    const d=draft(kind);text=text.trim();if(!text)return false;
    if(/_{2,}/.test(text))throw new Error('请将填空处换成已知信息，未确定的内容可写“待定”或删去。');
    const index=d.messageEditIndex,editing=Number.isInteger(index)&&d.projectMessages?.[index];
    if(text.length>3000)throw new Error('每条项目说明不能超过3000字。');
    if(!editing&&(d.projectMessages||[]).length>=50)throw new Error('最多50条项目说明，请先删除或合并已有内容。');
    if(editing)d.projectMessages[index]={text};else d.projectMessages=[...(d.projectMessages||[]),{text}];
    d.messageDraft='';delete d.messageEditIndex;changed(kind);return true;
  }
  function commit(kind,{automatic=false}={}){
    const d=draft(kind);
    if(!automatic)return saveFree(kind,document?.querySelector('#project-message')?.value??d.messageDraft??'');
    if(d.messageDraft?.trim()&&!/_{2,}/.test(d.messageDraft))return saveFree(kind,d.messageDraft);
  }
  async function click(action,value){
    if(!['update','review'].includes(state.route)||action!=='project-edit-message')return false;
    const kind=state.route,d=draft(kind),message=d.projectMessages?.[Number(value)];if(!message)return true;
    d.messageEditIndex=Number(value);d.messageDraft=message.text;saveDraft(kind);await render();document?.querySelector('#project-message')?.focus?.();return true;
  }
  function remove(kind,index){
    const d=draft(kind);if(!d.projectMessages?.[index])return;
    d.projectMessages.splice(index,1);
    if(d.messageEditIndex===index){delete d.messageEditIndex;d.messageDraft='';}else if(d.messageEditIndex>index)d.messageEditIndex--;
    changed(kind);
  }
  function autosave(kind){
    const d=draft(kind),text=d.messageDraft||'',index=Number.isInteger(d.messageEditIndex)?d.messageEditIndex:(d.projectMessages||[]).length;
    if(!text.trim())return;
    saveFree(kind,text);d.messageEditIndex=index;d.messageDraft=text;saveDraft(kind);
    const status=document?.querySelector('#note-autosave-status');if(status)status.textContent='已自动保存';
  }
  return {migrate,prompts,composer,commit,click,remove,autosave};
}
