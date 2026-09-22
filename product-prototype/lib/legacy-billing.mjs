import { randomUUID } from 'node:crypto';
import { readJson, atomicJson } from './platform.mjs';

export const PLANS = {
  personal: { id:'personal', name:'个人版', price:49900, qa:1000, documents:40, points:4, externalData:false },
  professional: { id:'professional', name:'专业版', price:99900, qa:2000, documents:80, points:12, externalData:true }
};
const zero = () => ({qa:0,documents:0,points:0});
const fault = (message,code='BILLING_REQUIRED',status=402) => Object.assign(new Error(message),{code,status});
const nextMonth = value => { const d=new Date(value),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString(); };
export const taskCost = (kind,fileCount=0,points) => {if(['update','review'].includes(kind)&&(!Number.isInteger(points)||points<1))throw new Error('请先评估项目点数，再确认开始。');return {qa:kind==='generate'?1:0,documents:kind==='generate'?fileCount:0,points:kind==='generate'?0:points};};

// All read/modify/write operations share one queue. The local server is a single process.
export class Billing {
  constructor(path,{now=()=>new Date(),mode='sandbox'}={}) {this.path=path;this.now=now;this.mode=mode;this.tail=Promise.resolve();}
  transact(fn) {
    const action=this.tail.then(async()=>{
      let db;try{db=await readJson(this.path);}catch(e){if(e.code!=='ENOENT')throw e;db={version:1,seats:[{id:'primary',subscription:null}],orders:[],reservations:{}};}
      const value=await fn(db,this.now().toISOString());await atomicJson(this.path,db);return value;
    });this.tail=action.catch(()=>{});return action;
  }
  seat(db,id='primary') {const s=db.seats.find(s=>s.id===id);if(!s)throw fault('账号不存在。','ACCOUNT_NOT_FOUND',404);return s;}
  ensureAccount(id){return this.transact(db=>{if(!db.seats.some(s=>s.id===id))db.seats.push({id,subscription:null});return {ok:true};});}
  quota(db,seat,now) {
    const s=seat.subscription,active=!!s&&s.endsAt>now,plan=active?PLANS[s.plan]:null;
    const limit=plan?{qa:plan.qa,documents:plan.documents,points:plan.points+s.addonPoints}:zero(),used=active?{...s.used}:zero(),reserved=zero();
    for(const r of Object.values(db.reservations))if(!r.creditVersion&&r.seatId===seat.id&&r.state==='reserved'&&r.cycle===s?.startsAt)for(const k of Object.keys(reserved))reserved[k]+=r.cost[k];
    return {active,plan:plan?.id||null,externalData:plan?.externalData||false,startsAt:s?.startsAt,endsAt:s?.endsAt,limit,used,reserved,available:Object.fromEntries(Object.keys(limit).map(k=>[k,Math.max(0,limit[k]-used[k]-reserved[k])]))};
  }
  view(id='primary') {return this.transact((db,now)=>({mode:this.mode,plans:Object.values(PLANS),addon:{price:29900,points:4},seat:{id,quota:this.quota(db,this.seat(db,id),now)},orders:db.orders.filter(o=>o.ownerId===id).slice().reverse().map(o=>({...o,lines:o.lines.map(({name,email,...line})=>line)})),rules:{documents:'在对话中每新增上传 1 个文件计 1 份；重复引用已关联材料不再计量。更新与复核的材料处理含在任务点数内。',cycle:'每次订阅有效一个月，到期手动续费；额度不结转。升级保留当前周期与已用额度。',account:'套餐和额度仅绑定当前登录账号，无需姓名、邮箱或身份信息。'}}));}
  reserve(id,seatId,cost) {return this.transact((db,now)=>{
    const old=db.reservations[id];if(old&&old.state!=='released')return old;
    const seat=this.seat(db,seatId),q=this.quota(db,seat,now);
    if(!q.active)throw fault('请先订阅个人版或专业版，再开始任务。');
    for(const [k,label] of [['qa','问答次数'],['documents','对话文件上传份数'],['points','更新 / 复核点数']])if(q.available[k]<cost[k]){
      const next=k==='points'?'可加购点数后继续。':`${q.plan==='personal'?'可升级专业版增加本期用量。':'可在下个订阅周期继续。'}加购点数不增加问答次数或对话文件上传份数。`;
      throw fault(`${label}不足：本次需要 ${cost[k]}，可用 ${q.available[k]}。${next}`,'QUOTA_EXHAUSTED');
    }
    return db.reservations[id]={seatId,cost,state:'reserved',cycle:seat.subscription.startsAt,createdAt:now};
  });}
  settle(id,success) {return this.transact((db,now)=>{
    const r=db.reservations[id];if(!r||r.state!=='reserved')return r;
    const seat=this.seat(db,r.seatId);
    if(success&&seat.subscription?.startsAt===r.cycle)for(const k of Object.keys(r.cost))seat.subscription.used[k]+=r.cost[k];
    r.state=success?'consumed':'released';r.settledAt=now;return r;
  });}
  reconcile(jobs) {return this.transact((db,now)=>{
    const byId=new Map(jobs.map(j=>[j.id,j]));
    for(const [id,r] of Object.entries(db.reservations))if(r.state==='reserved'){
      const j=byId.get(id);if(j?.status==='complete') {const s=this.seat(db,r.seatId);if(s.subscription?.startsAt===r.cycle)for(const k of Object.keys(r.cost))s.subscription.used[k]+=r.cost[k];r.state='consumed';}
      else r.state='released';r.settledAt=now;
    }
  });}
  createOrder(ownerId,input) {return this.transact((db,now)=>{
    if(this.mode!=='sandbox')throw fault('支付服务尚未配置，暂不能创建支付订单。','PAYMENT_UNAVAILABLE',503);
    const owner=this.seat(db,ownerId),type=input.type||'subscription';
    if(!['subscription','upgrade','addon'].includes(type))throw fault('订单类型无效。','INVALID_ORDER',400);
    if(typeof input.idempotencyKey!=='string'||!/^[\w-]{8,80}$/.test(input.idempotencyKey))throw fault('请重新打开结算页。','INVALID_ORDER',400);
    const old=db.orders.find(o=>o.ownerId===ownerId&&o.idempotencyKey===input.idempotencyKey);if(old)return old;
    let amount,lines=[];
    const q=this.quota(db,owner,now);
    if(type==='addon'){
      if(!q.active)throw fault('加购需要有效订阅。');
      const count=Number(input.quantity);if(!Number.isInteger(count)||count<1||count>20)throw fault('加购数量须为 1–20 组。','INVALID_ORDER',400);
      amount=29900*count;lines=[{seatId:ownerId,quantity:count,cycle:owner.subscription.startsAt,endsAt:owner.subscription.endsAt,points:4*count}];
    }else if(type==='upgrade'){
      if(q.plan!=='personal')throw fault('只有有效个人版订阅可以升级。','INVALID_ORDER',400);
      const s=owner.subscription,ratio=(new Date(s.endsAt)-new Date(now))/(new Date(s.endsAt)-new Date(s.startsAt));
      amount=Math.ceil((PLANS.professional.price-PLANS.personal.price)*ratio);lines=[{seatId:ownerId,plan:'professional',cycle:s.startsAt,endsAt:s.endsAt}];
    }else{
      if(!PLANS[input.plan])throw fault('套餐无效。','INVALID_ORDER',400);
      if(q.active)throw fault('已有有效订阅，可升级或加购，到期后再续费。','INVALID_ORDER',400);
      lines=[{seatId:ownerId,plan:input.plan}];
      amount=PLANS[input.plan].price;
    }
    const order={id:randomUUID(),ownerId,idempotencyKey:input.idempotencyKey,type,lines,amount,currency:'CNY',mode:'sandbox',status:'pending',createdAt:now,expiresAt:new Date(new Date(now).getTime()+30*60000).toISOString()};db.orders.push(order);return order;
  });}
  order(ownerId,id,action) {return this.transact((db,now)=>{
    const o=db.orders.find(o=>o.id===id&&o.ownerId===ownerId);if(!o)throw fault('订单不存在。','ORDER_NOT_FOUND',404);
    if(o.status==='pending'&&o.expiresAt<=now)o.status='expired';
    if(action==='cancel'&&o.status==='pending')o.status='cancelled';
    if(action==='sandbox-pay'){
      if(this.mode!=='sandbox'||o.mode!=='sandbox')throw fault('演示支付不可用。','PAYMENT_UNAVAILABLE',503);
      if(o.status==='paid')return o;
      if(o.status!=='pending')throw fault('订单已关闭，请重新下单。','ORDER_CLOSED',409);
      // Validate every line before mutation; stale orders never grant extra quota.
      for(const line of o.lines){
        const seat=db.seats.find(s=>s.id===line.seatId),q=seat&&this.quota(db,seat,now);
        if(o.type==='subscription'&&q?.active)throw fault('订阅状态已变化，请取消订单后重新选择。','STALE_ORDER',409);
        if(o.type!=='subscription'&&(!q?.active||seat.subscription.startsAt!==line.cycle||(o.type==='upgrade'&&q.plan!=='personal')))throw fault('订阅周期已变化，请重新下单。','STALE_ORDER',409);
      }
      for(const line of o.lines){
        let seat=db.seats.find(s=>s.id===line.seatId);if(!seat){seat={id:line.seatId};db.seats.push(seat);}
        if(o.type==='subscription')seat.subscription={plan:line.plan,startsAt:now,endsAt:nextMonth(now),used:zero(),addonPoints:0};
        if(o.type==='upgrade')seat.subscription.plan='professional';
        if(o.type==='addon')seat.subscription.addonPoints+=line.points;
      }
      o.status='paid';o.paidAt=now;o.receipt='DEMO-'+o.id.slice(0,8).toUpperCase();
    }
    return o;
  });}
}
