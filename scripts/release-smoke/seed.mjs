// Runs ONLY inside this harness's API container, against its new dedicated database.
import {Pool} from 'pg';
import {publishPrices,grantCredits} from '/app/apps/api/dist/billing.js';
import {transaction} from '/app/apps/api/dist/data.js';
import {INITIAL_FIXED_PRICES} from '/app/packages/contracts/dist/index.js';
if(!/^bb-release-[a-f0-9]+$/.test(process.env.BB_RELEASE_TEST_INSTANCE??''))throw Error('Release test instance missing');
const url=new URL(process.env.DATABASE_URL);
if(url.hostname!=='postgres'||url.pathname!=='/bb_release_smoke')throw Error('Dedicated test database required');
const pool=new Pool({connectionString:url.toString()});
try{
 const [username,password]=JSON.parse(process.env.BB_RELEASE_ACCOUNT);
 const r=await fetch('http://127.0.0.1:3000/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json',origin:process.env.BB_ALLOWED_ORIGIN},body:JSON.stringify({username,password,accepted_terms_version:process.env.BB_TERMS_VERSION})});
 if(r.status!==201)throw Error('Local registration failed: '+r.status);
 const owner=(await pool.query('SELECT id FROM bb_users WHERE username=$1',[username])).rows[0]?.id;
 if(!owner)throw Error('Test account was not persisted');
 await publishPrices(pool,{id:'release-smoke-legacy-fixture',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'release-smoke',reason:'Isolated test only; commercial price tables come from migrations'});
 await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:'release-smoke-initial',points:10000000n,expiresAt:null,actor:'release-smoke',reason:'Synthetic test credit, no payment or production balance'}));
 console.log(JSON.stringify({username,owner,syntheticCredits:true}));
}finally{await pool.end();}
