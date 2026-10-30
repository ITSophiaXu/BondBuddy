import {test,expect} from '@playwright/test';

for(const enabled of [false,true])test(`recovery help stays reachable after failed login; enabled=${enabled}`,async({page})=>{
  let unavailable=true;
  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/auth/recovery/info'))return unavailable?route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE'}}):route.fulfill({json:{enabled,support_contact:enabled?'合成客服渠道':null,link_minutes:30}});
    return route.fulfill({status:401,json:{code:'UNAUTHENTICATED'}});
  });
  await page.goto('/');
  await page.getByLabel('用户名').fill('synthetic_ux');await page.getByLabel('密码').fill('Synthetic-password-123');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  const help=page.getByRole('link',{name:'忘记密码？查看找回方式'});await help.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'重新读取找回方式'})).toBeVisible();
  await expect(page.locator('main')).toContainText('注册新账号不会恢复原账号项目');
  unavailable=false;await page.getByRole('button',{name:'重新读取找回方式'}).click();
  if(enabled){await expect(page.getByLabel('账号用户名')).toBeVisible();await expect(page.locator('main')).toContainText('合成客服渠道');}
  else{await expect(page.locator('main')).toContainText('当前无法在线重置密码');await expect(page.locator('#recovery-request-form')).toHaveCount(0);}
  await page.getByRole('link',{name:'返回登录'}).click();await expect(help).toBeVisible();
});
