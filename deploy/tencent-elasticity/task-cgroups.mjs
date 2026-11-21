import {mkdir,lstat,chown,chmod,readFile,open,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,parse} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {replacePrivateJson} from './transport-renewal.mjs';
import {canonical,requireThat} from './policy.mjs';

const exec=promisify(execFile);
const parent='/run/bondbuddy/task-cgroups';
const stateParent='/var/lib/bondbuddy/task-cgroups';
const serviceId=service=>{requireThat(['authoring','review'].includes(service),'TASK_CGROUP_SERVICE');return service;};
async function trustedFile(path){
 const info=await lstat(path);
 requireThat(info.isFile()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0,'TASK_CGROUP_BROKER_UNTRUSTED');
 for(let directory=dirname(path);;directory=dirname(directory)){
  const parent=await lstat(directory);
  requireThat(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&(parent.mode&0o022)===0,'TASK_CGROUP_BROKER_UNTRUSTED');
  if(directory===parse(directory).root)break;
 }
}
export async function loadTaskCgroupSecurity(workerProfile){
 requireThat(process.getuid?.()===0,'TASK_CGROUP_ROOT_REQUIRED');
 requireThat((await readFile('/sys/module/apparmor/parameters/enabled','utf8')).trim()==='Y','TASK_CGROUP_APPARMOR_REQUIRED');
 const profile=fileURLToPath(new URL('./task-cgroup-broker.profile',import.meta.url));
 await trustedFile(profile);await trustedFile(workerProfile);
 await exec('/usr/sbin/apparmor_parser',['-r',workerProfile,profile],{timeout:10000,maxBuffer:4096});
 const loaded=(await readFile('/sys/kernel/security/apparmor/profiles','utf8')).split('\n');
 requireThat(loaded.includes('bondbuddy-task-cgroups-v1 (enforce)')&&loaded.includes('bondbuddy-codex-v1 (enforce)'),'TASK_CGROUP_APPARMOR_NOT_LOADED');
}
export async function assertTaskCgroupServiceIdle(service,runSystemctl=async args=>exec('/usr/bin/systemctl',args,{timeout:10000,maxBuffer:4096})){
 serviceId(service);
 let status;
 try{status=(await runSystemctl(['is-active',`bondbuddy-task-cgroups-${service}.service`])).stdout.trim();}
 catch(error){status=error.stdout?.trim();}
 requireThat(['inactive','failed'].includes(status),'TASK_CGROUP_LIVE_REPLACEMENT_REFUSED');
}
async function protectedDirectory(path,mode,gid=0){
 await mkdir(path,{recursive:true,mode});
 const info=await lstat(path);
 requireThat(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0,'TASK_CGROUP_PARENT');
 await chown(path,0,gid);await chmod(path,mode);
}
export async function prepareTaskCgroups(service){
 requireThat(process.getuid?.()===0,'TASK_CGROUP_ROOT_REQUIRED');
 serviceId(service);
 for(const path of ['/run/bondbuddy',parent,'/var/lib/bondbuddy',stateParent])await protectedDirectory(path,0o750);
 await protectedDirectory(`${parent}/${service}`,0o750,1000);
 return `${parent}/${service}`;
}
async function processIdentity(pid){
 const raw=await readFile(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
 const groups=(await readFile(`/proc/${pid}/cgroup`,'utf8')).trim().split('\n');
 requireThat(fields[19]&&groups.length===1&&groups[0].startsWith('0::/'),'TASK_CGROUP_V2_REQUIRED');
 return {pid,start:fields[19],group:groups[0].slice(3)};
}
export function taskCgroupUnit({service,session,group,brokerPath}){
 serviceId(service);
 requireThat(/^[a-f0-9-]{36}$/.test(session)&&/^\/[-A-Za-z0-9_.:/]+$/.test(group)&&group!=='/'&&
   !group.split('/').includes('..')&&/^\/opt\/bondbuddy\/[-A-Za-z0-9_./]*task-cgroup-broker.py$/.test(brokerPath)&&
   !brokerPath.split('/').includes('..'),'TASK_CGROUP_UNIT_SCOPE');
 const root=`${stateParent}/${session}`,socket=`${parent}/${service}/broker.sock`;
 return `[Unit]
Description=BondBuddy task containment (${service})
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/python3 -I ${brokerPath} ${root}/binding.json ${root} ${socket}
Restart=on-failure
RestartSec=1
UMask=0077
NoNewPrivileges=yes
AppArmorProfile=bondbuddy-task-cgroups-v1
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/etc/bondbuddy
RestrictNamespaces=yes
RestrictSUIDSGID=yes
ReadOnlyPaths=/sys/fs/cgroup
ReadWritePaths=/sys/fs/cgroup${group} ${root} ${parent}/${service}
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_SYS_PTRACE
RestrictAddressFamilies=AF_UNIX
LockPersonality=yes
`;
}
/** Trusted Docker inspect supplies only the actual init. No client PID/path is
 * accepted. Bind a fresh epoch/session; never rebind a live historical worker. */
export async function bindTaskCgroups(service,containerId,context,runDocker,runSystemctl=async args=>exec('/usr/bin/systemctl',args,{timeout:10000,maxBuffer:4096})){
 serviceId(service);requireThat(/^[a-f0-9]{12,64}$/.test(containerId)&&/^[a-f0-9-]{36}$/.test(context.session_id),'TASK_CGROUP_BINDING_SCOPE');
 const inspected=JSON.parse(await runDocker(['inspect','--format','{{json .State}}',containerId]));
 requireThat(inspected.Running===true&&Number.isSafeInteger(inspected.Pid)&&inspected.Pid>1,'TASK_CGROUP_CONTAINER_NOT_RUNNING');
 const identity=await processIdentity(inspected.Pid);
 requireThat(/^\/[-A-Za-z0-9_.:/]+$/.test(identity.group)&&identity.group!=='/'&&!identity.group.split('/').includes('..'),'TASK_CGROUP_CONTAINER_SCOPE');
 const groupInfo=await lstat(`/sys/fs/cgroup${identity.group}`);
 requireThat(groupInfo.isDirectory()&&!groupInfo.isSymbolicLink()&&groupInfo.uid===0&&(groupInfo.mode&0o022)===0,'TASK_CGROUP_NOT_DELEGATABLE');
 const brokerPath=fileURLToPath(new URL('./task-cgroup-broker.py',import.meta.url));
 await trustedFile(brokerPath);
 const root=`${stateParent}/${context.session_id}`;
 await protectedDirectory(root,0o700);
 const binding={pid:identity.pid,start:identity.start,group:identity.group,context};
 const bindingFile=`${root}/binding.json`;
 try{
  const prior=JSON.parse(await readFile(bindingFile,'utf8'));
  requireThat(canonical(prior)===canonical(binding),'TASK_CGROUP_REBIND_REFUSED');
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  await replacePrivateJson(bindingFile,binding);
 }
 requireThat(JSON.stringify(await processIdentity(identity.pid))===JSON.stringify(identity),'TASK_CGROUP_CONTAINER_CHANGED');
 const unit=taskCgroupUnit({service,session:context.session_id,group:identity.group,brokerPath});
 const unitName=`bondbuddy-task-cgroups-${service}.service`,path=`/etc/systemd/system/${unitName}`;
 let active;
 try{active=(await runSystemctl(['is-active',unitName])).stdout.trim();}
 catch(error){requireThat(['inactive','failed'].includes(error.stdout?.trim()),'TASK_CGROUP_UNIT_STATE_UNKNOWN');active=error.stdout.trim();}
 if(active==='active'){
  requireThat(await readFile(path,'utf8')===unit,'TASK_CGROUP_LIVE_REPLACEMENT_REFUSED');
  return;
 }
 requireThat(['inactive','failed'].includes(active),'TASK_CGROUP_LIVE_REPLACEMENT_REFUSED');
 const temporary=path+`.${createHash('sha256').update(unit).digest('hex')}.new`;
 const descriptor=await open(temporary,'wx',0o600);
 try{await descriptor.writeFile(unit);await descriptor.sync();}finally{await descriptor.close();}
 await rename(temporary,path);
 await runSystemctl(['daemon-reload']);
 // Replacing a live broker would lose the known container/worker boundary.
 await runSystemctl(['start',unitName]);
}
