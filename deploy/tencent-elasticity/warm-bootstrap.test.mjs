import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapUserData,warmBootstrapUserData} from './bootstrap.mjs';
import {runParameters} from './tencent-cvm.mjs';
import {sha256,canonical} from './policy.mjs';

test('retained public bytes reproduce the original complete launch without changing cold launches',()=>{
  const h='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']}];
  const original={version:'tencent-execution-pool-v1',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',account_id:'123',pool_tag:'synthetic',
    min_running:0,max_owned:2,phase:'automatic',global_model_limit:8,node_model_limit:8,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,
    scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,image_id:'img-synthetic',vpc_id:'vpc-synthetic',subnet_id:'subnet-synthetic',security_group_id:'sg-synthetic',
    source_sha256:h,image_sha256:h,network_review_sha256:h,quote_sha256:h,role_names:['one','two'],services,
    node_secrets:[{role_name:'one',role_id:'1',secret_name:'one'},{role_name:'two',role_id:'2',secret_name:'two'}]};
  const request={account_id:'123',region:'ap-beijing',instance_id:null,instance_count:1,source_sha256:h,image_sha256:h,services};
  const bytes=bootstrapUserData(original,request,0),token=sha256('synthetic');
  const expected=sha256(canonical(runParameters(original,request,token,bytes,0,'synthetic')));
  request.launch_manifest_sha256=expected;
  // Public launch formatting changes after the instance was created.
  const current={...original,business_overlay_sha256:h,retained_warm_bootstraps:[{instance_id:'ins-synthetic',launch_manifest_sha256:expected,user_data_sha256:sha256(bytes),user_data_base64:Buffer.from(bytes).toString('base64')}]};
  assert.notEqual(bootstrapUserData(current,request,0),bytes);
  const restored=warmBootstrapUserData(current,request,0,'ins-synthetic');
  assert.equal(sha256(canonical(runParameters(current,request,token,restored,0,'synthetic','ins-synthetic'))),expected);
  assert.throws(()=>runParameters(current,request,token,bytes,0,'synthetic'),/BOOTSTRAP_SLOT_MANIFEST_DRIFT/);
  assert.equal(warmBootstrapUserData(current,request,0,'ins-other'),bootstrapUserData(current,request,0));
  assert.throws(()=>warmBootstrapUserData(current,{...request,launch_manifest_sha256:'b'.repeat(64)},0,'ins-synthetic'),/WARM_BOOTSTRAP_BINDING/);
  for(const delta of [{user_data_sha256:'b'.repeat(64)},{user_data_base64:current.retained_warm_bootstraps[0].user_data_base64+'\n'}])
    assert.throws(()=>warmBootstrapUserData({...current,retained_warm_bootstraps:[{...current.retained_warm_bootstraps[0],...delta}]},request,0,'ins-synthetic'),/WARM_BOOTSTRAP_BINDING/);
});
