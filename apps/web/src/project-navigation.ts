/** Keep the collection entry and filters in the URL across project navigation. */
export function projectNavigationContext(query=new URLSearchParams(location.hash.split('?')[1])) {
  const from=query.get('from');return from==='dashboard'||from==='projects'?'projects':null;
}
export function projectListContext(query=new URLSearchParams(location.hash.split('?')[1])) {return projectNavigationContext(query)!==null;}
export function projectSection(fallback:string) {return projectNavigationContext()??fallback;}
export function withProjectContext(query:URLSearchParams, fromList=projectListContext()) {
  if(fromList){const source=new URLSearchParams(location.hash.split('?')[1]);query.set('from',projectNavigationContext(source)??'projects');for(const key of ['dashboard_kind','dashboard_status']){const value=source.get(key);if(value)query.set(key,value);}}
  return query;
}
export function projectBackLink() {
  return '<a class="back-link" href="#tasks">← 返回全部项目</a>';
}
