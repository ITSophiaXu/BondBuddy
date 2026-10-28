// Read-only synthetic visual QA host. No API, model, payment or refund mutations are forwarded.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OUTCOME_CATALOG,COMMERCE_RULES,OUTCOME_PRICE_VERSION,LEGACY_OUTCOME_PRICE_VERSION,commerceMetadata} from '@bondbuddy/contracts';
const here=fileURLToPath(new URL('.',import.meta.url)),dist=resolve(here,'../../dist'),prototype=resolve(here,'../../../../product-prototype/public');
const now='2026-10-28T04:00:00Z',future='2030-01-01T00:00:00Z';
const quotation=(id,status,amount,pricing)=>({id,project_id:'synthetic-owned-project',action:'question_answer',input_hash:'a'.repeat(64),quote_status:status,price_version:LEGACY_OUTCOME_PRICE_VERSION,amount_fen:amount,scope_lines:status==='pending_scope'?[]:[{key:id,label:'固定原题、原要求及材料版本',quantity:1,unit:'事项',unit_price_fen:amount,amount_fen:amount,evidence:['合成视觉测试：已锁定原问题和材料版本，不连接真实账务。'],pricing}],reason:status==='pending_scope'?'范围尚待核对，准备材料与要求保留。':'按已确认的问题与材料范围报价。',created_at:now,published_at:status==='pending_scope'?null:now,expires_at:future,closed_at:null,decline_reason:'',closure_reason:'',revision:1,previous_quote_id:null});
const quotes=[quotation('synthetic-covered','ready',0,{base_amount_fen:9900,owned_coverage_fen:9900,due_fen:0,reason:'同版本原范围已购覆盖，无需新增付费。'}),quotation('synthetic-upgrade','ready',6000,{base_amount_fen:9900,owned_coverage_fen:3900,due_fen:6000,reason:'同一事项从事实修订升级实质论证，只补差额。'}),quotation('synthetic-pending','pending_scope',0)];
const records=[{reservation_id:'synthetic-cny',run_id:'synthetic-run',project_id:'synthetic-owned-project',project_name:'合成项目',task_name:'原范围问题回复',created_at:now,finalized_at:now,state:'settled',reserved_points:4990,charged_points:4990,released_points:0,corrected_points:0,...commerceMetadata(4990)},{reservation_id:'synthetic-legacy',run_id:'synthetic-old',project_id:'synthetic-old-project',project_name:'合成旧项目',task_name:'关联文件编制',created_at:now,finalized_at:now,state:'settled',reserved_points:4500,charged_points:4500,released_points:0,corrected_points:0}];
const bodies={
 '/me':{user_id:'synthetic-visual-owner',session_status:'active'},
 '/account':{user_id:'synthetic-visual-owner',username:'synthetic_visual',phone_masked:null,status:'active',created_at:now,accepted_terms_version:'terms-1',current_terms_version:'terms-1',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null},
 '/account/sessions':{items:[]},'/account/recovery':{enabled:false,support_operator:false,current:null,pending:null},
 '/commerce/catalog':{enabled:true,currency:'CNY',version:OUTCOME_PRICE_VERSION,model:'pay_as_you_go',items:OUTCOME_CATALOG,rules:COMMERCE_RULES},
 '/commerce/account':{available_fen:16800,held_fen:4990,payment_enabled:false,providers:[],legacy_balance_notice:'历史积分按提交时规则保留。'},
 '/commerce/quotations':{items:quotes},'/credits/consumption-history':{items:records,page:{next_cursor:null,has_more:false}},'/credits/recharge-history':{items:[],page:{next_cursor:null,has_more:false}},
};
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:5184'),path=decodeURIComponent(url.pathname);
  if(req.method!=='GET'){res.writeHead(405,{'content-type':'application/json'});res.end(JSON.stringify({code:'SYNTHETIC_READ_ONLY'}));return;}
  if(path.startsWith('/api/v1/')){const body=bodies[path.slice(7)];res.writeHead(body?200:404,{'content-type':'application/json'});res.end(JSON.stringify(body??{code:'NOT_FOUND'}));return;}
  const root=path.startsWith('/prototype-commerce/')?prototype:dist,name=path.startsWith('/prototype-commerce/')?path.slice(20):path==='/'?'index.html':path.slice(1),file=resolve(root,name);
  if(file!==root&&!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
  const content=await readFile(file);res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream'});res.end(content);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(5184,'127.0.0.1',()=>console.log('Synthetic read-only visual preview http://127.0.0.1:5184/#/account?quotation=synthetic-covered'));
