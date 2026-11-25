#!/usr/bin/python3
"""Local client: drain every page over SSH without granting remote write access."""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import shlex
import subprocess


def content_query_selection(args):
    # Match the server's accepted option order and --file=value spelling. Values
    # of other options must never be mistaken for the positional content kind.
    if not args or args[0] != 'content': return None, None
    kind = selected = None; index = 1; positional_only = False
    while index < len(args):
        token = args[index]
        if token == '--' and not positional_only:
            positional_only = True
        elif token.startswith('--') and not positional_only:
            name, separator, value = token.partition('=')
            if name not in ('--reason', '--file', '--length', '--offset'): return None, None
            if not separator:
                index += 1
                if index >= len(args): return None, None
                value = args[index]
            if name == '--file': selected = value
        elif kind is None: kind = token
        index += 1
    return kind, selected


def export(target, ssh_config, query, output, invoke=None):
    args=shlex.split(query)
    if not args or args[0] not in ('logs','db','runs','content','exec-log') or any(token.partition('=')[0] in ('--cursor','--offset') for token in args):
        raise ValueError('Use a pageable read query without an existing cursor/offset')
    if not target or target.startswith('-') or any(c.isspace() for c in target): raise ValueError('Invalid SSH target')
    output=pathlib.Path(output)
    partial=output.with_name(output.name+'.partial')
    if output.exists() or partial.exists(): raise ValueError('Choose a new output file')
    content=args[0] in ('content','exec-log'); marker=None; expected_hash=None; rows=0; seen=set(); checksum=hashlib.sha256(); capture_truncated=False
    content_kind, selected_file=content_query_selection(args)
    exec_content=args[0]=='exec-log' or content_kind=='exec'
    operations_content=content_kind=='result' and selected_file=='operations.json'
    def call(command):
        # Cover the broker command, 18s reference lookup, 15s SSH connection
        # bound and 12s transfer headroom: exec 180s, selected operations 90s.
        result=subprocess.run(['ssh','-F',str(ssh_config),'-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',target,shlex.join(command)],check=True,capture_output=True,timeout=180 if exec_content else 90 if operations_content else 60)
        return json.loads(result.stdout)
    invoke=invoke or call
    with open(partial,'xb') as file:
        os.chmod(partial,0o600)
        while True:
            # For -- queries, place options before all positionals: argparse also
            # accepts a trailing -- after an option-separated id. Keep ordinary
            # queries' existing continuation order.
            continuation = ['--offset' if content else '--cursor',str(marker)] if marker is not None else []
            command=args[:1]+continuation+args[1:] if '--' in args else args+continuation
            page=invoke(command)
            if content:
                if page.get('offset')!=(marker or 0) or page.get('encoding')!='base64': raise ValueError('Invalid content page')
                if expected_hash is None: expected_hash=page['redacted_sha256']
                capture_truncated |= page.get('capture_truncated',False)
                if expected_hash!=page['redacted_sha256']: raise ValueError('Content changed during export')
                chunk=base64.b64decode(page['data'],validate=True); file.write(chunk); checksum.update(chunk)
                next_marker=page['next_offset']
                if next_marker is not None and next_marker!=(marker or 0)+len(chunk): raise ValueError('Noncontiguous content page')
            else:
                for item in page['items']:
                    chunk=(json.dumps(item,ensure_ascii=False)+'\n').encode(); file.write(chunk); checksum.update(chunk); rows+=1
                next_marker=page['next_cursor']
            if next_marker is None: break
            if str(next_marker) in seen: raise ValueError('Repeated continuation cursor')
            seen.add(str(next_marker)); marker=next_marker
        if content and checksum.hexdigest()!=expected_hash: raise ValueError('Export hash mismatch')
        file.flush(); os.fsync(file.fileno())
    # Atomic create without replacing a file another export created during pagination.
    os.link(partial,output)
    partial.unlink()
    return {'path':str(output),'sha256':checksum.hexdigest(),'rows':rows if not content else None,'complete':True,'source_capture_truncated':capture_truncated}


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--target',required=True); parser.add_argument('--ssh-config',required=True); parser.add_argument('--query',required=True); parser.add_argument('--output',required=True)
    args=parser.parse_args()
    print(json.dumps(export(args.target,args.ssh_config,args.query,args.output),ensure_ascii=False))
