// Only non-secret provenance/hashes are persisted. Pending is an attempt, never a success receipt.
import { readFileSync, existsSync, realpathSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hash, atomicJSON, atomicText, readJSON } from './role-state.mjs';
const [mode,state,role,commit,aux,envFile,script] = process.argv.slice(2);
const path = `${state}/pending-release.json`;
const fail = () => { throw new Error('release provenance'); };
const docker = args => execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const target = service => ({ops:'worker','worker-review':'worker','worker-parse':'worker',migrate:'api','integrity-beijing-tunnel':'integrity-tunnel'})[service] || service;
const imageRef = (service,sha) => `${target(service)==='integrity-tunnel'?'bondbuddy-integrity-tunnel':'bondbuddy-m1-'+target(service)}:${sha.slice(0,12)}`;
const pending = () => {
 const p=readJSON(path);
 if(p.version!==1 || p.status!=='pending' || p.role!==role || !Array.isArray(p.releases) || !p.releases.length || p.releases.length>2) fail();
 for(const r of p.releases) if(!/^[a-f0-9]{40}$/.test(r.snapshot.commit)) fail();
 if(typeof p.from!=='string' || p.from && !/^[a-f0-9]{12}$/.test(p.from) || !/^[a-f0-9]{12}$/.test(p.to)) fail();
 if(p.from==='' && (p.releases.length!==1 || p.releases[0].snapshot.commit.slice(0,12)!==p.to)) fail();
 return p;
};
function inventory(records,initial=false) {
 const expected=records[0].snapshot.project;
 const ids=docker(['ps','-q','--filter',`label=com.docker.compose.project=${expected}`]).split(/\s+/).filter(Boolean);
 let consumers=false;
 for(const id of ids) {
  const field=f=>docker(['inspect','--format',f,id]);
  const service=field('{{ index .Config.Labels "com.docker.compose.service" }}');
  if(['api','ops','web','migrate','worker','worker-review','worker-parse'].includes(service)) consumers=true;
  if(field('{{ index .Config.Labels "com.docker.compose.project" }}')!==expected) fail();
  const actual=field('{{.Image}}');
  if(service==='postgres') {
   const pg=records[0].snapshot.postgres;
   if(!pg || actual!==pg.image_id) fail();
   const mounts=JSON.parse(field('{{json .Mounts}}')).filter(m=>m.Destination==='/var/lib/postgresql/data');
   if(mounts.length!==1 || mounts[0].Type!=='volume' || mounts[0].Name!==pg.volume.name) fail();
   continue;
  }
  const matches=records.filter(r=>r.snapshot.services[service]?.image_id===actual);
  if(!matches.length) fail();
  const revision=docker(['image','inspect','--format','{{ index .Config.Labels "org.opencontainers.image.revision" }}',actual]);
  if(!matches.some(r=>r.snapshot.commit===revision)) fail();
  const configHash=field('{{ index .Config.Labels "com.docker.compose.config-hash" }}');
  if(!/^[a-f0-9]{64}$/.test(configHash)) fail();
  if(initial) {
   // Seal the verified A runtime's existing Compose hash, including current-only adoption.
   for(const r of matches) (r.observed_config_hashes[service] ||= []).push(configHash);
  } else if(!matches.some(r=>r.snapshot.services[service].config_hash===configHash || r.observed_config_hashes[service]?.includes(configHash))) fail();
 }
 return consumers;
}
try {
 if(mode==='snapshot') {
  if(!/^[a-f0-9]{40}$/.test(commit)) fail();
  const c=JSON.parse(readFileSync(0,'utf8'));
  const hashes=Object.fromEntries(readFileSync(aux,'utf8').trim().split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/)));
  const snapshot={commit,project:c.name,context:hash(JSON.stringify({role,state:realpathSync(state),env:realpathSync(envFile)})),
   env_sha256:hash(readFileSync(envFile)),binding_sha256:existsSync(`${state}/environment-binding.json`)?hash(readFileSync(`${state}/environment-binding.json`)):null,
   config_sha256:hash(JSON.stringify(c)),services:{},postgres:null};
  for(const [name,s] of Object.entries(c.services)) {
   if(name==='postgres') {
    snapshot.postgres={image_id:docker(['image','inspect','--format','{{.Id}}',s.image]),volume:c.volumes.pgdata};continue;
   }
   const allowed=role==='main'?['api','ops','migrate','web','egress','worker-parse']:['worker','worker-review','worker-parse','egress','pg-tunnel','integrity-beijing-tunnel','integrity-egress'];
   if(!allowed.includes(name) || s.image!==imageRef(name,commit) || !/^[a-f0-9]{64}$/.test(hashes[name])) fail();
   const source=docker(['image','inspect','--format','{{ index .Config.Labels "org.opencontainers.image.revision" }}',s.image]);
   if(source!==commit) fail();
   snapshot.services[name]={image_ref:s.image,image_id:docker(['image','inspect','--format','{{.Id}}',s.image]),source,config_hash:hashes[name]};
  }
  console.log(JSON.stringify(snapshot));
 } else if(mode==='refs') {
  const p=pending();console.log([p.script_commit,...p.releases.map(r=>r.snapshot.commit)].join('\n'));
 } else if(mode==='prepare' || mode==='verify') {
  const snapshots=readFileSync(0,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const current=existsSync(`${state}/current`)?readFileSync(`${state}/current`,'utf8').trim():'';
  if(mode==='prepare') {
   if(existsSync(path) || !/^[a-f0-9]{40}$/.test(script)) fail();
   const unique=[...new Map(snapshots.map(s=>[s.commit,s])).values()];
   if(!unique.some(s=>s.commit===commit) || current && snapshots[0].commit.slice(0,12)!==current) fail();
   const records=unique.map(snapshot=>({snapshot,observed_config_hashes:{}}));
   if(records.some(r=>r.snapshot.context!==records[0].snapshot.context || JSON.stringify(r.snapshot.postgres)!==JSON.stringify(records[0].snapshot.postgres))) fail();
   // Existing running containers must be the verified A; B may be absent before the first switch.
   inventory(current?[records.find(r=>r.snapshot.commit.slice(0,12)===current)]:records,true);
   atomicJSON(path,{version:1,status:'pending',role,script_commit:script,from:current,to:commit.slice(0,12),releases:records});
  } else {
   const p=pending();
   if(!p.releases.some(r=>r.snapshot.commit===commit) || current && !p.releases.some(r=>r.snapshot.commit.slice(0,12)===current)) fail();
   if(!current && (p.from!=='' || p.releases.length!==1 || p.releases[0].snapshot.commit!==commit)) fail();
   if(snapshots.length!==p.releases.length || p.releases.some(r=>!snapshots.some(s=>JSON.stringify(s)===JSON.stringify(r.snapshot)))) fail();
   const consumers=inventory(p.releases);
   console.log([current || commit.slice(0,12),p.from===''?'1':'0',consumers?'1':'0'].join('\n'));
  }
 } else if(mode==='clear') {
  const p=pending(), current=existsSync(`${state}/current`)?readFileSync(`${state}/current`,'utf8').trim():'';
  if(!p.releases.some(r=>r.snapshot.commit===commit) || current && !p.releases.some(r=>r.snapshot.commit.slice(0,12)===current)) fail();
  atomicText(`${state}/current`,commit.slice(0,12)+'\n');
  unlinkSync(path);
  const dir=openSync(state,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 } else fail();
} catch {
 console.error('release provenance rejected: verify pending/current sources, immutable service IDs, configuration/project and PostgreSQL binding (details withheld)');
 process.exitCode=3;
}
