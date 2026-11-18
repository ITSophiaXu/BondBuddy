"""Loaded after ../activate.py. Correction within the original locked release."""
FIXED='73b7830ca0e5737183e9ed72ba404d22fd337aca8a011b5bedea2a2cf2ecd74d'
BEFORE='e1ea58fabf3f64b250b5e7d3793a616bdc5414437c4d8223bd57e6ef773bfa06'
SYNTHETIC='12041f7157b011f7293ccf5b41abb0842bd751913d2a4ceacdc89b43eaaf86d2'
TARGET='/app/apps/worker/dist/material-parser.js'

def remove_synthetic_residue(c):
 import re,tarfile
 env=dict(x.split('=',1)for x in c['Config']['Env']);need(env['BB_PARSE_STAGING_DIR']=='/var/lib/bondbuddy/parse-staging','staging_path')
 mounts=[m for m in c['Mounts']if m['Destination']==env['BB_PARSE_STAGING_DIR']]
 need(len(mounts)==1 and mounts[0]['Source']=='/var/lib/bondbuddy/parser-relocation-20261116/staging'and mounts[0]['RW'],'staging_mount')
 root=pathlib.Path(mounts[0]['Source']);need(root.resolve()==root and root.is_dir()and not root.is_symlink(),'staging_root')
 def private(p,directory=False):
  s=p.lstat();need(s.st_uid==1000 and s.st_gid==1000 and not stat.S_ISLNK(s.st_mode)and not(s.st_mode&0o077),'staging_owner_mode')
  need(stat.S_ISDIR(s.st_mode)if directory else stat.S_ISREG(s.st_mode)and s.st_nlink==1,'staging_type')
 private(root,True);fds=[]
 try:
  lock=root/'.bb-parse-admission.lock';private(lock);fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  rp=root/'.bb-parse-registry.json';private(rp);original=rp.read_bytes();reg=json.loads(original);need(reg['version']==1,'registry_version');matches=[]
  for n,nonce in reg['entries'].items():
   need(re.fullmatch(r'bb-material-[A-Za-z0-9]{6}',n),'staging_name');d=root/n;need(d.resolve().parent==root,'staging_boundary');private(d,True)
   source=d/'source.pdf'
   if not source.exists():continue
   private(source)
   if sha(source.read_bytes())!=SYNTHETIC:continue
   need(set(x.name for x in d.iterdir())=={'.owner.json','.owner.lock','source.pdf'},'synthetic_contents')
   for x in d.iterdir():private(x)
   need(read(d/'.owner.json')=={'version':1,'nonce':nonce},'synthetic_nonce')
   fd=os.open(d/'.owner.lock',os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);matches.append((n,d))
  need(len(matches)==1,'exact_synthetic_residue')
  n,d=matches[0];backup=P/'synthetic-staging-before.tar';need(not backup.exists(),'backup_exists')
  fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb')as out:
   with tarfile.open(fileobj=out,mode='w')as t:t.add(d,arcname=n,recursive=True)
   out.flush();os.fsync(out.fileno())
  write_once(P/'synthetic-staging-registry.before.json',original)
  # The exact directory and all entries were checked under admission and owner locks.
  for x in d.iterdir():x.unlink()
  d.rmdir();del reg['entries'][n]
  tmp=root/'.bb-parse-registry-audit1615.tmp';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb')as out:os.fchown(out.fileno(),1000,1000);out.write(json.dumps(reg).encode());out.flush();os.fsync(out.fileno())
  os.replace(tmp,rp);receipt={'at':utc(),'removed_directory':n,'synthetic_sha256':SYNTHETIC,'backup_sha256':sha(backup.read_bytes()),'registry_before_sha256':sha(original),'registry_after_sha256':sha(rp.read_bytes()),'other_entries_preserved':True};save(P/'synthetic-staging-recovery.json',receipt);return receipt
 finally:
  for fd in reversed(fds):os.close(fd)

