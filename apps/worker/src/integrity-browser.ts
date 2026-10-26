import {chromium,type BrowserContext,type Page,type Response} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {IntegrityBrowser,IntegritySite,IntegritySubject} from '@bondbuddy/contracts';
import {integrityProxy,integrityBrowserUrlAllowed} from './integrity-browser-network.js';
import {startIntegrityDesktop,type IntegrityDesktop} from './integrity-desktop.js';
import {visibleText,firstVisible,challenge as blocker,pageErrors as errors,loadingOnly,searchInput,searchButton,queryReflected,courtRegion,resultsLoading} from './integrity-browser-page.js';

export type BrowserCapture={kind:'result'|'detail'|'blocker';url:string;title:string;captured_at:string;page:number;text:string;screenshot:Buffer};
export type BrowserCollection={query:string;search_performed:boolean;outcome:IntegrityBrowser['outcome'];scope:string;limitation:string;reason:string;captures:BrowserCapture[]};
export type IntegrityCollector=(site:IntegritySite,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>,signal:AbortSignal)=>Promise<BrowserCollection>;
export function integrityBrowserEnvironment(cacheDirectory:string){
 const env:Record<string,string>={XDG_CACHE_HOME:cacheDirectory};
 for(const key of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key]!;
 return env;
}
const zero=/未(?:检索|查询|搜索)到.{0,30}(结果|信息|记录|内容)|未能搜到您想要的内容|没有找到.{0,30}(结果|信息|记录|内容)|暂无(?:相关)?(?:数据|记录|信息)|共\s*(?:找到|检索到|查询到|搜索到)?\s*0\s*(?:条|个|项)|(?:找到|相关结果|结果数)[：:\s]*0\s*(?:条|个|项)|no results found/i;
const count=/(?:共|找到|检索到|查询到|搜索到|相关结果)[\s\S]{0,12}?[1-9][\d,]*\s*(?:条|个|项)/;
const clean=(s:string)=>s.replace(/\s+/g,' ').trim();
// Official search pages load their form, configuration and results sequentially.
// The Beijing runtime observed a valid tax response after the former 18s limit.
const collectionLimits={waitMs:90000,maxPages:3,attempts:2};
type CollectionLimits={waitMs:number;maxPages:number;attempts?:number;screenCapture?:(page:Page)=>Promise<Buffer>};
/** Court forms take an exact name; topical keywords belong only in general site searches. */
export function integritySearchQuery(site:IntegritySite,subject:Pick<IntegritySubject,'name'|'province'>){
 const exactName=['credit-china','execution-dishonest','execution-debtor','execution-restriction'].includes(site.id);
 return [subject.name,...(!exactName?site.queryTerms?.slice(0,1)??[]:[]),...(site.id==='local-csrc'?[subject.province]:[])].filter(Boolean).join(' ');
}
async function capture(page:Page,kind:BrowserCapture['kind'],pageNo:number,screenCapture?:(page:Page)=>Promise<Buffer>):Promise<BrowserCapture>{
 const text=await visibleText(page);
 if(loadingOnly(text))throw Error('EMPTY_OFFICIAL_PAGE');
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
function resultSignature(text:string,query:string){
 return text.split(/\n/).map(clean).filter(line=>zero.test(line)||count.test(line)||line.includes(query)).join('\n');
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
  try{return await collectInContext(context,site,subject,signal,{...collectionLimits,screenCapture:desktop.capture});}finally{signal.removeEventListener('abort',abort);await context.close();}
 }finally{try{await browser?.close();}finally{await desktop?.close();await proxy.close();await rm(cache,{recursive:true,force:true});}}
};

