"""Real loopback SSH and sudo tests in an ephemeral, network-isolated Linux container."""
import json
import os
import pathlib
import subprocess
import time

import archive
import install
from export import export

def run(args, input=None, check=True):
    return subprocess.run(args,input=input,capture_output=True,check=check,timeout=30)

pathlib.Path('/run/sshd').mkdir(exist_ok=True)
config=json.loads(pathlib.Path('config.main.example.json').read_text())
config['check_execution_registry']=False
pathlib.Path('/root/config.json').write_text(json.dumps(config))
receipt=json.loads(run(['/usr/bin/python3','install.py','install','/root/config.json']).stdout)
for who in ('developer','machine'):
    run(['ssh-keygen','-q','-t','ed25519','-N','','-f','/root/'+who])
run(['/usr/bin/python3','install.py','account','bb-log-test','/root/developer.pub'])
run(['/usr/bin/python3','install.py','account','bb-ingest-test','/root/machine.pub','--role','ingest','--source','azure'])
hostkey=pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
pathlib.Path('/root/known_hosts').write_text('127.0.0.1 '+hostkey[0]+' '+hostkey[1]+'\n')
sshd=subprocess.Popen(['/usr/sbin/sshd','-D','-e'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def ssh(command, user='bb-log-test', body=None):
    key='/root/developer' if user=='bb-log-test' else '/root/machine'
    return run(['ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/root/known_hosts','-i',key,user+'@127.0.0.1',command],input=body,check=False)
try:
    result=None
    for _ in range(30):
        result=ssh('capabilities')
        if result.returncode==0:break
        time.sleep(.1)
    assert result.returncode==0,result.stderr.decode()
    assert json.loads(result.stdout)['version']==3
    denied=['sh','sudo sh','docker exec api sh','cat /etc/shadow','db users --id "x;select 1"','logs api ; id','ingest','--collect','internal-sftp']
    for command in denied:
        result=ssh(command)
        assert result.returncode!=0,(command,result.stdout,result.stderr)
    assert ssh('logs',user='bb-ingest-test').returncode!=0
    assert 'docker' not in run(['id','-nG','bb-log-test']).stdout.decode().split()
    # Real machine SSH ingestion, followed by developer read, including 1,205 entries and export pagination.
    node=archive.connect('/root/node.sqlite3',True)
    with node:
        for i in range(1205):archive.record(node,'azure','a'*64,'upload-confirmation','2026-01-01T00:00:00Z',i,'synthetic line '+str(i))
    after=0
    while True:
        batch=archive.export_batch(node,'azure',after)
        if not batch['records']:break
        response=ssh('ingest',user='bb-ingest-test',body=json.dumps(batch).encode())
        assert response.returncode==0,response.stderr.decode()
        after=json.loads(response.stdout)['acknowledged']
    assert after==1205
    page=json.loads(ssh('logs upload-confirmation --limit 10').stdout)
    assert len(page['items'])==10 and page['next_cursor']
    query='logs upload-confirmation --limit 333'
    report=export('unused','unused',query,'/root/export.jsonl',lambda args:json.loads(ssh(__import__('shlex').join(args)).stdout))
    assert report['rows']==1205
    assert len(pathlib.Path('/root/export.jsonl').read_text().splitlines())==1205
    forged=archive.export_batch(node,'azure',0);forged['source']='main'
    assert ssh('ingest',user='bb-ingest-test',body=json.dumps(forged).encode()).returncode!=0
    audit=pathlib.Path('/var/lib/bondbuddy-diagnostics/access-audit.jsonl').read_text()
    assert 'bb-log-test' in audit and 'bb-ingest-test' in audit
    node.close()
    # Revocation takes effect on a new command, without restarting an application.
    active=json.loads(pathlib.Path('/etc/bondbuddy-diagnostics/config.json').read_text())
    del active['actors']['bb-log-test']
    install.atomic(pathlib.Path('/etc/bondbuddy-diagnostics/config.json'),json.dumps(active).encode())
    assert ssh('capabilities').returncode!=0
    print(json.dumps({'passed':True,'checks':['real SSH login','nine forbidden commands','separate ingestion identity','1205-record SSH transfer and full export','source impersonation rejected','per-user durable audit','account revocation'],'productionChanged':False}))
finally:
    sshd.terminate()
    try:sshd.wait(timeout=5)
    except subprocess.TimeoutExpired:sshd.kill();sshd.wait()
