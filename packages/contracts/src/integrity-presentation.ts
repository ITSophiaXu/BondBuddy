import type {IntegrityDiagnostic,IntegrityFinding,IntegrityRecord} from './integrity.js';

const diagnosticLabels:Record<IntegrityDiagnostic['code'],string>={
 results:'搜索返回结果',no_results:'搜索无返回结果',captcha_required:'需要验证码',login_required:'需要登录',authentication_required:'需要验证码和登录',
 access_denied:'网站拒绝访问',http_error:'网站响应错误',blank_page_timeout:'页面空白（加载超时）',page_load_timeout:'页面加载超时',
 result_load_timeout:'查询结果加载超时',query_form_unavailable:'查询页面尚未就绪',result_unverified:'本次查询结果未确认',network_error:'网络连接失败',page_error:'网站页面报错',operation_failed:'查询操作未完成'
};
export function integrityDiagnosticLabel(d:IntegrityDiagnostic){
 return diagnosticLabels[d.code];
}
const diagnosticDescriptions:Record<IntegrityDiagnostic['code'],string>={
 results:'官网搜索返回结果，具体事项及主体关联以本次查询记录为准。',
 no_results:'官网已响应本次查询，页面明确显示无结果；仅限本次查询词和页面范围。',
 captcha_required:'网站要求输入验证码，本次自动查询未能完成。',
 login_required:'网站要求登录后查询，本次自动查询未能完成。',
 authentication_required:'网站要求登录并输入验证码，本次自动查询未能完成。',
 access_denied:'网站拒绝了本次访问，未能完成查询。',
 http_error:'网站未正常返回查询页面或结果，本次查询未完成。',
 blank_page_timeout:'等待后页面仍为空白，未取得可确认的查询结果。',
 page_load_timeout:'等待后查询页面仍未加载完成，未取得可确认的查询结果。',
 result_load_timeout:'已提交查询，等待后结果仍未加载完成。',
 query_form_unavailable:'页面已打开，但尚无法填写或提交查询，未取得可确认的结果。',
 result_unverified:'已尝试查询，但尚不能确认页面内容是本次查询的结果。',
 network_error:'未能正常连接查询网站，本次查询未完成。',
 page_error:'网站页面显示错误，本次查询未完成。',
 operation_failed:'本次查询操作未能完成，未取得可确认的查询结果。'
};
export function integrityFindingLabel(f:IntegrityFinding){
 if(f.subject_match==='different_subject')return '其他主体记录';
 if(f.subject_match==='unconfirmed')return f.nature==='adverse'?'不利事项线索 · 主体未确认':'搜索命中 · 主体未确认';
 return f.nature==='adverse'?'不利记录 · 企业全称匹配':f.nature==='information'?'一般信息 · 企业全称匹配':'事项性质待确认 · 企业全称匹配';
}
const cleanReason=(s:string)=>s.replace(/(?:[，；、\s]*(?:待人工补证|待补证|待人工补充信息|需要人工补充信息|请(?:人工)?上传补充证据))[。；]?/g,'').trim();
// These legacy collector phrases contain diagnostics, not business scope. Keep the saved text intact.
const customerLimitation=(s:string)=>s
 .replace(/截图直接采集隔离服务器桌面的完整屏幕，含浏览器和 XFCE 原生系统面板（北京时间），未叠加时间或绘制时钟栏；/g,'截图保留采集时的完整屏幕内容；')
 .replace(/后续页面采集未完成[（(]net::[A-Z_]+[）)]/g,'后续页面采集未完成');
export type IntegrityPresentation={label:string;description:string;limitation?:string;tone:'neutral'|'warning'|'danger';group:'results'|'no_results'|'incomplete'|'not_applicable'};
/** One display contract for web and Word. Persisted historical observations are never rewritten. */
export function integrityRecordPresentation(record:IntegrityRecord):IntegrityPresentation{
 const d=record.browser?.diagnostic,reason=cleanReason(record.reason);
 const view=(label:string,group:IntegrityPresentation['group'],tone:IntegrityPresentation['tone']='neutral',description=reason):IntegrityPresentation=>({label,group,tone,description,...(record.browser?{limitation:customerLimitation(record.browser.limitation)}:{})});
 const failure=(code:IntegrityDiagnostic['code'])=>view(diagnosticLabels[code],'incomplete','warning',diagnosticDescriptions[code]);
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
 // Derive customer copy from the cause; raw reason/detail/status remain available for diagnosis only.
 if(d){const phase={open:'加载官网',query:'提交查询',results:'等待查询结果'}[d.phase];return view(integrityDiagnosticLabel(d),'incomplete','warning',`${diagnosticDescriptions[d.code]}\n发生阶段：${phase}${d.attempts?` · 已尝试 ${d.attempts} 次`:''}${d.elapsed_ms!==undefined?` · 总耗时 ${Math.ceil(d.elapsed_ms/1000)} 秒`:''}`);}
 // Historical free text can only support causes it explicitly records; do not guess a phase or status code.
 const http=reason.match(/\bHTTP\s*(4\d{2}|5\d{2})\b/i)??reason.match(/\b(403)\s*Forbidden\b/i);
 if(http?.[1]==='403'||/拒绝访问|访问已被拦截|访问受限|Forbidden|GeoBL/i.test(reason))return failure('access_denied');
 if(http)return failure('http_error');
 if(/验证码或登录|验证码\s*\/\s*登录/.test(reason))return view('验证码／登录受限（类型未记录）','incomplete','warning','网站要求验证码或登录，历史记录未区分具体要求，本次查询未完成。');
 if(/要求验证码|需要验证码/.test(reason))return failure('captcha_required');
 if(/要求登录|需要登录|请先登录/.test(reason))return failure('login_required');
 if(/net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|网络连接失败/.test(reason))return failure('network_error');
 if(/超时/.test(reason))return view('查询超时（阶段未记录）','incomplete','warning','等待后仍未完成查询，历史记录未说明在哪一步超时。');
 if(/未能自动确定属地官网/.test(reason))return view('未能确定查询网站','incomplete','warning','未能自动确定属地官网，本项未完成查询。');
 return view('查询未完成（原因未记录）','incomplete','warning','历史记录未保存可区分的失败原因，本次查询未完成。');
}
