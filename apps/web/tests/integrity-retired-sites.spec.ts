import {test, expect} from '@playwright/test';
import {INTEGRITY_SITES, integritySelectableSitesForSubjects, removeUnavailableIntegritySites} from '@bondbuddy/contracts';
import {fixture, install, projectId, ownerId, checkId, historicalRounds, writes} from './integrity-continuation-fixtures';

const retired = ['credit-china', 'execution-dishonest', 'execution-debtor', 'execution-restriction', 'industry-credit', 'customs', 'customs-credit', 'nmpa', 'tax', 'tax-dishonest', 'csrc', 'mofcom'];
const route = `/#integrity?project=${projectId}`;

for (const source of ['server', 'local'] as const) test(`${source} saved selections drop retired sites and keep verified scope`, async ({page}) => {
  const state = fixture();
  const draft = {...state.workspace.draft, site_ids: [...retired, 'pbc', 'bankruptcy']};
  if (source === 'server') state.workspace.draft = draft;
  else await page.addInitScript(({ownerId, projectId, draft, revision}) => {
    const key=`bb-integrity-recovery:${ownerId}:${projectId}`;
    if(localStorage.getItem(key)===null)localStorage.setItem(key, JSON.stringify({version: 'integrity-recovery-cache-v1', owner: ownerId, project: projectId, value: {revision, draft}}));
  }, {ownerId, projectId, draft, revision: state.workspace.revision});
  await install(page, state); await page.goto(route);
  await expect(page.locator('#integrity-site-count')).toHaveText('（已选 2 个）');
  for (const id of retired) await expect(page.locator(`[name=integrity-site][value="${id}"]`)).toHaveCount(0);
  await expect(page.locator('[name=integrity-site][value="bankruptcy"]')).toBeChecked();
  expect(writes(state)).toEqual([]);
  await page.locator('#integrity-save').click();
  await expect.poll(() => state.drafts.length).toBe(1);
  expect(state.drafts[0].draft.site_ids).toEqual(['pbc', 'bankruptcy']);
  await page.reload(); await expect(page.locator('#integrity-site-count')).toHaveText('（已选 2 个）');
});

test('all/group selections include only the verified scope for the current companies', async ({page}) => {
  const state = fixture(); state.workspace.draft.site_ids = [];
  await install(page, state); await page.goto(route);
  const available=integritySelectableSitesForSubjects(state.workspace.draft.subjects);
  await expect(page.locator('[name=integrity-site]')).toHaveCount(available.length);
  await page.locator('[data-site-group="基础征信"]').check();
  await expect(page.locator('[name=integrity-site]:checked')).toHaveCount(1);
  await page.locator('#integrity-all').click();
  await expect(page.locator('#integrity-site-count')).toHaveText(`（已选 ${available.length} 个）`);
  await expect(page.locator('[name=integrity-site][value="pbc"]')).toBeChecked();
  await page.locator('#integrity-none').click();
  await expect(page.locator('[name=integrity-site]:checked')).toHaveCount(0);
  await expect(page.locator('#integrity-start')).toBeDisabled();
  expect(writes(state)).toEqual([]);
});

for (const archivedSite of ['credit-china', 'customs', 'customs-credit', 'nmpa']) test(`${archivedSite} historical selection adoption filters only new preparation and keeps old records`, async ({page}) => {
  const state = fixture(), site = INTEGRITY_SITES.find(value => value.id === archivedSite)!;
  for (const round of state.workspace.rounds) {
    round.manifest.draft.site_ids = round.manifest.draft.site_ids.map(id => id === 'credit-china' ? archivedSite : id);
    for (const record of [...round.records, ...round.manifest.records]) if (record.site_id === 'credit-china') Object.assign(record, {site_id: archivedSite, site_name: site.name, urls: site.links.map(link => link.url)});
    for (const evidence of round.evidence) if (evidence.site_id === 'credit-china') Object.assign(evidence, {site_id: archivedSite, url: site.links[0].url});
  }
  const history = historicalRounds(state);
  const expected=removeUnavailableIntegritySites(state.workspace.rounds.find(round=>round.run_id===checkId)!.manifest.draft.site_ids,state.workspace.rounds.find(round=>round.run_id===checkId)!.manifest.draft.subjects);
  await install(page, state); await page.goto(`${route}&run=${checkId}`);
  await expect(page.locator(`[data-evidence="0:${archivedSite}"]`)).toBeAttached();
  await page.locator('#integrity-use-round').click();
  await expect(page.locator('.integrity-modal[open]')).not.toContainText(site.name);
  await page.locator('#integrity-adopt-confirm').click();
  await expect(page.locator('[name=integrity-site]:checked')).toHaveCount(expected.length);
  for (const id of retired) await expect(page.locator(`[name=integrity-site][value="${id}"]`)).toHaveCount(0);
  await page.reload(); await expect(page.locator('[name=integrity-site]:checked')).toHaveCount(expected.length);
  expect(historicalRounds(state)).toEqual(history); expect(writes(state)).toEqual([]);
  // The remaining historical items only accept companies; the roster has a person.
  await page.locator('#integrity-start').click();
  await expect(page.locator('#integrity-status')).toHaveText('每个对象至少需要一个可查询的适用官网，请核对人员适用网站和企业注册地。');
  await expect(page.locator('#integrity-confirm')).toHaveCount(0);
  expect(writes(state)).toEqual([]);
});

