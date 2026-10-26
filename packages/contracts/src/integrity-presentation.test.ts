import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {IntegrityRecordSchema,integrityRecordPresentation as present,type IntegrityRecord,type IntegrityDiagnostic,type IntegrityFinding} from './integrity.js';
const record:IntegrityRecord={subject_id:'s',site_id:'tax',site_name:'测试官网',urls:[],query:'合成企业',status:'query_failed',reason:'官网加载或查询超时，未取得可确认结果，待人工补证。',checked_at:'2026-10-26T00:00:00Z',sources:[],search_performed:false};
const withDiagnostic=(d:IntegrityDiagnostic):IntegrityRecord=>({...record,browser:{version:'official-browser-v1',outcome:'failed',scope:'测试范围',limitation:'合成',captures:[],diagnostic:d}});
test('diagnostics preserve exact failure causes and validate without breaking historical records',()=>{
 assert.equal(Value.Check(IntegrityRecordSchema,record),true);
 for(const [code,label] of Object.entries({blank_page_timeout:'页面空白（加载超时）',page_load_timeout:'页面加载超时',result_load_timeout:'查询结果加载超时',query_form_unavailable:'查询页面尚未就绪',result_unverified:'本次查询结果未确认',captcha_required:'需要验证码',login_required:'需要登录',authentication_required:'需要验证码和登录',network_error:'网络连接失败',page_error:'网站页面报错',operation_failed:'查询操作未完成'})){
  const r=withDiagnostic({code:code as IntegrityDiagnostic['code'],phase:'results',attempts:2,elapsed_ms:4500});
  assert.equal(Value.Check(IntegrityRecordSchema,r),true);assert.equal(present(r).label,label);assert.match(present(r).description,/已尝试 2 次/);assert.doesNotMatch(present(r).description,/待人工补证/);
 }
 assert.equal(present(withDiagnostic({code:'access_denied',phase:'open',http_status:403,detail:'GeoBL'})).label,'网站拒绝访问');
 assert.equal(present(withDiagnostic({code:'http_error',phase:'results',http_status:503})).label,'网站响应错误');
 for(const d of [{code:'access_denied',phase:'open',http_status:403,detail:'403 Forbidden GeoBL'},{code:'network_error',phase:'results',detail:'net::ERR_NAME_NOT_RESOLVED'},{code:'operation_failed',phase:'query',detail:'INTERNAL_OPERATION_ERROR'}] as IntegrityDiagnostic[]){
  const r={...withDiagnostic(d),reason:`查询失败：${d.detail}`},before=JSON.stringify(r),view=present(r);
  assert.doesNotMatch(view.label+view.description,/HTTP|403|Forbidden|GeoBL|net::|ERR_|INTERNAL_/);
  assert.equal(JSON.stringify(r),before);assert.equal(r.browser!.diagnostic!.detail,d.detail);
 }
 assert.equal(present({...record,status:'no_public_results',reason:'页面共 0 条',search_performed:true}).label,'搜索无返回结果');
});
test('historical unknown errors never acquire invented HTTP or authentication causes',()=>{
 const before=JSON.stringify(record);
 assert.equal(present(record).label,'查询超时（阶段未记录）');
 assert.equal(present({...record,reason:'未取得结果，待人工补证。'}).label,'查询未完成（原因未记录）');
 assert.equal(present({...record,reason:'官网响应 HTTP 403，GeoBL。'}).label,'网站拒绝访问');
 assert.equal(present({...record,reason:'官网要求验证码或登录'}).label,'验证码／登录受限（类型未记录）');
 for(const [reason,label] of [['官网响应 HTTP 403，GeoBL。','网站拒绝访问'],['HTTP 503 Service Unavailable','网站响应错误'],['net::ERR_CONNECTION_RESET','网络连接失败'],['TimeoutError 查询超时','查询超时（阶段未记录）'],['INTERNAL_OPERATION_ERROR','查询未完成（原因未记录）']]){
  const r={...record,reason},before=JSON.stringify(r),view=present(r);
  assert.equal(view.label,label);assert.doesNotMatch(view.description,/HTTP|403|503|Forbidden|GeoBL|net::|ERR_|INTERNAL_|TimeoutError/);assert.equal(JSON.stringify(r),before);
 }
 assert.equal(JSON.stringify(record),before);
});
test('display limitations omit legacy collection diagnostics without changing original scope or evidence',()=>{
 const r=withDiagnostic({code:'results',phase:'results',detail:'net::ERR_CONNECTION_RESET'});
 r.status='public_matches';r.browser!.limitation='截图直接采集隔离服务器桌面的完整屏幕，含浏览器和 XFCE 原生系统面板（北京时间），未叠加时间或绘制时钟栏；仅覆盖屏幕可见区域。 本次仅查询河南省，不覆盖其他地区执行案件。 后续页面采集未完成（net::ERR_CONNECTION_RESET），已取得的查询结果仍保留。';
 const before=JSON.stringify(r),view=present(r);
 assert.match(view.limitation!,/仅查询河南省/);assert.match(view.limitation!,/后续页面采集未完成/);assert.doesNotMatch(view.limitation!,/XFCE|net::|ERR_|隔离服务器/);assert.equal(JSON.stringify(r),before);
});
test('adverse records, ambiguous identities, ordinary notices and unrelated hits remain distinct',()=>{
 const f:IntegrityFinding={capture_id:'c',quote:'合成企业 行政处罚决定',explanation:'记录显示被处以罚款，原文未载明整改状态。',title:'行政处罚：未按规定披露信息',nature:'adverse',subject_match:'company_name'};
 const r={...record,status:'public_matches' as const,findings:[f]};
 assert.equal(present(r).label,'发现不利记录（企业全称匹配）');assert.equal(present(r).tone,'danger');assert.match(present(r).description,/行政处罚/);
 assert.equal(present({...r,findings:[{...f,subject_match:'unconfirmed'}]}).label,'发现不利线索（主体未确认）');
 assert.equal(present({...r,findings:[{...f,subject_match:'different_subject'}]}).label,'搜索返回其他主体记录');
 assert.equal(present({...r,findings:[{...f,nature:'information'}]}).label,'搜索返回一般信息');
 assert.equal(present({...r,findings:[]}).label,'搜索返回结果（关联待确认）');
 assert.notEqual(present({...r,findings:[]}).group,'no_results');
});
