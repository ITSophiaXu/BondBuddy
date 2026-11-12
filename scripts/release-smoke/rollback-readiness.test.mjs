import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyRollbackReadiness} from './rollback-readiness.mjs';
import {fiveFlowFixture} from './evidence-fixtures.mjs';
import {POLICY,REQUIRED_CHECKS} from '../prospectus-quality-gate.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),now=Date.now(),candidate='c'.repeat(40);
const expected={commit:'a'.repeat(40),tree:'b'.repeat(40),inspectorSha256:'d'.repeat(64)},imageId='sha256:'+'e'.repeat(64);
function fixture(scope='main'){
 const stamp=new Date(now-48*3600*1000).toISOString(),images=Object.fromEntries(['api','worker','web'].map(t=>[t,{id:imageId,platform:'linux/amd64'}]));
 const smokeRaw=JSON.stringify(fiveFlowFixture(expected,stamp,images));
 const qualityRaw=JSON.stringify({schema_version:POLICY,status:'passed',platform:'linux',clean_tree:true,commit:expected.commit,tree:expected.tree,started_at:stamp,finished_at:stamp,
  checks:REQUIRED_CHECKS.map(id=>({id,status:'passed',log_sha256:'f'.repeat(64),
   ...(['gate-regressions','api-source-selection','browser-input-chain','worker-authoring'].includes(id)?{summary:{tests:1,pass:1,fail:0,cancelled:0,skipped:0,todo:0}}:{}),
   ...(id==='document-regressions'?{summary:{tests:1,passed:1,failures:0,errors:0,skipped:0,expected_failures:0,unexpected_successes:0,render_required:true,authorized_render_reports:1,rendered_documents:3}}:{}),
   ...(id==='real-model-acceptance'?{summary:{status:'passed',commit:expected.commit,tree:expected.tree,real_model:true,case_count:1,evidence_sha256:'f'.repeat(64)}}:{}),
  }))});
 const detail=scope==='all'?`deploy\t${expected.commit.slice(0,12)} commit=${expected.commit}`:`deploy-${scope}\tapp=${expected.commit} rollback=0`;
 const releasesLog=`${stamp}\t${detail} quality_sha256=${hash(qualityRaw)} smoke_sha256=${hash(smokeRaw)}\n`;
 const calls=[],docker=args=>{calls.push(args);if(args[0]==='version')return 'linux/amd64';return JSON.stringify([{Id:imageId,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':expected.commit}}}]);};
 return {candidate,current:expected.commit.slice(0,12),scope,previousExpected:expected,qualityRaw,smokeRaw,releasesLog,docker,now,calls};
}
test('old versions need both original logged receipts and the same retained images, including role',()=>{
 for(const scope of ['all','main','execution']){
  const f=fixture(scope),result=verifyRollbackReadiness(f);assert.equal(result.status,'verified');assert.equal(result.previous,expected.commit);
  assert.ok(f.calls.every(args=>['version','image'].includes(args[0])));
 }
});
test('missing legacy evidence, wrong role, mutated receipts and mechanical-only quality block before image operations',()=>{
 for(const mutate of [f=>delete f.qualityRaw,f=>delete f.smokeRaw,f=>f.releasesLog='',f=>f.smokeRaw+='\n',
  f=>f.releasesLog=f.releasesLog.replace('deploy-main','deploy-execution'),
  f=>{const q=JSON.parse(f.qualityRaw);q.checks=q.checks.filter(c=>c.id!=='real-model-acceptance');f.qualityRaw=JSON.stringify(q);},
  f=>{const s=JSON.parse(f.smokeRaw);delete s.schema;f.smokeRaw=JSON.stringify(s);},
 ]){const f=fixture();mutate(f);assert.throws(()=>verifyRollbackReadiness(f));assert.equal(f.calls.length,0);}
});
test('legacy rollout has no implicit rollback waiver or image reconstruction fallback',()=>{
 const f=fixture();f.docker=args=>{f.calls.push(args);if(args[0]==='version')return 'linux/amd64';throw Error('image removed');};
 assert.throws(()=>verifyRollbackReadiness(f),/Missing tested deployment image/);assert.ok(f.calls.every(args=>!['tag','build','pull'].includes(args[0])));
 assert.equal(verifyRollbackReadiness({candidate,current:'',scope:'main'}).status,'first_deployment');
 assert.equal(verifyRollbackReadiness({candidate,current:candidate.slice(0,12),scope:'main'}).status,'same_candidate');
 assert.throws(()=>verifyRollbackReadiness({candidate,current:'',scope:'other'}));
});
