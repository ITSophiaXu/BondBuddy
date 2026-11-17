/** Portal availability does not depend on whether a query finds matching records. */
export function classifyIntegrityAccessibility(page){
 if(page.probe_error)return {accessible:false,reason:'probe_failure'};
 if(!/^https?:/.test(page.final_url??''))return {accessible:false,reason:'navigation_error'};
 if(page.http_status>=400)return {accessible:false,reason:'http_error'};
 if(/net::ERR_/.test(page.navigation_error??''))return {accessible:false,reason:'navigation_error'};
 const text=(page.text??'').trim();
 const failure=/403 Forbidden|404 Not Found|502 Bad Gateway|Access Denied|This site can.t be reached|无法访问此网站|网页无法访问|网站维护中|暂停服务|系统维护|您访问的页面不存在/i;
 if(text.length<1500&&failure.test((page.title??'')+'\n'+text))return {accessible:false,reason:'error_or_maintenance_page'};
 if(!page.screenshot_bytes||page.screenshot_bytes<=1000||text.length<=20)return {accessible:false,reason:'blank_or_unusable_page'};
 return {accessible:true,reason:'official_page_rendered'};
}
