import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const local=resolve('.local/supplement-work');
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
const cleanup=json('database-cleanup-audit.json');assert.deepEqual(cleanup.databases,[{datname:'bb_g03_template_20261026'}]);assert.deepEqual(cleanup.other_client_sessions,[]);
const stopped=json('postgres-stop.json');assert.equal(stopped.stop.status,0);assert.equal(stopped.status_after.status,3);
const summary={synthetic:true,baseline_commit:'27718689',saved_work_captured:true,new_adoption_executed:false,new_paid_pricing_approved:false,
 surcharge_decision:'B: necessary rework quoted separately; explicit surcharge confirmation before continuing',surcharge_formula:null,
 source_files_unchanged:after.length,database,
 infrastructure_cleanup:{audit:cleanup,postgres:stopped},
 builds:['contracts-build','api-build','worker-build','web-tsc','web-build','contracts-check'].map(latest),
 api:nodeTest('api-test'),worker:nodeTest('worker-test'),retention_races:nodeTest('retention-test'),migration_upgrade:json('migration-upgrade-1.json'),
 full_main:browser('browser-real'),synthetic_ui:browser('browser-ui'),inflight_original_input:browser('inflight-test'),
 historical_failures_retained:['api-build.log','api-test.log','inflight-test.log'],
 limits:['V1 only','Candidates are not persisted or adopted','No new provider/business generation, Azure or final new-input Word acceptance',
 'One existing Azurite queue case, two existing Azurite worker suites and one Linux-only symlink case remain skipped']};
writeFileSync(join(local,'verification-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({api:summary.api.counts,worker:summary.worker.counts,retention:summary.retention_races.counts,
 main:summary.full_main.stats.expected,ui:summary.synthetic_ui.stats.expected,inflight:summary.inflight_original_input.stats.expected,
 unchanged_files:summary.source_files_unchanged},null,2));
