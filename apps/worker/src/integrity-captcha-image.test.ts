import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { INTEGRITY_SITES, integrityDiagnosticLabel } from '@bondbuddy/contracts';
import { collectInContext } from './integrity-browser.js';
import { observeCaptchaImages, readCaptchaImage } from './integrity-captcha-image.js';

const site = INTEGRITY_SITES.find((s) => s.id === 'credit-china')!;
const subject = {
  name: '河南图片加载合成企业',
  kind: 'company' as const,
  province: '河南',
  city: '',
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="5" y="30" font-size="24">A1b2</text></svg>';
const modes = [
  'slow_image',
  'refresh_recovers',
  'reload_recovers',
  'persistent_broken',
  'pending_image',
  'forbidden',
  'rate_limited',
  'delayed_refresh',
  'same_url_refresh',
  'refresh_unchanged',
  'broken_during_model',
  'abort_loading',
  'text_only_broken',
] as const;

test(
  'captcha image loading recovers within bounds and never spends recognition on broken or stale pixels',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 120000 },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const mode of modes)
        await t.test(mode, async () => {
          const context = await browser.newContext(),
            abort = new AbortController();
          let documents = 0,
            imageRequests = 0,
            recognitions = 0,
            refreshes = 0;
          const submissions: string[] = [];
          await context.route('**/*', async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (url.pathname === '/query') return route.fulfill({ body: 'queried' });
            if (url.pathname === '/refresh') {
              refreshes++;
              return route.fulfill({ body: 'ok' });
            }
            if (url.pathname === '/verify') {
              const code = url.searchParams.get('code')!;
              submissions.push(code);
              return route.fulfill({ body: code === 'A1b2' ? 'accepted' : 'rejected' });
            }
            if (url.pathname === '/captcha.svg') {
              imageRequests++;
              if (mode === 'pending_image' || mode === 'abort_loading') return;
              if (mode === 'slow_image') await new Promise((r) => setTimeout(r, 5500));
              if (mode === 'forbidden' || mode === 'rate_limited')
                return route.fulfill({
                  status: mode === 'forbidden' ? 403 : 429,
                  body: 'unavailable',
                });
              const broken =
                mode === 'persistent_broken' ||
                mode === 'text_only_broken' ||
                (mode === 'refresh_recovers' && imageRequests === 1) ||
                (mode === 'reload_recovers' && documents === 1) ||
                (mode === 'broken_during_model' && imageRequests > 1);
              return route.fulfill(
                broken
                  ? { status: 503, body: 'unavailable' }
                  : {
                      contentType: 'image/svg+xml',
                      headers: { 'cache-control': 'no-store' },
                      body: svg,
                    },
              );
            }
            documents++;
            const change =
              mode === 'refresh_unchanged'
                ? ''
                : mode === 'same_url_refresh'
                  ? 'img.removeAttribute("src");requestAnimationFrame(()=>{img.src="/captcha.svg";});'
                  : 'img.src="/captcha.svg?n="+(++version);';
            const script = [
              'let version=1;const popup=document.querySelector(".vcodepop"),img=document.querySelector("#vcodeimg"),err=document.querySelector(".errortip");',
              'document.querySelector("#search").onclick=async()=>{await fetch("/query?q="+encodeURIComponent(document.querySelector("#search_input").value));popup.style.display="block";};',
              'document.querySelector(".vcodeimgbox span").onclick=()=>{fetch("/refresh");setTimeout(()=>{' +
                change +
                'err.style.display="none";},' +
                (mode === 'delayed_refresh' ? 700 : 0) +
                ');};',
              'document.querySelector(".confirm").onclick=async()=>{const r=await(await fetch("/verify?code="+document.querySelector("#vcode").value)).text();if(r==="accepted"){popup.style.display="none";document.querySelector("main").textContent=document.querySelector("#search_input").value+" 共1条 企业主体信息";}else{err.style.display="block";err.textContent="验证码错误";}};',
            ].join('\n');
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body:
                '<!doctype html><meta charset="utf-8"><input id="search_input" placeholder="企业名称"><button id="search">搜索</button><main>请输入企业名称</main><div class="vcodepop" style="display:none;position:fixed;z-index:99999;background:white;top:80px;padding:20px"><input id="vcode" placeholder="请输入验证码"><p class="errortip" style="display:none"></p><div class="vcodeimgbox"><img id="vcodeimg" width="120" height="40" src="/captcha.svg"><span>看不清? 换一张</span></div><div class="buttongroup"><a class="confirm">验证</a></div></div><script>' +
                script +
                '</script>',
            });
          });
          let abortTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const recognize = async () => {
              recognitions++;
              if (
                ['delayed_refresh', 'same_url_refresh', 'refresh_unchanged'].includes(mode) &&
                recognitions === 1
              )
                return 'BAD0';
              if (mode === 'broken_during_model') {
                const page = context.pages()[0];
                await page
                  .locator('#vcodeimg')
                  .evaluate((e) => ((e as HTMLImageElement).src = '/captcha.svg?n=2'));
                await page.waitForFunction(() => {
                  const i = document.querySelector('#vcodeimg') as HTMLImageElement;
                  return i.complete && i.naturalWidth === 0;
                });
              }
              if (['delayed_refresh', 'same_url_refresh'].includes(mode))
                assert.equal(
                  imageRequests,
                  2,
                  'must wait for a fresh image request, even with identical pixels',
                );
              return 'A1b2';
            };
            if (mode === 'abort_loading') abortTimer = setTimeout(() => abort.abort(), 1500);
            const waitMs =
              mode === 'slow_image'
                ? 7000
                : ['pending_image', 'refresh_unchanged'].includes(mode)
                  ? 1000
                  : 5000;
            const resultPromise = collectInContext(
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
              {
                waitMs,
                maxPages: 1,
                attempts: mode === 'broken_during_model' || mode === 'refresh_unchanged' ? 1 : 2,
                screenCapture: async () => Buffer.from('synthetic screenshot'),
                ...(mode === 'text_only_broken' ? {} : { captchaRecognizer: recognize }),
              },
            );
            if (mode === 'abort_loading') {
              await assert.rejects(resultPromise, { name: 'AbortError' });
              assert.equal(recognitions, 0);
              assert.equal(submissions.length, 0);
              return;
            }
            const result = await resultPromise;
            if (
              [
                'slow_image',
                'refresh_recovers',
                'reload_recovers',
                'delayed_refresh',
                'same_url_refresh',
              ].includes(mode)
            ) {
              assert.equal(result.outcome, 'results');
              assert.equal(result.search_performed, true);
              assert.deepEqual(
                submissions,
                ['delayed_refresh', 'same_url_refresh'].includes(mode)
                  ? ['BAD0', 'A1b2']
                  : ['A1b2'],
              );
              assert.equal(recognitions, submissions.length);
              assert.equal(result.captures[0]?.kind, 'result');
              if (mode === 'slow_image')
                assert.equal(
                  refreshes,
                  0,
                  'a slow but valid image must not be needlessly replaced',
                );
              if (mode === 'reload_recovers') {
                assert.equal(documents, 2);
                assert.equal(refreshes, 1);
              }
            } else {
              assert.equal(result.diagnostic?.code, 'captcha_required');
              assert.equal(
                result.captures.some((c) => c.kind === 'result'),
                false,
              );
              const detail =
                mode === 'forbidden'
                  ? 'CAPTCHA_IMAGE_ACCESS_DENIED'
                  : mode === 'rate_limited'
                    ? 'CAPTCHA_IMAGE_RATE_LIMITED'
                    : mode === 'pending_image'
                      ? 'CAPTCHA_IMAGE_LOAD_TIMEOUT'
                      : mode === 'refresh_unchanged'
                        ? 'CAPTCHA_IMAGE_REFRESH_FAILED'
                        : 'CAPTCHA_IMAGE_LOAD_FAILED';
              assert.equal(result.diagnostic?.detail, detail);
              assert.match(
                integrityDiagnosticLabel(result.diagnostic!),
                /验证码|网站拒绝访问|网站限制访问频率/,
              );
              assert.doesNotMatch(result.reason, /已尝试自动验证|HTTP|403|503|Forbidden/);
              if (mode === 'refresh_unchanged') {
                assert.deepEqual(submissions, ['BAD0']);
                assert.equal(recognitions, 1);
              } else {
                assert.equal(submissions.length, 0);
                assert.equal(recognitions, mode === 'broken_during_model' ? 1 : 0);
              }
              if (mode === 'forbidden' || mode === 'rate_limited') {
                assert.equal(documents, 1);
                assert.equal(refreshes, 0);
                assert.equal(result.diagnostic?.http_status, mode === 'rate_limited' ? 429 : 403);
              }
              if (mode === 'persistent_broken' || mode === 'text_only_broken') {
                assert.equal(documents, 2);
                assert.equal(imageRequests, 3);
                assert.equal(refreshes, 1);
                assert.equal(result.diagnostic?.http_status, 503);
              }
            }
          } finally {
            if (abortTimer) clearTimeout(abortTimer);
            await context.close();
          }
        });
    } finally {
      await browser.close();
    }
  },
);

