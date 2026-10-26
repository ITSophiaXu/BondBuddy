import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const local=resolve('.local/supplement-input');
const json=name=>JSON.parse(readFileSync(join(local,name),'utf8'));
const latest=mode=>{
 const values=readdirSync(local).map(name=>{const match=name.match(new RegExp(`^${mode}(?:-(\\d+))?\\.json$`));return match?{name,n:Number(match[1]??0)}:null;}).filter(Boolean).sort((a,b)=>b.n-a.n);
 assert(values.length,mode);const value=json(values[0].name);assert.equal(value.status,0,values[0].name);return {name:values[0].name,...value};
};
const nodeTest=mode=>{
 const result=latest(mode),log=readFileSync(join(local,result.name.replace(/\.json$/,'.log')),'utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const count=field=>Number(log.match(new RegExp(`ℹ ${field} (\\d+)`))?.[1]);
 const counts={tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};
 assert.equal(counts.failed,0);assert.equal(counts.tests,counts.passed+counts.skipped);return {...result,counts};
};
const browser=mode=>{
 const result=latest(mode),suffix=result.name.slice(mode.length,-'.json'.length),report=`${mode}-report${suffix}.json`,stats=json(report).stats;
 assert.equal(stats.unexpected,0);assert.equal(stats.flaky,0);assert.equal(stats.skipped,0);return {...result,report,stats};
};
const before=json('source-before.json'),after=json('source-after.json');assert.deepEqual(after,before);
const database=json('database-final.json');assert.equal(database.runs,0);assert.equal(database.executions,0);assert.deepEqual(database.clones,[]);
const summary={synthetic:true,baseline_commit:'4386a62e',new_adoption_executed:false,new_paid_pricing_approved:false,
 source_files_unchanged:after.length,database,
 builds:['contracts-build','api-build','worker-build','web-tsc','web-build','contracts-check'].map(latest),
 api:nodeTest('api-test'),worker:nodeTest('worker-test'),real_claimed_loaders:nodeTest('loader-pg-test'),
 full_main:browser('browser-real'),synthetic_ui:browser('browser-ui'),inflight_original_input:browser('inflight-test'),
 historical_failures_retained:['api-build.log','web-tsc.log','worker-build.log','browser-ui.log'],
 limits:['V1 only','Candidates are not persisted or adopted','No new provider/business generation, Azure or final new-input Word acceptance',
 'Two existing Azurite-dependent worker suites and one Linux-only symlink case remain skipped']};
writeFileSync(join(local,'verification-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({api:summary.api.counts,worker:summary.worker.counts,loaders:summary.real_claimed_loaders.counts,
 main:summary.full_main.stats.expected,ui:summary.synthetic_ui.stats.expected,inflight:summary.inflight_original_input.stats.expected,
 unchanged_files:summary.source_files_unchanged},null,2));
