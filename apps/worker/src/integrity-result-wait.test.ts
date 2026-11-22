import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { collectInContext } from './integrity-browser.js';
import { integrityResponseCount } from './integrity-query-readiness.js';

const site = {
  id: 'tax',
  name: '合成官网',
  topic: '合成测试',
  group: 'test',
  links: [{ label: '合成官网', url: 'https://www.chinatax.gov.cn/' }],
};
const subject = {
  name: '截图等待合成测试企业',
  kind: 'company' as const,
  province: '北京',
  city: '',
};
const html = (body: string, script = '') =>
  `<!doctype html><meta charset="utf-8"><body>${body}<script>${script}</script>`;
const form = '<input type="search"><button>搜索</button><main>请输入查询词</main>';
const navigation =
  "document.querySelector('button').onclick=()=>location.href='/search?q='+encodeURIComponent(document.querySelector('input').value);";
const fast = { waitMs: 6000, maxPages: 1, attempts: 1, resultStableMs: 150, zeroConfirmMs: 300 };
const run = (
  context: BrowserContext,
  options: Partial<Parameters<typeof collectInContext>[4]> = {},
) =>
  collectInContext(context, site, subject, new AbortController().signal, { ...fast, ...options });

test('JSON zero evidence rejects error envelopes, conflicting totals and unknown objects', () => {
  for (const data of [{ total: 0 }, { data: { totalCount: '0', rows: [] } }, []])
    assert.equal(integrityResponseCount(data).count, 0);
  for (const data of [{ total: 1 }, { data: { items: [{ name: 'synthetic' }] } }, [{ id: 1 }]])
    assert.equal(integrityResponseCount(data).count, 1);
  for (const data of [
    { success: false, total: 0 },
    { code: 500, total: 0 },
    { total: 0, items: [{}] },
    { total: 0, data: { total: 1 } },
  ])
    assert.equal(integrityResponseCount(data).invalid, true);
  for (const data of [{}, { status: 'ok' }, { total: -1 }, { total: 'unknown' }])
    assert.equal(integrityResponseCount(data).count, undefined);
});

