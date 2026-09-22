import { randomUUID,randomBytes } from 'node:crypto';
import { readJson,atomicJson } from './platform.mjs';
import { Billing as LegacyBilling } from './legacy-billing.mjs';
import { CREDIT_RULES,CREDIT_VERSION,actualCredits } from './credit-pricing.mjs';
const addDays=(now,n)=>new Date(Date.parse(now)+n*86400000).toISOString();
const day=now=>new Date(Date.parse(now)+8*3600000).toISOString().slice(0,10),month=now=>day(now).slice(0,7);
const error=(message,code='CREDITS_INSUFFICIENT',status=402)=>Object.assign(new Error(message),{code,status});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export class Billing extends LegacyBilling {
  transact(fn){
    const action=this.tail.then(async()=>{
      let db;try{db=await readJson(this.path);}catch(e){if(e.code!=='ENOENT')throw e;db={version:1,seats:[{id:'primary',subscription:null}],orders:[],reservations:{}};}
      const now=this.now().toISOString();
      if(db.version<2){await atomicJson(this.path+'.pre-credits-backup.json',db);db.version=2;db.creditVersion=CREDIT_VERSION;db.ledger=[];db.invitations=[];}
      db.ledger??=[];db.invitations??=[];
      for(const seat of db.seats)this.wallet(db,seat,now);
      this.rewards(db,now);const value=await fn(db,now);await atomicJson(this.path,db);return value;
    });this.tail=action.catch(()=>{});return action;
  }
  ledger(db,seatId,type,credits,detail,now){db.ledger.push({id:randomUUID(),seatId,type,credits,createdAt:now,...detail});}
  grant(db,seat,amount,source,now,days,reference){
    if(seat.lots.some(l=>l.reference===reference))return;
    const lot={id:randomUUID(),source,total:amount,remaining:amount,createdAt:now,expiresAt:days?addDays(now,days):null,reference};seat.lots.push(lot);
    this.ledger(db,seat.id,'grant',amount,{source,lotId:lot.id,reference},now);return lot;
  }
  wallet(db,seat,now,{newUser=false,createdAt=now}={}){
    if(seat.lots)return;
    seat.lots=[];seat.creditCreatedAt=createdAt;seat.inviteCode=randomBytes(6).toString('hex').toUpperCase();seat.activity={};
    this.grant(db,seat,2000,newUser?'welcome':'migration_welcome',now,30,'welcome:'+seat.id);
  }
  ensureAccount(id,{created=false,createdAt,inviteCode}={}){return this.transact((db,now)=>{
    let seat=db.seats.find(s=>s.id===id);
    if(!seat){seat={id,subscription:null};db.seats.push(seat);this.wallet(db,seat,now,{newUser:created,createdAt:createdAt||now});}
    if(created&&!seat.referralLocked){
      seat.creditCreatedAt=createdAt||now;seat.referralLocked=true;
      const inviter=inviteCode&&db.seats.find(s=>s.inviteCode===String(inviteCode).trim().toUpperCase()&&s.id!==id);
      if(inviter)db.invitations.push({id:randomUUID(),inviter:inviter.id,invitee:id,createdAt:now,activation:false,paid:false,paidEligibleAt:null});
    }return {ok:true};
  });}
  held(db,seatId,lotId){return Object.values(db.reservations).filter(r=>r.seatId===seatId&&['reserved','pending_metering'].includes(r.state)&&r.creditVersion).reduce((n,r)=>n+r.allocations.filter(a=>a.lotId===lotId).reduce((s,a)=>s+a.credits,0),0);}
  balance(db,seat,now){
    let available=0,frozen=0,paid=0,reward=0,expiring=0;
    const lots=seat.lots.map(l=>{const held=this.held(db,seat.id,l.id),usable=l.expiresAt&&l.expiresAt<=now?0:Math.max(0,l.remaining-held);frozen+=held;available+=usable;if(l.source==='purchase')paid+=usable;else reward+=usable;if(l.expiresAt&&l.expiresAt>now&&l.expiresAt<=addDays(now,7))expiring+=usable;return {...l,available:usable,frozen:held,expired:!!l.expiresAt&&l.expiresAt<=now};});
    const spent=db.ledger.filter(l=>l.seatId===seat.id&&l.type==='settle').reduce((n,l)=>n+l.credits,0);return {available,frozen,paid,reward,expiring,spent,lots};
  }
  quota(db,seat,now){const w=this.balance(db,seat,now);return {active:true,plan:'credits',externalData:true,available:{credits:w.available,points:w.available,qa:w.available,documents:w.available},used:{credits:w.spent},reserved:{credits:w.frozen},limit:{credits:w.available+w.frozen+w.spent},legacy:super.quota(db,seat,now)};}
  view(id='primary'){return this.transact((db,now)=>{
    const seat=this.seat(db,id);return {mode:this.mode,creditVersion:CREDIT_VERSION,plans:[],packs:CREDIT_RULES.recharge,seat:{id,quota:this.quota(db,seat,now)},wallet:this.balance(db,seat,now),
      invitation:{code:seat.inviteCode,invited:db.invitations.filter(i=>i.inviter===id).length,pending:db.invitations.filter(i=>i.inviter===id&&i.paidEligibleAt&&!i.paid).length},
      activity:{today:seat.activity[day(now)]?.modelSpend||0,monthlyReward:Object.entries(seat.activity).filter(([d,a])=>d.startsWith(month(now))&&a.granted).length*20},
      ledger:db.ledger.filter(l=>l.seatId===id).slice(-200).reverse(),orders:db.orders.filter(o=>o.ownerId===id).slice().reverse(),
      rules:{reference:100,welcome:2000,welcomeDays:30,daily:20,dailyCap:400,paidExpiry:null,execution:'点击执行，余额足够自动开始；后台冻结，完成后按实际用量结算，多退不补。'}};
  });}
  reserve(id,seatId,cost){
    if(cost?.credits===undefined)return Promise.reject(error('内部计费参数缺失。','INVALID_COST',400));
    return this.transact((db,now)=>{
      if(!integer(cost.credits)||!cost.snapshot||cost.snapshot.reservation!==cost.credits)throw error('内部计费参数无效。','INVALID_COST',400);
      const old=db.reservations[id];if(old&&old.seatId!==seatId)throw error('任务不属于当前账号。','FORBIDDEN',403);if(old&&old.state!=='released')return old;
      const seat=this.seat(db,seatId),balance=this.balance(db,seat,now),legacy=super.quota(db,seat,now),lc=cost.legacyCost;
      // Existing purchased monthly allowances retain their original units and expiry.
      if(lc&&legacy.active&&Object.keys(lc).every(k=>legacy.available[k]>=lc[k]))return db.reservations[id]={seatId,cost:lc,cycle:seat.subscription.startsAt,state:'reserved',createdAt:now,legacy:true};
      if(balance.available<cost.credits)throw error('积分不足，请充值后重试。');
      let remaining=cost.credits;const allocations=[],sorted=balance.lots.filter(l=>l.available>0).sort((a,b)=>(a.expiresAt||'9999').localeCompare(b.expiresAt||'9999')||a.createdAt.localeCompare(b.createdAt));
      for(const l of sorted){const n=Math.min(l.available,remaining);if(n)allocations.push({lotId:l.id,credits:n});remaining-=n;if(!remaining)break;}
      const r={id:randomUUID(),seatId,creditVersion:CREDIT_VERSION,cost:structuredClone(cost),allocations,state:'reserved',createdAt:now};db.reservations[id]=r;
      this.ledger(db,seatId,'freeze',cost.credits,{taskId:id,reservationId:r.id},now);return r;
    });
  }
  finish(db,id,success,job,now){
    const r=db.reservations[id];if(!r||!['reserved','pending_metering'].includes(r.state))return r;const seat=this.seat(db,r.seatId);
    if(!r.creditVersion){if(success&&seat.subscription?.startsAt===r.cycle)for(const k of Object.keys(r.cost))seat.subscription.used[k]+=r.cost[k];r.state=success?'consumed':'released';r.settledAt=now;return r;}
    let actual={credits:0,modelCredits:0};
    if(success){try{if(!job?.metering?.complete)throw error('模型用量待核对，本次暂未结算。','METERING_PENDING',409);actual=actualCredits(r.cost.snapshot,job.metering.events);}catch(e){if(e.code!=='METERING_PENDING')throw e;r.state='pending_metering';r.reason=e.message;return r;}}
    const charge=success?Math.min(actual.credits,r.cost.credits):0;let rest=charge,paidSpend=0;const debits=[];
    for(const a of r.allocations){const lot=seat.lots.find(l=>l.id===a.lotId),used=Math.min(a.credits,rest);lot.remaining-=used;rest-=used;if(lot.source==='purchase')paidSpend+=used;if(used)debits.push({lotId:lot.id,credits:used});if(!success&&job?.status!=='cancelled'&&lot.expiresAt&&lot.expiresAt<=now){const compensation=a.credits-used;lot.remaining-=compensation;this.grant(db,seat,compensation,'failure_compensation',now,7,'failure:'+r.id+':'+lot.id);}}
    Object.assign(r,{state:success?'consumed':'released',settledAt:now,charged:charge,actual:actual.credits,released:r.cost.credits-charge,overrun:Math.max(0,actual.credits-r.cost.credits),debits,paidSpend});
    if(success){this.ledger(db,seat.id,'settle',charge,{taskId:id,reservationId:r.id,paidSpend,actual:actual.credits,debits},now);const daily=seat.activity[day(now)]??={modelSpend:0,granted:false};daily.modelSpend+=actual.credits?Math.floor(charge*actual.modelCredits/actual.credits):0;}
    this.ledger(db,seat.id,'release',r.released,{taskId:id,reservationId:r.id},now);this.rewards(db,now);return r;
  }
  settle(id,success,job){return this.transact((db,now)=>this.finish(db,id,success,job,now));}
  reconcile(jobs){return this.transact((db,now)=>{const byId=new Map(jobs.map(j=>[j.id,j]));for(const [id,r]of Object.entries(db.reservations))if(['reserved','pending_metering'].includes(r.state)){const j=byId.get(id);this.finish(db,id,j?.status==='complete',j,now);}});}
  rewards(db,now){
    for(const seat of db.seats)for(const [date,a]of Object.entries(seat.activity||{}))if(date<day(now)&&a.modelSpend>=100&&!a.granted){const count=Object.entries(seat.activity).filter(([d,v])=>d.slice(0,7)===date.slice(0,7)&&v.granted).length;if(count<20){this.grant(db,seat,20,'daily',date+'T16:00:00.000Z',30,'daily:'+date);a.granted=true;}}
    for(const i of db.invitations){
      const invited=this.seat(db,i.invitee),inviter=this.seat(db,i.inviter),settled=db.ledger.filter(l=>l.seatId===i.invitee&&l.type==='settle');
      const spent=settled.reduce((n,l)=>n+l.credits,0),paidSpend=settled.reduce((n,l)=>n+(l.paidSpend||0),0),window=now<=addDays(i.createdAt,30);
      const orders=db.orders.filter(o=>o.ownerId===i.invitee&&o.type==='recharge'&&['paid','partially_refunded','refunded'].includes(o.status)),netPaid=orders.reduce((n,o)=>n+o.amount-(o.refundedAmount||0),0);
      if(!i.activation&&window&&spent>=500&&db.invitations.filter(x=>x.inviter===i.inviter&&x.activationAt&&month(x.activationAt)===month(now)).length<10){this.grant(db,inviter,1000,'invite_activation',now,30,'invite-a:'+i.id);this.grant(db,invited,500,'invited_activation',now,30,'invited-a:'+i.id);i.activation=true;i.activationAt=now;}
      if(!i.paidEligibleAt&&window&&netPaid>=10000&&paidSpend>=1000){i.paidEligibleAt=now;i.paidRefundBaseline=orders.reduce((n,o)=>n+(o.refundedCredits||0),0);}
      if(i.paidEligibleAt&&!i.paid){const refunded=orders.reduce((n,o)=>n+(o.refundedCredits||0),0);if(netPaid<10000||refunded>i.paidRefundBaseline){i.paidEligibleAt=null;continue;}if(now>=addDays(i.paidEligibleAt,14)&&db.invitations.filter(x=>x.inviter===i.inviter&&x.paidAt&&month(x.paidAt)===month(now)).length<5){this.grant(db,inviter,2000,'invite_paid',now,90,'invite-p:'+i.id);this.grant(db,invited,1000,'invited_paid',now,90,'invited-p:'+i.id);i.paid=true;i.paidAt=now;}}
    }
  }
  createOrder(ownerId,input){return this.transact((db,now)=>{
    this.seat(db,ownerId);if(this.mode!=='sandbox')throw error('支付服务尚未配置，暂不能创建支付订单。','PAYMENT_UNAVAILABLE',503);
    if(input.type!=='recharge')throw error('旧套餐已停止新售，请选择积分充值。','INVALID_ORDER',400);
    if(typeof input.idempotencyKey!=='string'||!/^[\w-]{8,80}$/.test(input.idempotencyKey))throw error('订单标识无效，请重新充值。','INVALID_ORDER',400);
    const old=db.orders.find(o=>o.ownerId===ownerId&&o.idempotencyKey===input.idempotencyKey);if(old)return old;
    const pack=CREDIT_RULES.recharge.find(p=>p.cny===Number(input.amountCny));if(!pack)throw error('充值档位无效。','INVALID_ORDER',400);
    const order={id:randomUUID(),ownerId,idempotencyKey:input.idempotencyKey,type:'recharge',lines:[{credits:pack.paid_credits}],credits:pack.paid_credits,amount:pack.cny*100,currency:'CNY',mode:this.mode,status:'pending',createdAt:now,expiresAt:addDays(now,1/48)};db.orders.push(order);return order;
  });}
  order(ownerId,id,action){return this.transact((db,now)=>{
    const o=db.orders.find(o=>o.id===id&&o.ownerId===ownerId);if(!o)throw error('订单不存在。','ORDER_NOT_FOUND',404);
    if(o.status==='pending'&&o.expiresAt<=now)o.status='expired';if(action==='cancel'&&o.status==='pending')o.status='cancelled';
    if(action==='sandbox-pay'){
      if(this.mode!=='sandbox'||o.mode!=='sandbox')throw error('演示支付不可用。','PAYMENT_UNAVAILABLE',503);if(['paid','partially_refunded','refunded'].includes(o.status))return o;
      if(o.status!=='pending')throw error('订单已关闭，请重新下单。','ORDER_CLOSED',409);if(o.type!=='recharge')throw error('旧待付订单不再收款，请取消后选择积分充值。','LEGACY_ORDER',409);
      const lot=this.grant(db,this.seat(db,ownerId),o.credits,'purchase',now,null,'order:'+o.id);lot.orderId=o.id;lot.paidAmount=o.amount;
      o.status='paid';o.paidAt=now;o.receipt='DEMO-'+o.id.slice(0,8).toUpperCase();this.rewards(db,now);
    }return o;
  });}
  refund(ownerId,id,input){return this.transact((db,now)=>{
    const o=db.orders.find(o=>o.id===id&&o.ownerId===ownerId&&o.type==='recharge');if(!o)throw error('充值订单不存在。','ORDER_NOT_FOUND',404);
    if(typeof input.idempotencyKey!=='string'||!/^[\w-]{8,80}$/.test(input.idempotencyKey))throw error('退款标识无效。','INVALID_REFUND',400);
    o.refunds??=[];const old=o.refunds.find(r=>r.key===input.idempotencyKey);if(old)return old;
    if(this.mode!=='sandbox'||o.mode!=='sandbox')throw error('真实退款通道尚未接入。','PAYMENT_UNAVAILABLE',503);if(!['paid','partially_refunded'].includes(o.status))throw error('订单当前不能退款。','INVALID_REFUND',409);
    const seat=this.seat(db,ownerId),lot=seat.lots.find(l=>l.orderId===id),available=lot.remaining-this.held(db,ownerId,lot.id),credits=input.credits??available;
    if(!integer(credits)||credits<=0||credits>available)throw error('可退积分不足，冻结积分须先完成或取消任务。','INVALID_REFUND',409);
    const total=(o.refundedCredits||0)+credits,amount=Math.floor(o.amount*total/o.credits)-(o.refundedAmount||0);lot.remaining-=credits;o.refundedCredits=total;o.refundedAmount=(o.refundedAmount||0)+amount;o.status=total===o.credits?'refunded':'partially_refunded';
    const r={id:randomUUID(),key:input.idempotencyKey,credits,amount,createdAt:now,mode:'sandbox'};o.refunds.push(r);this.ledger(db,ownerId,'refund',credits,{orderId:id,amount},now);this.rewards(db,now);return r;
  });}
}
