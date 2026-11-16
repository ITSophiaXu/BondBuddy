/** Turn a complete real-site sweep into the new-check allowlist and a reviewable report. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.env.BB_SITE_SWEEP_OUTPUT;
if(!root)throw Error('Explicit BB_SITE_SWEEP_OUTPUT required');
const plan=JSON.parse(readFileSync(root+'/plan.json','utf8'));
if(plan.jobs.length!==129||new Set(plan.jobs.map(job=>job.key)).size!==129)throw Error('Expected the complete 129-endpoint inventory');
const review=JSON.parse(readFileSync(root+'/visual-review.json','utf8'));
const rows=plan.jobs.map(job=>{
 const row=JSON.parse(readFileSync(root+'/results/'+job.key+'.json','utf8'));
 if(row.pending||row.key!==job.key||row.site?.id!==job.site.id||row.site.links[0].url!==job.site.links[0].url)throw Error('Incomplete/mismatched test: '+job.key);
 if(row.test_error||row.runtime_failure)throw Error('Resolve test/runtime failure before classification: '+job.key);
 for(const c of row.captures??[])if(createHash('sha256').update(readFileSync(root+'/'+c.file)).digest('hex')!==c.sha256)throw Error('Capture hash mismatch: '+job.key);
 if(row.verified_query){const checked=review.results.find(item=>item.key===row.key&&item.decision==='query_and_result_visible');if(!checked||!row.captures.some(c=>c.file===checked.capture&&c.sha256===checked.sha256))throw Error('Review the real query/result screenshot: '+job.key);}
 return row;
});
const nationalIds=[...new Set(rows.filter(r=>r.category!=='regional').map(r=>r.site.id))];
const endpoints={};
for(const id of nationalIds){const group=rows.filter(r=>r.site.id===id);if(group.every(r=>r.verified_query))endpoints[id]=group.map(r=>r.site.links[0].url);}
for(const id of ['local-csrc','local-tax']){const group=rows.filter(r=>r.site.id===id&&r.verified_query);if(group.length)endpoints[id]=group.map(r=>r.site.links[0].url);}
const started=rows.map(r=>r.started_at).sort()[0],finished=rows.map(r=>r.checked_at).sort().at(-1);
const checkedDate=new Date(Date.parse(finished)+8*3600e3).toISOString().slice(0,10);
const localTime=iso=>new Date(Date.parse(iso)+8*3600e3).toISOString().replace('T',' ').slice(0,19);
const results=rows.map(r=>({key:r.key,site_id:r.site.id,name:r.site.name,category:r.category,...(r.region?{region:r.region}:{}),subject:r.subject,configured_url:r.site.links[0].url,checked_at:r.checked_at,elapsed_ms:r.elapsed_ms,...(r.retry_of?{retry_of:r.retry_of}:{}),query:r.query,outcome:r.outcome,search_performed:r.search_performed,verified_query:r.verified_query,decision:endpoints[r.site.id]?.includes(r.site.links[0].url)?'enabled':'paused',diagnostic:r.diagnostic,captures:r.captures.map(({text,...c})=>c)}));
const report={version:'integrity-site-sweep-v1',screenshot_review:review,started_at:started,finished_at:finished,network:plan.network,inventory_source:plan.inventory_source,collector_source:plan.collector_source,model_calls:0,production_mutations:0,routing_note:plan.routing_note,tested_endpoints:rows.length,enabled_site_ids:Object.keys(endpoints),enabled_endpoints:results.filter(r=>r.decision==='enabled').length,paused_endpoints:results.filter(r=>r.decision==='paused').length,results};
mkdirSync('docs/acceptance',{recursive:true});
writeFileSync('docs/acceptance/integrity-site-sweep-20261116.json',JSON.stringify(report,null,2)+'\n');
writeFileSync(root+'/测试汇总.json',JSON.stringify(report,null,2)+'\n');
writeFileSync('packages/contracts/src/integrity-site-availability.ts',`/** Verified public endpoints for NEW checks only. Historical metadata is preserved.\n * Evidence: docs/acceptance/integrity-site-sweep-20261116.json.\n * A reachable homepage or an unconfirmed query is insufficient for this allowlist. */\nexport const INTEGRITY_AVAILABILITY_CHECKED_AT = '${checkedDate}';\nexport const INTEGRITY_VERIFIED_ENDPOINTS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(endpoints,null,2)};\n`);
const labels={results:'返回查询结果',no_results:'明确返回零结果',captcha_required:'验证码阻断',login_required:'需登录',authentication_required:'需登录和验证码',access_denied:'访问被拒绝',http_error:'HTTP 错误',blank_page_timeout:'页面空白超时',page_load_timeout:'页面加载超时',result_load_timeout:'结果加载超时',query_form_unavailable:'查询入口未就绪',result_unverified:'结果未确认',network_error:'网络或页面资源错误',page_error:'页面报错',operation_failed:'查询操作失败'};
const national=results.filter(r=>r.category==='national'),regional=results.filter(r=>r.category==='regional'),legacy=results.filter(r=>r.category==='legacy');
const detail=r=>[labels[r.diagnostic?.code]??r.outcome,r.diagnostic?.phase,r.diagnostic?.http_status,r.diagnostic?.detail].filter(Boolean).join(' / ').replaceAll('|','\\|');
const table=items=>'|查询项 / 入口|决定|本次结果|截图数|\n|---|---|---|---:|\n'+items.map(r=>`|[${r.name}](${r.configured_url})${r.region?'（'+r.region+'）':''}|${r.decision==='enabled'?'启用':'暂停'}|${detail(r)}|${r.captures.length}|`).join('\n')+'\n';
const md=`# BondBuddy 诚信核查逐站实测与启停清单\n\n实测时间（北京时间）：${localTime(started)} 至 ${localTime(finished)}。本机 Docker、真实 Chromium、产品官方采集器，通过本机公网出口访问；未使用生产北京出口。\n\n## 结果\n\n已完成 ${rows.length} 个实际入口测试：52 个全国查询项、4 个历史查询项（其中 1 项含 2 个入口）、36 个地区各 2 个属地入口。按“已提交查询、结果明确、保留真实结果截图”启用 ${report.enabled_endpoints} 个入口，暂停 ${report.paused_endpoints} 个入口。主页能打开、验证码拦截、未确认结果和查询超时均不算完成查询。暂停原因分开记录，不统一称作网站宕机。\n\n全国目录启用 ${national.filter(r=>r.decision==='enabled').length}／52 项；历史目录保留 ${legacy.filter(r=>r.decision==='enabled').length}／5 个入口；属地证监局启用 ${regional.filter(r=>r.site_id==='local-csrc'&&r.decision==='enabled').length}／36 个地区、税务局启用 ${regional.filter(r=>r.site_id==='local-tax'&&r.decision==='enabled').length}／36 个地区。多个栏目可以来自同一网站，不能把入口数当成独立域名数。\n\n## 使用规则\n\n- 新核查仅选择实测通过的入口；属地选项须对应本轮所有企业均通过的地区，否则不带入该选项。注册地变化后重新核对并保存范围，不默默跳过部分企业后照原范围收费。\n- 服务端保存、报价、新建执行同一范围校验，客户端旧版本不能绕过。原任务、待确认请求、历史查询记录、证据及免费重导出保留原范围。\n- 测试查询词为“东营市城市建设发展集团有限公司”，专项栏目附加事项关键词。地区字段仅用于逐入口测试，不表示该公司在每个地区注册，也不形成对该发行人的诚信结论。\n- 本次不调用模型、不生成生产任务、不连接生产数据库、不扣用户积分。返回搜索结果不等于发现违法，零结果也不等于企业不存在风险。\n- 本机出口测试不替代最终生产执行节点验收；统一发布前须在最终节点复核启用范围。当前代码尚未部署。\n\n## 全国查询项\n\n${table(national)}\n## 属地入口\n\n${table(regional)}\n## 历史查询项\n\n旧任务仍可查看这些入口的原始元数据；仅实测通过的历史范围可用于准备新核查。同一历史项含多个入口时，须全部通过才保留该项。\n\n${table(legacy)}\n## 后续恢复\n\n逐站修复其表中具体原因，在目标执行环境真实提交查询，核对结果归属、查询事项和截图后，更新实测证据和可用入口表，再交统一发布。不把登录/验证码页、门户首页或未完成查询写成“无记录”。\n\n采集器来源：${plan.collector_source}。原目录来源：${plan.inventory_source}。每条记录包含配置入口、查询词、开始/完成状态、诊断和截图哈希，见同目录测试汇总 JSON；本地保留全部截图和完整原始采集结果。所有启用入口均已逐项查看首张结果截图，核对查询词、官网归属和结果状态；其中模糊匹配的其他主体内容不作为测试企业的失信结论。首次测试触及 420 秒总时限的入口均单独复验，首轮异常保存在 first-attempts，摘要中保留 retry_of。\n`;
writeFileSync('docs/acceptance/integrity-site-sweep-20261116.md',md);writeFileSync(root+'/网站启停清单.md',md);
console.log(JSON.stringify({tested:report.tested_endpoints,enabled_endpoints:report.enabled_endpoints,paused_endpoints:report.paused_endpoints,enabled_site_ids:report.enabled_site_ids}));
