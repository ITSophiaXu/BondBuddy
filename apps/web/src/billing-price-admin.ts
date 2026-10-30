import {Value} from '@sinclair/typebox/value';
import {AUTOMATIC_TASK_SKUS,billingPriceAdminSchemas,billingPermissionSchemas, type BillingPermission,type BillingCostVersion,type BillingPriceVersion,type BillingCostVersionCreate,type BillingPriceDraftCreate} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError} from './api';
import {date,esc} from './ui';
import './billing-price-admin.css';

export function multiplierToBps(value:string):string{
  if(!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/.test(value))throw Error('倍率需大于0、至多4位小数，且不超过100。');
  const [whole,fraction='']=value.split('.'),bps=BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
  if(bps<=0n||bps>1000000n)throw Error('倍率需大于0，且不超过100。');return bps.toString();
}
const fen=(v:string)=>{const n=BigInt(v);return `${n/100n}.${(n%100n).toString().padStart(2,'0')}`;};
const pts=(v:string)=>BigInt(v).toLocaleString('zh-CN');
const bpsToMultiplier=(v:string)=>`${BigInt(v)/10000n}.${(BigInt(v)%10000n).toString().padStart(4,'0')}`.replace(/\.?0+$/,'');
type Intent={kind:'cost'|'draft'|'validate'|'publish';path:string;body:Record<string,unknown>};
const prefix='/admin/price-versions';
const costPath='/admin/cost-versions';