test(
  'captcha image denial after a redirect is attributed to the original image',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 15000 },
  async (t) => {
    let redirectedRequests = 0;
    // Use real local responses: routing only intercepts the initial redirect URL,
    // and a synthetic public-to-loopback redirect is blocked by browser policy.
    const server = createServer((request, response) => {
      if (request.url === '/captcha.svg') {
        response.writeHead(302, { location: '/captcha-denied.svg' });
        response.end();
      } else if (request.url === '/captcha-denied.svg') {
        redirectedRequests++;
        response.writeHead(403);
        response.end('unavailable');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<div class="vcodepop"><img id="vcodeimg" width="120" height="40" src="/captcha.svg"></div>',
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext(),
        images = observeCaptchaImages(context),
        page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${address.port}/`);
        const controls = {
          frame: page.mainFrame(),
          popup: page.locator('.vcodepop'),
          image: page.locator('#vcodeimg'),
          input: page.locator('#vcode'),
          submit: page.locator('.confirm'),
          refresh: page.locator('.refresh'),
          error: page.locator('.errortip'),
        };
        const result = await readCaptchaImage(controls, images, new AbortController().signal, 2000);
        assert.equal(redirectedRequests, 1);
        assert.equal(result.status, 'image_failed');
        if (result.status !== 'image_failed')
          throw new Error('Expected the final response to be rejected');
        assert.equal(result.detail, 'CAPTCHA_IMAGE_ACCESS_DENIED');
        assert.equal(result.http_status, 403);
        assert.equal(result.retryable, false);
        assert.equal(result.version.src, `http://127.0.0.1:${address.port}/captcha.svg`);
      } finally {
        images.close();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
);
