import { randomUUID } from 'node:crypto';
export function endpoint(value) {
  const u=new URL(value);
  if(u.username||u.password||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw new Error('连接地址须为 HTTPS，或本机 HTTP；凭证请填写在密钥栏。');
  return u.href;
}
export async function mcpSession(config,signal,fetcher=fetch) {
  const url=endpoint(config.url);let session='',version='2025-03-26';
  async function rpc(method,params,notification=false) {
    const id=randomUUID(),timeout=AbortSignal.timeout(30000);
    const response=await fetcher(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(config.token?{Authorization:`Bearer ${config.token}`} :{}),...(session?{'Mcp-Session-Id':session}:{}),'MCP-Protocol-Version':version},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params}),signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if(!response.ok)throw new Error(`MCP 服务返回 ${response.status}`);
    if(response.headers.get('Mcp-Session-Id'))session=response.headers.get('Mcp-Session-Id');
    if(notification){await response.body?.cancel();return;}
    let payload;const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',size=0;
    const stream=response.headers.get('content-type')?.includes('text/event-stream');
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>12*1024*1024)throw new Error('MCP 响应超过 12 MB，请使用分页。');buffer+=decoder.decode(value,{stream:true});if(stream){buffer=buffer.replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data){const message=JSON.parse(data);if(message.id===id){payload=message;break;}}}if(payload)break;}}if(!stream)payload=JSON.parse(buffer+decoder.decode());}finally{await reader.cancel().catch(()=>{});}
    if(!payload||payload.id!==id)throw new Error('MCP 响应与请求不匹配。');
    if(payload.error)throw new Error(`MCP 调用失败（${payload.error.code}）。请检查工具和参数配置。`);
    return payload.result;
  }
  const initialized=await rpc('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'BondBuddy',version:'1.1.0'}});
  version=initialized.protocolVersion||version;await rpc('notifications/initialized',{},true);
  return {rpc,async tools(){const result=[],seen=new Set();let cursor;for(let i=0;i<20;i++){const page=await rpc('tools/list',cursor?{cursor}:{});result.push(...(page.tools||[]));if(!page.nextCursor)return result;if(seen.has(page.nextCursor))throw new Error('工具目录分页游标重复。');cursor=page.nextCursor;seen.add(cursor);}throw new Error('工具目录分页超限。');},async close(){if(session)await fetcher(url,{method:'DELETE',redirect:'error',headers:{'Mcp-Session-Id':session,'MCP-Protocol-Version':version,...(config.token?{Authorization:`Bearer ${config.token}`}:{})},signal:AbortSignal.timeout(3000)}).then(r=>r.body?.cancel()).catch(()=>{});}};
}
export function templateArgs(template,values){
  if(Array.isArray(template))return template.map(v=>templateArgs(v,values));
  if(template&&typeof template==='object')return Object.fromEntries(Object.entries(template).map(([k,v])=>[k,templateArgs(v,values)]));
  if(typeof template==='string')return template.replace(/\{\{(query|issuer|cursor)\}\}/g,(_,key)=>values[key]??'');
  return template;
}
export function unwrap(result) {
  if(result.isError)throw new Error('查询工具报告失败。');
  if(result.structuredContent)return result.structuredContent;
  const blocks=(result.content||[]).filter(c=>c.type==='text').map(c=>c.text);
  for(const text of blocks)try{return JSON.parse(text);}catch{}
  return {results:blocks.map(content=>({title:'MCP 查询结果',content})),complete:false};
}
