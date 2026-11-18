import pathlib,json,base64,hashlib,difflib,sys
sys.stdout.reconfigure(encoding='utf-8');P=pathlib.Path('work/release-1550');h=lambda b:hashlib.sha256(b).hexdigest();r=json.loads((P/'merge-receipt.json').read_text(encoding='utf-8'))
def replace(t,a,b):
 if t.count(a)!=1:raise RuntimeError('exact replacement count '+str(t.count(a))+' '+a[:90])
 return t.replace(a,b,1)
def region(t,a,b):return t[t.index(a):t.index(b,t.index(a))]
for f in list(r['conflicts']):
 role,name=f['role'],f['path'];actual=base64.b64decode(json.loads((P/('live-'+role+'.json')).read_text(encoding='utf-8'))['files'][name]);t=actual.decode().replace('\r\n','\n');old=(P/'source-leaves/parent'/name).read_text(encoding='utf-8');new=(P/'source-leaves/candidate'/name).read_text(encoding='utf-8')
 if name.endswith('/model-call-budget.js'):
  comments='            // Renew every five seconds on the existing connection instead of reopening\n            // the database transport each time. Idle connections still retire promptly.\n';assert old.replace(comments,'')==t;t=new
 elif name.endswith('/file-authoring-completion.js'):
  helper=region(new,'/** Fixed application-owned handlers only;','async function available(');t=replace(t,'async function available(',helper+'async function available(')
 elif name.endswith('/codex-adapter.js'):
  t=replace(t,"import { fileCompletionArgs } from './file-authoring-completion.js';","import { fileCompletionArgs } from './file-authoring-completion.js';\nimport { reviewFileCompletionArgs } from './review-file-completion.js';")
  generic=region(new,'// Review, QA and project-file workspaces','// -c overrides, applied')
  t=replace(t,'// -c overrides, applied',generic+'// -c overrides, applied')
  t=replace(t,'export function codexConfigOverrides(c, files = false) {','export function codexConfigOverrides(c, files = false, completion = false) {')
  t=replace(t,"'model_context_window=1000000', 'model_auto_compact_token_limit=900000',","'model_context_window=1000000', 'model_auto_compact_token_limit=900000',\n        ...(files && !completion ? [`developer_instructions=${q(FILE_WORKSPACE_CONTINUATION_INSTRUCTIONS)}`, `compact_prompt=${q(FILE_WORKSPACE_COMPACT_PROMPT)}`] : []),")
  t=replace(t,'export function buildCodexArgs(c, o) {',"export function buildCodexArgs(c, o) {\n    if (o.reviewCompletion && (!o.fileAuthoring || o.fileCompletion || o.fileRecovery || o.contextRotation))\n        throw new CodexAdapterError('MODEL_ADAPTER_CONFIG_INVALID');")
  t=replace(t,'...codexConfigOverrides(c, o.fileAuthoring),','...codexConfigOverrides(c, o.fileAuthoring, o.fileCompletion),')
  t=replace(t,"!(o.fileCompletion && f === 'hooks')","!((o.fileCompletion || o.reviewCompletion) && f === 'hooks')")
  t=replace(t,'            args.push(...fileCompletionArgs());','            args.push(...fileCompletionArgs());\n        if (o.reviewCompletion)\n            args.push(...reviewFileCompletionArgs());')
  t=replace(t,'fileCompletion: input.fileWorkspace?.completionCheck === true,','fileCompletion: input.fileWorkspace?.completionCheck === true, reviewCompletion: input.fileWorkspace?.reviewCompletionCheck === true,')
  t=replace(t,"(input.fileWorkspace.completionCheck ? 'codex-file-authoring-2' : 'codex-file-authoring-1')","(input.fileWorkspace.reviewCompletionCheck ? 'codex-review-file-2' : input.fileWorkspace.completionCheck ? 'codex-file-authoring-2' : 'codex-file-authoring-1')")
 elif name.endswith('/queue.js') and role in ['api','ops']:
  helper=(P/'source-leaves/candidate/apps/api/dist/execution-capacity.js').read_text(encoding='utf-8');helper=region(helper,'export async function lockTaskQueueScheduling','export async function executionNodeState');helper=helper.replace('export async function','async function').replace('export function','function')
  marker='export async function claim(';t=replace(t,marker,helper+'\n'+marker)
  start=t.index(marker);end=t.index('\nexport ',start+len(marker));part=t[start:end]
  part=replace(part,'return transaction(pool, async (client) => {','return transaction(pool, async (client) => {\n        await lockTaskQueueScheduling(client);')
  line=next(x for x in part.splitlines()if 'SELECT r.* FROM bb_runs r JOIN bb_jobs j' in x)
  assert 'ORDER BY j.created_at FOR UPDATE' in line and 'client.query("' in line
  nl=line.replace('client.query("','client.query(`',1).replace('", [options.', '`, [options.',1).replace('ORDER BY j.created_at FOR UPDATE',"ORDER BY ${accountExecutionLoadSql('r.owner_user_id')},j.created_at,j.id FOR UPDATE")
  assert '", [options.' not in nl
  part=replace(part,line,nl);t=t[:start]+part+t[end:]
 else:raise RuntimeError('unhandled '+name)
 b=t.encode();q=P/'merged'/role/name;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
 r['files'].append({'role':role,'path':name,'mode':'reviewed_legacy_compatibility','before_sha256':h(actual),'after_sha256':h(b),'bytes':len(b),'parent_sha256':h(old.encode()),'candidate_sha256':h(new.encode())})
 diff=''.join(difflib.unified_diff(actual.decode().replace('\r\n','\n').splitlines(True),t.splitlines(True),fromfile='live/'+name,tofile='release/'+name));q=P/'compatibility-diffs'/role/(name+'.diff');q.parent.mkdir(parents=True,exist_ok=True);q.write_text(diff,encoding='utf-8')
r['conflicts']=[];(P/'merge-final.json').write_text(json.dumps(r,indent=2),encoding='utf-8');print(json.dumps({'files':len(r['files']),'manual_compatibility':sum(x['mode']=='reviewed_legacy_compatibility' for x in r['files'])}))