test(
  'result capture waits for complete query evidence',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 180000 },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const delayMs of [6000, 30000])
        await t.test(
          `unmarked placeholder zero with ${delayMs / 1000}s API returns the final hit`,
          async () => {
            const context = await browser.newContext();
            let completed = 0,
              captured = 0;
            await context.route('**/*', async (route) => {
              const path = new URL(route.request().url()).pathname;
              if (path === '/api') {
                await new Promise((r) => setTimeout(r, delayMs));
                completed = Date.now();
                return route.fulfill({ contentType: 'application/json', body: '{"total":1}' });
              }
              return route.fulfill({
                contentType: 'text/html',
                body:
                  path === '/search'
                    ? html(
                        '<main>共0条</main>',
                        "fetch('/api?q='+encodeURIComponent(new URL(location.href).searchParams.get('q'))).then(r=>r.json()).then(d=>document.querySelector('main').textContent='共'+d.total+'条');",
                      )
                    : html(form, navigation),
              });
            });
            try {
              // Use the production observation windows, not accelerated fixture timings.
              const result = await run(context, {
                waitMs: 60000,
                resultStableMs: undefined,
                zeroConfirmMs: undefined,
                screenCapture: async (page) => {
                  captured = Date.now();
                  return page.screenshot();
                },
              });
              assert.equal(result.outcome, 'results');
              assert.match(result.captures[0].text, /共1条/);
              assert.ok(completed > 0 && captured - completed >= 2000);
              assert.equal(result.captures.length, 1);
            } finally {
              await context.close();
            }
          },
        );
      await t.test(
        'real zero gets the full 2s stability plus 5s confirmation; telemetry cannot stall it',
        async () => {
          const context = await browser.newContext();
          let completed = 0,
            captured = 0;
          await context.route('**/*', (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === '/telemetry') return;
            if (path === '/api') {
              completed = Date.now();
              return route.fulfill({ contentType: 'application/json', body: '{"total":0}' });
            }
            return route.fulfill({
              contentType: 'text/html',
              body: html(
                form,
                "document.querySelector('button').onclick=async()=>{const q=document.querySelector('input').value;await fetch('/api?q='+encodeURIComponent(q));document.querySelector('main').textContent='共0条';fetch('/telemetry?q='+encodeURIComponent(q));};",
              ),
            });
          });
          try {
            const r = await run(context, {
              waitMs: 15000,
              resultStableMs: undefined,
              zeroConfirmMs: undefined,
              screenCapture: async (page) => {
                captured = Date.now();
                return page.screenshot();
              },
            });
            assert.equal(r.outcome, 'no_results');
            assert.ok(captured - completed >= 7000);
            assert.equal(r.timing?.result_stable_ms, 2000);
            assert.equal(r.timing?.zero_confirm_ms, 5000);
            assert.ok(
              Date.parse(r.timing!.captured_at!) - Date.parse(r.timing!.response_completed_at!) >=
                7000,
            );
          } finally {
            await context.close();
          }
        },
      );
      await t.test(
        'an unchanged zero needs explicit API zero, not merely a successful unrelated body',
        async () => {
          for (const explicit of [true, false]) {
            const context = await browser.newContext();
            await context.route('**/*', (route) =>
              new URL(route.request().url()).pathname === '/api'
                ? route.fulfill(
                    explicit
                      ? { contentType: 'application/json', body: '{"total":0}' }
                      : { body: 'query accepted' },
                  )
                : route.fulfill({
                    contentType: 'text/html',
                    body: html(
                      form.replace('请输入查询词', '共0条'),
                      "document.querySelector('button').onclick=()=>fetch('/api?q='+encodeURIComponent(document.querySelector('input').value));",
                    ),
                  }),
            );
            try {
              const r = await run(context, { waitMs: 3000 });
              assert.equal(r.outcome, explicit ? 'no_results' : 'unverified');
            } finally {
              await context.close();
            }
          }
        },
      );
      for (const mode of [
        'token',
        'late-request',
        'failed',
        'pending',
        'unknown-json',
        'contradicting-json',
        'business-error',
      ] as const)
        await t.test(mode, async () => {
          const context = await browser.newContext();
          let queries = 0;
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url()),
              path = url.pathname;
            if (path === '/api') {
              queries++;
              if (mode === 'pending') return;
              if (mode === 'failed') return route.abort('connectionreset');
              if (mode === 'token') await new Promise((r) => setTimeout(r, 2300));
              const body =
                mode === 'unknown-json'
                  ? '{"ok":true}'
                  : mode === 'business-error'
                    ? '{"success":false,"total":0}'
                    : mode === 'contradicting-json' ||
                        mode === 'token' ||
                        (mode === 'late-request' && queries > 1)
                      ? '{"total":1}'
                      : '{"total":0}';
              return route.fulfill({ contentType: 'application/json', body });
            }
            const query =
              mode === 'token'
                ? "'/api?token=synthetic'"
                : "'/api?q='+encodeURIComponent(new URL(location.href).searchParams.get('q'))";
            const script = `const load=async()=>{const data=await fetch(${query}).then(r=>r.json());${mode === 'token' || mode === 'late-request' ? "document.querySelector('main').textContent='共'+data.total+'条';" : ''}};load();${mode === 'late-request' ? 'setTimeout(load,1500);' : ''}`;
            return route.fulfill({
              contentType: 'text/html',
              body:
                path === '/search' ? html('<main>共0条</main>', script) : html(form, navigation),
            });
          });
          try {
            const r = await run(context, { zeroConfirmMs: mode === 'late-request' ? 2200 : 300 });
            if (mode === 'token' || mode === 'late-request') {
              assert.equal(r.outcome, 'results');
              assert.match(r.captures[0].text, /共1条/);
            } else {
              assert.notEqual(r.outcome, 'no_results');
              assert.ok(r.captures.every((c) => c.kind !== 'result'));
            }
            if (mode === 'pending') assert.equal(r.diagnostic?.code, 'result_load_timeout');
            if (
              mode === 'unknown-json' ||
              mode === 'contradicting-json' ||
              mode === 'business-error'
            )
              assert.equal(r.diagnostic?.code, 'result_unverified');
          } finally {
            await context.close();
          }
        });
      await t.test(
        'a scripted zero shell cannot pass before a delayed API even starts',
        async () => {
          const context = await browser.newContext();
          let queried = false;
          await context.route('**/*', (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === '/api') {
              queried = true;
              return route.fulfill({ contentType: 'application/json', body: '{"total":1}' });
            }
            return route.fulfill({
              contentType: 'text/html',
              body:
                path === '/search'
                  ? html(
                      '<main>共0条</main>',
                      "setTimeout(async()=>{const d=await fetch('/api?token=synthetic').then(r=>r.json());document.querySelector('main').textContent='共'+d.total+'条';},2500);",
                    )
                  : html(form, navigation),
            });
          });
          try {
            const r = await run(context);
            assert.equal(queried, true);
            assert.equal(r.outcome, 'results');
            assert.match(r.captures[0].text, /共1条/);
          } finally {
            await context.close();
          }
        },
      );
      await t.test(
        'one successful dataset cannot erase another failed dataset at the same API path',
        async () => {
          const context = await browser.newContext();
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/api')
              return route.fulfill({
                status: url.searchParams.has('failed') ? 503 : 200,
                contentType: 'application/json',
                body: '{"total":0}',
              });
            return route.fulfill({
              contentType: 'text/html',
              body:
                url.pathname === '/search'
                  ? html('<main>共0条</main>', "fetch('/api?failed=1');fetch('/api?ok=1');")
                  : html(form, navigation),
            });
          });
          try {
            const r = await run(context);
            assert.equal(r.outcome, 'failed');
            assert.equal(r.diagnostic?.http_status, 503);
            assert.ok(r.captures.every((c) => c.kind !== 'result'));
          } finally {
            await context.close();
          }
        },
      );
      await t.test(
        'unknown scripted zero and a deadline shorter than confirmation remain unverified',
        async () => {
          for (const scripted of [false, true]) {
            const context = await browser.newContext();
            await context.route('**/*', (route) =>
              route.fulfill({
                contentType: 'text/html',
                body:
                  new URL(route.request().url()).pathname === '/search'
                    ? html('<main>共0条</main>', scripted ? 'setTimeout(()=>{},60000);' : '')
                    : html(form, navigation),
              }),
            );
            try {
              const r = await run(context, {
                waitMs: 3500,
                ...(!scripted ? { resultStableMs: undefined, zeroConfirmMs: undefined } : {}),
              });
              assert.equal(r.outcome, 'unverified');
              assert.ok(r.captures.every((c) => c.kind !== 'result'));
            } finally {
              await context.close();
            }
          }
        },
      );
      await t.test('next-page capture also waits for a pending result API', async () => {
        const context = await browser.newContext();
        let secondFinished = 0,
          secondCaptured = 0;
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api') {
            if (url.searchParams.get('page') === '2') {
              await new Promise((r) => setTimeout(r, 2200));
              secondFinished = Date.now();
            }
            return route.fulfill({ contentType: 'application/json', body: '{"total":2}' });
          }
          return route.fulfill({
            contentType: 'text/html',
            body: html(
              form,
              "const show=n=>document.querySelector('main').innerHTML='共2条 第'+n+'页'+(n===1?'<button id=next>下一页</button>':'');document.querySelector('button').onclick=async()=>{await fetch('/api?q='+encodeURIComponent(document.querySelector('input').value));show(1);};document.addEventListener('click',async e=>{if(e.target.id==='next'){document.querySelector('main').textContent='共2条 第2页';await fetch('/api?page=2');show(2);}});",
            ),
          });
        });
        try {
          const r = await run(context, {
            maxPages: 2,
            screenCapture: async (page) => {
              if ((await page.locator('main').innerText()).includes('第2页'))
                secondCaptured = Date.now();
              return page.screenshot();
            },
          });
          assert.equal(r.outcome, 'results');
          assert.equal(r.captures.length, 2);
          assert.ok(secondFinished > 0 && secondCaptured >= secondFinished);
        } finally {
          await context.close();
        }
      });
      for (const mode of [
        'zero-to-hit',
        'same-count-replacement',
        'pending-during-capture',
      ] as const)
        await t.test(`discard screenshot on ${mode}`, async () => {
          const context = await browser.newContext();
          let captures = 0;
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/api') {
              if (url.searchParams.has('changed') && mode === 'pending-during-capture') return;
              return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                  total: mode === 'zero-to-hit' && !url.searchParams.has('changed') ? 0 : 1,
                }),
              });
            }
            return route.fulfill({
              contentType: 'text/html',
              body: html(
                form,
                "document.querySelector('button').onclick=async()=>{const d=await fetch('/api?q='+encodeURIComponent(document.querySelector('input').value)).then(r=>r.json());document.querySelector('main').textContent='共'+d.total+'条 原结果';};",
              ),
            });
          });
          const screenCapture = async (page: Page) => {
            const png = await page.screenshot();
            if (captures++ === 0) {
              if (mode === 'pending-during-capture')
                await page.evaluate(() => {
                  void fetch('/api?changed=1');
                });
              else
                await page.evaluate(async () => {
                  await fetch('/api?changed=1');
                  document.querySelector('main')!.textContent = '共1条 新结果';
                });
            }
            return png;
          };
          try {
            const r = await run(context, { screenCapture });
            if (mode === 'pending-during-capture') {
              assert.equal(r.outcome, 'unverified');
              assert.ok(r.captures.every((c) => c.kind !== 'result'));
            } else {
              assert.equal(r.outcome, 'results');
              assert.equal(r.captures.length, 1);
              assert.match(r.captures[0].text, /新结果/);
              assert.ok(captures >= 2);
            }
            assert.equal(r.timing?.discarded_captures, 1);
          } finally {
            await context.close();
          }
        });
    } finally {
      await browser.close();
    }
  },
);

