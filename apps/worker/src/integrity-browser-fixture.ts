// Synthetic website fixture for real Chromium interaction tests; never used by the production collector.
import type {BrowserContext} from 'playwright';
export async function integrityWebsiteFixture(context:BrowserContext,mode:'hits'|'zero'|'captcha'|'login'|'failure'|'stale'|'late'|'popup'|'waf'|'zero-ndrc'='hits'){
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/detail')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>合成测试企业 监管记录</h1><p>合成测试企业被要求补充材料。本页为自动化测试，不是真实监管信息。</p>'});
  if(url.pathname==='/result')return route.fulfill({contentType:'text/plain; charset=utf-8',body:'synthetic response'});
  const form='<input id="search" placeholder="输入名称"><button id="go">搜索</button>';
  const submit=`document.querySelector('#go').onclick=async()=>{const q=document.querySelector('#search').value;await fetch('/result?q='+encodeURIComponent(q));${mode==='late'?'await new Promise(r=>setTimeout(r,1600));':''}${mode==='stale'?'return;':mode==='waf'?`document.querySelector('#results').innerText='您的请求可能存在威胁，已被拦截！';`:mode==='zero-ndrc'?`document.querySelector('#results').innerText='很抱歉！未能搜到您想要的内容';`:mode==='captcha'?`document.querySelector('#results').innerText='请完成安全验证 向右滑动完成验证';`:mode==='failure'?`document.querySelector('#results').innerText='502 Bad Gateway';`:mode==='zero'||mode==='late'?`document.querySelector('#results').innerText='查询词：'+q+' 共0条相关结果';`:`document.querySelector('#results').innerHTML='<h1>查询结果 共2条</h1><a href="/detail">'+q+' 监管记录</a><p>'+q+'被要求补充材料。本页为合成测试。</p>';`}};`;
  await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成官网查询测试</title><style>body{font:20px sans-serif;padding:40px}input,button{font:inherit;padding:10px}</style><h1>合成官网查询测试</h1>${mode==='login'?'<p>请先登录后查询</p><input type="password">':form}<div id="results">${mode==='stale'?'共0条相关结果':'请输入查询词'}</div><footer>合成备案号 05035542</footer><script>${mode==='login'?'':submit}</script></html>`});
 });
}
