import { resolve } from 'node:path';

/** Synthetic verifier data only; never offered as a real Docker receipt. */
export function syntheticDockerEvidence(candidate, entry, runId) {
  const prefix='bb-pr-gate-docker-'+runId+'-'+entry.sequence,image='sha256:'+'e'.repeat(64),backup=entry.profileId==='docker-backup';
  const configuration={...candidate,run_id:runId,test_id:entry.testId,profile_id:entry.profileId,prefix,image,context:'synthetic-local',
    scratch:resolve('synthetic-scratch'),trace:resolve('synthetic-cases.json'),...(backup?{network:prefix+'-network',azurite_name:prefix+'-azurite',
      azurite_image:'sha256:'+'c'.repeat(64),app_volume:'bb-pr-gate-native-'+runId,
      host_connection:'synthetic;BlobEndpoint=http://127.0.0.1:32100/devstoreaccount1;',
      container_connection:'synthetic;BlobEndpoint=http://'+prefix+'-azurite:10000/devstoreaccount1;'}:{})};
  return {configuration,source_bundle_sha256:'e'.repeat(64),source_sha256:entry.sourceSha256,
    source_before:{raw_bytes_verified:true,files:10,manifest_sha256:'d'.repeat(64)},source_after:{raw_bytes_verified:true,files:10,manifest_sha256:'d'.repeat(64)},models:0,source_root:resolve('synthetic-source'),
    engine_endpoint:'unix:///synthetic/docker.sock',original_command:{executable:'/synthetic/node',cwd:resolve('synthetic-source'),
      args:['--test','--test-reporter=tap',entry.runPath],timeout_ms:300000,output_limit_failed:false},
    cases:(backup?[1,0,0,0,0]:[0,1,1,1]).map((status,index)=>({index:index+1,name:prefix+'-case-'+(index+1),status,signal:null,error:null,
      commands:[{args:['create','--pull','never','--name',prefix+'-case-'+(index+1),'--network',backup?configuration.network:'none',
        '--entrypoint',backup?'/usr/bin/env':'/usr/local/bin/bb-copilot-token',image],status:0,error:null},
        {args:['start','-a',String(index+1).repeat(64)],status,error:null,stdout_sha256:'d'.repeat(64),stderr_sha256:'d'.repeat(64)},
        {args:['rm','--force','--volumes',String(index+1).repeat(64)],status:0},...Array.from({length:3},()=>({synthetic:true}))],
      cleanup:{status:'passed'},isolation:{id:String(index+1).repeat(64),
        name:prefix+'-case-'+(index+1),image,user:'1000:1000',rootfs_readonly:true,privileged:false,cap_drop:['ALL'],no_new_privileges:true,
        memory:512*1024**2,memory_swap:512*1024**2,nano_cpus:1000000000,pids_limit:128,network:backup?configuration.network:'none',
        mounts:backup?[{destination:'/app',type:'volume',name:configuration.app_volume,rw:false},{destination:'/backup',type:'bind',rw:true}]
          :[{destination:'/run/secrets/bb-copilot-oauth',type:'bind',rw:false},{destination:'/usr/local/bin/bb-copilot-token',type:'bind',rw:false}]}})),
    ...(backup?{network:{name:configuration.network,internal:true},azurite:{name:configuration.azurite_name,image:configuration.azurite_image,
      host_ip:'127.0.0.1',host_port:'32100'},dependencies:{normalized_lock_sha256:'d'.repeat(64),installed:false,product_packages:'current candidate only'}}:{})};
}
