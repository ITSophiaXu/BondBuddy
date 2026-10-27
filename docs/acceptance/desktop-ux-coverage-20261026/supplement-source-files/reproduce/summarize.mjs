import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const local=resolve('.local/supplement-source-files'),precheck=resolve('.local/supplement-source');
const json=(name,dir=local)=>JSON.parse(readFileSync(join(dir,name),'utf8'));
const latest=(mode,dir=local)=>{
 const values=readdirSync(dir).map(name=>{const match=name.match(new RegExp(`^${mode}(?:-(\\d+))?\\.json$`));return match?{name,n:Number(match[1]??0)}:null;}).filter(Boolean).sort((a,b)=>b.n-a.n);
 assert(values.length,mode);const value=json(values[0].name,dir);assert.equal(value.status,0,values[0].name);return {name:values[0].name,...value};
};
const nodeTest=(mode,dir=local)=>{
 const result=latest(mode,dir),log=readFileSync(join(dir,result.name.replace(/\.json$/,'.log')),'utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const count=field=>Number(log.match(new RegExp(`ℹ ${field} (\\d+)`))?.[1]);
 const counts={tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};
 assert.equal(counts.failed,0);assert.equal(counts.tests,counts.passed+counts.skipped);return {...result,counts};
};
const browser=mode=>{
 const result=latest(mode),suffix=result.name.slice(mode.length,-'.json'.length),report=`${mode}-report${suffix}.json`,stats=json(report).stats;
 assert.equal(stats.unexpected,0);assert.equal(stats.flaky,0);assert.equal(stats.skipped,0);return {...result,report,stats};
};
const before=json('source-before.json'),after=json('source-after.json');assert.deepEqual(after,before);
const original=json('source-before-1.json'),map=new Map(original.map(file=>[file.path,file.sha256]));
const originalDiff=before.filter(file=>map.get(file.path)!==file.sha256).map(file=>({path:file.path,before:map.get(file.path)??null,after:file.sha256}));
const removed=original.filter(file=>!before.some(next=>next.path===file.path));
const database=json('database-final.json');assert.equal(database.runs,0);assert.equal(database.executions,0);assert.deepEqual(database.clones,[]);
const cleanup=json('database-cleanup-audit.json');assert.deepEqual(cleanup.databases,[{datname:'bb_g03_template_20261026'}]);assert.deepEqual(cleanup.other_client_sessions,[]);
const stopped=json('postgres-stop.json');assert.equal(stopped.stop.status,0);assert.equal(stopped.status_after.status,3);
const summary={synthetic:true,baseline_commit:'0f506703',goal_complete:false,g03_complete:false,
 source_declarations_prepared:true,old_file_reader:'service-internal exact pins and bounded bytes',new_adoption_executed:false,
 surcharge_decision:'B: necessary rework quoted separately; explicit surcharge confirmation before continuing',surcharge_formula:null,
 source_binding:{initial_baseline_files:original.length,final_unchanged_files:after.length,initial_to_final_changes:originalDiff,removed},database,
 infrastructure_cleanup:{audit:cleanup,postgres:stopped},
 builds:['api-build','worker-build','web-tsc','web-build'].map(mode=>latest(mode)),
 contracts:{build:latest('contracts-build',precheck),examples:latest('contracts-check',precheck),synthetic:186,internal_library:12},
 api:nodeTest('api-test'),compiler_precheck:nodeTest('compiler-unit-tests',precheck),source_helper_precheck:nodeTest('source-unit-tests',precheck),
 exact_file_reference:{tsc:json('run-file-reference-tsc-r2.json'),tests:json('run-file-reference-test-r2.json'),cleanup:json('run-file-reference-cleanup-r2.json')},
 full_main:browser('browser-real'),synthetic_ui:browser('browser-ui'),
 historical_failures_retained:['source-precheck/api-build-1.log','source-precheck/compiler-unit-tests-1.log','api-test-1.log','browser-ui.log'],
 historical_visual_defect:'browser-real-evidence/m1-source-declaration-isolated-viewport.png; initial real-main passed functionality before visual review found oversized checkbox',
 limits:['V1 only; no adopted successor input or new execution','Project-file checkpoint formats do not imply HTTP supplement support',
 'No complete raw-file write intent, inventory or tombstone lifecycle','No new provider/business generation, Azure or final supplemented Word acceptance',
 'One pre-existing Azurite queue suite remains skipped']};
assert.equal(summary.exact_file_reference.tsc.exit_code,0);assert.equal(summary.exact_file_reference.tests.exit_code,0);
writeFileSync(join(local,'verification-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({api:summary.api.counts,main:summary.full_main.stats.expected,ui:summary.synthetic_ui.stats.expected,
 original_files:original.length,final_unchanged_files:after.length,changes_between_baselines:originalDiff.length},null,2));
