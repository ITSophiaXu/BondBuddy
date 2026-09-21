import { mcpSession, templateArgs, unwrap } from './mcp.mjs';
export const BOND_QUERY_RULES='公司债券兑付存续情况须覆盖发行人发行过的全部公司债券，包括已到期与未到期，以及提前兑付、回售、展期、违约等。须核对发行人主体、债券代码、发行额、余额、到期日、兑息兑本记录、违约/展期及查询时点。使用 Wind 或企业预警通等授权数据来源，不能把存续券列表视为全部发行历史。查无结果、分页未完成、主体不确定或状态不全时列待补证，不得据此声称从未违约或全部按期兑付。';
const cleanUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
export async function gatherExternal({query,issuer='',web,registry,connectorIds=[],bondQuery=false,settings,signal,sessionFactory=mcpSession}) {
  const results=[],limitations=[],coverage=[];let totalBytes=0;
  function add(items,provider,tool='') {for(const item of items){const v=typeof item==='object'&&item?item:{content:String(item)},raw=String(v.content||JSON.stringify(v));totalBytes+=Buffer.byteLength(JSON.stringify(v));if(totalBytes>12*1024*1024)throw new Error('查询数据累计超过 12 MB，本次未取得全量记录。');if(raw.length>12000)limitations.push(`${provider} 单条记录过长，仅向模型提供前 12,000 字。`);results.push({title:String(v.title||v.bondName||v.name||'查询结果').slice(0,300),url:cleanUrl(v.url),source:`${provider}${tool?' / '+tool:''}`,content:raw.slice(0,12000),raw:v,accessedAt:new Date().toISOString()});}}
  async function request(url,headers,body,provider){const timeout=AbortSignal.timeout(30000);const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});if(!r.ok)throw new Error('查询失败');const d=await r.json();add((d.results||[]).slice(0,20),provider);}
  if(web){if(!settings.tavilyKey)limitations.push('联网检索未配置，本次未执行网页查询。');else try{const before=results.length;await request('https://api.tavily.com/search',{Authorization:`Bearer ${settings.tavilyKey}`},{query,search_depth:'basic',max_results:5,include_answer:false},'联网搜索');if(results.length===before)limitations.push('联网检索未返回可用来源，不能据此判断事项不存在。');}catch{limitations.push('联网检索失败，本次无法核验最新网页信息。');}}
  if(registry){if(!settings.registryUrl||!settings.registryKey)limitations.push('工商查询尚未连接，本次未获得工商查询结果。');else try{const before=results.length;await request(settings.registryUrl,{Authorization:`Bearer ${settings.registryKey}`},{query},'工商查询');if(results.length===before)limitations.push('工商查询未返回可用来源，不能据此判断企业不存在。');}catch{limitations.push('工商查询服务暂时不可用，本次相关事项未完成外部核验。');}}
  const connectors=settings.connectors||[],selected=new Set(connectorIds);
  for(const id of selected){
    const c=connectors.find(c=>c.id===id&&c.enabled);
    if(!c){limitations.push(`所选数据连接 ${id} 未启用。`);continue;}
    let session;const start=results.length;let pages=0,complete=false,total=null,scopeVerified=true,issuerMatched=true,reason='';
    try{
      if(bondQuery&&c.purpose==='bonds'&&!issuer.trim())throw new Error('请填写发行人全称后查询全部债券。');
      session=await sessionFactory(c,signal);const available=await session.tools(),tool=available.find(t=>t.name===c.tool);
      if(!tool)throw new Error('平台查询服务暂时不可用，本次未取得该来源数据。');
      if(tool.annotations?.destructiveHint===true||!(tool.annotations?.readOnlyHint===true||c.readOnlyConfirmed))throw new Error('仅可调用已确认只读的查询工具。');
      let cursor='',seen=new Set(),rowCount=0;
      for(let i=0;i<50;i++){
        const args=templateArgs(c.args,{query:bondQuery?`${query}\n${BOND_QUERY_RULES}`:query,issuer,cursor});
        for(const key of tool.inputSchema?.required||[])if(!(key in args))throw new Error(`参数模板缺少字段 ${key}`);
        const data=unwrap(await session.rpc('tools/call',{name:c.tool,arguments:args}));pages++;
        const rows=data.bonds||data.results||data.items||[];if(!Array.isArray(rows))throw new Error('查询数据须包含 bonds、results 或 items 数组。');
        rowCount+=rows.length;if(rowCount>10000)throw new Error('超过 10,000 条查询上限，结果未全部获取。');
        add(rows,c.name,c.tool);total=Number.isInteger(data.total)?data.total:total;
        scopeVerified=scopeVerified&&data.scope?.includeMatured===true&&data.scope?.includeOutstanding===true;
        issuerMatched=issuerMatched&&!!issuer&&[data.issuer?.name,data.issuer?.matchedName,data.issuer].includes(issuer.trim());
        const next=data.nextCursor;
        if(next===undefined||next===null||next===''){complete=data.complete===true&&(total===null||total===rowCount);break;}
        if(!JSON.stringify(c.args).includes('{{cursor}}'))throw new Error('服务返回分页，但参数模板没有 {{cursor}}。');
        if(seen.has(String(next)))throw new Error('分页游标重复，已停止查询。');
        seen.add(String(next));cursor=String(next);
      }
      if(!complete)reason='服务未确认已获取全部记录，或分页未完整结束。';
      if(c.purpose==='bonds'&&(!scopeVerified||!issuerMatched)){complete=false;reason+=' 未确认发行人准确匹配及已到期、未到期全口径。';}
      if(results.length===start){complete=false;reason+=' 查询未返回记录，不能据此认定未发债或无违约。';}
    }catch(e){complete=false;reason=e.message;}finally{await session?.close();}
    if(!pages){scopeVerified=false;issuerMatched=false;}
    if(reason)limitations.push(`${c.name}：${reason}`);
    coverage.push({connectorId:c.id,provider:c.name,purpose:c.purpose,issuer,pages,rows:results.length-start,total,complete,scopeVerified,issuerMatched,reason,accessedAt:new Date().toISOString()});
  }
  if(bondQuery&&!coverage.some(c=>c.purpose==='bonds'&&c.complete))limitations.push('全部公司债券兑付存续情况尚未完成外部核验；尚未从 Wind 或企业预警通取得匹配主体的全部历史发行记录。');
  return {results,limitations:[...new Set(limitations)],coverage};
}
export function externalDocuments(external){return external.results.map((r,i)=>({id:`EXT${String(i+1).padStart(5,'0')}`,role:'external',filename:`${r.source} · ${r.title}`,parseStatus:'parsed',warnings:[],records:[{locator:'QUERY',text:`来源：${r.source}\n链接：${r.url||'授权 MCP 数据（无公开链接）'}\n查询时间：${r.accessedAt}\n${r.content}`}]}));}
export function externalCsv(external){const cell=v=>'"'+String(typeof v==='object'?JSON.stringify(v):v??'').replaceAll('"','""').replace(/^[\t\r\n ]*[=+@-]/,"'$&")+'"';return '\uFEFF'+[['来源','债券名称或标题','债券代码','市场','发行日期','发行金额（原单位）','余额（原单位）','到期日','状态','兑息兑付记录','违约及展期','链接','查询时间','原始记录'],...external.results.map(r=>[r.source,r.title,r.raw.bondCode||r.raw.code,r.raw.market,r.raw.issueDate,r.raw.issueAmount,r.raw.balance,r.raw.maturityDate,r.raw.status,r.raw.payments||r.raw.repayment,r.raw.creditEvents||r.raw.defaultStatus,r.url,r.accessedAt,JSON.stringify(r.raw)])].map(row=>row.map(cell).join(',')).join('\r\n');}
