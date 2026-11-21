/** Failed requires an explicit page outcome; absent evidence remains missing. */
export function pageCoverage(pageCount:number,covered:number[],failed:number[]=[]){
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>1500)throw Error('WORKFLOW_PAGE_COVERAGE_INVALID');
  for(const p of [...covered,...failed])if(!Number.isSafeInteger(p)||p<1||p>pageCount)throw Error('WORKFLOW_PAGE_COVERAGE_INVALID');
  const success=new Set(covered),failure=new Set(failed.filter(p=>!success.has(p)));
  return {page_count:pageCount,covered:[...success].sort((a,b)=>a-b),failed:[...failure].sort((a,b)=>a-b),missing:Array.from({length:pageCount},(_,i)=>i+1).filter(p=>!success.has(p)&&!failure.has(p))};
}
