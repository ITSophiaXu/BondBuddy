"""Verify fixed TAT request hashes, source, target and installation archive offline."""
import ast,base64,gzip,hashlib,io,json,pathlib,tarfile
HERE=pathlib.Path(__file__).resolve().parent
WRAPPERS={'inspect':'PREFLIGHT','activate':'ACTIVATE','resume':'RESUME'}
def sha(raw):return hashlib.sha256(raw).hexdigest()
def verify():
 results=[]
 for name in ('inspect','install','activate','resume'):
  manifest=json.loads((HERE/(name+'-manifest.json')).read_bytes())
  raw=(HERE/(name+'-request.json')).read_bytes();request=json.loads(raw)
  assert sha(raw)==manifest['request_sha256'] and len(raw)==manifest['request_bytes'],name+' request changed'
  assert request['InstanceIds']==['ins-p4i0pcub'] and request['Username']=='root'
  assert request['CommandType']=='SHELL' and request['SaveCommand'] is False
  assert 0<request['Timeout']<=600 and len(request['Content'])<=65536
  script=base64.b64decode(request['Content'],validate=True)
  assert sha(script)==manifest['script_sha256'] and len(script)==manifest['script_bytes']
  assert b'\r' not in script
  if name!='install':
   source=(HERE/(name+'-node.py')).read_bytes();marker=WRAPPERS[name]
   expected=("#!/bin/sh\nset -eu\npython3 - <<'BB_DIAGNOSTICS_"+marker+"'\n").encode()+source+('\nBB_DIAGNOSTICS_'+marker+'\n').encode()
   assert script==expected and sha(source)==manifest['source_sha256'],name+' source mismatch'
  else:
   prefix=b"#!/bin/sh\nset -eu\npython3 - <<'BB_DIAGNOSTICS_INSTALL'\n";suffix=b'\nBB_DIAGNOSTICS_INSTALL\n'
   assert script.startswith(prefix) and script.endswith(suffix)
   source=script[len(prefix):-len(suffix)]
   tree=ast.parse(source)
   variables={}
   for node in tree.body:
    if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('PACKAGE_SHA','PACKAGE','FILES','EXPECTED'):
     variables[node.targets[0].id]=ast.literal_eval(node.value)
   template=(HERE/'install-node.template.py').read_text()
   for key in ('PACKAGE_SHA','PACKAGE','FILES','EXPECTED'):template=template.replace('__'+key+'__',repr(variables[key]))
   assert template.encode()==source,'install template mismatch'
   archive=base64.b64decode(variables['PACKAGE'],validate=True);assert sha(archive)==variables['PACKAGE_SHA']==manifest['runtime_archive_sha256']
   with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as package:
    members=package.getmembers();assert {m.name for m in members}==set(variables['FILES']) and len(members)==len(variables['FILES'])
    for member in members:assert member.isfile() and sha(package.extractfile(member).read())==variables['FILES'][member.name]
  compile(source,name+'-node.py','exec')
  results.append({'request':name,'sha256':sha(raw),'verified':True})
 print(json.dumps(results,indent=2))
if __name__=='__main__':verify()
