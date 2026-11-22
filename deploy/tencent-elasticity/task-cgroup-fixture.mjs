// Synthetic Linux fixture; never installed or used by a deployed worker.
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';

const children=new Map();
async function request(input){
 return new Promise((resolve,reject)=>{
  const client=connect('/run/bondbuddy/task-cgroups/broker.sock');let text='';
  client.on('error',reject);client.on('connect',()=>client.write(JSON.stringify(input)+'\n'));
  client.on('data',chunk=>{text+=chunk;if(text.endsWith('\n')){client.destroy();resolve(JSON.parse(text));}});
 });
}
async function operation(input){
 if(input.action==='spawn'){
  const child=spawn('/usr/bin/python3',['-I','/opt/bondbuddy/task-runner.py',input.receipt.key,input.receipt.identity,'--',...input.command],
   {detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BB_TASK_CGROUP_KEY:input.receipt.key,BB_TASK_CGROUP_IDENTITY:input.receipt.identity,
    ...(input.receipt.callBinding?{BB_TASK_CALL_PARENT_KEY:input.receipt.callBinding.parentKey,BB_TASK_CALL_PARENT_IDENTITY:input.receipt.callBinding.parentIdentity,
      BB_TASK_CALL_LOGICAL_ID:input.receipt.callBinding.logicalCallId,BB_TASK_CALL_GENERATION:String(input.receipt.callBinding.generation)}:{})}});
  const entry={child,stdout:'',stderr:'',done:once(child,'close')};children.set(child.pid,entry);
  child.stdout.on('data',chunk=>{entry.stdout+=chunk;});child.stderr.on('data',chunk=>{entry.stderr+=chunk;});
  if(input.wait===false)return {pid:child.pid};
  const [code]=await entry.done;return {code,stdout:entry.stdout,stderr:entry.stderr};
 }
 if(input.action==='child'){
  const program=`const {connect}=require('node:net');const c=connect('/run/bondbuddy/task-cgroups/broker.sock',()=>c.write(${JSON.stringify(JSON.stringify(input.request)+'\n')}));c.on('data',d=>{process.stdout.write(d);c.destroy();});`;
  const child=spawn(process.execPath,['-e',program],{stdio:['ignore','pipe','inherit']});let stdout='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});await once(child,'close');return JSON.parse(stdout);
 }
 if(input.action==='output'){const entry=children.get(input.pid);return {stdout:entry.stdout,stderr:entry.stderr};}
 if(input.action==='wait'){const entry=children.get(input.pid),[code]=await entry.done;return {code,stdout:entry.stdout,stderr:entry.stderr};}
 return request(input);
}
process.stdout.write(JSON.stringify({boot:true})+'\n');
for await(const line of createInterface({input:process.stdin})){
 try{console.log(JSON.stringify(await operation(JSON.parse(line))));}
 catch(error){console.log(JSON.stringify({fixtureError:String(error)}));}
}
