import { projectConversation } from './project-conversation.js';
import { REVIEW_DIMENSIONS,FINANCIAL_ROLES } from './review-scope.js';
import { planQueries,hasExternalData } from './query-policy.js';
import { MARKETS,offeringsFor,offeringName } from './markets.js';
import { ROLE_NAMES,SUPPORT_ROLES,normaliseOptional,FUNDING_PURPOSES } from './project-fields.js';

export function projectWorkspace({state,esc,icon,bytes,head,api,post,toast,render,draft,saveDraft,authoring,reportingPreview,refreshJobs,upload=async(path,body)=>api(path,{method:'POST',body}),document=globalThis.document,location=globalThis.location}){
  const pending=new Map();
  const operationKey=kind=>`${state.accountEpoch}:${kind}`;
  const busy=kind=>pending.has(operationKey(kind));
  const select=(name,label,options,value,required=false)=>`<div class="field"><label for="${name}">${label}${required?' <span class="required">*</span>':''}</label><select id="${name}" name="${name}" ${required?'required':''}>${options.map(([id,text])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(text)}</option>`).join('')}</select></div>`;
  const textField=(name,label,value,placeholder='',required=false)=>`<div class="field"><label for="${name}">${label}${required?' <span class="required">*</span>':''}</label><input id="${name}" name="${name}" value="${esc(value||'')}" placeholder="${esc(placeholder)}" maxlength="${name==='title'?150:300}" ${required?'required':''}></div>`;
  const fields=kind=>{const {dataUpdate,updateYears,sourceScope,majorRestructuring,investorProtection,protectionTerms,registrationMode,conversationTopic,conversationDrafts,messageEditIndex,messageDraft,informationLayout,...d}=draft(kind);return {...d,...normaliseOptional(d),updateMode:'full',kind,scope:`${d.exchange}-${d.offering}`,periods:`${d.year}-${d.quarter}`,projectMessages:JSON.stringify(d.projectMessages||[]),projectId:undefined,assessment:undefined};};
  function invalidate(kind){const d=draft(kind);if(d.assessment){delete d.assessment;saveDraft(kind);}}
  const conversation=projectConversation({state,draft,saveDraft,esc,icon,render,invalidate,document});
  function basics(kind,d){
    const currentYear=new Date().getFullYear();
    return `${kind==='review'?reviewOverview():''}<section class="form-section"><h2>项目基本信息</h2><p>${kind==='review'?'填写必要信息，用于确定适用规则和财务核对期间。':'填写本次发行安排；选填信息可按已知情况补充。'}</p><div class="field-grid">${textField('title','项目名称',d.title,'例如：2026年第一期债券',true)}${textField('issuer','发行人全称',d.issuer,'填写本次发行人的法定全称',true)}${select('exchange','发行市场',MARKETS,d.exchange,true)}${select('offering',d.exchange==='nafmii'?'债务融资工具品种':'发行方式',offeringsFor(d.exchange),d.offering,true)}<div class="field full"><label for="year">最新报告期 <span class="required">*</span></label><div class="period-row"><select id="year" name="year" required>${Array.from({length:currentYear-1998},(_,i)=>currentYear+1-i).map(y=>`<option value="${y}" ${String(y)===d.year?'selected':''}>${y} 年</option>`).join('')}</select><div class="quarter-grid">${[['03-31','3月末'],['06-30','6月末'],['09-30','9月末'],['12-31','年末']].map(([v,l])=>`<label class="quarter"><input type="radio" name="quarter" value="${v}" ${v===d.quarter?'checked':''} required>${l}</label>`).join('')}</div></div>${reportingPreview(d,kind==='update'?'simple':false)}</div></div></section>${kind==='update'?authoring.optional(d):''}`;
  }
  function selected(kind){const d=draft(kind);return state.files[kind].filter(f=>kind==='review'?f.role!=='reference':SUPPORT_ROLES.includes(f.role)||(d.authoringMode==='historical'?f.role==='historical':f.role==='userReference'));}
  function reviewOverview(){
    const plan=planQueries({kind:'review',prompt:[draft('review').reviewNotes,...(draft('review').projectMessages||[]).map(m=>m.text)].filter(Boolean).join('\n'),connectors:state.connectors||[],webAvailable:state.health.webConfigured,registryAvailable:state.health.registryConfigured,externalDataAllowed:hasExternalData(state.billing?.seat.quota)});
    const status=plan.requiresProfessional?'当前套餐依据上传材料复核；公开检索与工商查询需专业版。':plan.web||plan.registry||plan.connectorIds.length?'将使用已连接的公开检索和数据来源；未覆盖的部分会单独说明。':'公开查询服务暂未连接；相关核验会标记为未覆盖。';
    return '<section class="review-overview"><h2>这次会复核什么</h2><div class="review-dimensions">'+REVIEW_DIMENSIONS.map((d,i)=>'<article><span class="review-number">0'+(i+1)+'</span><h3>'+d.title+'</h3><p>'+d.description+'</p><small>'+d.deliverable+'</small></article>').join('')+'</div><p class="review-source-status">'+esc(status)+'</p><p class="authoring-help">结果包括原文批注、复核报告和待补充事项。未取得依据的事项不会标为已通过。</p></section>';
  }
  function fileRow(kind,f){
    const index=state.files[kind].indexOf(f),pending=f.uploadStatus==='uploading',failed=f.uploadStatus==='error';
    const status=f.stored?'已上传并保存':failed?f.error:pending?(f.progress===100?'传输完成，正在保存…':'正在上传 '+(f.progress===null?'':f.progress+'%')):'已选择，等待上传';
    return '<div class="file-item"><div class="file-icon">'+icon('file')+'</div><div class="file-name"><strong>'+esc(f.file.name)+'</strong><small class="'+(failed?'upload-error':'')+'">'+bytes(f.file.size)+' · '+esc(status)+'</small>'+(pending?'<progress max="100" '+(f.progress===null?'':'value="'+(f.progress||0)+'"')+' aria-label="'+esc(f.file.name)+'上传进度"></progress>':'')+'</div>'+(failed?'<button type="button" class="text-btn" data-action="retry-project-upload" data-value="'+index+'">重试</button>':'')+'<button type="button" class="icon-btn" data-action="remove-file" data-value="'+index+'" '+(pending?'disabled':'')+' aria-label="移除'+esc(f.file.name)+'">'+icon('close')+'</button></div>';
  }
  function uploads(kind,d){
    const files=selected(kind),primary=kind==='review'?'updated':'historical';
    const groups=[];
    if(kind==='review'||d.authoringMode==='historical')groups.push({role:primary,title:kind==='review'?'待复核募集书':'本发行人历史募集书',hint:'必需 · 1 份 DOCX；用于原文定位和 Word '+(kind==='review'?'批注':'修订'),accept:'.docx',single:true,roles:[primary]});
    groups.push({role:'audit',title:'审计报告 / 财务报表及附注',hint:'必需 · 可上传一份完整审计报告，也可分开上传报表和附注；同一文件无需重复上传。',roles:FINANCIAL_ROLES});
    if(kind==='update')groups.push({role:'fundUse',title:'募投项目与权证材料',hint:'按项目提供：可研报告、备案许可、土地或建设许可证、基金备案许可、子公司股权投资相关材料等。',roles:['fundUse','feasibility','resolutions']});
    if(kind==='update'&&d.authoringMode==='reference')groups.push({role:'userReference',title:'相似募集书',hint:'选填 · 有合适的参考文件可以上传；没有也可以继续提供本项目材料。',accept:'.docx,.pdf',single:true,roles:['userReference']});
    const assigned=new Set(groups.flatMap(g=>g.roles));groups.push({role:'other',title:kind==='review'?'其他核对依据':'其他项目材料',hint:kind==='review'?'选填 · 可补充适用法规、工商资料、授信或其他核对依据。':'选填 · 可补充发行方案、授信、经营及其他资料。',roles:[...new Set(files.filter(f=>!assigned.has(f.role)).map(f=>f.role)),'other']});
    return (kind==='review'?reviewOverview():'')+'<section class="form-section material-sections"><h2>提供项目材料</h2><p>在对应分区添加文件，选中后立即上传。每份材料都会显示上传状态。</p>'+groups.map(g=>'<section class="material-group"><div class="material-group-heading"><h3>'+g.title+'</h3><span>'+files.filter(f=>g.roles.includes(f.role)).length+' 份</span></div><p>'+g.hint+'</p><label class="dropzone compact-dropzone" data-upload-role="'+g.role+'">'+icon('upload')+'<strong>点击或拖入'+g.title+'</strong><span>'+((g.accept||'.docx,.pdf,.xlsx,.csv,.txt').replaceAll('.','').toUpperCase().replaceAll(',',' / '))+'</span><input type="file" data-project-upload-role="'+g.role+'" accept="'+(g.accept||'.docx,.pdf,.xlsx,.csv,.txt')+'" '+(g.single?'':'multiple')+' aria-label="上传'+g.title+'"></label><div class="file-list">'+files.filter(f=>g.roles.includes(f.role)).map(f=>fileRow(kind,f)).join('')+'</div></section>').join('')+'<p class="authoring-help">最多60份、合计80 MB。上传材料免费；扫描件或无法解析的文件需替换后再执行。</p></section>';
  }
  function buttonProgress(progress){const button=document.querySelector('#start-task');if(button)button.textContent=progress.transferred?'上传完成，正在准备任务…':'正在提交任务 '+(progress.percent===null?'':progress.percent+'%');}
  async function transfer(kind,item){
    const epoch=state.accountEpoch;item.uploadStatus='uploading';item.progress=0;item.error='';if(state.route===kind)await render();
    const data=new FormData();for(const [key,value]of Object.entries(fields(kind)))if(value!==undefined&&value!==null&&typeof value!=='object')data.set(key,value);data.append(item.role,item.file);
    try{const {file}=await upload('/api/projects/'+draft(kind).projectId+'/materials',data,{onProgress:p=>{if(state.accountEpoch!==epoch)return;item.progress=p.percent;if(state.route===kind)void render();}});if(state.accountEpoch!==epoch)return;item.stored=true;item.key=file.key;item.uploadStatus='complete';}
    catch(error){if(state.accountEpoch!==epoch)return;item.uploadStatus='error';item.error=error.message;}
    if(state.accountEpoch===epoch&&state.route===kind)await render();
  }
  async function addFiles(inputFiles,role){
    const kind=state.route,d=draft(kind);if(busy(kind))throw new Error('正在处理当前材料，请完成后再修改。');if(!d.projectId)throw new Error('请先创建项目，再上传材料。');
    if(state.health.projectInputVersion!==3)throw new Error('请先重启服务并刷新页面。');
    const candidates=Array.from(inputFiles),single=['historical','updated','userReference'].includes(role);
    if(single&&candidates.length!==1)throw new Error('这个分区每次提供一份募集书。');
    if(single&&state.files[kind].some(f=>f.role===role&&f.uploadStatus==='uploading'))throw new Error('请等待当前募集书上传完成。');
    const accepted=[];let next=[...state.files[kind]];
    for(const file of candidates){
      const format=role==='userReference'?/\.(docx|pdf)$/i:['historical','updated'].includes(role)?/\.docx$/i:/\.(docx|pdf|xlsx|csv|txt)$/i;
      if(!file.size||!format.test(file.name))throw new Error('文件为空或格式不支持，请按分区提示上传。');
      const current=single?next.filter(f=>f.role!==role):next;
      if(current.some(f=>f.file.name===file.name&&f.file.size===file.size))continue;
      if(current.length>=60||current.reduce((n,f)=>n+f.file.size,0)+file.size>80*1024*1024)throw new Error('最多60份材料，合计不超过80 MB。');
      const item={file,role,uploadStatus:'uploading',progress:0};next=[...current,item];accepted.push(item);
    }
    const epoch=state.accountEpoch;state.files[kind]=next;invalidate(kind);await render();for(const item of accepted){if(state.accountEpoch!==epoch)break;await transfer(kind,item);}
  }
  function quoteContent(){return '<p>材料与需求已保存。准备完成后，点击执行即可开始。</p>';}
  function cowork(kind,d){
    const messages=d.projectMessages||[];
    return `<aside class="panel project-cowork"><div class="cowork-heading">${icon('file')}<h2>募集书更新补充说明</h2></div><div class="cowork-messages">${messages.map((m,i)=>`<div class="cowork-message"><p>${esc(m.text).replaceAll('\n','<br>')}</p><div class="cowork-message-actions"><button type="button" data-action="project-edit-message" data-value="${i}">修改</button></div></div>`).join('')}</div>${conversation.composer(kind,d)}</aside>`;
  }
  function page(kind){
    const d=draft(kind);
    if(Object.hasOwn(d,'registrationMode')){const previous=d.registrationMode;delete d.registrationMode;if(previous){invalidate(kind);if(state.step===3)state.step=2;}saveDraft(kind);}
    if(d.updateMode!=='full'){
      if(d.assessment){invalidate(kind);if(state.step===3)state.step=2;}
      d.updateMode='full';
      delete d.dataUpdate;delete d.updateYears;delete d.sourceScope;
      delete d.majorRestructuring;delete d.investorProtection;
      if(d.protectionTerms)d.reviewNotes=[d.reviewNotes,'已提供的条款安排：'+d.protectionTerms].filter(Boolean).join('；');
      delete d.protectionTerms;
      if(!d.purposeCategory&&FUNDING_PURPOSES.includes(d.purpose))d.purposeCategory=d.purpose;
      saveDraft(kind);
    }
    if(!d.trancheTerms&&[d.term,d.secondTerm,d.trancheOneOptionTerms,d.trancheTwoOptionTerms].some(Boolean))d.trancheTerms=[d.term?'债券期限：'+d.term:'',d.trancheOneOptionTerms?'含权安排：'+d.trancheOneOptionTerms:'',d.trancheOneSpecialType?'专项品种：'+d.trancheOneSpecialType:'',d.secondTerm?'另一品种期限：'+d.secondTerm:'',d.trancheTwoOptionTerms?'另一品种含权安排：'+d.trancheTwoOptionTerms:''].filter(Boolean).join('；');
    if(!d.underwritingArrangements)d.underwritingArrangements=[d.leadUnderwriter?'主承销商：'+d.leadUnderwriter:'',d.coUnderwriters?'联席主承销商：'+d.coUnderwriters:'',d.bookrunner?'簿记管理人：'+d.bookrunner:''].filter(Boolean).join('；');
    if(!d.otherAgencies&&d.trustee)d.otherAgencies='受托管理人：'+d.trustee;
    if(!offeringsFor(d.exchange).some(([v])=>v===d.offering))d.offering=offeringsFor(d.exchange)[0][0];
    conversation.migrate(kind);
    const uploading=selected(kind).some(f=>f.uploadStatus==='uploading');
    state.step=Math.min(2,state.step);const locked=busy(kind),step=state.step,ready=state.health.authoringVersion===2&&state.health.projectInputVersion===3&&state.health.oneClickExecution===true;const labels=['创建项目','材料与要求'];
    const content=(ready?'':'<div class="notice" role="status"><span>新版项目流程等待服务重启。请关闭原启动窗口，重新打开 Start-BondBuddy.cmd 后刷新；已填写的信息会保留，重启前不会开始任务或扣点。</span></div>')+(step===1?basics(kind,d):step===2?uploads(kind,d):quoteContent(d.assessment));
    const button=step===1?(d.projectId?'保存并继续':'创建项目，继续提供材料'):'开始'+(kind==='update'?'更新':'复核');
    return head(kind==='update'?'更新募集说明书':'复核募集说明书','提供项目材料和要求，点击开始即可执行。','PROSPECTUS WORKSPACE','<a class="btn secondary" href="#tasks">查看全部项目</a>')+`<div class="stepper">${labels.map((label,i)=>`${i?'<span class="step-line"></span>':''}<span class="step ${step===i+1?'current':''}"><b>${step>i+1?'✓':i+1}</b>${label}</span>`).join('')}</div><fieldset class="workspace-layout workspace-controls" ${locked?'disabled aria-busy="true"':''}><form id="workflow-form"><div class="panel form-card">${content}</div><div class="form-footer">${step>1?'<button type="button" class="btn secondary" data-action="previous-step">上一步</button>':'<span>创建项目与上传材料免费</span>'}<button type="submit" class="btn primary" id="start-task" ${ready&&!uploading&&!locked?'':'disabled'}>${locked?pending.get(operationKey(kind)):!ready?'等待服务重启':uploading?'等待材料上传完成':button}</button></div></form>${cowork(kind,d)}</fieldset>`;
  }
  async function assess(kind){
    const d=draft(kind),epoch=state.accountEpoch,data=new FormData();for(const [k,v] of Object.entries(fields(kind)))if(v!==undefined&&v!==null&&typeof v!=='object')data.set(k,v);
    const files=selected(kind);data.set('retainedFiles',JSON.stringify(files.filter(f=>f.stored).map(f=>f.key)));for(const f of files)if(!f.stored)data.append(f.role,f.file);
    if(files.some(f=>['uploading','error'].includes(f.uploadStatus)))throw new Error('请等待上传完成，并重试未成功的文件。');
    if(!files.some(f=>FINANCIAL_ROLES.includes(f.role)))throw new Error('请先上传审计报告，或财务报表及附注。');
    let job;
    try{({job}=await upload(`/api/projects/${d.projectId}/execute`,data,{onProgress:progress=>{if(state.route===kind)buttonProgress(progress);}}));}
    catch(error){
      // A failed parsing attempt can already have stored a new material snapshot.
      if(state.accountEpoch===epoch)try{const latest=await api('/api/tasks/'+d.projectId);if(state.accountEpoch===epoch){state.files[kind]=latest.job.files.map(f=>({stored:true,key:f.key,role:f.role,file:{name:f.filename,size:f.size}}));delete d.assessment;saveDraft(kind);}}catch{}
      throw error;
    }
    delete d.assessment;delete d.projectId;state.files[kind]=[];saveDraft(kind);await refreshJobs();location.hash='task/'+job.id;
  }
  async function submit(form){
    if(['workflow-form','project-message-form'].includes(form.id)&&busy(state.route))return true;
    if(form.id==='project-message-form'){
      conversation.commit(state.route);await render();return true;
    }
    if(form.id!=='workflow-form'||!['update','review'].includes(state.route))return false;
    if(state.health.authoringVersion!==2||state.health.projectInputVersion!==3)throw new Error('请先重启本地服务并刷新，再创建或执行项目。');
    if(!form.reportValidity())return true;
    const kind=state.route,d=draft(kind),step=state.step,key=operationKey(kind);
    if(selected(kind).some(f=>f.uploadStatus==='uploading'))throw new Error('请等待材料上传完成。');
    pending.set(key,step===1?'正在保存项目…':step===2||!d.assessment?.quote?'正在准备任务…':'正在开始任务…');
    try{
      if(step>=2&&/_{2,}/.test(d.messageDraft||''))throw new Error('还有未补全的说明，请补充后加入项目，或清空后开始。');
      conversation.commit(kind,{automatic:true});
      await render();
      if(step===1){
        if(!d.projectId){const {job}=await post('/api/projects',fields(kind));d.projectId=job.id;saveDraft(kind);await refreshJobs();}
        if(!state.files[kind].length){const {job}=await api('/api/tasks/'+d.projectId);state.files[kind]=job.files.map(f=>({stored:true,key:f.key,role:f.role,file:{name:f.filename,size:f.size}}));}
        if(state.route===kind){state.step=2;state.uploadRole='audit';await render();}
      }else {await assess(kind);}
    }finally{pending.delete(key);if(state.route===kind&&operationKey(kind)===key)await render();}
    return true;
  }
  function input(el){
    if(el.id==='project-message'){draft(state.route).messageDraft=el.value;saveDraft(state.route);return;}
    if(el.closest('#workflow-form')&&el.name)invalidate(state.route);
  }
  function change(el){
    if(el.dataset?.projectUploadRole){void addFiles(el.files,el.dataset.projectUploadRole).catch(error=>toast(error.message,true));return true;}
    if(el.name==='exchange'&&el.closest('#workflow-form')){const d=draft(state.route);d.exchange=el.value;d.offering=offeringsFor(d.exchange)[0][0];invalidate(state.route);saveDraft(state.route);void render();return true;}
    if(el.id==='workspace-primary')return false;
    if(el.dataset.fileIndex!==undefined)invalidate(state.route);
    return false;
  }
  async function click(action,value){
    if(busy(state.route)&&(['previous-step','retry-project-upload','remove-file'].includes(action)||action.startsWith('project-')))return true;
    if(await conversation.click(action,value))return true;
    if(action==='project-prompt'){const examples={'授信情况':'截至____，公司银行授信总额____亿元，已使用____亿元，未使用____亿元。','修改要求':'请将____调整为____，原因是____。','补充信息':'补充一项项目信息：','财务疑点':'募集书第____页的____数据与审计报告第____页存在差异，请核对。','合规关注':'请特别核对____事项是否符合适用规定，相关依据为____。','公开信息线索':'关于____事项，已知公开信息或查询线索为____，请核验。','复核重点':'请在全文复核时特别关注____。'};const d=draft(state.route),example=examples[value]||'';d.messageDraft=[d.messageDraft?.trim(),example].filter(Boolean).join('\n');saveDraft(state.route);await render();document.querySelector('#project-message').value=d.messageDraft;document.querySelector('#project-message').focus();return true;}
    if(action==='project-remove-message'){conversation.remove(state.route,Number(value));await render();return true;}
    if(action==='project-resume'){
      const {job}=await api('/api/tasks/'+value);const kind=job.kind;const [exchange,offering]=job.context.scope.split('-');
      state.drafts[kind]={...draft(kind),...job.context,title:job.title,exchange,offering,year:job.context.periods.slice(0,4),quarter:job.context.periods.slice(5),projectId:job.id,assessment:job.quote?job:undefined,conversationTopic:'',conversationDrafts:{},informationLayout:undefined,messageDraft:'',messageEditIndex:undefined};
      state.files[kind]=job.files.map(f=>({stored:true,key:f.key,role:f.role,file:{name:f.filename,size:f.size}}));saveDraft(kind);state.resumeProjectStep=2;location.hash=kind;return true;
    }
    if(action==='retry-project-upload'){const kind=state.route,item=state.files[kind][Number(value)];if(item&&!item.stored)await transfer(kind,item);return true;}
    if(action==='remove-file'){
      const kind=state.route,item=state.files[kind][Number(value)],key=operationKey(kind);if(!item||item.uploadStatus==='uploading')return true;
      pending.set(key,'正在移除材料…');invalidate(kind);await render();
      try{if(item.stored)await api(`/api/projects/${draft(kind).projectId}/materials/${item.key}`,{method:'DELETE'});if(operationKey(kind)===key)state.files[kind]=state.files[kind].filter(f=>f!==item);}
      finally{pending.delete(key);if(state.route===kind&&operationKey(kind)===key)await render();}
      return true;
    }
    return false;
  }
  return {page,submit,click,input,change,invalidate,quoteContent,addFiles};
}
