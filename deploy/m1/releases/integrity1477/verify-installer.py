"""Execute the exact cold installer twice in network-none disposable filesystem."""
import base64,hashlib,json,pathlib,subprocess,sys
v=json.load(sys.stdin);sha=lambda b:hashlib.sha256(b).hexdigest()
for p,s in v['before'].items():
 p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(s));p.chmod(0o600)
program=base64.b64decode(v['program']);assert sha(program)==v['program_sha256']
for attempt in [1,2]:
 exec(compile(program,'exact-browser-public-installer','exec'),{'__name__':'__verification__'})
 for p,h in v['after'].items():assert sha(pathlib.Path(p).read_bytes())==h,p
 n=json.loads(pathlib.Path('/etc/bondbuddy/elastic-node.json').read_bytes());b=json.loads(pathlib.Path('/etc/bondbuddy/elastic-bootstrap.json').read_bytes())
 assert n['seccomp_file'].endswith('/integrity-browser-seccomp.json');assert n['seccomp_sha256']==sha(pathlib.Path(n['seccomp_file']).read_bytes());assert n['compose_sha256']==sha(pathlib.Path(n['compose_file']).read_bytes());assert b['adapter_sha256']==sha(pathlib.Path(b['adapter_path']).read_bytes())
 assert n['business_overlay_sha256']=='183e5240e6cefc09314943fc270b009fd547e497437af111a99fd77235e17dd0'
 print(json.dumps({'attempt':attempt,'status':'PASS','exact_files':len(v['after']),'config_hashes_verified':True,'business_pin_unchanged':True}))
