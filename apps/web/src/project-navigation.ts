/** Keep the collection entry and filters in the URL across project navigation. */
export function projectNavigationContext(query=new URLSearchParams(location.hash.split('?')[1])) {
  const from=query.get('from');return from==='dashboard'||from==='projects'?from:null;
}
export function projectListContext(query=new URLSearchParams(location.hash.split('?')[1])) {return projectNavigationContext(query)!==null;}
export function projectSection(fallback:string) {return projectNavigationContext()??fallback;}
export function withProjectContext(query:URLSearchParams, fromList=projectListContext()) {
  if(fromList){const source=new URLSearchParams(location.hash.split('?')[1]);query.set('from',projectNavigationContext(source)??'projects');for(const key of ['dashboard_kind','dashboard_status']){const value=source.get(key);if(value)query.set(key,value);}}
  return query;
}
export function projectBackLink() {
  const source=new URLSearchParams(location.hash.split('?')[1]);
  if(projectNavigationContext(source)!=='dashboard')return '<a class="back-link" href="#tasks">← 返回全部项目</a>';
  const query=new URLSearchParams(),kind=source.get('dashboard_kind'),status=source.get('dashboard_status');
  if(kind&&['update','review','generation'].includes(kind))query.set('kind',kind);
  if(status&&['attention','active','done'].includes(status))query.set('status',status);
  return `<a class="back-link" href="#dashboard${query.size?'?'+query:''}">← 返回工作台</a>`;
}
