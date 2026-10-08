import { GENERATION_TYPES,generationType,generationSections } from './generation-catalog.js';
export function materialStudio({state,esc,icon,bytes,head,api,upload,render,toast,refreshJobs,document=globalThis.document,location=globalThis.location}){
  function draft(){if(!state.materialDraft){let saved={};try{saved=JSON.parse(globalThis.localStorage?.getItem('bondbuddy-material-'+(state.user?.id||'guest'))||'{}');}catch{}state.materialDraft={type:'initiation',market:'',sourceMode:'upload',projectId:'',broker:'',templateId:'',summaryKind:'private',instructionDraft:'',instructionMessages:[],...saved,files:[],templates:[],templatesBroker:'',busy:false,progress:null,error:''};if(!Array.isArray(saved.instructionMessages))state.materialDraft.instructionMessages=typeof saved.instructions==='string'&&saved.instructions.trim()?[{text:saved.instructions.trim()}]:[];delete state.materialDraft.instructions;if(state.materialDraft.sourceMode!=='project'||!state.materialDraft.projectId)state.materialDraft.sourceMode='upload';if(!generationType(state.materialDraft.type))state.materialDraft.type='initiation';}return state.materialDraft;}
  function persist(){const d=draft(),values=Object.fromEntries(['type','market','sourceMode','projectId','broker','templateId','summaryKind','instructionMessages','instructionDraft','instructionEditIndex'].map(key=>[key,d[key]]));try{globalThis.localStorage?.setItem('bondbuddy-material-'+(state.user?.id||'guest'),JSON.stringify(values));}catch{}}
  const field=(id,label,value,placeholder='',required=false)=>`<label class="field"><span>${label}${required?' <span class="required">*</span>':''}</span><input name="${id}" data-studio-field="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required?'required':''} maxlength="200"></label>`;
  function fileList(role){return draft().files.filter(f=>f.role===role).map(f=>`<div class="file-item"><div class="file-icon">${icon('file')}</div><div class="file-name"><strong>${esc(f.file.name)}</strong><small>${bytes(f.file.size)} · 已选择，生成时上传</small></div><button type="button" class="icon-btn" data-action="studio-remove-file" data-value="${draft().files.indexOf(f)}" aria-label="移除${esc(f.file.name)}">${icon('close')}</button></div>`).join('');}
  function zone(role,title,hint,accept='.docx,.pdf',multiple=false){return `<section class="material-group"><h3>${title}</h3><p>${hint}</p><label class="dropzone compact-dropzone" data-studio-upload="${role}">${icon('upload')}<strong>点击或拖入文件</strong><span>${accept.replaceAll('.','').replaceAll(',',' / ').toUpperCase()}</span><input type="file" data-studio-upload="${role}" accept="${accept}" ${multiple?'multiple':''} aria-label="上传${title}"></label><div class="file-list">${fileList(role)}</div></section>`;}
  function instructionText(messages){
    if(messages.length>50)throw new Error('最多保留50条说明，请删除或合并后再继续。');
    const text=messages.map(m=>m.text.trim()).filter(Boolean).join('\n\n');
    if(text.length>12000)throw new Error('补充说明与写作要求合计不能超过12000字，请精简后再继续。');
    return text;
  }
  function commitInstruction(){
    const d=draft(),text=d.instructionDraft?.trim();if(!text)return false;
    const messages=[...d.instructionMessages],index=d.instructionEditIndex;
    if(Number.isInteger(index)&&messages[index])messages[index]={text};else messages.push({text});
    instructionText(messages);d.instructionMessages=messages;d.instructionDraft='';delete d.instructionEditIndex;persist();return true;
  }
  function templatePreview(d,type){
    return `<details class="studio-template-details"><summary>查看${type.title}的模板结构</summary><p>${d.type==='initiation'?'实际采用该券商的模板章节与要求，以下为常见内容参考。':'采用对应材料模板，结合募集书提取所需信息。'}</p><ol>${generationSections(d.type,d.summaryKind).map(s=>`<li>${s.title}</li>`).join('')}</ol><div class="studio-delivery">${icon('file')}<strong>可编辑 Word + 编制说明</strong><p>缺失信息会列为待补充，并保留引用来源。</p></div></details>`;
  }
  function page(){
    const d=draft(),type=generationType(d.type),ready=state.health.materialStudioVersion===1,projects=state.jobs.filter(j=>['update','review'].includes(j.kind));
    const selected=projects.find(j=>j.id===d.projectId),pending=selected?.kind==='update'&&selected.status!=='complete';
    return head('材料生成','上传最新版募集书，或关联已有募集书项目，按对应模板生成材料。','MATERIAL STUDIO')+`<div class="studio-layout material-studio-single"><form id="material-studio-form"><fieldset ${d.busy?'disabled':''}><section class="panel form-card"><h2>要生成哪份材料</h2><div class="material-type-grid">${GENERATION_TYPES.map(t=>`<label class="material-type ${t.id===d.type?'selected':''}"><input type="radio" name="type" data-studio-field="type" value="${t.id}" ${t.id===d.type?'checked':''}><strong>${t.title}</strong><span>${t.description}</span></label>`).join('')}</div>${d.type==='summary'?`<div class="history-answer" role="group" aria-label="摘要类型">${[['private','私募债摘要'],['public','公募债摘要']].map(([v,label])=>`<label class="choice"><input type="radio" name="summaryKind" data-studio-field="summaryKind" value="${v}" ${d.summaryKind===v?'checked':''}>${label}</label>`).join('')}</div>`:''}${templatePreview(d,type)}</section><section class="panel form-card"><h2>选择交易所</h2><label class="field"><span>交易所 <span class="required">*</span></span><select data-studio-field="market"><option value="">请选择交易所</option><option value="sse" ${d.market==='sse'?'selected':''}>上海证券交易所</option><option value="szse" ${d.market==='szse'?'selected':''}>深圳证券交易所</option></select></label><p class="authoring-help">按所选交易所采用对应材料的编制要求。</p></section><section class="panel form-card"><h2>这份材料依据哪份募集书</h2><p>会从募集书和关联资料中提取信息；已关联的材料无需重复上传。</p><div class="history-answer">${[['upload','上传最新版募集书'],['project','关联募集书项目']].map(([v,label])=>`<label class="choice"><input type="radio" name="sourceMode" data-studio-field="sourceMode" value="${v}" ${d.sourceMode===v?'checked':''}>${label}</label>`).join('')}</div>${d.sourceMode==='project'?`<label class="field"><span>募集书项目 <span class="required">*</span></span><select name="projectId" data-studio-field="projectId" required><option value="">请选择项目</option>${projects.map(j=>`<option value="${esc(j.id)}" ${j.id===d.projectId?'selected':''}>${esc(j.title)} · ${j.status==='complete'?'已完成':'当前上传稿'}</option>`).join('')}</select></label>${!projects.length?'<p class="authoring-help">还没有募集书项目，可以选择上传最新版募集书。</p>':''}${pending?'<p class="notice">此项目更新尚未完成，将使用当前上传的历史稿。需要更新后的信息时，请等待项目完成或上传最新版。</p>':''}`:zone('prospectus','最新版募集说明书','必需 · 1 份 DOCX 或可检索 PDF。') }</section>${d.type==='initiation'?`<section class="panel form-card"><h2>按立项券商的要求编写</h2>${field('broker','立项券商全称',d.broker,'例如：某某证券股份有限公司',true)}<p class="authoring-help">不同券商的模板可能不同。填写券商名称后，可查找本账号已保存的模板。</p><button type="button" class="btn secondary small" data-action="studio-find-template" ${!ready?'disabled':''}>查找已保存模板</button>${d.templatesBroker===d.broker&&d.templates.length?`<div class="saved-template-list">${d.templates.map((t,i)=>`<label class="choice"><input type="radio" name="templateId" data-studio-field="templateId" value="${t.id}" ${t.id===d.templateId?'checked':''}><span><strong>${esc(t.filename)}</strong><small>${new Date(t.createdAt).toLocaleDateString('zh-CN')} 保存${i===0?' · 最近保存模板':''}</small></span></label>`).join('')}</div><p class="authoring-help">可直接复用；上传新模板时优先使用新文件，并保留旧版本。</p>`:d.templatesBroker===d.broker&&d.broker?'<p class="authoring-help">尚未保存该券商的模板，请在下方提供一份。</p>':''}${zone('generationTemplate','立项模板或已完成的立项报告',d.templates.length?'选填 · 需要采用新版本时上传，后续同券商项目可复用。':'首次使用该券商时必需。上传后保存在当前账号的券商模板库，后续不必重复提供。','.docx,.pdf,.txt')}${zone('generationRules','立项相关规则','建议提供券商的立项管理办法、准入标准、负面清单或材料要求。','.docx,.pdf,.txt',true)}</section>`:''}<section class="panel form-card"><h2>补充资料</h2>${zone('other','其他支持材料','选填 · 发行安排、授信、尽调资料等，可按现有情况补充。','.docx,.pdf,.xlsx,.csv,.txt',true)}</section><section class="panel form-card"><h2><label for="studio-requirements">材料生成要求与说明</label> <small class="material-optional">选填</small></h2><textarea id="studio-requirements" data-studio-field="instructionDraft" rows="5" maxlength="12000" placeholder="补充材料用途、写作重点、格式要求或其他需要说明的事项。">${esc(d.instructionDraft||'')}</textarea><p class="authoring-help">自动保存，点击生成时与本次材料一起提交。</p></section></fieldset>${!ready?'<p class="notice">新版材料生成等待服务重启。填写内容会保留，重启并刷新后再提交。</p>':''}${d.busy?`<div class="upload-summary" role="status"><strong>${d.progress===100?'文件传输完成，正在整理材料…':`正在上传材料 ${d.progress===null?'':d.progress+'%'}`}</strong><progress max="100" ${d.progress===null?'':`value="${d.progress}"`} aria-label="材料上传进度"></progress></div>`:''}${d.error?`<p class="upload-error" role="alert">${esc(d.error)}</p>`:''}<div class="form-footer"><span>生成可编辑 Word 和编制说明。</span><button type="submit" class="btn primary" ${!ready||d.busy?'disabled':''}>${d.busy?'正在提交…':'生成'+type.title}</button></div></form></div>`;
  }
  function input(el){if(!el.dataset?.studioField)return false;const d=draft();if(d.busy)return true;d[el.dataset.studioField]=el.value;persist();return true;}
  async function change(el){
    if(draft().busy)return Boolean(el.dataset?.studioUpload||el.dataset?.studioField);
    if(el.dataset?.studioUpload){addFiles(el.files,el.dataset.studioUpload);return true;}
    if(!el.dataset?.studioField)return false;input(el);const d=draft();
    if(el.dataset.studioField==='broker'){d.templates=[];d.templateId='';d.templatesBroker='';if(d.broker.trim()&&state.health.materialStudioVersion===1){await click('studio-find-template');return true;}}
    if(el.dataset.studioField==='projectId'){const project=state.jobs.find(j=>j.id===d.projectId);if(project?.context?.scope)d.summaryKind=project.context.scope.endsWith('-private')?'private':'public';}
    persist();if(el.dataset.studioField!=='instructionDraft')await render();return true;
  }
  function addFiles(files,role){
    const d=draft();if(d.busy)return;const list=Array.from(files),single=['prospectus','generationTemplate'].includes(role);
    if(single&&list.length!==1)throw new Error('本分区提供一份文件即可。');
    const allowed=role==='prospectus'?/\.(docx|pdf)$/i:role==='generationTemplate'||role==='generationRules'?/\.(docx|pdf|txt)$/i:/\.(docx|pdf|xlsx|csv|txt)$/i;
    let next=single?d.files.filter(f=>f.role!==role):[...d.files];
    for(const file of list){if(!file.size||!allowed.test(file.name))throw new Error('文件为空或格式不支持。');if(next.some(f=>f.role===role&&f.file.name===file.name&&f.file.size===file.size))continue;next.push({file,role});}
    if(next.length>60||next.reduce((n,f)=>n+f.file.size,0)>80*1024*1024)throw new Error('最多60份文件，合计80 MB。');d.files=next;void render();
  }
  async function click(action,value){
    if(!action.startsWith('studio-'))return false;const d=draft();if(d.busy)return true;
    if(action==='studio-instruction-edit'){
      const index=Number(value);if(!Number.isInteger(index)||!d.instructionMessages[index])return true;commitInstruction();d.instructionEditIndex=index;d.instructionDraft=d.instructionMessages[index].text;persist();await render();document?.querySelector('#studio-message')?.focus?.();return true;
    }
    if(action==='studio-instruction-remove'){
      const index=Number(value);if(!Number.isInteger(index)||!d.instructionMessages[index])return true;d.instructionMessages.splice(index,1);if(d.instructionEditIndex===index){delete d.instructionEditIndex;d.instructionDraft='';}else if(d.instructionEditIndex>index)d.instructionEditIndex--;persist();await render();return true;
    }
    if(action==='studio-instruction-cancel'){delete d.instructionEditIndex;d.instructionDraft='';persist();await render();return true;}
    if(action==='studio-writing-prompt'){
      const example={focus:'请重点说明偿债来源和资金用途，并结合募集书中的数据提供依据。',format:'请使用正式、审慎的书面表述，金额单位与募集书保持一致。',extra:'补充一项项目信息：'}[value];if(!example)return true;d.instructionDraft=[d.instructionDraft?.trim(),example].filter(Boolean).join('\n');persist();await render();document?.querySelector('#studio-message')?.focus?.();return true;
    }
    if(action==='studio-remove-file'){if(!d.busy)d.files.splice(Number(value),1);await render();return true;}
    if(action==='studio-find-template'){
      const broker=d.broker.trim();if(!broker)throw new Error('请先填写立项券商全称。');const epoch=state.accountEpoch;
      const {templates}=await api('/api/generation/templates?broker='+encodeURIComponent(broker));if(epoch!==state.accountEpoch||d.broker.trim()!==broker)return true;
      d.broker=broker;d.templatesBroker=broker;d.templates=templates;d.templateId=templates[0]?.id||'';persist();await render();return true;
    }return false;
  }
  async function submit(form){
    if(form.id==='studio-message-form'){if(!draft().busy){commitInstruction();await render();}return true;}
    if(form.id!=='material-studio-form')return false;const d=draft();if(d.busy)return true;
    if(state.health.materialStudioVersion!==1||!state.health.oneClickExecution)throw new Error('请重启本地服务并刷新页面。');
    if(!form.reportValidity())return true;
    if(d.sourceMode==='project'&&!d.projectId)throw new Error('请选择募集书项目。');
    if(d.sourceMode==='upload'&&!d.files.some(f=>f.role==='prospectus'))throw new Error('请上传最新版募集书。');
    commitInstruction();const instructions=instructionText(d.instructionMessages);
    const epoch=state.accountEpoch,data=new FormData();const fingerprint=JSON.stringify([d.type,d.summaryKind,instructions,d.broker,d.templateId,d.projectId,d.sourceMode,d.files.map(f=>[f.role,f.file.name,f.file.size,f.file.lastModified])]);if(d.requestFingerprint!==fingerprint){d.requestId=crypto.randomUUID();d.requestFingerprint=fingerprint;}d.requestId??=crypto.randomUUID();data.set('requestId',d.requestId);data.set('materialType',d.type);data.set('summaryKind',d.summaryKind);data.set('instructions',instructions);data.set('broker',d.broker.trim());data.set('templateId',d.templateId);if(d.sourceMode==='project')data.set('projectId',d.projectId);
    for(const f of d.files)if((f.role!=='prospectus'||d.sourceMode==='upload')&&(!['generationTemplate','generationRules'].includes(f.role)||d.type==='initiation'))data.append(f.role,f.file);
    if(d.type!=='initiation'){data.delete('broker');data.delete('templateId');}
    d.busy=true;d.progress=0;d.error='';await render();
    try{const {job}=await upload('/api/generation/tasks',data,{onProgress:p=>{if(epoch!==state.accountEpoch)return;d.progress=p.percent;if(state.route==='generate')void render();}});if(epoch!==state.accountEpoch)return true;d.files=[];d.requestId=null;d.busy=false;await refreshJobs();location.hash='task/'+job.id;}
    catch(error){if(epoch!==state.accountEpoch)return true;d.error=error.message;d.busy=false;if(state.route==='generate')await render();throw error;}return true;
  }
  return {page,input,change,click,submit,addFiles};
}
