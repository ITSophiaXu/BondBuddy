import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.env.BB_ACCESSIBILITY_OUTPUT;
if(!root)throw Error('BB_ACCESSIBILITY_OUTPUT required');
const plan=JSON.parse(readFileSync(root+'/plan.json','utf8'));
if(plan.jobs.length!==129)throw Error('Full inventory required');
const review=JSON.parse(readFileSync(root+'/visual-review.json','utf8'));
const history=row=>[...(row.previous?history(row.previous):[]),...row.attempts];
const rows=plan.jobs.map(job=>{
 const row=JSON.parse(readFileSync(root+'/results/'+job.key+'.json','utf8'));
 if(row.key!==job.key||row.configured_url!==job.site.links[0].url)throw Error('Mismatched probe '+job.key);
 const attempt=row.attempts.find(a=>a.accessible)??row.attempts.at(-1);
 if(row.accessible){
  if(createHash('sha256').update(readFileSync(root+'/'+attempt.capture)).digest('hex')!==attempt.sha256)throw Error('Capture changed '+job.key);
  if(!review.results.some(r=>r.key===job.key&&r.sha256===attempt.sha256&&r.decision==='usable_official_page'))throw Error('Visual review required '+job.key);
 }
 return {key:job.key,site_id:job.site.id,name:job.site.name,category:job.category,region:job.region,subject:job.subject,
  original_url:row.configured_url,configured_url:row.accessible?(row.tested_url??row.configured_url):row.configured_url,tested_url:row.tested_url??row.configured_url,
  accessible:row.accessible,decision:row.accessible?'enabled':'paused',checked_at:attempt.finished_at,
  reason:attempt.reason,http_status:attempt.http_status,navigation_error:attempt.navigation_error,error:attempt.error,
  final_url:attempt.final_url,title:attempt.title,capture:attempt.capture,sha256:attempt.sha256,
  attempts:history(row).length,browser_mode:attempt.browser_mode??'headless',
  attempt_history:history(row).map(a=>({started_at:a.started_at,finished_at:a.finished_at,tested_url:a.tested_url??a.configured_url,browser_mode:a.browser_mode??'headless',accessible:a.accessible,reason:a.reason,http_status:a.http_status,capture:a.capture,sha256:a.sha256}))};
});
const endpoints={};
for(const id of new Set(rows.map(r=>r.site_id))){
 const group=rows.filter(r=>r.site_id===id);
 if(id.startsWith('local-')){const valid=group.filter(r=>r.accessible);if(valid.length)endpoints[id]=valid.map(r=>r.configured_url);}
 else if(group.every(r=>r.accessible))endpoints[id]=group.map(r=>r.configured_url);
}
// Every original historical item with multiple links still needs usable portals.
for(const row of rows)row.decision=endpoints[row.site_id]?.includes(row.configured_url)?'enabled':'paused';
const report={version:'integrity-accessibility-v1',checked_at:'2026-11-17',policy:'usable official page plus actual screenshot; search completion and zero results do not affect availability',network:'local Docker public egress via product official-site proxy; not production Beijing egress',inventory_source:plan.inventory_source,browser_image:'sha256:134e040ae35b6995cc9de5cb2233fce5372c57fb8ec9ac8fa67ec0dff05bf88f',model_calls:0,production_mutations:0,tested_endpoints:rows.length,enabled_site_ids:Object.keys(endpoints),enabled_endpoints:rows.filter(r=>r.decision==='enabled').length,paused_endpoints:rows.filter(r=>r.decision==='paused').length,results:rows};
mkdirSync('docs/acceptance',{recursive:true});
writeFileSync('docs/acceptance/integrity-accessibility-20261117.json',JSON.stringify(report,null,2)+'\n');
writeFileSync(root+'/测试汇总.json',JSON.stringify(report,null,2)+'\n');
writeFileSync('packages/contracts/src/integrity-site-availability.ts',`/** Portal access and screenshots verified separately from query outcomes.\n * Evidence: docs/acceptance/integrity-accessibility-20261117.json.\n * Empty search results and incomplete automation do not retire a usable portal. */\nexport const INTEGRITY_AVAILABILITY_CHECKED_AT = '2026-11-17';\nexport const INTEGRITY_VERIFIED_ENDPOINTS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(endpoints,null,2)};\n`);
for(const file of ['packages/contracts/src/integrity-regions.ts','packages/contracts/src/integrity-sites.ts']){
 let source=readFileSync(file,'utf8');
 for(const r of rows.filter(r=>r.accessible&&r.original_url!==r.configured_url)){
  if(new URL(r.original_url).hostname!==new URL(r.configured_url).hostname)throw Error('Unexpected origin change');
  source=source.replaceAll(r.original_url,r.configured_url);
 }
 writeFileSync(file,source);
}
const labels={official_page_rendered:'官网页面与截图正常',http_error:'HTTP访问失败',navigation_error:'网络连接失败',error_or_maintenance_page:'错误或维护页面',blank_or_unusable_page:'空白或未取得可用页面',probe_failure:'未完成页面打开或截图'};
const table=items=>'| 网站/入口 | 地址 | 状态 | 本次访问结果 |\n|---|---|---|---|\n'+items.map(r=>`| ${r.name} | ${r.configured_url} | ${r.decision==='enabled'?'启用':'暂停'} | ${labels[r.reason]??r.reason}${r.http_status?'（'+r.http_status+'）':''}${r.original_url!==r.configured_url?'；更新为同域HTTPS':''} |`).join('\n');
const national=rows.filter(r=>r.category==='national'),regional=rows.filter(r=>r.category==='regional');
const md=`# 诚信核查网站访问与截图复测\n\n2026-11-17，本地隔离 Chromium，经产品官网代理真实访问 129 个入口；不调用模型、不创建生产任务、不扣用户积分。新口径只要求正常官网页面和有效截图，不再要求自动搜索完成。零结果不导致停用，登录/验证码与未完成搜索仍在任务结果中如实记录。\n\n目录完整显示 54 项（52 全国项、2 属地项）；全国 ${national.filter(r=>r.decision==='enabled').length}/52 项可选；地方证监局 ${regional.filter(r=>r.site_id==='local-csrc'&&r.decision==='enabled').length}/36 个、税务局 ${regional.filter(r=>r.site_id==='local-tax'&&r.decision==='enabled').length}/36 个入口通过。完整审计含5个历史入口，共启用${report.enabled_endpoints}个入口、暂停${report.paused_endpoints}个。入口数不是独立网站数，地方入口只按企业注册地带入。\n\n失败保留两次尝试；旧HTTP地址失败时复验同域HTTPS，成功才更新地址。截图逐项查看并保留SHA256。测试基于本地出口；生产官网代理通道仍须单独验证，不能据此称线上任务已成功。\n\n## 全国查询项\n\n${table(national)}\n\n## 属地入口\n\n${table(regional)}\n\n## 历史入口\n\n${table(rows.filter(r=>r.category==='legacy'))}\n\n代码完成后仍需按发布规则上线。本报告是访问性测试，未将首页、验证码或未完成查询冒充“无记录”结论。\n`;
writeFileSync('docs/acceptance/integrity-accessibility-20261117.md',md);writeFileSync(root+'/网站启停清单.md',md);
console.log(JSON.stringify({national:national.filter(r=>r.decision==='enabled').length,regional:regional.filter(r=>r.decision==='enabled').length,enabled:report.enabled_endpoints,paused:report.paused_endpoints}));
