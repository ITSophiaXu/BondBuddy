// Accelerated observation windows for legacy fixtures; production durations have dedicated regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { INTEGRITY_SITES } from '@bondbuddy/contracts';
import { collectInContext } from './integrity-browser.js';
import { creditChinaVerification } from './integrity-browser-page.js';

const site = INTEGRITY_SITES.find((s) => s.id === 'credit-china')!;
const subject = { name: '河南合成测试企业', kind: 'company' as const, province: '河南', city: '' };
// Structure observed in the official search modal on 2026-10-27; all data is synthetic.
const modal =
  '<div class="vcodepop" style="position:fixed;z-index:99999;background:white;top:80px;padding:20px"><div class="vcodeinputbox"><input id="vcode" placeholder="请输入验证码"><p>验证码已失效，请重新申请验证码</p></div><div class="vcodeimgbox"><img id="vcodeimg" width="80" height="30" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><span>看不清? 换一张</span></div><div class="buttongroup"><a class="cancel">取消</a><a class="confirm">验证</a></div></div>';
const form =
  '<input id="search_input" placeholder="企业名称"><button id="submit">搜索</button><main>请输入企业名称</main>';
const html = (body: string) =>
  '<!doctype html><meta charset="utf-8"><title>合成信用查询</title><body>' + body + '</body>';

test(
  'Credit China verification is detected while unrelated resources are incomplete',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 60000 },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const phase of ['open', 'results'] as const)
        for (const resource of ['pending-script', 'failed-style'] as const)
          await t.test(phase + ' / ' + resource, async () => {
            const context = await browser.newContext();
            let attempts = 0,
              verifications = 0;
            await context.route('**/*', async (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === '/slow.js') return; // A stalled deferred resource never completes DOMContentLoaded.
              if (path === '/broken.css') return route.fulfill({ status: 503, body: '' });
              if (path === '/verify') {
                verifications++;
                return route.fulfill({ body: 'must not submit' });
              }
              if (path === '/query') attempts++;
              const assets =
                resource === 'pending-script'
                  ? '<script defer src="/slow.js"></script>'
                  : '<link rel="stylesheet" href="/broken.css">';
              const challenge = html(
                modal +
                  '<script>document.querySelector(".confirm").onclick=()=>fetch("/verify");</script>' +
                  assets,
              );
              const search = html(
                form +
                  '<script>document.querySelector("#submit").onclick=()=>location.href="/query?q="+encodeURIComponent(document.querySelector("input").value);</script>',
              );
              return route.fulfill({
                contentType: 'text/html; charset=utf-8',
                body: phase === 'open' || path === '/query' ? challenge : search,
              });
            });
            try {
              const start = Date.now();
              const result = await collectInContext(
                context,
                site,
                subject,
                new AbortController().signal,
                {
                  resultStableMs: 150,
                  zeroConfirmMs: 300,
                  waitMs: 12000,
                  attempts: 2,
                  maxPages: 1,
                  screenCapture: async () => Buffer.from('synthetic screenshot'),
                },
              );
              assert.equal(result.outcome, 'blocked');
              assert.equal(result.diagnostic?.code, 'captcha_required');
              assert.equal(result.diagnostic?.phase, phase);
              assert.equal(result.diagnostic?.attempts, 1);
              assert.equal(result.search_performed, phase === 'results');
              assert.equal(attempts, phase === 'results' ? 1 : 0);
              assert.ok(
                Date.now() - start < 9000,
                'must recognize the visible gate before its loading timeout',
              );
              assert.equal(result.captures[0]?.kind, 'blocker');
              assert.equal(verifications, 0);
              assert.doesNotMatch(result.reason, /补充信息后|上传补充证据|HTTP|503/);
            } finally {
              await context.close();
            }
          });
      for (const phase of ['open', 'results'] as const)
        await t.test(
          'a stalled document without verification remains a loading timeout / ' + phase,
          async () => {
            const context = await browser.newContext();
            await context.route('**/*', (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === '/slow.js') return;
              const body =
                phase === 'open' || path === '/query'
                  ? form + '<script defer src="/slow.js"></script>'
                  : form +
                    '<script>document.querySelector("#submit").onclick=()=>location.href="/query?q="+encodeURIComponent(document.querySelector("input").value);</script>';
              return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(body) });
            });
            try {
              const result = await collectInContext(
                context,
                site,
                subject,
                new AbortController().signal,
                {
                  resultStableMs: 150,
                  zeroConfirmMs: 300,
                  waitMs: 1200,
                  attempts: 1,
                  maxPages: 1,
                  screenCapture: async () => Buffer.from('synthetic screenshot'),
                },
              );
              assert.equal(result.outcome, 'unverified');
              assert.equal(
                result.diagnostic?.code,
                phase === 'open' ? 'page_load_timeout' : 'result_load_timeout',
              );
              assert.equal(
                result.captures.some((c) => c.kind === 'result'),
                false,
              );
            } finally {
              await context.close();
            }
          },
        );
      await t.test(
        'hidden, unstyled and foreign lookalikes cannot override loading diagnostics',
        async () => {
          for (const [url, markup] of [
            [
              'https://www.creditchina.gov.cn/',
              modal.replace('position:fixed;', 'display:none;position:fixed;'),
            ],
            ['https://www.creditchina.gov.cn/', modal.replace('position:fixed;z-index:99999;', '')],
            ['https://unrelated.example/', modal],
          ]) {
            const context = await browser.newContext();
            await context.route('**/*', (route) =>
              route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(markup) }),
            );
            try {
              const page = await context.newPage();
              await page.goto(url);
              assert.equal(await creditChinaVerification(page), false);
            } finally {
              await context.close();
            }
          }
        },
      );
      await t.test(
        'captcha appearing during the screenshot cannot become a successful result',
        async () => {
          const context = await browser.newContext();
          await context.route('**/*', (route) =>
            route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body:
                new URL(route.request().url()).pathname === '/query'
                  ? 'ok'
                  : html(
                      form +
                        '<script>document.querySelector("#submit").onclick=async()=>{const q=document.querySelector("input").value;await fetch("/query?q="+encodeURIComponent(q));document.querySelector("main").textContent=q+" 共0条";};</script>',
                    ),
            }),
          );
          try {
            const result = await collectInContext(
              context,
              site,
              subject,
              new AbortController().signal,
              {
                resultStableMs: 150,
                zeroConfirmMs: 300,
                waitMs: 6000,
                attempts: 1,
                maxPages: 1,
                screenCapture: async (page) => {
                  await page
                    .locator('body')
                    .evaluate(
                      (body, markup) => body.insertAdjacentHTML('beforeend', markup),
                      modal,
                    );
                  return Buffer.from('synthetic screenshot');
                },
              },
            );
            assert.equal(result.outcome, 'blocked');
            assert.equal(result.diagnostic?.code, 'captcha_required');
            assert.equal(
              result.captures.some((c) => c.kind === 'result'),
              false,
            );
          } finally {
            await context.close();
          }
        },
      );
    } finally {
      await browser.close();
    }
  },
);
