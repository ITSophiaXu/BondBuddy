import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test} from '@playwright/test';
import {assertFixture,base,checkId,checkRoute,fixture,install,replaceSource,writeCalls} from './consistency-originals-fixtures';

// This optional collector is only for the unchanged published baseline served
// from its own checkout. It records the actual missing-record UI at 1440x960;
// it does not patch an older component into the current application.
test('consistency history baseline: published recent-thirty-only UI cannot display the linked older record',async({page})=>{
  test.skip(process.env.BB_CONSISTENCY_HISTORY_BASELINE!=='1','Only run against the unchanged published baseline with its dedicated server.');
  const s=fixture({historical:true});replaceSource(s);s.check.created_at='2026-09-01T01:00:00Z';
  const recent=Array.from({length:30},(_,index)=>{
    const check=structuredClone(s.check);check.run_id='synthetic-history-recent-'+index;
    check.created_at=new Date(Date.UTC(2026,9,25,12,index)).toISOString();check.source=structuredClone(s.source);check.stale=false;
    check.files.forEach(file=>{file.filename='近期检查'+index+'_'+file.filename;});
    check.result!.files.forEach(file=>file.findings.forEach(item=>{item.reason='合成最近30轮说明 '+index;}));return check;
  });
  s.checks=[...recent,s.check];await page.setViewportSize({width:1440,height:960});await install(page,s);
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);
    if(request.method()!=='GET'||path!==base+'/project-files/checks')return route.fallback();
    s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});return route.fulfill({status:200,json:{checks:recent}});
  });
  await page.goto(checkRoute());
  const heading=page.getByRole('heading',{name:'指定的检查记录暂时无法读取',exact:true});await expect(heading).toBeVisible();
  await expect(page.locator('.fc-results')).toHaveCount(0);await expect(page.locator('#fc-history option')).toHaveCount(31);
  expect(s.calls.some(call=>call.path===base+'/project-files/checks/'+checkId)).toBe(false);
  expect(writeCalls(s)).toEqual([]);assertFixture(s);
  const directory=process.env.BB_CONSISTENCY_HISTORY_EVIDENCE_DIR??test.info().outputPath('baseline');await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,'history-baseline-missing-1440.png')});
  await writeFile(join(directory,'history-baseline-missing-1440.json'),JSON.stringify({synthetic:true,baseline_commit:'8c81e8f1032ba5e23657eb32a43d9dfd0c9612fe',viewport:{width:1440,height:960},url:page.url(),linked_check:checkId,recent_checks:recent.length,heading:await heading.textContent(),writes:writeCalls(s)},null,2));
});
