import {randomUUID} from 'node:crypto';
import {test,expect,browserApi} from './local-prelaunch-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1','Explicit dedicated local full-stack opt-in required.');
test.use({viewport:{width:1440,height:1000}});

test('browser whitespace issuer rejection retains selected values and correction creates one project',async({page,audit})=>{
  await page.goto('/#/new');
  await page.screenshot({path:audit.directory+'/creation-page.png',fullPage:true});
  await page.getByLabel('发行人全称',{exact:true}).fill('   ');
  await page.getByLabel('发行市场',{exact:true}).selectOption('sse');
  await page.getByLabel('发行方式',{exact:true}).selectOption('private');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
  await expect(page.locator('#page-error')).toContainText('请填写发行人全称');
  await expect(page.getByLabel('发行市场',{exact:true})).toHaveValue('sse');
  await expect(page.getByLabel('发行方式',{exact:true})).toHaveValue('private');
  expect(audit.checkpoint('whitespace-issuer-rejected-with-no-persistent-project').projects).toBe(audit.before.projects);
  audit.noTaskOrDebit('rejected-user-input-no-task-or-fee');
  await page.getByLabel('发行人全称',{exact:true}).fill('纯合成输入恢复 '+randomUUID().slice(0,8)+' 有限公司');
  const saving=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
  const response=await saving;expect(response.status(),await response.text()).toBe(201);const created=await response.json();
  await expect(page.locator('#project-heading')).toBeVisible();
  expect(audit.checkpoint('corrected-issuer-one-project').projects).toBe(audit.before.projects+1);
  const saved=await browserApi(page,'GET',`/api/v1/projects/${created.project_id}`);expect(saved.status).toBe(200);
  expect(saved.body.market).toBe('sse');expect(saved.body.offering).toBe('private');
  audit.noTaskOrDebit('corrected-input-does-not-start-paid-work');
});

test('browser invalid money identifies the optional section and preserves input through correction',async({page,audit})=>{
  await page.goto('/#/new');
  const issuer='纯合成金额纠错 '+randomUUID().slice(0,8)+' 有限公司';
  await page.getByLabel('发行人全称',{exact:true}).fill(issuer);
  await page.locator('[data-update-group="issuance"] summary').click();
  await page.getByLabel('申报 / 注册总额',{exact:true}).fill('not-a-number');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
  await expect(page.locator('#page-error')).toBeVisible();
  await expect(page.locator('[data-update-group="issuance"]')).toHaveAttribute('open','');
  await expect(page.getByLabel('发行人全称',{exact:true})).toHaveValue(issuer);
  await expect(page.getByLabel('申报 / 注册总额',{exact:true})).toHaveValue('not-a-number');
  expect(audit.checkpoint('bad-money-retained-with-no-persistent-project').projects).toBe(audit.before.projects);
  audit.noTaskOrDebit('bad-money-no-paid-work');
  await page.getByLabel('申报 / 注册总额',{exact:true}).fill('1.20');
  const saving=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/projects'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'创建项目，继续提供材料',exact:true}).click();
  const response=await saving;expect(response.status(),await response.text()).toBe(201);const created=await response.json();
  const saved=await browserApi(page,'GET',`/api/v1/projects/${created.project_id}`);expect(saved.status).toBe(200);
  expect(saved.body.update_details.registration_amount.value).toBe('1.20');expect(saved.body.issuer_name).toBe(issuer);
  expect(audit.checkpoint('corrected-money-one-project').projects).toBe(audit.before.projects+1);
  audit.noTaskOrDebit('saved-amount-does-not-charge');
});
