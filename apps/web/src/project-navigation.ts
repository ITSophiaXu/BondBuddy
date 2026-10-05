/** Carry list context in the URL so reload/new tabs preserve the selected navigation. */
export function projectListContext(query=new URLSearchParams(location.hash.split('?')[1])) {
  return query.get('from')==='projects';
}
export function withProjectContext(query:URLSearchParams, fromList=projectListContext()) {
  if(fromList)query.set('from','projects');
  return query;
}
export const projectBackLink='<a class="back-link" href="#tasks">← 返回全部项目</a>';
