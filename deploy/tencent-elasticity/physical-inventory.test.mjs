import test from 'node:test';
import assert from 'node:assert/strict';
import {TencentCvm} from './tencent-cvm.mjs';

const config={account_id:'123456',pool_tag:'synthetic-pool'};
const instance=(n,owned=true)=>({InstanceId:'ins-synthetic'+n,InstanceState:'STOPPED',
  Tags:owned?[{Key:'bondbuddy-pool',Value:config.pool_tag}]:[]});
function fixture(pages,{account=config.account_id,denied=false,sameRole=false}={}){
  const reads=[],descriptions=[];
  const cloud=new TencentCvm({config,transport:{call:async(service,action,payload)=>{
    if(service==='sts'&&action==='GetCallerIdentity')return {AccountId:account};
    assert.equal(service,'cvm');assert.equal(action,'DescribeInstances');
    assert.deepEqual(Object.keys(payload).sort(),['Limit','Offset']);
    assert.equal(payload.Limit,100);reads.push(payload);
    if(denied)throw Object.assign(Error('CLOUD_API_ERROR'),{code:'UnauthorizedOperation'});
    assert.ok(reads.length<=pages.length,'unexpected read or lifecycle dispatch');
    return structuredClone(pages[reads.length-1]);
  }}});
  // Existing describe/launch identity checks are unchanged; these tests cover
  // the complete inventory boundary before any per-instance work is allowed.
  cloud.describe=async id=>{descriptions.push(id);return {instance_id:id,role_name:sameRole?'slot':id,instance_state:'STOPPED'};};
  return {cloud,reads,descriptions};
}
test('complete empty physical inventory needs no manually refreshed input',async()=>{
  const f=fixture([{TotalCount:0,InstanceSet:[]}]);
  assert.deepEqual(await f.cloud.inventory(),[]);assert.deepEqual(f.reads,[{Offset:0,Limit:100}]);
});
test('all pages are read without filters before two owned stopped slots are returned',async()=>{
  const f=fixture([{TotalCount:2,InstanceSet:[instance(1)]},{TotalCount:2,InstanceSet:[instance(2)]}]);
  assert.deepEqual((await f.cloud.inventory()).map(x=>x.instance_id),['ins-synthetic1','ins-synthetic2']);
  assert.deepEqual(f.reads,[{Offset:0,Limit:100},{Offset:1,Limit:100}]);
});
test('an untagged physical instance on a later page closes admission before describing pool nodes',async()=>{
  const f=fixture([{TotalCount:2,InstanceSet:[instance(1)]},{TotalCount:2,InstanceSet:[instance(2,false)]}]);
  await assert.rejects(f.cloud.inventory(),/INVENTORY_DRIFT/);assert.equal(f.reads.length,2);assert.deepEqual(f.descriptions,[]);
});
test('three physical instances cannot be hidden behind the owned-node limit',async()=>{
  const f=fixture([{TotalCount:3,InstanceSet:[instance(1),instance(2)]},{TotalCount:3,InstanceSet:[instance(3)]}]);
  await assert.rejects(f.cloud.inventory(),/INVENTORY_DRIFT/);assert.deepEqual(f.reads.map(x=>x.Offset),[0,2]);assert.deepEqual(f.descriptions,[]);
});
test('duplicate pages, changing totals and missing pages fail closed',async()=>{
  for(const pages of [
    [{TotalCount:2,InstanceSet:[instance(1)]},{TotalCount:2,InstanceSet:[instance(1)]}],
    [{TotalCount:2,InstanceSet:[instance(1)]},{TotalCount:3,InstanceSet:[instance(2)]}],
    [{TotalCount:2,InstanceSet:[instance(1)]},{TotalCount:2,InstanceSet:[]}],
  ]){
    const f=fixture(pages);await assert.rejects(f.cloud.inventory(),/INVENTORY_(DRIFT|INCOMPLETE)/);assert.deepEqual(f.descriptions,[]);
  }
});
test('incomplete excessive pagination is bounded and cannot admit a node',async()=>{
  const f=fixture(Array.from({length:10},(_,i)=>({TotalCount:11,InstanceSet:[instance(i)]})));
  await assert.rejects(f.cloud.inventory(),/INVENTORY_INCOMPLETE/);assert.equal(f.reads.length,10);assert.deepEqual(f.descriptions,[]);
});
test('a permission denial is propagated without a filtered or file fallback',async()=>{
  const f=fixture([],{denied:true});await assert.rejects(f.cloud.inventory(),{code:'UnauthorizedOperation'});assert.equal(f.reads.length,1);
});
test('account mismatch and duplicate execution roles retain their existing guards',async()=>{
  const wrong=fixture([],{account:'999999'});await assert.rejects(wrong.cloud.inventory(),/CLOUD_ACCOUNT_MISMATCH/);assert.equal(wrong.reads.length,0);
  const duplicate=fixture([{TotalCount:2,InstanceSet:[instance(1),instance(2)]}],{sameRole:true});
  await assert.rejects(duplicate.cloud.inventory(),/ROLE_SLOT_DUPLICATED/);
});
