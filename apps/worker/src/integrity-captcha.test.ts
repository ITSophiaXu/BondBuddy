// Accelerated observation windows for legacy fixtures; production durations have dedicated regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { INTEGRITY_SITES } from '@bondbuddy/contracts';
import { collectInContext } from './integrity-browser.js';
import { IntegrityCaptchaInterruption } from './integrity-captcha.js';

const site = INTEGRITY_SITES.find((s) => s.id === 'credit-china')!;
const subject = {
  name: '河南验证码合成企业',
  kind: 'company' as const,
  province: '河南',
  city: '',
};
const image = (code: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><rect width="160" height="60" fill="white"/><text x="10" y="40" font-size="32">' +
      code +
      '</text></svg>',
  );
const modal =
  '<div class="vcodepop" style="position:fixed;z-index:99999;background:white;top:80px;padding:20px;display:none"><input id="vcode" placeholder="请输入验证码"><p class="errortip" style="display:none"></p><div class="vcodeimgbox"><img id="vcodeimg" src="' +
  image('A1b2') +
  '"><span>看不清? 换一张</span></div><div class="buttongroup"><a class="confirm">验证</a></div></div>';

test(
  'automatic image verification continues only to confirmed website outcomes',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 120000 },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const mode of [
        'results',
        'single_page',
        'zero',
        'open',
        'wrong_then_valid',
        'always_wrong',
        'unreadable',
        'changed',
        'expired',
        'slow',
        'slow_model',
        'pending_validation',
        'no_result_after_accept',
        'interrupted',
        'aborted',
        'slider',
        'login',
      ] as const)
        await t.test(mode, async () => {
          const context = await browser.newContext();
          let recognitions = 0;
          const submissions: string[] = [];
          const abort = new AbortController();
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/query') return route.fulfill({ body: 'queried' });
            if (url.pathname === '/verify') {
              const code = url.searchParams.get('code')!;
              submissions.push(code);
              if (mode === 'pending_validation') return;
              if (mode === 'slow') await new Promise((r) => setTimeout(r, 500));
              return route.fulfill({
                body:
                  mode !== 'always_wrong' &&
                  code ===
                    (mode === 'wrong_then_valid' || mode === 'changed' || mode === 'expired'
                      ? 'C3d4'
                      : 'A1b2')
                    ? 'accepted'
                    : 'rejected',
              });
            }
            const entity =
              '<ul id="companylists"><li class="company-item"><p class="company-name">' +
              subject.name +
              '</p><p class="company-messages">统一社会信用代码：123456789012345678 主体类型：企业法人</p></li></ul>';
            const script = [
              'let accepted=false;const popup=document.querySelector(".vcodepop"),err=document.querySelector(".errortip"),main=document.querySelector("main");',
              'const show=()=>{popup.style.display="block";' +
                (mode === 'expired'
                  ? 'err.textContent="验证码已失效";err.style.display="block";'
                  : '') +
                '};',
              'document.querySelector(".vcodeimgbox span").onclick=()=>{document.querySelector("#vcodeimg").src=' +
                JSON.stringify(image('C3d4')) +
                ';err.style.display="none";};',
              mode === 'single_page'
                ? 'const results=()=>{main.innerHTML=' + JSON.stringify(entity) + ';};'
                : 'const results=()=>{main.textContent=document.querySelector("#search_input").value+' +
                  JSON.stringify(
                    mode === 'zero'
                      ? ' 共0条'
                      : mode === 'no_result_after_accept'
                        ? ' 加载中'
                        : ' 共1条 企业主体信息',
                  ) +
                  ';};',
              'document.querySelector("#search").onclick=async()=>{await fetch("/query?q="+encodeURIComponent(document.querySelector("#search_input").value));if(accepted)results();else show();};',
              'document.querySelector(".confirm").onclick=async()=>{const answer=await (await fetch("/verify?code="+encodeURIComponent(document.querySelector("#vcode").value))).text();if(answer==="accepted"){accepted=true;popup.style.display="none";' +
                (mode === 'open' ? '' : 'results();') +
                '}else{err.textContent="验证码错误";err.style.display="block";}};',
              mode === 'open' ? 'show();' : '',
            ].join('\n');
            const gate =
              mode === 'slider'
                ? '<p>请完成滑块验证，向右滑动</p>'
                : mode === 'login'
                  ? '<input type="password"><p>请先登录</p>'
                  : '';
            await route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body:
                '<!doctype html><meta charset="utf-8"><body><input id="search_input" placeholder="企业名称"><button id="search">搜索</button><main>请输入企业名称</main>' +
                gate +
                modal +
                '<script>' +
                script +
                '</script>',
            });
          });
          try {
            const options = {
              resultStableMs: 150,
              zeroConfirmMs: 300,
              waitMs:
                mode === 'slow_model'
                  ? 2000
                  : mode === 'pending_validation'
                    ? 1500
                    : mode === 'no_result_after_accept'
                      ? 3500
                      : 9000,
              maxPages: 1,
              attempts: 1,
              screenCapture: async () => Buffer.from('synthetic screenshot'),
              captchaRecognizer: async (input: { png: Buffer; sha256: string }) => {
                recognitions++;
                if (mode === 'slow_model') await new Promise((r) => setTimeout(r, 2500));
                assert.ok(input.png.length > 100);
                assert.equal(input.sha256.length, 64);
                if (mode === 'interrupted')
                  throw new IntegrityCaptchaInterruption({
                    kind: 'pause',
                    stage: 'provider_reconcile',
                    reason: 'provider_result_pending',
                  });
                if (mode === 'aborted') {
                  abort.abort();
                  abort.signal.throwIfAborted();
                }
                if (mode === 'changed' && recognitions === 1) {
                  await context
                    .pages()[0]
                    .locator('#vcodeimg')
                    .evaluate((e, src) => ((e as HTMLImageElement).src = src), image('C3d4'));
                  return 'A1b2';
                }
                if (mode === 'unreadable') return null;
                if (mode === 'always_wrong' || (mode === 'wrong_then_valid' && recognitions === 1))
                  return 'BAD0';
                return mode === 'wrong_then_valid' || mode === 'changed' || mode === 'expired'
                  ? 'C3d4'
                  : 'A1b2';
              },
            };
            const work = collectInContext(
              context,
              {
                ...site,
                links: [
                  {
                    ...site.links[0],
                    url: 'https://www.creditchina.gov.cn/xinyongxinxi/index.html',
                  },
                ],
              },
              subject,
              abort.signal,
              options,
            );
            if (mode === 'interrupted') {
              await assert.rejects(work, IntegrityCaptchaInterruption);
              assert.equal(submissions.length, 0);
              return;
            }
            if (mode === 'aborted') {
              await assert.rejects(work, { name: 'AbortError' });
              assert.equal(submissions.length, 0);
              return;
            }
            const result = await work;
            if (
              ['always_wrong', 'unreadable', 'pending_validation', 'slider', 'login'].includes(mode)
            ) {
              assert.equal(result.outcome, 'blocked');
              assert.equal(
                result.captures.some((c) => c.kind === 'result'),
                false,
              );
              assert.equal(
                recognitions,
                mode === 'slider' || mode === 'login' ? 0 : mode === 'pending_validation' ? 1 : 2,
              );
              assert.equal(
                submissions.length,
                mode === 'always_wrong' ? 2 : mode === 'pending_validation' ? 1 : 0,
              );
              assert.equal(
                result.diagnostic?.code,
                mode === 'login' ? 'login_required' : 'captcha_required',
              );
            } else if (mode === 'no_result_after_accept') {
              assert.equal(result.outcome, 'unverified');
              assert.equal(
                result.captures.some((c) => c.kind === 'result'),
                false,
              );
            } else {
              assert.equal(result.outcome, mode === 'zero' ? 'no_results' : 'results');
              assert.equal(result.search_performed, true);
              assert.equal(result.captures[0]?.kind, 'result');
              assert.doesNotMatch(result.captures[0]?.text ?? '', /请输入验证码/);
              assert.deepEqual(
                submissions,
                mode === 'wrong_then_valid'
                  ? ['BAD0', 'C3d4']
                  : mode === 'changed' || mode === 'expired'
                    ? ['C3d4']
                    : ['A1b2'],
              );
            }
          } finally {
            await context.close();
          }
        });
    } finally {
      await browser.close();
    }
  },
);
