import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import { readJson, atomicJson } from './platform.mjs';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const fail=(message,code='AUTH_INVALID',status=400)=>({message,code,status});
const unwrap=value=>{if(value.error)throw Object.assign(new Error(value.error.message),value.error);return value;};
export function normalizePhone(value){const phone=String(value||'').replace(/[\s-]/g,'').replace(/^\+86/,'');if(!/^1[3-9]\d{9}$/.test(phone))throw Object.assign(new Error('请输入有效的 11 位手机号。'),{status:400,code:'PHONE_INVALID'});return phone;}
const publicUser=user=>user?{id:user.id,phoneMasked:user.phone.slice(0,3)+'****'+user.phone.slice(-4),createdAt:user.createdAt}:null;

// This is a local demo: codes are displayed on the page, never sent by SMS.
export class DemoAuth {
  constructor(path,{now=()=>Date.now()}={}){this.path=path;this.now=now;this.tail=Promise.resolve();}
  transact(fn,write=true){const action=this.tail.then(async()=>{let db;try{db=await readJson(this.path);}catch(e){if(e.code!=='ENOENT')throw e;db={version:1,users:[],challenges:{},sessions:{}};}const result=await fn(db,this.now());if(write)await atomicJson(this.path,db);return result;});this.tail=action.catch(()=>{});return action;}
  async requestCode(value){const phone=normalizePhone(value);return unwrap(await this.transact((db,now)=>{
    const old=db.challenges[phone];if(old&&now<old.resendAt)return {error:fail(`请在 ${Math.ceil((old.resendAt-now)/1000)} 秒后重新获取。`,'CODE_COOLDOWN',429)};
    for(const [key,c] of Object.entries(db.challenges))if(c.expiresAt<=now)delete db.challenges[key];
    for(const [key,s] of Object.entries(db.sessions))if(s.expiresAt<=now)delete db.sessions[key];
    if(Object.keys(db.challenges).length>=500)return {error:fail('请求较多，请稍后再试。','CODE_LIMIT',429)};
    const code=String(randomInt(100000,1000000)),id=randomUUID();db.challenges[phone]={id,digest:hash(id+code),expiresAt:now+5*60000,resendAt:now+60000,attempts:0};
    return {mode:'demo',challengeId:id,demoCode:code,expiresIn:300,resendAfter:60,message:'演示验证码已显示在页面，未发送短信。'};
  }));}
  async verify(value,code,challengeId){const phone=normalizePhone(value);return unwrap(await this.transact((db,now)=>{
    const c=db.challenges[phone];if(!c||c.id!==challengeId||c.expiresAt<=now)return {error:fail('验证码已失效，请重新获取。','CODE_EXPIRED')};
    if(c.attempts>=5)return {error:fail('输入错误次数较多，请重新获取验证码。','CODE_LOCKED',429)};
    if(!/^\d{6}$/.test(String(code))||c.digest!==hash(c.id+code)){c.attempts++;return {error:fail('验证码不正确，请使用页面显示的演示验证码。','CODE_INVALID')};}
    let user=db.users.find(u=>u.phone===phone),created=false;
    if(!user){created=true;user={id:db.users.length?randomUUID():'primary',phone,createdAt:new Date(now).toISOString()};db.users.push(user);}
    delete db.challenges[phone];
    const token=randomBytes(32).toString('hex');db.sessions[hash(token)]={userId:user.id,expiresAt:now+30*86400000};
    return {user:publicUser(user),created,token,maxAge:30*86400};
  }));}
  session(token){if(!token||!/^[a-f\d]{64}$/.test(token))return Promise.resolve(null);return this.transact((db,now)=>{const s=db.sessions[hash(token)];return s&&s.expiresAt>now?publicUser(db.users.find(u=>u.id===s.userId)):null;},false);}
  logout(token){return this.transact(db=>{if(token)delete db.sessions[hash(token)];return {ok:true};});}
}
