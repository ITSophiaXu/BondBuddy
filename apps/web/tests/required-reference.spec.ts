import {expect, test} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {fixture, install, projectId, sourceDeclaration, expectNoExecution, assertFixture, sha256, now} from './authoring-source-guide-fixtures';

test.afterEach(async ({page}) => { await assertFixture(page); });

test('financial materials alone cannot start; a saved source with complete information enables starting', async ({page}) => {
  const s = fixture(), originalMaterials = s.materials;
  s.materials = s.materials.filter(m => m.role === 'audit');
  s.project.update_details!.source_prospectuses = [];
  await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#workspace-material-count')).toContainText('1 份已保存材料');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toContainText('请先上传并采用一份历史／参考募集书');
  await page.locator('#execute-input').dispatchEvent('click');
  expectNoExecution(s); expect(s.locked).toEqual([]);
  s.materials = originalMaterials;
  await page.reload();
  await expect(page.locator('#start-disabled-reason')).toContainText('请补齐');
  await expect(page.locator('#execute-input')).toBeDisabled();
  s.project.update_details!.source_prospectuses = s.materials.filter(m => ['historical','reference'].includes(m.role)).map(m => sourceDeclaration(m));
  await page.reload();
  await expect(page.locator('#execute-input')).toBeEnabled();
  expectNoExecution(s); expect(s.locked).toEqual([]);
});

test('a verified previous result can be continued without uploading another source', async ({page}) => {
  const s = fixture();
  s.materials = s.materials.filter(m => m.role === 'audit');
  s.project.update_details!.source_prospectuses = [];
  s.prospectusVersions = {project_id: projectId, current_version_id: 'synthetic-guide-generated', selection_revision: 3, inactive_material_ids: [], versions: [{
    version_id: 'synthetic-guide-generated', sequence: 1, origin: 'generated', filename: '合成上一轮募集书.docx', sha256: sha256('synthetic-generated-result'),
    created_at: now, material_id: null, material_version: null, artifact_id: 'synthetic-guide-artifact', artifact_version: 1, revision_artifact_id: null, run_id: 'synthetic-guide-run'}]};
  await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('[data-prospectus-heading]')).toHaveText('历史／参考募集书（必填）');
  await expect(page.locator('#execute-input')).toBeEnabled();
  await expect(page.locator('#start-disabled-reason')).toBeEmpty();
  expectNoExecution(s);
});

test('source information precedes financial materials and redundant preparation actions are absent', async ({page}) => {
  const s = fixture();
  await install(page, s);
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('[data-prospectus-heading]')).toHaveText('历史／参考募集书（必填）');
  await expect(page.locator('#material-partitions > section').first()).toContainText('原稿信息与格式');
  await expect(page.locator('#material-partitions > section').nth(1)).toContainText('审计报告 / 财务报表及附注');
  await expect(page.locator('[data-authoring-preparation-guide]')).toBeHidden();
  await expect(page.locator('[data-authoring-requirements],[data-prospectus-skip]')).toHaveCount(0);
  await expect(page.locator('#project-message')).toBeAttached();
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    const upload = await page.locator('#prospectus-panel').boundingBox();
    const source = await page.locator('#material-partitions > section').first().boundingBox();
    const financial = await page.locator('#material-partitions > section').nth(1).boundingBox();
    expect(source!.y).toBeGreaterThanOrEqual(upload!.y + upload!.height);
    expect(financial!.y).toBeGreaterThanOrEqual(source!.y + source!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.BB_REQUIRED_REFERENCE_EVIDENCE) {
      await mkdir(process.env.BB_REQUIRED_REFERENCE_EVIDENCE, {recursive:true});
      await page.screenshot({path:`${process.env.BB_REQUIRED_REFERENCE_EVIDENCE}/workspace-${width}.png`,fullPage:true});
    }
  }
  expectNoExecution(s);
});