test('retired-only selection becomes empty and cannot start a check', async ({page}) => {
  const state = fixture(); state.workspace.draft.site_ids = [...retired];
  await install(page, state); await page.goto(route);
  await expect(page.locator('#integrity-site-count')).toHaveText('（已选 0 个）');
  await expect(page.locator('#integrity-start')).toBeDisabled();
  expect(writes(state)).toEqual([]);
});


test('registration changes exclude unresolved regional scope while preserving the roster and national selection', async ({page}) => {
  const state=fixture();state.workspace.draft.site_ids=['pbc','local-csrc'];
  await install(page,state);await page.goto(route);
  await expect(page.locator('[name=integrity-site][value="local-csrc"]')).toBeChecked();
  await page.locator('[data-region][data-field="province"]').selectOption('');
  await expect(page.locator('[name=integrity-site][value="local-csrc"]')).toHaveCount(0);
  await expect(page.locator('[name=integrity-site][value="pbc"]')).toBeChecked();
  await expect(page.locator('#integrity-site-count')).toHaveText('（已选 1 个）');
  await page.locator('#integrity-save').click();
  await expect.poll(()=>state.drafts.length).toBe(1);
  expect(state.drafts[0].draft.site_ids).toEqual(['pbc']);
  expect(state.drafts[0].draft.subjects).toHaveLength(1);
});

test('adding an unresolved company updates availability without losing notes or making requests', async ({page}) => {
  const state=fixture();state.workspace.draft.site_ids=['pbc','local-csrc'];
  await install(page,state);await page.goto(route);
  await page.locator('#integrity-notes').fill('保留本轮说明');
  await page.locator('#integrity-add').click();
  await expect(page.locator('[name=integrity-site][value="local-csrc"]')).toHaveCount(0);
  await expect(page.locator('[name=integrity-site][value="pbc"]')).toBeChecked();
  await expect(page.locator('#integrity-notes')).toHaveValue('保留本轮说明');
  expect(writes(state)).toEqual([]);
});


test('a pending save keeps the exact historical scope visible and locked until its receipt is resolved', async ({page}) => {
  const state=fixture();
  const draft={...state.workspace.draft,subjects:state.workspace.draft.subjects.map(s=>({...s,province:'北京市'})),site_ids:['pbc','credit-china','local-tax']};
  await page.addInitScript(({ownerId,projectId,draft,revision})=>{
    const value={revision,draft,pending:{kind:'draft',request:{expected_revision:revision,draft}}};
    localStorage.setItem(`bb-integrity-recovery:${ownerId}:${projectId}`,JSON.stringify({version:'integrity-recovery-cache-v1',owner:ownerId,project:projectId,value}));
  },{ownerId,projectId,draft,revision:state.workspace.revision});
  await install(page,state);await page.goto(route);
  await expect(page.locator('#integrity-preparation-controls')).toHaveJSProperty('disabled',true);
  await expect(page.locator('#integrity-site-count')).toHaveText('（已选 3 个）');
  await expect(page.locator('[name=integrity-site][value="credit-china"]')).toBeChecked();
  await expect(page.locator('[name=integrity-site][value="local-tax"]')).toBeChecked();
  const cached=await page.evaluate(({ownerId,projectId})=>JSON.parse(localStorage.getItem(`bb-integrity-recovery:${ownerId}:${projectId}`)!).value,{ownerId,projectId});
  expect(cached.draft).toEqual(draft);expect(cached.pending.request.draft).toEqual(draft);
  await page.reload();
  await expect(page.locator('#integrity-site-count')).toHaveText('（已选 3 个）');
  expect(writes(state)).toEqual([]);
});