export function priceComparisonHtml(version:BillingPriceVersion):string{
  return `<div class="billing-price-table" role="region" aria-label="全部十二项任务价格差异" tabindex="0"><table><thead><tr><th>任务 / 单位</th><th>规划成本（元）</th><th>基准价（元）</th><th>原积分</th><th>新积分</th><th>积分变化</th></tr></thead><tbody>${version.rows.map(r=>`<tr><th scope="row">${esc(r.label)}<small>${esc(r.unit)} · ${esc(r.sku)}</small></th><td>${r.planned_cost_cny===null?'来源未补齐':esc(r.planned_cost_cny)}</td><td>${fen(r.base_price_fen)}</td><td>${pts(r.previous_points)}</td><td><strong>${pts(r.points)}</strong></td><td>${BigInt(r.delta_points)>0n?'+':''}${pts(r.delta_points)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** Account management extension. Publication always binds the reviewed immutable checksum. */
export class BillingPriceAdminPage{
  private controller=new AbortController();private permissions=new Set<BillingPermission>();
  private costs:BillingCostVersion[]=[];private versions:BillingPriceVersion[]=[];private selected?:string;private current='';
  private loading=false;private busy=false;private error='';private notice='';private pending?:Intent;private storageBlocked=false;
  private costJson=JSON.stringify({rows:AUTOMATIC_TASK_SKUS.map(sku=>({sku,planned_cost_cny:'',source:''})),change_reason:''},null,2);
  private baseCost='';private multiplier='1.7';private reason='';private effective='';private restored=false;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private active:()=>boolean,private owner:string){}
  dispose(){this.controller.abort();}
  private live(){return this.active()&&!this.controller.signal.aborted;}
  private key(){return 'bb-price-admin-intent-v1:'+this.owner;}
  private restore(){
    if(this.restored)return;this.restored=true;
    try{const raw=localStorage.getItem(this.key());if(!raw)return;const x=JSON.parse(raw) as Intent;
      if(!x||!['cost','draft','validate','publish'].includes(x.kind)||typeof x.path!=='string'||!x.body||typeof x.body!=='object')throw Error();
      const schema=x.kind==='cost'?billingPriceAdminSchemas.BillingCostVersionCreateRequest:x.kind==='draft'?billingPriceAdminSchemas.BillingPriceDraftCreateRequest:x.kind==='validate'?billingPriceAdminSchemas.BillingPriceValidateRequest:billingPriceAdminSchemas.BillingPricePublishRequest;
      const expected=x.kind==='cost'?x.path===costPath:x.kind==='draft'?x.path===prefix:new RegExp('^/admin/price-versions/[A-Za-z0-9_-]+/'+x.kind+'$').test(x.path);
      if(!expected||!Value.Check(schema,x.body))throw Error();this.pending=x;
    }catch{this.storageBlocked=true;this.error='未能可靠读取原管理操作。请保留当前页面并联系账务管理员核实。';}
  }
  async render(){this.restore();await this.refresh();}
  private async refresh(){
    if(this.loading||!this.live())return;this.loading=true;this.draw();
    try{
      const auth=await this.api.request<{permissions:BillingPermission[]}>('GET','/billing/permissions',undefined,{},this.controller.signal);
      if(!Value.Check(billingPermissionSchemas.BillingPermissionsResponse,auth))throw Error('Invalid permissions');
      if(!this.live())return;this.permissions=new Set(auth.permissions);
      if(this.permissions.has('price_draft')||this.permissions.has('price_publish')){
        const [costs,prices]=await Promise.all([this.api.request<{items:BillingCostVersion[]}>('GET',costPath,undefined,{},this.controller.signal),this.api.request<{current_version:string;items:BillingPriceVersion[]}>('GET',prefix,undefined,{},this.controller.signal)]);
        if(!Value.Check(billingPriceAdminSchemas.BillingCostVersionsResponse,costs)||!Value.Check(billingPriceAdminSchemas.BillingPriceVersionsResponse,prices))throw Error('Invalid price versions');
        if(!this.live())return;this.costs=costs.items;this.versions=prices.items;this.current=prices.current_version;
        this.baseCost ||= this.costs[0]?.id??'';this.selected ||= this.versions[0]?.id;
      }
      if(!this.storageBlocked)this.error='';
    }catch(e){if(this.live())this.error=friendlyError(e,'read');}
    finally{if(this.live()){this.loading=false;this.draw();}}
  }
  private async execute(intent:Intent){
    if(this.busy||this.storageBlocked||!this.live())return;
    if(!navigator.locks){this.error='当前浏览器不支持可靠的跨页面操作锁，请换用支持该功能的浏览器后继续。';this.draw();return;}
    await navigator.locks.request(this.key(),{ifAvailable:true},async lock=>{
      if(!lock){this.error='另一个页面正在处理价格操作，请等待后刷新核对。';this.draw();return;}
      await this.executeLocked(intent);
    });
  }
  private async executeLocked(intent:Intent){
    if(this.busy||this.storageBlocked||!this.live())return;
    try{const old=localStorage.getItem(this.key()),raw=JSON.stringify(intent);if(old&&old!==raw)throw Error();localStorage.setItem(this.key(),raw);if(localStorage.getItem(this.key())!==raw)throw Error();this.pending=intent;}
    catch{this.storageBlocked=true;this.error='无法保留原操作，尚未发送。请联系账务管理员核实。';this.draw();return;}
    this.busy=true;this.error='';this.notice='正在提交原管理操作…';this.draw();
    try{
      const result=await this.api.request<{cost_version?:BillingCostVersion;version?:BillingPriceVersion}>('POST',intent.path,intent.body,{},this.controller.signal);
      const schema=intent.kind==='cost'?billingPriceAdminSchemas.BillingCostVersionResponse:billingPriceAdminSchemas.BillingPriceVersionResponse;
      if(!Value.Check(schema,result))throw Error('Invalid price management result');if(!this.live())return;
      if(localStorage.getItem(this.key())!==JSON.stringify(intent))throw Error('Original operation changed');localStorage.removeItem(this.key());if(localStorage.getItem(this.key())!==null)throw Error('Original operation not cleared');
      this.pending=undefined;if('cost_version' in result)this.baseCost=result.cost_version.id;
      const savedVersion='version' in result?result.version:undefined;if(savedVersion){this.selected=savedVersion.id;this.versions=[savedVersion,...this.versions.filter(v=>v.id!==savedVersion.id)];}
      this.notice=intent.kind==='publish'?'该价格已发布，将在指定时间用于新任务。':intent.kind==='validate'?(savedVersion?.validated_checksum?'全部校验通过，可按权限发布。':'校验未通过，请查看各项结果；当前价格不受影响。'):'版本已保存，原始内容与来源保持冻结。';
      await this.refresh();
    }catch(e){if(this.live()){
      this.error=friendlyError(e,'save');this.notice='原操作已保留。先刷新核对，也可重试同一操作；不会自动新建另一笔。';
      if(e instanceof ApiError&&e.status===422){
        try{if(localStorage.getItem(this.key())!==JSON.stringify(intent))throw Error();localStorage.removeItem(this.key());if(localStorage.getItem(this.key())!==null)throw Error();this.pending=undefined;this.notice='服务端已拒绝此操作，输入保留，请修正后提交。';}
        catch{this.storageBlocked=true;}
      }
    }}
    finally{if(this.live()){this.busy=false;this.draw();}}
  }
  private draft(rollback?:BillingPriceVersion){
    try{
      const body:BillingPriceDraftCreate={request_id:crypto.randomUUID(),base_cost_version:rollback?.base_cost_version??this.baseCost,multiplier_bps:rollback?.multiplier_bps??multiplierToBps(this.multiplier),change_reason:this.reason.trim(),...(rollback?{rollback_of:rollback.id}:{})};
      if(!Value.Check(billingPriceAdminSchemas.BillingPriceDraftCreateRequest,body)||!body.change_reason)throw Error('请选择成本版本并填写变更原因。');
      void this.execute({kind:'draft',path:prefix,body});
    }catch(e){this.error=e instanceof Error?e.message:'请核对草稿输入。';this.draw();}
  }
  private draw(){
    if(!this.live())return;const allowed=this.permissions.has('price_draft')||this.permissions.has('price_publish'),v=this.versions.find(x=>x.id===this.selected);
    const disabled=this.busy||!!this.pending||this.storageBlocked,attr=disabled?'disabled':'';
    this.shell(`<div class="billing-price-admin"><a href="#/account">返回我的账号</a><header><h1>价格管理</h1><p>冻结标准成本，核对全部任务差异，再发布未来生效的价格。</p></header>
      ${this.error?`<p class="form-message" role="alert">${esc(this.error)}</p>`:''}${this.notice?`<p role="status">${esc(this.notice)}</p>`:''}
      <button class="button secondary" id="price-refresh" ${this.loading||this.busy?'disabled':''}>${this.loading?'正在读取…':'刷新版本与权限'}</button>
      ${this.pending?`<section class="panel price-admin-pending"><h2>原操作待核对</h2><p>${esc(this.pending.kind==='publish'?'发布价格':this.pending.kind==='validate'?'校验价格':this.pending.kind==='cost'?'冻结成本':'创建草稿')} · ${esc(this.pending.path)}</p><button class="button primary" id="price-retry" ${this.busy?'disabled':''}>重试原操作</button><p>保留原内容、原版本与原生效时间，成功后才结束这次操作。</p></section>`:''}
      ${!allowed?`<p>${this.loading?'正在读取权限…':'当前账号没有价格管理权限。'}</p>`:`<p class="price-version-current">当前生效版本 <code>${esc(this.current)}</code></p>
      ${this.permissions.has('price_draft')?`<details class="panel"><summary>录入并冻结完整标准成本</summary><p>每项均填写人民币规划成本与来源。缺少原始成本时可查看旧基准，不能据此发布新价。</p><label for="cost-json">12项标准成本 JSON</label><textarea id="cost-json" rows="12" spellcheck="false" ${attr}>${esc(this.costJson)}</textarea><button class="button secondary" id="cost-freeze" ${attr}>冻结成本版本</button></details>
      <section class="panel"><h2>新建价格草稿</h2><div class="price-admin-form"><label>标准成本版本<select id="price-cost" ${attr}>${this.costs.map(c=>`<option value="${esc(c.id)}" ${c.id===this.baseCost?'selected':''}>${esc(c.id)}${c.complete?' · 来源完整':' · 缺原始成本，不可发布'}</option>`).join('')}</select></label><label>定价倍率<input id="price-multiplier" inputmode="decimal" value="${esc(this.multiplier)}" ${attr}></label><label class="price-admin-wide">变更原因<textarea id="price-reason" maxlength="2000" rows="2" ${attr}>${esc(this.reason)}</textarea></label></div><button class="button primary" id="price-draft" ${attr}>生成全部12项价格差异</button><p>倍率始终应用于冻结成本生成的基准价，每个阶段独立向上取整。</p></section>`:''}
      <section class="panel"><h2>版本与价格差异</h2><label for="price-version">选择版本</label><select id="price-version" ${this.busy?'disabled':''}><option value="">选择已保存版本</option>${this.versions.map(x=>`<option value="${esc(x.id)}" ${x.id===this.selected?'selected':''}>${esc(x.id)} · ${x.state==='DRAFT'?'草稿':'已发布'}</option>`).join('')}</select>
      ${v?`<dl class="price-admin-metadata"><div><dt>状态</dt><dd>${v.state==='DRAFT'?'草稿':'已发布'}${v.effective_at?' · 生效 '+esc(date(v.effective_at)):''}</dd></div><div><dt>对比版本</dt><dd>${esc(v.comparison_version)}</dd></div><div><dt>原因</dt><dd>${esc(v.change_reason)}</dd></div><div><dt>内容校验和</dt><dd><code>${esc(v.checksum)}</code></dd></div></dl>${priceComparisonHtml(v)}
      ${v.validation_checks.length?`<ul class="price-admin-checks">${v.validation_checks.map(c=>`<li data-passed="${c.passed}"><strong>${c.passed?'通过':'未通过'}</strong> · ${esc(c.message)}</li>`).join('')}</ul>`:'<p>该草稿尚未校验。</p>'}
      <div class="price-admin-actions">${v.state==='DRAFT'&&this.permissions.has('price_draft')?`<button class="button secondary" id="price-validate" ${attr}>校验此版本</button>`:''}
      ${v.state==='DRAFT'&&this.permissions.has('price_publish')?`<label>生效时间（本机时区）<input type="datetime-local" id="price-effective" value="${esc(this.effective)}" ${attr}></label><button class="button primary" id="price-publish" ${disabled||v.validated_checksum!==v.checksum||!v.validation_checks.length||v.validation_checks.some(c=>!c.passed)?'disabled':''}>发布此版本</button>`:''}
      ${v.state==='PUBLISHED'&&this.permissions.has('price_draft')?`<button class="button secondary" id="price-rollback" ${attr}>按此版本生成回滚草稿</button>`:''}</div><p>已发布版本保留记录；旧有效报价、已受理任务和已付周期继续使用原价格。回滚也需创建、校验并发布新的未来版本。</p>`:'<p>暂无选中的价格草稿。</p>'}</section>`}</div>`,'account');
    const on=(id:string,fn:()=>void)=>document.getElementById(id)?.addEventListener('click',fn,{signal:this.controller.signal});
    on('price-refresh',()=>void this.refresh());on('price-retry',()=>{if(this.pending)void this.execute(this.pending);});
    const field=(id:string,fn:(s:string)=>void)=>document.getElementById(id)?.addEventListener('input',e=>fn((e.target as HTMLInputElement).value),{signal:this.controller.signal});
    field('cost-json',s=>this.costJson=s);field('price-cost',s=>this.baseCost=s);field('price-multiplier',s=>this.multiplier=s);field('price-reason',s=>this.reason=s);field('price-effective',s=>this.effective=s);
    on('cost-freeze',()=>{try{const body={...JSON.parse(this.costJson),request_id:crypto.randomUUID()} as BillingCostVersionCreate;if(!Value.Check(billingPriceAdminSchemas.BillingCostVersionCreateRequest,body))throw Error('请填写12项有效成本、来源及变更原因。');void this.execute({kind:'cost',path:costPath,body});}catch(e){this.error=e instanceof Error?e.message:'请核对标准成本 JSON。';this.draw();}});
    on('price-draft',()=>this.draft());document.getElementById('price-version')?.addEventListener('change',e=>{this.selected=(e.target as HTMLSelectElement).value;this.draw();},{signal:this.controller.signal});
    on('price-validate',()=>{if(v)void this.execute({kind:'validate',path:`${prefix}/${encodeURIComponent(v.id)}/validate`,body:{expected_checksum:v.checksum}});});
    on('price-publish',()=>{try{if(!v||!this.effective)throw Error('请选择明确的未来生效时间。');const when=new Date(this.effective);if(!Number.isFinite(when.valueOf())||when.valueOf()<=Date.now())throw Error('生效时间须在未来。');void this.execute({kind:'publish',path:`${prefix}/${encodeURIComponent(v.id)}/publish`,body:{expected_checksum:v.checksum,effective_at:when.toISOString()}});}catch(e){this.error=e instanceof Error?e.message:'请核对生效时间。';this.draw();}});
    on('price-rollback',()=>{if(v){this.baseCost=v.base_cost_version;this.multiplier=bpsToMultiplier(v.multiplier_bps);this.draft(v);}});
  }
}
