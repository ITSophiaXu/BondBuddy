import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gatherExternal, externalDocuments, externalCsv } from '../lib/external.mjs';
import { mcpSession, endpoint } from '../lib/mcp.mjs';
const config={id:'wind',vendor:'wind',name:'Wind 测试',url:'http://127.0.0.1:9876/mcp',tool:'bonds',purpose:'bonds',enabled:true,args:{issuer:'{{issuer}}',query:'{{query}}',cursor:'{{cursor}}',includeMatured:true,includeOutstanding:true}};
function mock(pages,tool={name:'bonds',annotations:{readOnlyHint:true},inputSchema:{required:['issuer']}}){let calls=0;return {get calls(){return calls;},session:async()=>({tools:async()=>[tool],rpc:async(method,{arguments:args})=>{assert(args.includeMatured&&args.includeOutstanding);assert(args.query.includes('已到期'));assert.equal(args.cursor,calls?'p2':'');return {structuredContent:pages[calls++]};},close:async()=>{}})};}
test('all historical issuance pages include matured and outstanding records with provenance',async()=>{
  const meta={issuer:'测试发行人',scope:{includeMatured:true,includeOutstanding:true},total:2};const stub=mock([{...meta,bonds:[{bondCode:'A',bondName:'已到期债券',status:'到期兑付'}],nextCursor:'p2'},{...meta,bonds:[{bondCode:'B',bondName:'存续债券',status:'存续'}],complete:true}]);
  const r=await gatherExternal({query:'兑付情况',issuer:'测试发行人',bondQuery:true,connectorIds:['wind'],settings:{connectors:[config]},sessionFactory:stub.session});assert.equal(stub.calls,2);assert.equal(r.results.length,2);assert.equal(r.coverage[0].complete,true);assert.equal(r.limitations.length,0);assert(externalCsv(r).includes('已到期债券'));assert(externalDocuments(r)[0].records[0].text.includes('查询时间'));
});
test('incomplete scope, mismatched issuer and missing configuration never become complete evidence',async()=>{
  const stub=mock([{issuer:'其他公司',bonds:[{status:'存续'}],complete:true}]);const r=await gatherExternal({query:'兑付情况',issuer:'测试发行人',bondQuery:true,connectorIds:['wind'],settings:{connectors:[config]},sessionFactory:stub.session});assert.equal(r.coverage[0].complete,false);assert(r.limitations.some(s=>s.includes('全部历史')));
  const missing=await gatherExternal({query:'兑付情况',bondQuery:true,settings:{}});assert.equal(missing.results.length,0);assert(missing.limitations.some(s=>s.includes('尚未完成')));
});
test('empty all-history results stay unverified and CSV protects spreadsheet formula cells',async()=>{
  const stub=mock([{issuer:'测试发行人',scope:{includeMatured:true,includeOutstanding:true},bonds:[],total:0,complete:true}]);const r=await gatherExternal({query:'兑付情况',issuer:'测试发行人',bondQuery:true,connectorIds:['wind'],settings:{connectors:[config]},sessionFactory:stub.session});assert.equal(r.coverage[0].complete,false);assert(r.limitations.some(s=>s.includes('未返回记录')));
  const csv=externalCsv({results:[{source:'test',title:'=CMD()',raw:{bondCode:'@A',payments:['已兑付']},accessedAt:'now'}]});assert(csv.includes("'=CMD()"));assert(csv.includes("'@A"));assert(csv.includes('兑息兑付记录'));
});
test('destructive tools never execute; repeated pages stop with a coverage gap',async()=>{
  const stub=mock([],{name:'bonds',annotations:{readOnlyHint:true,destructiveHint:true}});const r=await gatherExternal({issuer:'测试',query:'兑付',bondQuery:true,connectorIds:['wind'],settings:{connectors:[{...config,readOnlyConfirmed:true}]},sessionFactory:stub.session});assert.equal(stub.calls,0);assert(r.limitations.some(s=>s.includes('只读')));
  const pages=mock([{bonds:[{a:1}],nextCursor:'p2'},{bonds:[{b:1}],nextCursor:'p2'}]);const repeated=await gatherExternal({issuer:'测试',query:'兑付',bondQuery:true,connectorIds:['wind'],settings:{connectors:[config]},sessionFactory:pages.session});assert.equal(repeated.coverage[0].complete,false);assert(repeated.limitations.some(s=>s.includes('重复')));
});
test('actual MCP HTTP handshake, session, paginated tool discovery and SSE tool response',async()=>{
  const seen=[];const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
    let raw='';for await(const b of req)raw+=b;const v=JSON.parse(raw);seen.push(v.method);assert.equal(req.headers.authorization,'Bearer test-only');
    if(v.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    let result=v.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:v.method==='tools/list'?(v.params.cursor?{tools:[{name:'second'}]}:{tools:[{name:'bonds'}],nextCursor:'two'}):{structuredContent:{results:[{content:'ok'}]}};
    if(v.method==='initialize')res.setHeader('Mcp-Session-Id','test-session');else assert.equal(req.headers['mcp-session-id'],'test-session');
    if(v.method==='tools/call'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:v.id,result})+'\n\n');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));let session;
  try{session=await mcpSession({url:`http://127.0.0.1:${server.address().port}/mcp`,token:'test-only'});assert.equal((await session.tools()).length,2);assert((await session.rpc('tools/call',{name:'bonds',arguments:{}})).structuredContent);assert.deepEqual(seen.slice(0,2),['initialize','notifications/initialized']);}finally{await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
  assert.throws(()=>endpoint('http://external.example/mcp'));assert.throws(()=>endpoint('https://user:secret@example.com/mcp'));
});
