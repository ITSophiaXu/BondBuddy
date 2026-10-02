import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit --apply is the only mode that changes GitHub. User authorization and
// the host's network/approval controls remain required outside this script.
const dir = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const check = args.includes('--check');
const selectedArg = args.find(a => a.startsWith('--milestones='));
const selected = new Set(selectedArg ? selectedArg.split('=')[1].split(',') : plan.milestones.map(m => m.id));
for (const id of selected) if (!plan.milestones.some(m => m.id === id)) throw Error('Unknown milestone: ' + id);
if (args.some(a => !['--apply', '--check'].includes(a) && !a.startsWith('--milestones='))) throw Error('Unknown argument');
if (apply && check) throw Error('Choose --check or --apply');
// M3 is maintained through explicit, reviewed requirement updates. This legacy
// bulk publisher must never recreate excluded tasks or overwrite live edits.
// Reject before publication-state writes, gh discovery, or any network action.
if (apply && selected.has('M3')) throw Error('M3 --apply is disabled for this legacy publisher before network access. Reconcile the six current issues (#47/#48/#49/#55/#145/#56) individually with docs/product-decisions/2026-10-02-m3-review-scope.md. --check remains an offline check; it is not remote verification.');
const statePath = path.join(dir, 'published.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
  repository: plan.repository, namespace: plan.namespace, milestones: {}, issues: {}, verified: false
};
if (state.repository !== plan.repository || state.namespace !== plan.namespace) throw Error('Publication state belongs to another plan');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const marker = id => `<!-- ${plan.namespace}:${id} -->`;
const repoPath = `repos/${plan.repository}`;
const draftURL = id => `https://github.com/${plan.repository}/blob/${plan.branch}/product-prototype/product-specs/delivery-plan/issues/${id}.md`;
const title = t => `[${t.id}] ${t.title.replace(/^M\d · /, '')}`;
const draft = id => fs.readFileSync(path.join(dir, 'issues', id + '.md'), 'utf8').replace(/\r\n/g, '\n');
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idFromBody = body => body?.match(new RegExp(`<!-- ${escapeRegex(plan.namespace)}:([A-Z0-9-]+) -->`))?.[1];
function api(endpoint, method = 'GET', payload, paginate = false) {
  const requestFile = path.join(dir, '.publish-request.json');
  const command = ['api', endpoint, '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (paginate) command.push('--paginate', '--slurp');
  if (payload !== undefined) { fs.writeFileSync(requestFile, JSON.stringify(payload), 'utf8'); command.push('--input', requestFile); }
  let result;
  try { result = spawnSync('gh', command, { encoding: 'utf8', shell: false, maxBuffer: 24 * 1024 * 1024, windowsHide: true }); }
  finally { if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile); }
  if (result.error || result.status !== 0) throw Error(`${method} ${endpoint} failed; do not blindly retry a create. Re-run discovery. ${result.error?.message || result.stderr}`);
  if (!result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout);
  return paginate ? parsed.flat() : parsed;
}
const getAll = endpoint => api(endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100', 'GET', undefined, true);
const mutate = async (endpoint, method, payload) => {
  if (!apply) throw Error('Mutation needs --apply');
  // Keep mutation frequency comfortably below GitHub content creation limits.
  await new Promise(resolve => setTimeout(resolve, 1200));
  return api(endpoint, method, payload);
};
const taskIds = new Set(plan.tasks.map(t => t.id));
const currentM3Ids = ['M3-01', 'M3-02', 'M3-03', 'M3-09', 'M3-10', 'M3-11'];
const actualM3Ids = plan.tasks.filter(t => t.milestone === 'M3').map(t => t.id).sort();
if (JSON.stringify(actualM3Ids) !== JSON.stringify([...currentM3Ids].sort())) throw Error('M3 must contain exactly the six current tasks; excluded library/data tasks cannot rejoin this milestone.');
for (const t of plan.tasks.filter(t => t.milestone === 'M3')) {
  if (t.dependsOn.some(id => /^M2-|^M4-|^M1-3[23]$|^M3-0[4-8]$/.test(id))) throw Error('Out-of-scope M3 dependency: ' + t.id);
}
const ordered = [], visited = new Set(), active = new Set();
function visit(t) {
  if (visited.has(t.id)) return;
  if (active.has(t.id)) throw Error('Dependency cycle: ' + t.id);
  active.add(t.id);
  for (const id of t.dependsOn) { const dependency = plan.tasks.find(x => x.id === id); if (!dependency) throw Error('Missing dependency: ' + id); visit(dependency); }
  active.delete(t.id); visited.add(t.id); ordered.push(t);
}
for (const t of plan.tasks) visit(t);
for (const item of [...plan.milestones, ...plan.tasks]) {
  const body = draft(item.id);
  if (!body.includes(marker(item.id))) throw Error('Draft marker missing: ' + item.id);
  for (const match of body.matchAll(/\{\{([A-Z0-9-]+)\}\}/g)) if (!taskIds.has(match[1])) throw Error('Unknown reference: ' + match[1]);
}
const pending = plan.milestones.filter(m => selected.has(m.id) && m.pendingConfirmation);
console.log(JSON.stringify({mode:check?'offline-check':apply?'apply':'remote-preview',selected:[...selected],tasks:plan.tasks.filter(t=>selected.has(t.milestone)).length,pending:pending.map(m=>m.id)},null,2));
if (check) process.exit(0);
if (apply && pending.length) throw Error('Clarification still required before publishing ' + pending.map(m => m.id).join(', '));

// Discover all pages before any mutation. Existing human issues are untouched.
const existingIssues = getAll(`${repoPath}/issues?state=all`).filter(i => !i.pull_request);
const existingMilestones = getAll(`${repoPath}/milestones?state=all`);
const existingLabels = getAll(`${repoPath}/labels`);
const issues = new Map();
for (const issue of existingIssues) {
  const id = idFromBody(issue.body);
  if (!id) continue;
  if (issues.has(id)) throw Error('Duplicate remote marker: ' + id);
  issues.set(id, issue);
  const previous = state.issues[id];
  if (previous && previous.number !== issue.number) throw Error('Issue identity changed: ' + id);
  if (previous?.bodyHash && previous.bodyHash !== hash(issue.body || '')) throw Error('Human body edit detected; reconcile manually before applying: ' + issue.html_url);
  state.issues[id] = {...previous, number: issue.number, id: issue.id, url: issue.html_url};
}
for (const item of [...plan.milestones, ...plan.tasks]) {
  if (!selected.has(item.milestone || item.id) || issues.has(item.id)) continue;
  if (existingIssues.some(i => i.title === title(item))) throw Error('Title conflicts with an unmarked existing issue: ' + title(item));
}
if (!apply) {
  console.log(JSON.stringify({existingIssues:existingIssues.length,existingMilestones:existingMilestones.length,matchedPlanIssues:issues.size,plannedTasks:plan.tasks.filter(t=>selected.has(t.milestone)).length},null,2));
  process.exit(0);
}
state.verified = false; save();
for (const label of plan.labels) {
  if (!existingLabels.some(l => l.name === label.name)) { await mutate(`${repoPath}/labels`, 'POST', label); console.log('label ' + label.name); }
}
for (const m of plan.milestones.filter(m => selected.has(m.id))) {
  const found = existingMilestones.filter(x => x.description?.includes(marker(m.id)) || x.title === m.title);
  if (found.length > 1) throw Error('Duplicate milestone: ' + m.id);
  let remote = found[0];
  if (remote && !remote.description?.includes(marker(m.id))) throw Error('Milestone title belongs to unmarked content: ' + m.title);
  if (!remote) remote = await mutate(`${repoPath}/milestones`, 'POST', {title:m.title,description:[marker(m.id),m.goal,'上线门槛：'+m.gate].join('\n\n')});
  state.milestones[m.id] = {number:remote.number,url:remote.html_url,title:remote.title}; save();
  console.log(`${m.id} ${remote.html_url}`);
}
function render(id) {
  const body = draft(id).replace(/\{\{([A-Z0-9-]+)\}\}/g, (_, ref) => {
    const remote = state.issues[ref];
    return remote ? `#${remote.number}` : `[${ref}（待发布）](${draftURL(ref)})`;
  });
  const t = plan.tasks.find(t => t.id === id);
  return t ? body + `\n所属里程碑跟踪：#${state.issues[t.milestone].number}\n` : body;
}
async function ensureIssue(item, body) {
  let issue = issues.get(item.id);
  const milestoneId = item.milestone || item.id;
  if (!issue) {
    issue = await mutate(`${repoPath}/issues`, 'POST', {title:title(item),body,milestone:state.milestones[milestoneId].number,labels:item.labels || ['type:milestone']});
    issues.set(item.id, issue);
    state.issues[item.id] = {number:issue.number,id:issue.id,url:issue.html_url,bodyHash:hash(body)};
    save(); console.log(`${item.id} ${issue.html_url}`);
  } else {
    // A partially completed previous publication may lack its response mapping.
    // Recover only a byte-exact generated body; never overwrite unknown edits.
    const known = state.issues[item.id].bodyHash;
    if (!known && issue.body !== body) throw Error('Unrecorded existing body differs; review before update: ' + issue.html_url);
    const desiredTitle = title(item);
    const previousGeneratedTitle = (issue.body || '').match(/^# (.+)$/m)?.[1];
    if (issue.title !== desiredTitle && issue.title !== previousGeneratedTitle) throw Error('Existing title has a manual edit; reconcile before renaming: ' + issue.html_url);
    if (issue.body !== body || issue.title !== desiredTitle) {
      const latest = api(`${repoPath}/issues/${issue.number}`);
      if (hash(latest.body || '') !== known || latest.title !== issue.title) throw Error('Issue changed during publication; preserve the edit and reconcile manually: ' + latest.html_url);
      issue = await mutate(`${repoPath}/issues/${issue.number}`, 'PATCH', {title:desiredTitle,body}); issues.set(item.id,issue);
    }
    state.issues[item.id].bodyHash=hash(body); save();
  }
  return issue;
}
for (const m of plan.milestones.filter(m => selected.has(m.id))) await ensureIssue(m, render(m.id));
for (const t of ordered.filter(t => selected.has(t.milestone))) await ensureIssue(t, render(t.id));
for (const m of plan.milestones.filter(m => selected.has(m.id))) {
  const parent = issues.get(m.id);
  const attached = getAll(`${repoPath}/issues/${parent.number}/sub_issues`);
  for (const t of plan.tasks.filter(t => t.milestone === m.id)) {
    const child = state.issues[t.id];
    if (!attached.some(i => i.id === child.id)) await mutate(`${repoPath}/issues/${parent.number}/sub_issues`, 'POST', {sub_issue_id:child.id});
    state.issues[t.id].parent=parent.number; save();
  }
  await ensureIssue(m, render(m.id));
}
// Refresh dependency links in already published groups when a later group lands.
for (const t of plan.tasks.filter(t => state.issues[t.id] && selected.has(t.milestone))) await ensureIssue(t, render(t.id));
const verifiedIssues = getAll(`${repoPath}/issues?state=all`).filter(i=>!i.pull_request);
const failures=[];
for (const item of [...plan.milestones, ...plan.tasks].filter(i=>selected.has(i.milestone||i.id))) {
  const remote=verifiedIssues.find(i=>i.number===state.issues[item.id]?.number);
  const milestoneId=item.milestone||item.id;
  if(!remote || remote.title!==title(item) || remote.milestone?.number!==state.milestones[milestoneId].number || hash(remote.body||'')!==state.issues[item.id].bodyHash) failures.push(item.id);
  for (const label of item.labels||['type:milestone']) if(!remote?.labels.some(l=>l.name===label)) failures.push(item.id+':'+label);
}
for(const m of plan.milestones.filter(m=>selected.has(m.id))) {
  const children=getAll(`${repoPath}/issues/${state.issues[m.id].number}/sub_issues`);
  for(const t of plan.tasks.filter(t=>t.milestone===m.id)) if(!children.some(c=>c.id===state.issues[t.id].id)) failures.push(t.id+':parent');
}
if(failures.length) throw Error('Verification failed: '+failures.join(', '));
state.verified=true; state.verifiedAt=new Date().toISOString(); state.verifiedMilestones=[...selected]; save();
fs.writeFileSync(path.join(dir,'GitHub发布索引.md'),[
  '# GitHub 任务入口','',`仓库：[${plan.repository}](https://github.com/${plan.repository})`,'',
  '发布后已读取 GitHub 核对标题、标签、里程碑、正文和父子关系。认领时设置 assignee 或在任务下评论；本文记录发布时的链接，不追踪后续任务完成状态。','',
  '| 阶段 | 里程碑 | 跟踪 issue |','|---|---|---|',
  ...plan.milestones.filter(m=>state.milestones[m.id]).map(m=>`| ${m.id} | [${m.title}](${state.milestones[m.id].url}) | [#${state.issues[m.id].number}](${state.issues[m.id].url}) |`),'',
  '| 任务 | Issue |','|---|---|',...plan.tasks.filter(t=>state.issues[t.id]).map(t=>`| ${t.id} ${t.title} | [#${state.issues[t.id].number}](${state.issues[t.id].url}) |`),'',
  ...plan.milestones.filter(m=>!state.milestones[m.id]).map(m=>`${m.id} 尚未发布：${m.pendingConfirmation?'范围待用户确认':'不在本次发布范围'}。`),''].join('\n').trimEnd()+'\n');
console.log(JSON.stringify({verified:true,publishedMilestones:Object.keys(state.milestones).length,publishedIssues:Object.keys(state.issues).length},null,2));
