import hashlib,json,os,pathlib,subprocess,tarfile
R=pathlib.Path(__file__).resolve().parent
SHA='26b6551de8421c71b90e2642c933a3dcd67f9530777c147c451174cdefc9083f'
def digest(b):return hashlib.sha256(b).hexdigest()
def run(a,**kw):return subprocess.check_output(a,stderr=subprocess.PIPE,timeout=240,**kw)
def inspect(i):return json.loads(run(['docker','image','inspect',i]))[0]
def free():s=os.statvfs('/var/lib/docker');return s.f_bavail*s.f_frsize
raw=(R/'manifest.json').read_bytes();assert digest(raw)==SHA;m=json.loads(raw);before=free();assert before>2048*1024*1024+16*1024*1024
parent=inspect(m['base_candidate_image']);assert parent['Id']==m['base_candidate_image'] and parent['Os']=='linux' and parent['Architecture']=='amd64'
archive=R/'delta.tar.gz';assert digest(archive.read_bytes())==m['archive_sha256'];context=R/'context';context.mkdir(mode=0o700);overlay=context/'overlay';overlay.mkdir()
with tarfile.open(archive) as t:
 entries=t.getmembers();assert len(entries)==3 and len({x.name for x in entries})==3 and {x.name for x in entries}=={x['path'] for x in m['files']}
 assert all(x.isfile() and not pathlib.PurePosixPath(x.name).is_absolute() and '..' not in pathlib.PurePosixPath(x.name).parts for x in entries)
 t.extractall(overlay,filter='data')
for f in m['files']:
 b=(overlay/f['path']).read_bytes();assert len(b)==f['bytes'] and digest(b)==f['sha256'];os.chmod(overlay/f['path'],f['mode'])
base='bondbuddy-main1420-node8-base:'+SHA[:12];tag='bondbuddy-main1420-node8-api:'+SHA[:12]
exists=subprocess.run(['docker','image','inspect',tag],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);assert exists.returncode!=0
run(['docker','tag',parent['Id'],base]);dockerfile='FROM '+base+'\n'
for f in m['files']:dockerfile+='COPY --chown='+str(f['uid'])+':'+str(f['gid'])+' '+json.dumps(['overlay/'+f['path'],'/app/'+f['path']])+'\n'
dockerfile+='LABEL com.bondbuddy.main1420.node8-delta="'+SHA+'"\n';(context/'Dockerfile').write_text(dockerfile)
p=subprocess.run(['docker','build','--pull=false','--network=none','-t',tag,str(context)],env=dict(os.environ,DOCKER_BUILDKIT='0'),capture_output=True,timeout=600)
(R/'build.stdout.log').write_bytes(p.stdout);(R/'build.stderr.log').write_bytes(p.stderr);assert p.returncode==0
c=inspect(tag);assert c['RootFS']['Layers'][:len(parent['RootFS']['Layers'])]==parent['RootFS']['Layers'] and len(c['RootFS']['Layers'])==len(parent['RootFS']['Layers'])+3
config=json.loads(json.dumps(c['Config']));assert config['Labels'].pop('com.bondbuddy.main1420.node8-delta')==SHA;assert config==parent['Config']
verifier="const fs=require('fs'),c=require('crypto'),cp=require('child_process');const m=JSON.parse(fs.readFileSync(0,'utf8'));for(const f of m.files){const p='/app/'+f.path,b=fs.readFileSync(p);if(b.length!==f.bytes||c.createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error(p);const r=cp.spawnSync(process.execPath,['--check',p]);if(r.status!==0)throw Error(String(r.stderr));}console.log(JSON.stringify({files:m.files.length,syntax:m.files.length,node:process.version,business_executed:false}));"
v=json.loads(run(['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=128m','--cpus=0.5','-i','--entrypoint=/usr/local/bin/node',c['Id'],'-e',verifier],input=json.dumps(m).encode()))
after=free();assert after>2048*1024*1024
receipt={'manifest_sha256':SHA,'parent_image':parent['Id'],'candidate_image':c['Id'],'tag':tag,'parent_layers':len(parent['RootFS']['Layers']),'candidate_layers':len(c['RootFS']['Layers']),'config_preserved':True,'verification':v,'maximum_expected_build_writes_bytes':16*1024*1024,'free_bytes_before':before,'free_bytes_after':after,'production_switched':False,'candidate_only':True,'status':'PASS'}
(R/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
