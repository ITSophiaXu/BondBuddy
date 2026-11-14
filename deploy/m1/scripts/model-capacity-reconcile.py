#!/usr/bin/env python3
"""One-shot host proof for abandoned model permits. No TTL-based active reclaim.

Run on the execution host using its existing database access, under the existing
configuration/deployment locks for apply. Dry-run emits only identities/hashes.
Private env and credentials stay inside the existing query container.
"""
import argparse, datetime, hashlib, json, os, pathlib, subprocess


def namespaces(proc=pathlib.Path('/proc')):
    result={}
    for path in proc.iterdir():
        if not path.name.isdigit(): continue
        try:
            ns=os.readlink(path/'ns/pid')
            result.setdefault(ns,None)
            status=(path/'status').read_text()
            nested=next((line.split()[1:] for line in status.splitlines() if line.startswith('NSpid:')),[])
            if nested and nested[-1]=='1':
                stat=(path/'stat').read_text()
                result[ns]=stat[stat.rfind(')')+2:].split()[19]
        except FileNotFoundError: continue
        # Unreadable or failed enumeration must reject a reclaim.
    return result


def classify(row, machine, boot, live):
    if row['execution_host'] != machine: return 'retain_foreign_host'
    if row['host_boot_id'] != boot: return 'host_reboot_proves_exit'
    if row['pid_namespace'] not in live: return 'namespace_absence_proves_exit'
    current_init=live[row['pid_namespace']]
    if current_init is not None and current_init != row['namespace_init_start']:
        # PID namespace inode numbers can be recycled. A different PID 1 start
        # identity proves that the old namespace's init and entire child tree died.
        return 'namespace_replacement_proves_exit'
    return 'retain_live_namespace'


def digest(row):
    return hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--query-container',required=True)
    p.add_argument('--apply',action='store_true')
    p.add_argument('--locked-state')
    p.add_argument('--synthetic',action='store_true')
    args=p.parse_args()
    locks=[]
    if args.apply and not args.synthetic:
        import fcntl
        if not args.locked_state: raise RuntimeError('existing lock state required')
        state=pathlib.Path(args.locked_state)
        for name in ['config.lock','deploy.lock']:
            # Do not create another deployment lock or replace a binding.
            fd=os.open(state/name,os.O_WRONLY|os.O_NOFOLLOW)
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(fd)
    info=json.loads(subprocess.check_output(['docker','inspect',args.query_container]))[0]
    labels=info['Config'].get('Labels',{})
    if args.synthetic:
        if labels.get('bondbuddy.test') != '1348': raise RuntimeError('unowned query container')
    elif labels.get('com.docker.compose.project')!='bb-execution' or labels.get('com.docker.compose.service') not in ['worker','worker-review']:
        raise RuntimeError('unexpected database access component')
    if not info['State']['Running']: raise RuntimeError('query container is not running')
    machine=hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes()).hexdigest()
    boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    def query(sql,values=None):
        payload=json.dumps({'sql':sql,'values':values or []})
        js="import {Pool} from 'pg';let b='';for await(const c of process.stdin)b+=c;const q=JSON.parse(b);const p=new Pool({connectionString:process.env.DATABASE_URL});try{const r=await p.query(q.sql,q.values);console.log(JSON.stringify({rows:r.rows,count:r.rowCount}))}finally{await p.end()}"
        return json.loads(subprocess.check_output(['docker','exec','-i',args.query_container,'node','--input-type=module','-e',js],input=payload.encode()))
    rows=[item['snapshot'] for item in query('SELECT to_jsonb(h) snapshot FROM bb_model_capacity_holders h ORDER BY slot')['rows']]
    live=namespaces()
    results=[]
    for row in rows:
        reason=classify(row,machine,boot,live)
        result={'token':row['token'],'slot':row['slot'],'scope':row['scope'],'preimage_sha256':digest(row),'reason':reason,'released':False}
        if args.apply and reason in ['host_reboot_proves_exit','namespace_absence_proves_exit','namespace_replacement_proves_exit']:
            # Re-enumeration plus complete row CAS. Neither hostname nor PID
            # numbers inside a replacement container prove an old process dead.
            if classify(row,machine,boot,namespaces()) not in ['host_reboot_proves_exit','namespace_absence_proves_exit','namespace_replacement_proves_exit']:
                raise RuntimeError('exit proof changed')
            removed=query("DELETE FROM bb_model_capacity_holders h WHERE token=$1 AND to_jsonb(h)=$2::jsonb RETURNING token",[row['token'],row])
            if removed['count']!=1: raise RuntimeError('capacity holder preimage changed')
            result['released']=True
        results.append(result)
    print(json.dumps({'captured_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'query_component_id':info['Id'],'execution_host':machine,'host_boot_id':boot,'apply':args.apply,'holders':results},indent=2))
    for fd in reversed(locks): os.close(fd)


if __name__=='__main__': main()