def correct_parser(payload):
 plan=read(P/'plan.json');validate(plan);seal=get_seal(payload,plan);need(set(seal['activated'])=={'parser','confirmation'},'batch_state');need(shutil.disk_usage(ROOT).free>=int(2.5*1024**3),'disk_margin')
 fix=read(P/'staging-correction-plan.json');need(fix['before_sha256']==BEFORE and fix['sha256']==FIXED and fix['path']==TARGET,'fix_scope')
 need(sha(pathlib.Path(fix['source']).read_bytes())==FIXED,'fixed_source');cfg=pathlib.Path(fix['configuration_path']);need(sha(cfg.read_bytes())==fix['configuration_sha256']=='ee998583e601d2945c27f6175fb8c2f45fc58d49237e58351c1911f00f37baaf','fixed_config')
 need(read(PUBLIC/'staging-fix/full-parser-regression-exec.json')['exit_code']==0,'regression')
 need(len(payload['correction_release_commit'])==40 and payload['source_commit']=='de03f25cdb6ec4725695e947da2a611187df2620','source_binding')
 c=inspect(name('parser'));need(snapshot(c)==seal['activated']['parser']and c['Id']==fix['before_id']and healthy(c),'parser_drift');need(sha(effective(c,TARGET))==BEFORE,'parser_bytes')
 save(P/'parser.staging-correction.before.inspect.json',c);save(P/'staging-correction-binding.json',payload);seal['phase']='correcting_parser_staging';update(P/'activation-state.json',seal);update(PENDING,seal)
 try:
  run(['docker','stop','--time','-1',c['Id']],timeout=900);stopped=inspect(c['Id']);need(not stopped['State']['Running']and stopped['State']['ExitCode']==0,'correction_drain_failed')
  recovery=remove_synthetic_residue(stopped)
  run(['docker','compose','-p',PROJECT,'-f',str(cfg),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','--wait','--wait-timeout','90',SERVICES['parser']],timeout=150)
  new=inspect(name('parser'));compare(c,new,[{'source':fix['source'],'target':TARGET}]);need(healthy(new),'parser_health');protected(plan)
  for f in plan['files']:
   if f['role']=='parser':need(sha(effective(new,f['path']))==(FIXED if f['path']==TARGET else f['sha256']),'parser_effective_hash')
  correction={'status':'CORRECTED','at':utc(),'release_commit':payload['correction_release_commit'],'source_commit':payload['source_commit'],'source_pr':1616,'original_release_commit':seal['release_commit'],'before':snapshot(c),'after':snapshot(new),'natural_drain':True,'module_sha256':FIXED,'configuration_path':str(cfg),'configuration_sha256':sha(cfg.read_bytes()),'recovery':recovery}
  save(P/'staging-correction-activation.json',correction);seal['activated']['parser']=snapshot(new);seal['staging_correction']=correction;seal['phase']='corrected_parser_staging';update(P/'activation-state.json',seal);update(PENDING,seal);return correction
 except Exception as e:
  seal['phase']='needs_reconcile_parser_staging';seal['error']=str(e)if isinstance(e,RuntimeError)else type(e).__name__;update(P/'activation-state.json',seal);update(PENDING,seal);raise

def finish_corrected(payload):
 plan=read(P/'plan.json');validate(plan);seal=get_seal(payload,plan);need(set(seal['activated'])==set(ROLES),'all_components');verification=payload['functional_verification'];need(verification['status']=='PASS'and verification['browser']['status']=='PASS'and verification['counts']=={'runs':0,'quotes':0,'reservations':0,'model_calls':0},'functional_verification')
 correction=payload['correction'];need(correction['status']=='CORRECTED'and correction['module_sha256']==FIXED,'correction_receipt')
 if PROJECT=='bb-execution':need(read(P/'staging-correction-activation.json')==correction==seal['staging_correction'],'local_correction')
 registry=read(REGISTRY);actual={}
 for r in ROLES:
  c=inspect(name(r));need(snapshot(c)==seal['activated'][r]and healthy(c),'activated_drift');overlay=copy.deepcopy(plan['roles'][r]['overlay']);cfg=P/(r+'.candidate.compose.json')
  if r=='parser':
   for m in overlay:
    if m['target']==TARGET:m['source']=str(PUBLIC/'staging-fix/material-parser.fixed.js')
   cfg=pathlib.Path(correction['configuration_path']);need(sha(cfg.read_bytes())==correction['configuration_sha256'],'corrected_config')
  compare(read(P/(r+'.before.inspect.json')),c,overlay);actual[r]=snapshot(c)
  for f in plan['files']:
   if f['role']==r:need(sha(effective(c,f['path']))==(FIXED if r=='parser'and f['path']==TARGET else f['sha256']),'effective_hash')
  rec=registry['components'].setdefault(SERVICES[r],{});rec.update(container_id=c['Id'],image_id=c['Image'],configuration_path=str(cfg),configuration_files=[str(cfg)],configuration_sha256=sha(cfg.read_bytes()),config_env_sha256=sha(json.dumps(c['Config'],sort_keys=True).encode()),host_config_sha256=sha(json.dumps(c['HostConfig'],sort_keys=True).encode()),started_at=c['State']['StartedAt'],started_utc=c['State']['StartedAt'],running=True,health=c['State'].get('Health',{}).get('Status'))
  rec['audit_pdf1610']={'release_commit':seal['release_commit'],'archive_sha256':ARCHIVE,'at':utc(),'source_prs':[1591,1605,1610],'staging_correction':correction if r=='parser'else None,'receipt':str(P/'activation.json')}
 receipt={'status':'DEPLOYED_AND_VERIFIED','owner':OWNER,'at':utc(),'release_commit':seal['release_commit'],'correction_release_commit':correction['release_commit'],'archive_sha256':ARCHIVE,'roles':actual,'verified_files':len(plan['files']),'protected':plan['protected'],'other_services_preserved':True,'full_quality_gate_passed':False,'independent_human_document_acceptance':False,'migrations':0,'new_model_calls':0,'authorization':seal['approval'],'functional_verification':verification,'correction':correction,'rollback_root':str(P)}
 update(REGISTRY,registry);receipt['registry_sha256']=sha(REGISTRY.read_bytes());update(P/'activation.json',receipt);update(STATE/'release-audit-pdf1610-20261118.json',receipt);seal['phase']='deployed_and_verified';update(P/'activation-state.json',seal);need(read(PENDING)['owner']==OWNER,'pending_owner');PENDING.unlink();return receipt

def dispatch_correction(payload):
 configure(payload['host']);need(os.geteuid()==0,'root');fds=[]
 try:
  for n in ('config.lock','deploy.lock','migration.lock'):
   p=STATE/n;need(not p.is_symlink()and stat.S_ISREG(p.stat().st_mode),'existing_lock');fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);fds.append(fd);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  need(payload['action']in ('correct_parser','finish_corrected'),'action');need(payload['action']!='correct_parser'or payload['host']=='azure','correction_host');return globals()[payload['action']](payload)
 finally:
  for fd in reversed(fds):os.close(fd)