test(
  'HTTP 200 headers alone do not complete a slow response body',
  { skip: !process.env.BB_TEST_INTEGRITY_BROWSER, timeout: 30000 },
  async () => {
    let finished = 0,
      captured = 0;
    const timers: NodeJS.Timeout[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!);
      if (url.pathname === '/api') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"total":');
        timers.push(
          setTimeout(() => {
            finished = Date.now();
            res.end('1}');
          }, 6000),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          form,
          "document.querySelector('button').onclick=async()=>{const q=document.querySelector('input').value;document.querySelector('main').textContent='共0条';const d=await fetch('/api?q='+encodeURIComponent(q)).then(r=>r.json());document.querySelector('main').textContent='共'+d.total+'条';};",
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      proxy: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}` },
    });
    try {
      const r = await collectInContext(
        context,
        {
          ...site,
          links: [{ label: 'synthetic local proxy', url: 'http://www.chinatax.gov.cn/' }],
        },
        subject,
        new AbortController().signal,
        {
          ...fast,
          waitMs: 15000,
          screenCapture: async (page) => {
            captured = Date.now();
            return page.screenshot();
          },
        },
      );
      assert.equal(r.outcome, 'results');
      assert.ok(finished > 0 && captured >= finished);
      assert.match(r.captures[0].text, /共1条/);
    } finally {
      await browser.close();
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
