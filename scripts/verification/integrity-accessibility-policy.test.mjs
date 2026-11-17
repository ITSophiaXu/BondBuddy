import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIntegrityAccessibility as classify} from './integrity-accessibility-policy.mjs';
const page={final_url:'https://www.example.gov.cn/',title:'官网查询',http_status:200,text:'官网查询服务 输入查询条件 查看公开公告 主办单位 官方网站',screenshot_bytes:12000};
test('normal portal, zero results and unconfirmed searches stay accessible',()=>{
 for(const outcome of ['results','no_results','unverified'])assert.equal(classify({...page,outcome,search_performed:outcome!=='unverified'}).accessible,true);
 assert.equal(classify({...page,text:'官网查询服务 查询完成，共0条记录 暂无相关数据 主办单位 官方网站'}).accessible,true);
});
test('a rendered login or captcha page is accessible without inventing a search result',()=>{
 for(const outcome of ['captcha_required','login_required'])assert.equal(classify({...page,outcome,text:'官方查询服务 请登录后输入验证码进行查询 主办单位 官方网站'}).accessible,true);
});
test('error screenshots, blank pages, maintenance and transport failures are not valid portal captures',()=>{
 for(const extra of [{http_status:403},{navigation_error:'net::ERR_CERT_DATE_INVALID'},{text:''},{screenshot_bytes:0},{text:'官方网站正在系统维护，暂停服务，恢复时间另行通知'},{final_url:'chrome-error://chromewebdata/'}])assert.equal(classify({...page,...extra}).accessible,false);
});
