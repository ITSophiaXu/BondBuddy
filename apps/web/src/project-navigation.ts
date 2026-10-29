/** Keep the collection entry and filters in the URL across project navigation. */
export function projectNavigationContext(query=new URLSearchParams(location.hash.split('?')[1])) {
  const from=query.get('from');return from==='dashboard'||from==='projects'?'projects':null;
}
export function projectListContext(query=new URLSearchParams(location.hash.split('?')[1])) {return projectNavigationContext(query)!==null;}
export function projectSection(fallback:string) {return projectNavigationContext()??fallback;}
export function withProjectContext(query:URLSearchParams, fromList=projectListContext()) {
  const source=new URLSearchParams(location.hash.split('?')[1]);
  const project=navigationProjectContext(location.hash);
  if(project&&!query.has('return_project'))query.set('return_project',project.projectId);
  if(fromList){query.set('from',projectNavigationContext(source)??'projects');for(const key of ['dashboard_kind','dashboard_status']){const value=source.get(key);if(value)query.set(key,value);}}
  return query;
}
export function projectBackLink() {
  return '<a class="back-link" href="#tasks">← 返回任务进度与结果</a>';
}

export type ProjectWork='files'|'update'|'review'|'generate'|'integrity'|'qa'|'consistency';
export type NavigationProject={projectId:string;work:ProjectWork|null};
const projectId=(value:string|null)=>value&&value.length<=128&&!/[\u0000-\u001f]/.test(value)?value:null;

/** The return project is navigation context only; execution keeps its real workspace ID. */
export function navigationProjectContext(hash:string):NavigationProject|null {
  const raw=hash.replace(/^#/,''),[path,search='']=raw.split('?'),query=new URLSearchParams(search);
  const direct=path.match(/^\/projects\/([^/]+)(?:\/(files|review))?$/);
  let executionProject:string|null=null,work:ProjectWork|null=null;
  if(direct){
    try{executionProject=projectId(decodeURIComponent(direct[1]));}catch{return null;}
    work=direct[2]==='files'?'files':direct[2]==='review'?'review':'update';
  }else if(/^(?:\/?update|review|generate|integrity|qa|consistency)$/.test(path)){
    executionProject=projectId(query.get('project'));work=path.replace(/^\//,'') as ProjectWork;
    // A material task is addressed by topic; its return project is navigation only.
    if(!executionProject&&work==='generate'&&projectId(query.get('topic')))executionProject=projectId(query.get('return_project'));
  }else if(path==='/account'||path==='billing'){
    executionProject=projectId(query.get('project'));
    if(!executionProject&&workReturnTo(query.get('return_to')))executionProject=projectId(query.get('return_project'));
  }
  else if(/^\/artifacts\/[^/]+$/.test(path))executionProject=projectId(query.get('return_project'));
  if(!executionProject)return null;
  return {projectId:projectId(query.get('return_project'))??executionProject,work};
}

export function projectWorkHref(work:ProjectWork,id:string) {
  if(work==='files')return '#/projects/'+encodeURIComponent(id)+'/files';
  const query=new URLSearchParams({project:id,from:'projects',return_project:id});
  return '#'+work+'?'+query;
}

/** Only an existing business route can be a recharge return destination. */
export function workReturnTo(value:string|null):string|null {
  if(!value||value.length>2048||!value.startsWith('#')||value.slice(1).includes('#')||/[\\\u0000-\u001f\u007f]/.test(value))return null;
  try{if(/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value)))return null;}catch{return null;}
  const [path,search='']=value.slice(1).split('?'),query=new URLSearchParams(search);
  const direct=path.match(/^\/projects\/([^/]+)(?:\/(files|review))?$/),artifact=path.match(/^\/artifacts\/([^/]+)$/);
  if(direct||artifact){try{return projectId(decodeURIComponent((direct??artifact)![1]))?value:null;}catch{return null;}}
  if(!/^(?:\/?update|review|generate|integrity|qa|consistency)$/.test(path))return null;
  return (projectId(query.get('project'))||(path==='generate'&&projectId(query.get('topic'))))?value:null;
}

/** The order keeps its execution project; navigation keeps the original project separately. */
export function rechargeHref(executionProjectId?:string,hash=location.hash):string {
  const source=new URLSearchParams(hash.split('?')[1]),returnTo=workReturnTo(hash)??workReturnTo(source.get('return_to'));
  const path=hash.replace(/^#/,'').split('?')[0],direct=path.match(/^\/projects\/([^/]+)(?:\/(?:files|review))?$/);
  let execution=projectId(executionProjectId??null);
  if(!execution&&direct){try{execution=projectId(decodeURIComponent(direct[1]));}catch{/* No order project is inferred from a malformed route. */}}
  if(!execution&&/^(?:\/?update|review|generate|integrity|qa|consistency|\/account|billing)$/.test(path))execution=projectId(source.get('project'));
  const query=new URLSearchParams();if(execution)query.set('project',execution);
  const context=navigationProjectContext(hash)??(returnTo?navigationProjectContext(returnTo):null);
  if(context)query.set('return_project',context.projectId);
  if(returnTo)query.set('return_to',returnTo);
  return '#/account'+(query.size?'?'+query:'');
}
