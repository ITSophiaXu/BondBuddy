import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test} from '@playwright/test';
import {historyFixture,ids,open,readonly} from './consistency-update-history-fixtures';

// Optional same-size collector for the unchanged previous milestone served
// from its own checkout. No component is injected into that older application.
test('update history baseline: the previous milestone cannot resolve an update-only link beyond the recent thirty',async({page})=>{
  test.skip(process.env.BB_UPDATE_HISTORY_BASELINE!=='1','Run only against the unchanged previous milestone on a separate server.');
  const s=await open(page,historyFixture());
  await expect(page.locator('#fc-update-task').getByRole('heading')).toHaveText('指定的文件更新任务暂时无法读取');
  await expect(page.locator('.fc-results')).toHaveCount(0);expect(s.individualReads).toEqual([]);await readonly(page,s);
  const directory=process.env.BB_UPDATE_HISTORY_EVIDENCE_DIR??test.info().outputPath('baseline');await mkdir(directory,{recursive:true});
  await page.screenshot({path:join(directory,'update-history-baseline-missing-1440.png')});
  await writeFile(join(directory,'update-history-baseline-missing-1440.json'),JSON.stringify({synthetic:true,baseline_commit:'ce3f2a8d',viewport:{width:1440,height:960},
    url:page.url(),requested_update:ids.oldRun,recent_checks:s.recent.length,individual_reads:s.individualReads.length,writes:0},null,2));
});
