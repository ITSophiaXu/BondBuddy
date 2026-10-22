import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {baseURL,databaseURL,runtime,terms,ports} from './config.mjs';
import {publishPrices,grantCredits,creditBalance} from '../../apps/api/dist/billing.js';
import {transaction} from '../../apps/api/dist/data.js';
if(new URL(databaseURL).hostname!=='127.0.0.1'||new URL(databaseURL).port!==String(ports.postgres))throw Error('Local database guard failed');
mkdirSync(runtime,{recursive:true});
const pool=new Pool({connectionString:databaseURL});
try{
  const reviewPrices=JSON.parse(readFileSync(new URL('../../deploy/m1/config/review-prices-20261009.json',import.meta.url),'utf8'));
  await publishPrices(pool,{id:'local-integration-prices-v2',prices:reviewPrices.prices,effectiveAt:'2026-10-12T00:00:00.000Z',actor:'local-integration',reason:'Independent local acceptance; source deploy/m1/config/review-prices-20261009.json; no production accounting'});
  const accounts=[];
  for(const [username,points] of [['integration_user',1000000],['integration_low',1]]){
    const password='Local-Test-2026!';
    if(!(await pool.query('SELECT id FROM bb_users WHERE username=$1',[username])).rowCount){
      const r=await fetch(`${baseURL}/api/v1/auth/register`,{method:'POST',headers:{'content-type':'application/json',origin:baseURL},body:JSON.stringify({username,password,accepted_terms_version:terms})});
      if(r.status!==201)throw Error(`Local test registration failed (${r.status}): ${await r.text()}`);
    }
    const owner=(await pool.query('SELECT id FROM bb_users WHERE username=$1',[username])).rows[0].id;
    await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:`local-acceptance-${username}`,points,expiresAt:null,actor:'local-integration',reason:'Synthetic local test credits; not purchased, not production'}));
    accounts.push({username,password,owner,balance:await creditBalance(pool,owner)});
  }
  writeFileSync(join(runtime,'test-accounts.json'),JSON.stringify({baseURL,terms,accounts},null,2));
  console.log('Two independent local test accounts created; details saved in test-accounts.json');
}finally{await pool.end();}
