import type {Page, Frame, Locator} from 'playwright';
import {inferIntegrityRegion, type IntegrityDiagnostic,type IntegritySubject} from '@bondbuddy/contracts';

// Do not assume a DOMContentLoaded event means a portal's JavaScript form is ready.
const SEARCH_INPUT='input[type=search],input[name=qt],input[placeholder*="搜索"],input[placeholder*="查询"],input[placeholder*="检索"],input[placeholder*="名称"],input[placeholder*="姓名"],input[placeholder*="关键"],input[id*=search i],input[name*=search i],input[id*=keyword i],input[name*=keyword i],input[id*=pName],input[name*=name i],input[id*=qname i],input[id*=iname i],input[id*=kw i]';
const SEARCH_ACTION=/^(搜索|搜一搜|搜\s*索|查\s*询|查询信息|Search|检索)$/i;
export const pageErrors=/\b50[234]\s+(bad gateway|service unavailable|gateway timeout)\b|网页无法访问|系统维护|服务不可用|访问过于频繁|访问受限|拒绝访问|已被拦截|请求已被阻断|access denied|403\s*Forbidden|^\s*Forbidden\b|GeoBL|^\s*50[234]\s*$/im;
export function pageFailure(text:string,status:number,phase:IntegrityDiagnostic['phase']):IntegrityDiagnostic{
 const denied=status===403||/Forbidden|access denied|GeoBL|访问受限|拒绝访问|已被拦截|请求已被阻断/i.test(text);
 const detail=text.split('\n').find(line=>pageErrors.test(line))?.trim().slice(0,500);
 return {code:denied?'access_denied':status>=400?'http_error':'page_error',phase,...(status>=400?{http_status:status}:{}),...(detail?{detail}:{} )};
}
export const loadingOnly=(text:string)=>!text.trim()||/^(加载中|正在加载|请稍候|请稍后|loading)[\s.。…!！]*$/i.test(text.trim());
export async function visibleFrames(page:Page):Promise<Frame[]>{
 const frames:Frame[]=[];
 for(const frame of page.frames()){
  if(frame===page.mainFrame()||await frame.frameElement().then(e=>e.isVisible()).catch(()=>false))frames.push(frame);
 }
 return frames;
}
export async function visibleText(page:Page){
 const text=[];for(const frame of await visibleFrames(page))text.push(await frame.locator('body').innerText({timeout:1000}).catch(()=>''));
 return text.join('\n').slice(0,120000);
}
/** Includes @import dependencies; an empty CSSStyleSheet does not prove a load succeeded. */
export async function activeStylesheet(frame:Frame,url:string){
 return frame.evaluate(url=>{
  const active=(media:string)=>!media||matchMedia(media).matches;
  if([...document.querySelectorAll<HTMLLinkElement>('link[rel~=stylesheet]')].some(link=>link.href===url&&!link.disabled&&active(link.media)))return true;
  const seen=new Set<CSSStyleSheet>();
  const visit=(sheet:CSSStyleSheet):boolean=>{
   if(seen.has(sheet)||sheet.disabled||!active(sheet.media.mediaText))return false;seen.add(sheet);
   if(sheet.href===url)return true;
   try{return [...sheet.cssRules].some(rule=>rule instanceof CSSImportRule&&active(rule.media.mediaText)&&(rule.href===url||!!rule.styleSheet&&visit(rule.styleSheet)));}
   catch{return true;} // An opaque active sheet may import the failed resource; do not assume it is optional.
  };
  return [...document.styleSheets,...document.adoptedStyleSheets].some(visit);
 },url).catch(()=>true);
}
export async function firstVisible(locator:Locator){
 for(let i=0;i<Math.min(await locator.count(),40);i++){const item=locator.nth(i);if(await item.isVisible()&&await item.isEnabled())return item;}
 return undefined;
}
export async function challenge(page:Page,text:string){
 // A footer login link, a help article mentioning captcha, or a WAF error is not an authentication gate.
 let captcha=/请完成.{0,8}验证|向右滑动|拖动.{0,12}(滑块|验证)|请(?:输入|填写).{0,8}验证码|verify you are human/i.test(text);
 let login=/请完成.{0,8}登录|请先登录|登录后.{0,10}(查询|查看)|sign in to continue/i.test(text);
 for(const frame of await visibleFrames(page)){
  captcha ||= !!await frame.locator('iframe[src*="captcha"]:visible,iframe[src*="verify"]:visible,input[placeholder*="验证码"]:visible,input[id*=captcha i]:visible,input[name*=captcha i]:visible,input[id=yzm]:visible,input[id=yzmInput]:visible,input[id=j_captcha]:visible').count();
  login ||= !!await frame.locator('input[type=password]:visible').count();
 }
 return captcha&&login?'authentication_required':captcha?'captcha_required':login?'login_required':undefined;
}
export async function searchInput(page:Page){
 for(const frame of await visibleFrames(page)){
  if(!await frame.locator('body').evaluate(()=>document.readyState!=='loading').catch(()=>false))continue;
  const input=await firstVisible(frame.locator(SEARCH_INPUT));if(input)return {frame,input};
 }
 return undefined;
}
export async function resultsLoading(page:Page){
 for(const frame of await visibleFrames(page))if(await frame.locator('[aria-busy=true]:visible,.loading:visible,.el-loading-mask:visible,.ant-spin-spinning:visible,[role=progressbar]:visible').count())return true;
 return false;
}
export async function searchButton(frame:Frame,input?:Locator){
 // Portals often use an unlabelled image beside the field as their submit control.
 // Limit these attribute matches to the field's local container, never a global icon.
 if(input){let container=input;for(let depth=0;depth<3;depth++){
  container=container.locator('xpath=..');
  const action=await firstVisible(container.locator('button[type=submit],button[id*=search i],button[onclick*=search i],button[onclick*=jiansuo i],input[type=submit],input[type=button][onclick*=search i],img[onclick*="search" i],img[onclick*="query" i],[class*=search-btn i],[class*=search_btn i],[class*=searchBtn],[id=query_btn],.icon-search'));
  if(action)return action;
 }}
 return await firstVisible(frame.getByRole('button',{name:SEARCH_ACTION}).or(frame.getByRole('link',{name:SEARCH_ACTION})).or(frame.getByRole('img',{name:SEARCH_ACTION})))
  ??await firstVisible(frame.locator('a,span,div').filter({hasText:SEARCH_ACTION}));
}
export async function companyNameCondition(frame:Frame){
 const selects=frame.locator('select');
 for(let i=0;i<await selects.count();i++){
  const select=selects.nth(i);if(!await select.isVisible()||!await select.isEnabled())continue;
  const option=select.locator('option').filter({hasText:/^企业名称$/});
  if(await option.count()===1)await select.selectOption({label:'企业名称'});
 }
}
export async function queryReflected(page:Page,query:string,text:string){
 for(const frame of await visibleFrames(page)){
  if(await frame.locator('input:visible').evaluateAll((nodes,q)=>nodes.some(n=>(n as HTMLInputElement).value.trim()===q),query).catch(()=>false))return true;
  try{if([...new URL(frame.url()).searchParams.values()].some(v=>v===query))return true;}catch{/* about:blank */}
 }
 return text.includes(query);
}
export async function courtRegion(page:Page,subject:Pick<IntegritySubject,'name'|'kind'|'province'|'city'>){
 const region=inferIntegrityRegion(subject);
 for(const frame of await visibleFrames(page)){
  const selects=frame.locator('select');
  for(let i=0;i<await selects.count();i++){
   const select=selects.nth(i);if(!await select.isVisible()||!await select.isEnabled())continue;
   const options=await select.locator('option').evaluateAll(nodes=>nodes.map(n=>({label:(n.textContent??'').trim(),value:(n as HTMLOptionElement).value,disabled:(n as HTMLOptionElement).disabled})));
   // Recognize province controls by their actual options, not a guessed numeric province code.
   if(options.filter(o=>/河南|河北|北京|上海/.test(o.label)).length<2)continue;
   const all=options.find(o=>!o.disabled&&/^(全国|全国法院|全部|全部省份|全部法院|所有省份)$/.test(o.label.replace(/^[-—\s]+|[-—\s]+$/g,'')));
   const selected=all??options.find(o=>!o.disabled&&region.province&&o.label.replace(/省$|市$/,'')===region.province);
   if(selected){await select.selectOption({value:selected.value});return all?'全国':selected.label;}
  }
 }
 return '';
}
