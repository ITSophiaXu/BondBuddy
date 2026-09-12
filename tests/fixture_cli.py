"""Deterministic subprocess fixture; this is deliberately not a real Codex response."""
import json
import pathlib
import sys
import time

mode, out = sys.argv[1:3]
if mode == 'earlyfail':
    print('Could not find home directory', file=sys.stderr, flush=True)
    sys.exit(7)
sys.stdin.read()
if mode == 'permission':
    print('attempt to write a readonly database\nError: failed to initialize in-process app-server client: Access is denied. (os error 5)', file=sys.stderr, flush=True)
    sys.exit(7)
if mode == 'fail':
    print('fixture failure', file=sys.stderr, flush=True)
    sys.exit(7)
if mode == 'wait':
    time.sleep(30)
result = {'intent': 'answer', 'summary': 'SUBPROCESS FIXTURE', 'changes': [], 'assessments': []}
pathlib.Path(out).write_text(json.dumps(result), encoding='utf-8')
print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(result)}}), flush=True)