/** Injectable context only for controlled browser fixtures. Production always uses the protected proxy. */
export async function collectInContext(context:BrowserContext,site:IntegritySite,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>,signal:AbortSignal,limits:CollectionLimits=collectionLimits):Promise<BrowserCollection>{
 let result:BrowserCollection|undefined;
 const attempts=limits.attempts??collectionLimits.attempts;
 for(let attempt=0;attempt<attempts;attempt++){
  // Official credit search entry observed from the portal's search button (2026-10-26).
  // A broken portal shell must not prevent the normal query form from loading.
  const entry=site.id==='credit-china'&&attempt>0?new URL('/xinyongxinxi/index.html',site.links[0].url).href:site.links[0].url;
  signal.throwIfAborted();result=await collectAttempt(context,site,subject,signal,limits,entry);
  if(!['failed','unverified'].includes(result.outcome))return result;
 }
 if(!result)throw Error('INVALID_COLLECTION_LIMITS');
 result.reason=`已自动尝试 ${attempts} 次。${result.reason}`;
 return result;
}
async function collectAttempt(context:BrowserContext,site:IntegritySite,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>,signal:AbortSignal,limits:CollectionLimits,entry:string):Promise<BrowserCollection>{
 const capturePage=(page:Page,kind:BrowserCapture['kind'],n:number)=>capture(page,kind,n,limits.screenCapture);
 const query=integritySearchQuery(site,subject);
 const result:BrowserCollection={query,search_performed:false,outcome:'unverified',scope:`${site.name}官网站内查询；查询词：${query}。${site.topic}。`,limitation:(limits.screenCapture?'截图直接采集隔离服务器桌面的完整屏幕，含浏览器和 XFCE 原生系统面板（北京时间），未叠加时间或绘制时钟栏；仅覆盖屏幕可见区域。':'')+'仅覆盖实际截图的查询页面及已打开正文；不含登录后信息、未展示页或附件。全文搜索不等同于专项数据库核查，不能据此认定不存在违法失信。',reason:'未取得可核对的查询结果，无需上传补充证据。',captures:[]};
 let page=await context.newPage();page.setDefaultTimeout(Math.min(limits.waitMs,15000));page.setDefaultNavigationTimeout(limits.waitMs);
 let onResponse:((response:Response)=>void)|undefined;
 let navigationStatus=0;
 const onNavigation=(response:Response)=>{try{if(response.request().isNavigationRequest()&&response.frame()===page.mainFrame())navigationStatus=response.status();}catch{/* Popup navigation can precede creation of its frame. */}};
 context.on('response',onNavigation);
 const diagnostic=async()=>{try{result.captures.push(await capturePage(page,'blocker',1));}catch{/* A blank/error document is never fabricated as evidence. */}};
 try{
  signal.throwIfAborted();
  // Commit permits slow scripts/redirects to finish inside the readiness loop.
  await page.goto(entry,{waitUntil:'commit'});
  let text='',form:Awaited<ReturnType<typeof searchInput>>,openedSearch=false;
  const readyDeadline=Date.now()+limits.waitMs;
  while(Date.now()<readyDeadline){
   signal.throwIfAborted();text=await visibleText(page);
   if(await blocker(page,text)){result.outcome='blocked';result.reason='官网要求验证码或登录，自动查询已停止；无需补充信息或上传证据，其他网站继续。';await diagnostic();return result;}
   if(errors.test(text)){result.outcome='failed';result.reason=`官网访问异常${navigationStatus>=400?`（HTTP ${navigationStatus}）`:''}，未取得查询结果；无需补充信息或上传证据。`;await diagnostic();return result;}
   form=await searchInput(page);if(form)break;
   if(!openedSearch){const opener=await firstVisible(page.getByRole('link',{name:/^(站内搜索|搜索|查询|信息查询)$/}).or(page.getByRole('button',{name:/^(站内搜索|搜索|查询|信息查询)$/})));if(opener){openedSearch=true;await opener.click({noWaitAfter:true});}}
   const opened=context.pages().filter(p=>!p.isClosed());if(opened.length>1)page=opened.at(-1)!;
   await page.waitForTimeout(300);
  }
  if(!form){result.reason=loadingOnly(text)?'官网页面持续空白或仍在加载，未保存空白截图；无需补充信息或上传证据。':'官网查询控件未就绪，未完成查询；无需补充信息或上传证据。';if(navigationStatus>=400){result.outcome='failed';result.reason=`官网响应 HTTP ${navigationStatus}。`+result.reason;}await diagnostic();return result;}
  if(site.id.startsWith('execution-')){const region=await courtRegion(page,subject);if(region){result.scope+=` 执行法院范围：${region}。`;if(region!=='全国')result.limitation+=` 官网要求选择地区，本次仅查询${region}，不覆盖其他地区执行案件。`;}}
  await form.input.fill(query);
  const baseline=resultSignature(await visibleText(page),query);
  const beforePages=context.pages();let changedResponse=false;
  onResponse=(response:Response)=>{const request=response.request();try{let body=request.postData()??'';try{body=JSON.stringify(JSON.parse(body));}catch{}const sent=decodeURIComponent((request.url()+' '+body).replace(/\+/g,' '));if(response.ok()&&sent.includes(query))changedResponse=true;}catch{/* Unverifiable encoded requests are not proof of a submitted full-name search. */}};context.on('response',onResponse);
  const button=await searchButton(form.frame);
  if(button)await button.click({noWaitAfter:true});else await form.input.press('Enter',{noWaitAfter:true});
  result.search_performed=true;
  const deadline=Date.now()+limits.waitMs;let previous='',stable=0,verified=false;
  while(Date.now()<deadline){
   signal.throwIfAborted();await page.waitForTimeout(600);
   const opened=context.pages().filter(p=>!beforePages.includes(p)&&!p.isClosed());if(opened.length)page=opened.at(-1)!;
   text=await visibleText(page).catch(()=>'');
   if(await blocker(page,text)){result.outcome='blocked';result.reason='查询需要验证码或登录，自动查询已停止；无需上传补充证据，其他网站继续。';break;}
   if(errors.test(text)){result.outcome='failed';result.reason='提交查询后官网返回错误，未获得结果；无需补充信息或上传证据。';break;}
   const reflected=await queryReflected(page,query,text);
   const compact=resultSignature(text,query),candidate=outcome(text,query);
   stable=compact===previous?stable+1:0;previous=compact;
   // Require response AND changed visible results AND exact query echo; never trust a stale zero.
   if(changedResponse&&compact!==baseline&&reflected&&candidate!=='unverified'&&stable>=2&&!await resultsLoading(page)){result.outcome=candidate;verified=true;break;}
  }
  context.off('response',onResponse);
  if(result.outcome==='blocked'||result.outcome==='failed'){await diagnostic();return result;}
  if(!verified){result.reason='已提交查询，但官网尚未返回可确认的本次结果；无需补充信息或上传证据。';await diagnostic();return result;}
  result.captures.push(await capturePage(page,'result',1));
  result.reason=result.outcome==='no_results'?'本次官网站内查询未检索到相关结果；仅限所列查询词和页面范围，不代表无风险。':'官网检索到相关内容；需核对同名主体、记录事项与影响。';
  if(result.outcome==='no_results')return result;
  // Preserve subsequent pages when the site exposes a normal next-page control.
  for(let n=2;n<=limits.maxPages;n++){
   const next=await firstVisible(page.getByRole('link',{name:/^(下一页|下页|Next)\s*(?:>>|»|›)?$/i}).or(page.getByRole('button',{name:/^(下一页|下页|Next)\s*(?:>>|»|›)?$/i})));
   if(!next)break;const old=clean(await visibleText(page));await next.click({noWaitAfter:true});
   let updated=false,last='',steady=0;for(let i=0;i<20;i++){
    signal.throwIfAborted();await page.waitForTimeout(600);text=await visibleText(page);
    if(await blocker(page,text)||errors.test(text)){result.limitation+=' 翻页受限，后续页未完成查询。';result.captures.push(await capturePage(page,'blocker',n));break;}
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
   try{const r=await detail.goto(link.url,{waitUntil:'domcontentloaded',timeout:limits.waitMs});const body=await visibleText(detail);if(r&&r.status()<400&&!await blocker(detail,body)&&body.includes(subject.name))result.captures.push(await capturePage(detail,'detail',result.captures.length+1));}catch{result.limitation+=' 部分正文未能打开。';}finally{await detail.close();}
  }
  result.limitation+=` 本次保留 ${result.captures.filter(c=>c.kind==='result').length} 页查询截图，最多采集 ${limits.maxPages} 页；未展示的结果不在本次核查范围内。`;
  return result;
 }catch(error){signal.throwIfAborted();result.outcome='failed';const code=error instanceof Error?(error.message.match(/net::[A-Z_]+|EMPTY_OFFICIAL_PAGE|NO_OFFICIAL_PAGE_CAPTURE/)?.[0]??(error.name==='TimeoutError'?'加载超时':'页面操作未完成')):'页面操作未完成';result.reason=`官网加载或查询未完成（${code}），未取得可确认结果；无需补充信息或上传证据。`;await diagnostic();return result;}
 finally{context.off('response',onNavigation);if(onResponse)context.off('response',onResponse);await Promise.all(context.pages().map(p=>p.close().catch(()=>{})));}
}
