import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';
const base=resolve('.local/production-supplement-20261027'),cases=[];
for(const round of [4,5])for(const kind of ['authoring','review','m4']){
  const dir=join(base,`web-real-round${round}`,kind);
  let receipt=null;try{receipt=JSON.parse(await readFile(join(dir,'owned-cleanup.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const clone=receipt?.clone_name??JSON.parse(await readFile(join(dir,'assertions.json'),'utf8')).cloned_database;
  assert.match(clone,/^bb_prod_supplement02_20261027_t[0-9]+_[a-f0-9]{8}$/);
  cases.push({round,kind,clone,normal_cleanup_receipt_present:!!receipt,normal_cleanup_receipt:receipt});
}
const pool=new Pool({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/postgres',max:1});
let remaining;try{remaining=(await pool.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[cases.map(row=>row.clone)])).rows;}finally{await pool.end();}
assert.deepEqual(remaining,[]);
const audit={audited_at:new Date().toISOString(),read_only_maintenance_database:'postgres@127.0.0.1:15542',cases,owned_clones_remaining:remaining,
  round5_result:'2 passed / 1 timeout in teardown after all business assertions; not a full pass',
  review_note:'Round5 review normal cleanup receipt is absent. Clone absence is a later read-only audit, not proof r.close completed.'};
await writeFile(join(base,'web-real-round5/cleanup-audit-after-timeout.json'),JSON.stringify(audit,null,2));
process.stdout.write(JSON.stringify(audit,null,2)+'\n');
