"""JSON-line test transport: the Node harness executes each query against isolated PG16."""
import json
import sys
from database import Database, SPECS


class RealDatabase(Database):
    def query(self, sql):
        print(json.dumps({'sql': sql}), flush=True)
        response=json.loads(sys.stdin.readline())
        if 'error' in response: raise RuntimeError(response['error'])
        return response['result']


db=RealDatabase({})
available=db.available()
assert len(available)==len(SPECS)
for item in available:
    if item['available']:
        result=db.page(item['kind'],{},5)
        assert isinstance(result['items'],list)
seen=[]; cursor=None
while True:
    result=db.page('users',{},17,cursor)
    seen.extend(result['items']);cursor=result['next_cursor']
    if not cursor:break
assert len([r for r in seen if r['key'].startswith('diag-user-')])==125
assert len({r['key'] for r in seen})==len(seen)
assert all('password_hash' not in r['body'] and 'phone_e164' not in r['body'] for r in seen)
active=db.page('users',{'state':'active'},500)['items']
assert len([r for r in active if r['key'].startswith('diag-user-')])==125
disabled=db.page('users',{'state':'disabled'},500)['items']
assert all(r['body']['status']=='disabled' for r in disabled)
assert not any(r['key'].startswith('diag-user-') for r in disabled)
first=db.page('outbox',{'user':'diag-user-001'},13)
second=db.page('outbox',{'user':'diag-user-001'},13,first['next_cursor'])
assert len(first['items'])==len(second['items'])==13
assert not {r['key'] for r in first['items']} & {r['key'] for r in second['items']}
assert all('payload' not in r['body'] and 'lease_token' not in r['body'] for r in first['items'])
assert all(r['owner_id']=='diag-user-001' for r in first['items'])
print(json.dumps({'done': True,'collections':len(available),'paged_users':125}),flush=True)
