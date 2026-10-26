import type {IntegrityDiagnostic,IntegrityFinding,IntegrityRecord} from './integrity.js';

const diagnosticLabels:Record<IntegrityDiagnostic['code'],string>={
 results:'搜索返回结果',no_results:'搜索无返回结果',captcha_required:'需要验证码',login_required:'需要登录',authentication_required:'需要验证码和登录',
 access_denied:'网站拒绝访问',http_error:'网站响应错误',blank_page_timeout:'页面空白（加载超时）',page_load_timeout:'页面加载超时',
 result_load_timeout:'查询结果加载超时',query_form_unavailable:'查询控件未就绪',result_unverified:'本次查询结果未确认',network_error:'网络连接失败',page_error:'网站页面报错',operation_failed:'查询操作未完成'
};
export function integrityDiagnosticLabel(d:IntegrityDiagnostic){
 return diagnosticLabels[d.code]+(d.http_status?`（HTTP ${d.http_status}${d.http_status===403?' Forbidden':''}）`:'');
}
export function integrityFindingLabel(f:IntegrityFinding){
 if(f.subject_match==='different_subject')return '其他主体记录';
 if(f.subject_match==='unconfirmed')return f.nature==='adverse'?'不利事项线索 · 主体未确认':'搜索命中 · 主体未确认';
 return f.nature==='adverse'?'不利记录 · 企业全称匹配':f.nature==='information'?'一般信息 · 企业全称匹配':'事项性质待确认 · 企业全称匹配';
}
const cleanReason=(s:string)=>s.replace(/(?:[，；、\s]*(?:待人工补证|待补证|待人工补充信息|需要人工补充信息|请(?:人工)?上传补充证据))[。；]?/g,'').trim();
export type IntegrityPresentation={label:string;description:string;tone:'neutral'|'warning'|'danger';group:'results'|'no_results'|'incomplete'|'not_applicable'};
/** One display contract for web and Word. Persisted historical observations are never rewritten. */
export function integrityRecordPresentation(record:IntegrityRecord):IntegrityPresentation{
 const d=record.browser?.diagnostic,reason=cleanReason(record.reason);
 const view=(label:string,group:IntegrityPresentation['group'],tone:IntegrityPresentation['tone']='neutral',description=reason):IntegrityPresentation=>({label,group,tone,description});
 if(record.status==='not_applicable')return view('不适用','not_applicable');
 if(record.status==='public_matches'){
  const findings=record.findings;
  const summary=findings?.length?findings.map(f=>`${integrityFindingLabel(f)}：${f.title}\n${f.explanation}`).join('\n'):reason;
  if(findings?.some(f=>f.nature==='adverse'&&f.subject_match==='company_name'))return view('发现不利记录（企业全称匹配）','results','danger',summary);
  if(findings?.some(f=>f.nature==='adverse'&&f.subject_match==='unconfirmed'))return view('发现不利线索（主体未确认）','results','warning',summary);
  if(findings?.length&&findings.every(f=>f.subject_match==='different_subject'))return view('搜索返回其他主体记录','results','neutral',summary);
  if(findings?.length&&findings.every(f=>f.nature==='information'&&f.subject_match==='company_name'))return view('搜索返回一般信息','results','neutral',summary);
  return view('搜索返回结果（关联待确认）','results','warning',summary);
 }
 if(record.status==='no_public_results')return view('搜索无返回结果','no_results');
 if(d){const phase={open:'加载官网',query:'提交查询',results:'等待查询结果'}[d.phase];return view(integrityDiagnosticLabel(d),'incomplete','warning',`${reason}\n发生阶段：${phase}${d.attempts?` · 已尝试 ${d.attempts} 次`:''}${d.elapsed_ms!==undefined?` · 总耗时 ${Math.ceil(d.elapsed_ms/1000)} 秒`:''}`);}
 // Historical free text can only support causes it explicitly records; do not guess a phase or status code.
 const http=reason.match(/\bHTTP\s*(4\d{2}|5\d{2})\b/i)??reason.match(/\b(403)\s*Forbidden\b/i);
 if(http)return view(integrityDiagnosticLabel({code:http[1]==='403'?'access_denied':'http_error',phase:'open',http_status:Number(http[1])}),'incomplete','warning');
 if(/拒绝访问|访问已被拦截|访问受限|Forbidden|GeoBL/i.test(reason))return view('网站拒绝访问','incomplete','warning');
 if(/验证码或登录|验证码\s*\/\s*登录/.test(reason))return view('验证码／登录受限（类型未记录）','incomplete','warning');
 if(/要求验证码|需要验证码/.test(reason))return view('需要验证码','incomplete','warning');
 if(/要求登录|需要登录|请先登录/.test(reason))return view('需要登录','incomplete','warning');
 if(/超时/.test(reason))return view('查询超时（阶段未记录）','incomplete','warning');
 return view('查询未完成（原因未记录）','incomplete','warning',reason?`${reason} 历史记录未保存可区分的失败原因。`:'历史记录未保存具体失败原因。');
}
