import {chromium,type BrowserContext,type Page,type Locator} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {IntegrityBrowser,IntegritySite,IntegritySubject} from '@bondbuddy/contracts';
import {integrityProxy,integrityBrowserUrlAllowed} from './integrity-browser-network.js';
import {startIntegrityDesktop,type IntegrityDesktop} from './integrity-desktop.js';

export type BrowserCapture={kind:'result'|'detail'|'blocker';url:string;title:string;captured_at:string;page:number;text:string;screenshot:Buffer};
export type BrowserCollection={query:string;search_performed:boolean;outcome:IntegrityBrowser['outcome'];scope:string;limitation:string;reason:string;captures:BrowserCapture[]};
export type IntegrityCollector=(site:IntegritySite,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>,signal:AbortSignal)=>Promise<BrowserCollection>;
export function integrityBrowserEnvironment(cacheDirectory:string){
 const env:Record<string,string>={XDG_CACHE_HOME:cacheDirectory};
 for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key]!;
 return env;
}
const SEARCH_INPUT='input[type=search],input[placeholder*="搜索"],input[placeholder*="查询"],input[placeholder*="名称"],input[placeholder*="姓名"],input[placeholder*="关键"],input[id*=earch],input[name*=earch],input[id*=keyword i],input[name*=keyword i],input[id*=pName],input[name*=name i]';
const blockers=/请完成.{0,8}(验证|登录)|向右滑动|拖动.{0,12}(滑块|验证)|验证码|安全验证|访问过于频繁|访问受限|拒绝访问|已被拦截|请求已被阻断|请先登录|登录后.{0,10}(查询|查看)|captcha|verify you are human|access denied|sign in to continue/i;
const errors=/\b502\s+bad gateway\b|\b503\s+service unavailable\b|\b504\s+gateway timeout\b|网页无法访问|系统维护|服务不可用|^\s*50[234]\s*$/i;
const zero=/未(?:检索|查询|搜索)到.{0,30}(结果|信息|记录|内容)|未能搜到您想要的内容|没有找到.{0,30}(结果|信息|记录|内容)|共\s*(?:找到|检索到|查询到|搜索到)?\s*0\s*(?:条|个|项)|(?:找到|相关结果|结果数)[：:\s]*0\s*(?:条|个|项)|no results found/i;
const count=/(?:共|找到|检索到|查询到|搜索到|相关结果)[\s\S]{0,12}?[1-9][\d,]*\s*(?:条|个|项)/;
const clean=(s:string)=>s.replace(/\s+/g,' ').trim();
/** Court forms take an exact name; topical keywords belong only in general site searches. */
export function integritySearchQuery(site:IntegritySite,subject:Pick<IntegritySubject,'name'|'province'>){
 const exactName=['execution-dishonest','execution-debtor','execution-restriction'].includes(site.id);
 return [subject.name,...(!exactName?site.queryTerms?.slice(0,1)??[]:[]),...(site.id==='local-csrc'?[subject.province]:[])].filter(Boolean).join(' ');
}
async function visibleText(page:Page){return (await page.locator('body').innerText({timeout:4000})).slice(0,120000);}
async function firstVisible(locator:Locator){for(let i=0;i<Math.min(await locator.count(),30);i++){const item=locator.nth(i);if(await item.isVisible()&&await item.isEnabled())return item;}return undefined;}
async function blocker(page:Page,text:string){
 // A footer login link is not a login gate. Visible challenge frames/inputs are.
 return blockers.test(text)||await page.locator('input[type=password]:visible,iframe[src*="captcha"]:visible,iframe[src*="verify"]:visible,input[placeholder*="验证码"]:visible').count()>0;
}
async function capture(page:Page,kind:BrowserCapture['kind'],pageNo:number,screenCapture?:(page:Page)=>Promise<Buffer>):Promise<BrowserCapture>{
 const text=await visibleText(page);
 if(!/^https?:\/\//.test(page.url()))throw Error('NO_OFFICIAL_PAGE_CAPTURE');
 const height=await page.locator('body').evaluate(e=>Math.max(e.scrollHeight,document.documentElement.scrollHeight));
 if(height>20000)throw Error('BROWSER_PAGE_TOO_LONG');
 const screenshot=screenCapture?await screenCapture(page):await page.screenshot({type:'png',fullPage:true,timeout:10000});
 return {kind,url:page.url(),title:(await page.title()).slice(0,200),captured_at:new Date().toISOString(),page:pageNo,text,screenshot};
}
function outcome(text:string,query:string){
 if(errors.test(text))return 'failed';
 if(zero.test(text))return 'no_results';
 // A count alone can refer to a generic homepage feed; require the full subject in visible content.
 if(text.includes(query.split(' ')[0])&&count.test(text))return 'results';
 return 'unverified';
}

/** Uses the product's own short-lived browser, never the developer/user browser profile. */
export const collectIntegrityWebsite:IntegrityCollector=async(site,subject,signal)=>{
 const cache=await mkdtemp(join(tmpdir(),'bb-integrity-browser-'));
 const proxy=await integrityProxy(site,{upstreamUrl:process.env.BB_INTEGRITY_EGRESS_PROXY_URL});
 let browser;let desktop:IntegrityDesktop|undefined;
 try{
  desktop=await startIntegrityDesktop(cache,integrityBrowserEnvironment(cache));
  browser=await chromium.launch({headless:false,chromiumSandbox:true,env:desktop.env as Record<string,string>,proxy:{server:proxy.server},args:['--window-size=1440,952','--window-position=0,0','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--proxy-bypass-list=<-loopback>']});
  const context=await browser.newContext({viewport:null,locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:false,serviceWorkers:'block'});
  await context.route('**/*',route=>integrityBrowserUrlAllowed(site,route.request().url())?route.continue():route.abort('blockedbyclient'));
  const abort=()=>void context.close();signal.addEventListener('abort',abort,{once:true});
  try{return await collectInContext(context,site,subject,signal,{waitMs:18000,maxPages:3,screenCapture:desktop.capture});}finally{signal.removeEventListener('abort',abort);await context.close();}
 }finally{try{await browser?.close();}finally{await desktop?.close();await proxy.close();await rm(cache,{recursive:true,force:true});}}
};

/** Injectable context only for controlled browser fixtures. Production always uses the protected proxy. */
export async function collectInContext(context:BrowserContext,site:IntegritySite,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>,signal:AbortSignal,limits:{waitMs:number;maxPages:number;screenCapture?:(page:Page)=>Promise<Buffer>}={waitMs:18000,maxPages:3}) :Promise<BrowserCollection>{
 const capturePage=(page:Page,kind:BrowserCapture['kind'],n:number)=>capture(page,kind,n,limits.screenCapture);
 const query=integritySearchQuery(site,subject);
 const result:BrowserCollection={query,search_performed:false,outcome:'unverified',scope:`${site.name}官网站内查询；查询词：${query}。${site.topic}。`,limitation:(limits.screenCapture?'截图直接采集隔离服务器桌面的完整屏幕，含浏览器和 XFCE 原生系统面板（北京时间），未叠加时间或绘制时钟栏；仅覆盖屏幕可见区域。':'')+'仅覆盖实际截图的查询页面及已打开正文；不含登录后信息、未展示页或附件。全文搜索不等同于专项数据库核查，不能据此认定不存在违法失信。',reason:'未取得可核对的查询结果，待人工补证。',captures:[]};
 let page=await context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(20000);
 try{
  signal.throwIfAborted();
  const response=await page.goto(site.links[0].url,{waitUntil:'domcontentloaded'});
  let text=await visibleText(page);
  if(await blocker(page,text)){result.outcome='blocked';result.reason='官网要求验证码、登录或限制访问，已标记待人工补证，其他网站继续。';result.captures.push(await capturePage(page,'blocker',1));return result;}
  if(response&&response.status()>=400||errors.test(text)){result.outcome='failed';result.reason='官网访问失败，待人工补证。';result.captures.push(await capturePage(page,'blocker',1));return result;}
  let input=await firstVisible(page.locator(SEARCH_INPUT));
  if(!input){const opener=await firstVisible(page.getByRole('link',{name:/^(站内搜索|搜索|查询|信息查询)$/}));if(opener){await opener.click();await page.waitForLoadState('domcontentloaded');input=await firstVisible(page.locator(SEARCH_INPUT));}}
  if(!input){result.reason='官网未找到可用的公开查询输入框，需人工查询并补充截图。';result.captures.push(await capturePage(page,'blocker',1));return result;}
  await input.fill(query);
  const baseline=clean(await visibleText(page));
  const beforePages=context.pages();let changedResponse=false;
  const onResponse=(response:import('playwright').Response)=>{const request=response.request();try{const sent=decodeURIComponent((request.url()+' '+(request.postData()??'')).replace(/\+/g,' '));if(sent.includes(query))changedResponse=true;}catch{/* Unverifiable encoded requests are not proof of a submitted full-name search. */}};context.on('response',onResponse);
  const button=await firstVisible(page.getByRole('button',{name:/^(搜索|搜一搜|搜\s*索|查\s*询|查询信息|Search|检索)$/i}));
  if(button)await button.click({noWaitAfter:true});else await input.press('Enter',{noWaitAfter:true});
  result.search_performed=true;
  const deadline=Date.now()+limits.waitMs;let previous='',stable=0,verified=false;
  while(Date.now()<deadline){
   signal.throwIfAborted();await page.waitForTimeout(600);
   const opened=context.pages().filter(p=>!beforePages.includes(p)&&!p.isClosed());if(opened.length)page=opened.at(-1)!;
   text=await visibleText(page).catch(()=>'');
   if(await blocker(page,text)){result.outcome='blocked';result.reason='查询遇到验证码、登录或访问限制，待人工补证；其他网站继续。';break;}
   if(errors.test(text)){result.outcome='failed';result.reason='提交查询后官网返回错误，未获得结果，待人工补证。';break;}
   const reflected=await page.locator('input:visible').evaluateAll((nodes,q)=>nodes.some(n=>(n as HTMLInputElement).value===q),query).catch(()=>false);
   const compact=clean(text),candidate=outcome(text,query);
   stable=compact===previous?stable+1:0;previous=compact;
   // Require response AND changed visible results AND exact query echo; never trust a stale zero.
   if(changedResponse&&compact!==baseline&&reflected&&candidate!=='unverified'&&stable>=2){result.outcome=candidate;verified=true;break;}
  }
  context.off('response',onResponse);
  if(result.outcome==='blocked'||result.outcome==='failed'){result.captures.push(await capturePage(page,'blocker',1));return result;}
  if(!verified){result.reason='已提交查询，但未能确认页面结果对应本次完整查询词（可能异步加载、页面变化或查询条件不足），待人工补证。';result.captures.push(await capturePage(page,'blocker',1));return result;}
  result.captures.push(await capturePage(page,'result',1));
  result.reason=result.outcome==='no_results'?'本次官网站内查询未检索到相关结果；仅限所列查询词和页面范围，不代表无风险。':'官网检索到相关内容；需核对同名主体、记录事项与影响。';
  if(result.outcome==='no_results')return result;
  // Preserve subsequent pages when the site exposes a normal next-page control.
  for(let n=2;n<=limits.maxPages;n++){
   const next=await firstVisible(page.getByRole('link',{name:/^(下一页|下页|Next)\s*(?:>>|»|›)?$/i}).or(page.getByRole('button',{name:/^(下一页|下页|Next)\s*(?:>>|»|›)?$/i})));
   if(!next)break;const old=clean(await visibleText(page));await next.click({noWaitAfter:true});
   let updated=false,last='',steady=0;for(let i=0;i<20;i++){
    signal.throwIfAborted();await page.waitForTimeout(600);text=await visibleText(page);
    if(await blocker(page,text)||errors.test(text)){result.limitation+=' 翻页受限，后续页待人工补证。';result.captures.push(await capturePage(page,'blocker',n));break;}
    const current=clean(text);steady=current===last?steady+1:0;last=current;
    const echo=await page.locator('input:visible').evaluateAll((nodes,q)=>nodes.some(n=>(n as HTMLInputElement).value===q),query);
    if(current!==old&&echo&&outcome(text,query)==='results'&&steady>=2){updated=true;break;}
   }
   if(!updated)break;result.captures.push(await capturePage(page,'result',n));
  }
  // Open at most three result links whose visible surrounding text contains the full subject.
  const links=await page.locator('a[href]').evaluateAll((nodes,name)=>nodes.filter(n=>{const e=n as HTMLAnchorElement;return (e.innerText+' '+(e.parentElement?.innerText??'')).includes(name)&&e.innerText.trim().length>5;}).map(n=>({url:(n as HTMLAnchorElement).href,title:(n as HTMLAnchorElement).innerText})),subject.name);
  for(const link of [...new Map(links.map(l=>[l.url,l])).values()].filter(l=>integrityBrowserUrlAllowed(site,l.url)&&l.url!==page.url()).slice(0,3)){
   signal.throwIfAborted();const detail=await context.newPage();
   try{const r=await detail.goto(link.url,{waitUntil:'domcontentloaded',timeout:12000});const body=await visibleText(detail);if(r&&r.status()<400&&!await blocker(detail,body)&&body.includes(subject.name))result.captures.push(await capturePage(detail,'detail',result.captures.length+1));}catch{result.limitation+=' 部分正文未能打开，需人工核对。';}finally{await detail.close();}
  }
  result.limitation+=` 本次保留 ${result.captures.filter(c=>c.kind==='result').length} 页查询截图，最多采集 ${limits.maxPages} 页；未逐页覆盖的结果需人工补证。`;
  return result;
 }catch(error){signal.throwIfAborted();result.outcome='failed';result.reason='官网加载或查询超时，未取得可确认结果，待人工补证。';try{result.captures.push(await capturePage(page,'blocker',1));}catch{/* No fabricated screenshot when the browser cannot capture. */}return result;}
 finally{await Promise.all(context.pages().map(p=>p.close().catch(()=>{})));}
}
