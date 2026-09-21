'use strict';
const $=id=>document.getElementById(id);
let csrf='',current='',busy=false,loading=false,uploading=false,requestId='',project=null;
const knowledgeChoices=new Map();
const labels={prospectus:'历史募集书',financial:'财务报表',notes:'财务附注',audit:'审计报告',credit:'征信材料',registry:'工商材料',rating:'评级材料',other:'其他材料'};
async function api(path,data,raw=false,retried=false){
  const response=await fetch(path,{method:data===undefined?'GET':'POST',cache:'no-store',headers:data===undefined?{}:{'X-Bond-Token':csrf,'Content-Type':raw?'application/octet-stream':'application/json'},body:data===undefined?undefined:raw?data:JSON.stringify(data)});
  let result;try{result=await response.json()}catch{throw new Error('请求失败，请稍后重试')}
  if(response.status===403&&data!==undefined&&!retried&&(result.code==='request_token_invalid'||String(result.error||'').includes('访问校验失败'))){
    const health=await api('/api/health?_refresh='+Date.now());
    csrf=health.csrf;
    return api(path,data,raw,true);
  }
  if(!response.ok)throw new Error(result.code==='request_token_invalid'?'连接未能恢复，请稍后重新提交。':result.error||'请求失败，请稍后重试');
  return result;
}

function error(e){$('error').textContent=e?.message||'';}
async function list(select=current){
  const projects=await api('/api/projects');
  $('projects').replaceChildren(new Option('选择项目',''),...projects.map(p=>new Option(p.title,p.id)));
  if(projects.some(p=>p.id===select)){$('projects').value=select;current=select;await refresh()}
}
async function refresh(){
  if(!current||loading)return;loading=true;const id=current;
  try{
    const p=await api('/api/projects/'+id);if(id!==current)return;project=p;
    $('empty').hidden=true;$('detail').hidden=false;$('project-title').textContent=p.title;
    $('project-period').textContent='目标报告期：'+p.period+' · 全文更新';
    busy=['queued','running'].includes(p.job.status);
    $('use-reference-knowledge').checked=busy?!!p.job.use_reference_knowledge:knowledgeChoices.get(id)===true;
    $('use-reference-knowledge').disabled=busy;
    $('material-list').replaceChildren(...p.files.map(f=>{const li=document.createElement('li');li.textContent=(labels[f.category]||'材料')+' · '+f.name;return li}));
    $('run').disabled=busy||uploading||!p.original_id||!p.files.some(f=>f.role==='source');$('upload-button').disabled=busy||uploading;
    $('cancel').hidden=!busy;$('progress').hidden=!busy;
    if(p.job.progress_mode==='indeterminate')$('progress').removeAttribute('value');else $('progress').value=p.job.progress||0;
    const d=p.direct_word;
    $('download').hidden=busy||!d||!['ready','partial'].includes(d.status);
    $('download').href='/api/projects/'+id+'/export?view=revision';
    $('download').textContent=d?.status==='partial'?'下载修订 Word（含未完成事项）':'下载修订 Word';
    $('usage').href='/api/projects/'+id+'/usage';$('usage').download=p.title+'_用量记录.json';
    $('status').textContent=busy?(p.job.step||'正在更新全文'):d?.status==='ready'?'Word 已生成，可以下载':d?.status==='partial'?(d.execution_error?'任务未完成，已保存阶段 Word':'Word 已生成，部分内容缺少材料'):['failed','interrupted'].includes(p.job.status)?(p.job.error||'本次更新未完成'):d?.status==='cancelled'?'任务已停止':'材料准备好后即可开始全文更新';
    $('delivery-note').textContent=!busy&&d&&['ready','partial'].includes(d.status)?(d.workflow==='cli_word_v1'?(d.notes||d.summary||'更新范围与材料缺项请参见 Word 批注。'):('已检查 '+d.checked_locations+' 处，更新 '+d.updated_locations+' 处。'+(d.issues?.length?'尚有 '+d.issues.length+' 项未完成，详见 Word 批注。':''))):'生成后可在 Word「审阅 → 所有标记」查看全部改动。';
  }finally{loading=false}
}
async function guarded(fn){error(null);try{await fn()}catch(e){error(e)}}
$('projects').addEventListener('change',()=>guarded(async()=>{current=$('projects').value;requestId='';$('use-reference-knowledge').disabled=!current;$('use-reference-knowledge').checked=knowledgeChoices.get(current)===true;history.replaceState(null,'',current?'?project='+encodeURIComponent(current):location.pathname);$('detail').hidden=!current;$('empty').hidden=!!current;await refresh()}));
$('new-project').addEventListener('submit',e=>{e.preventDefault();guarded(async()=>{const p=await api('/api/projects',{title:$('title').value,period:$('period').value,mode:'full'});current=p.id;requestId='';await list(p.id)})});
$('upload').addEventListener('submit',e=>{e.preventDefault();guarded(async()=>{if(!current)throw new Error('请先选择项目');const id=current,category=$('category').value,files=[...$('files').files];if(!files.length)throw new Error('请选择材料');if(category==='prospectus'&&(files.length!==1||!files[0].name.toLowerCase().endsWith('.docx')))throw new Error('请选择一份 DOCX 历史募集书');uploading=true;$('upload-button').disabled=true;$('run').disabled=true;try{for(const f of files){$('status').textContent='正在上传：'+f.name;const query=new URLSearchParams({name:f.name,role:category==='prospectus'?'prospectus':'source',category});await api('/api/projects/'+id+'/files?'+query,f,true)}$('files').value='';requestId=''}finally{uploading=false;await refresh()}})});
$('run').addEventListener('click',()=>guarded(async()=>{$('run').disabled=true;requestId=requestId||crypto.randomUUID();await api('/api/projects/'+current+'/direct-word',{message:'请将全文更新至项目目标报告期，直接生成修订 Word。'+$('instruction').value,request_id:requestId,use_reference_knowledge:$('use-reference-knowledge').checked});requestId='';await refresh()}));
$('use-reference-knowledge').addEventListener('change',()=>{knowledgeChoices.set(current,$('use-reference-knowledge').checked);requestId=''});
$('cancel').addEventListener('click',()=>guarded(async()=>{await api('/api/projects/'+current+'/cancel',{});await refresh()}));
guarded(async()=>{csrf=(await api('/api/health')).csrf;await list(new URLSearchParams(location.search).get('project')||'project_328395d18d6e')});
setInterval(()=>{if(current&&!document.hidden)guarded(refresh)},5000);
