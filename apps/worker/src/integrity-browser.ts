import {
  integrityBrowserBoundary,
  integrityBrowserOperation,
  type integrityBrowserFailure,
} from './integrity-browser-boundary.js';
import {
  resolveCreditChinaCaptcha,
  IntegrityCaptchaInterruption,
  type IntegrityCaptchaRecognizer,
  type IntegrityCaptchaSession,
} from './integrity-captcha.js';
import { observeCaptchaImages } from './integrity-captcha-image.js';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
  type Response,
  type Request,
} from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  integrityDiagnosticLabel,
  type IntegrityDiagnostic,
  type IntegrityBrowser,
  type IntegritySite,
  type IntegritySubject,
} from '@bondbuddy/contracts';
import { integrityProxy, integrityBrowserUrlAllowed } from './integrity-browser-network.js';
import { startIntegrityDesktop, type IntegrityDesktop } from './integrity-desktop.js';
import {
  visibleFrames,
  visibleText,
  activeStylesheet,
  firstVisible,
  challenge as blocker,
  pageErrors as errors,
  pageFailure,
  loadingOnly,
  searchInput,
  searchButton,
  queryReflected,
  courtRegion,
  resultsLoading,
  resultAreaText,
  companyNameCondition,
  creditChinaVerification,
  domReady,
} from './integrity-browser-page.js';
import {
  observeIntegrityQuery,
  integrityRequestCarriesQuery,
  INTEGRITY_RESULT_STABLE_MS,
  INTEGRITY_ZERO_CONFIRM_MS,
} from './integrity-query-readiness.js';

export type BrowserCapture = {
  kind: 'result' | 'detail' | 'blocker';
  url: string;
  title: string;
  captured_at: string;
  page: number;
  text: string;
  screenshot: Buffer;
};
// Internal batch audit, persisted by saveBatch; not part of the public strict DTO.
type QueryTiming = {
  query_started_at: string;
  response_completed_at?: string;
  captured_at?: string;
  wait_ms: number;
  result_stable_ms: number;
  zero_confirm_ms: number;
  discarded_captures: number;
};
export type BrowserCollection = {
  query: string;
  search_performed: boolean;
  outcome: IntegrityBrowser['outcome'];
  scope: string;
  limitation: string;
  reason: string;
  captures: BrowserCapture[];
  diagnostic?: IntegrityDiagnostic;
  timing?: QueryTiming;
  runtime_failure?: ReturnType<typeof integrityBrowserFailure>;
};
export type IntegrityCollector = (
  site: IntegritySite,
  subject: Pick<IntegritySubject, 'name' | 'kind' | 'province' | 'city'>,
  signal: AbortSignal,
  options?: { captchaRecognizer?: IntegrityCaptchaRecognizer },
) => Promise<BrowserCollection>;
export function integrityBrowserEnvironment(cacheDirectory: string) {
  const env: Record<string, string> = { XDG_CACHE_HOME: cacheDirectory };
  for (const key of [
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
const zero =
  /未(?:检索|查询|搜索)到.{0,30}(结果|信息|记录|内容)|未能搜到您想要的内容|没有找到.{0,30}(结果|信息|记录|内容)|您搜索的内容不存在|没有(?:相关)?数据|暂无(?:相关)?(?:数据|记录|信息)|(?:共\s*(?:有|约|找到|检索到|查询到|搜索到)?|符合条件的有)\s*0\s*(?:条|个|项|篇)|(?:找到|相关结果|结果数)[：:\s]*0\s*(?:条|个|项|篇)|(?:搜索|全部)结果\s*[（(]\s*0\s*[）)]|no results found/i;
const count =
  /(?:共|找到|检索到|查询到|搜索到|相关结果|符合条件的有)[\s\S]{0,12}?[1-9][\d,]*\s*(?:条|个|项|篇)|[1-9][\d,]*\s*条结果|(?:搜索|全部)结果\s*[（(]\s*[1-9][\d,]*\s*[）)]/;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
// Official search pages load their form, configuration and results sequentially.
// The Beijing runtime observed a valid tax response after the former 18s limit.
const collectionLimits = { waitMs: 90000, maxPages: 3, attempts: 2 };
type CollectionLimits = {
  waitMs: number;
  maxPages: number;
  attempts?: number;
  captchaRecognizer?: IntegrityCaptchaRecognizer;
  screenCapture?: (page: Page) => Promise<Buffer>;
  resultStableMs?: number;
  zeroConfirmMs?: number;
};
/** Retry transient transport/server failures, never repeat a rejected or insecure request. */
export function retryIntegrityCollection(result: BrowserCollection) {
  if (!['failed', 'unverified'].includes(result.outcome)) return false;
  const d = result.diagnostic;
  if (
    d?.code === 'access_denied' ||
    /net::ERR_(?:CERT_[A-Z_]+|BLOCKED_BY_CLIENT)\b/.test(d?.detail ?? '')
  )
    return false;
  if (d?.http_status && d.http_status < 500) return [408, 425].includes(d.http_status);
  return true;
}
/** Court forms take an exact name; topical keywords belong only in general site searches. */
export function integritySearchQuery(
  site: IntegritySite,
  subject: Pick<IntegritySubject, 'name' | 'province'>,
) {
  const exactName = [
    'credit-china',
    'execution-dishonest',
    'execution-debtor',
    'execution-restriction',
  ].includes(site.id);
  return [
    subject.name,
    ...(!exactName ? (site.queryTerms?.slice(0, 1) ?? []) : []),
    ...(site.id === 'local-csrc' ? [subject.province] : []),
  ]
    .filter(Boolean)
    .join(' ');
}
async function capture(
  page: Page,
  kind: BrowserCapture['kind'],
  pageNo: number,
  screenCapture?: (page: Page) => Promise<Buffer>,
  query?: string,
  site?: IntegritySite,
  verify?: () => Promise<boolean>,
): Promise<BrowserCapture> {
  if (verify && !(await verify())) throw Error('OFFICIAL_QUERY_CHANGED_DURING_CAPTURE');
  let text = await visibleText(page);
  if (loadingOnly(text)) throw Error('EMPTY_OFFICIAL_PAGE');
  // A portal shell can contain plenty of text while its result area is still blank.
  // Keep an actual error/verification screen, but never a loading overlay as evidence.
  if ((await resultsLoading(page)) && !errors.test(text) && !(await blocker(page, text)))
    throw Error('OFFICIAL_PAGE_STILL_LOADING');
  if (!/^https?:\/\//.test(page.url())) throw Error('NO_OFFICIAL_PAGE_CAPTURE');
  const height = await page
    .locator('body')
    .evaluate((e) => Math.max(e.scrollHeight, document.documentElement.scrollHeight));
  if (height > 20000) throw Error('BROWSER_PAGE_TOO_LONG');
  const screenshot = screenCapture
    ? await screenCapture(page)
    : await page.screenshot({ type: 'png', fullPage: true, timeout: 10000 });
  text = await visibleText(page);
  if (
    (query &&
      ((await blocker(page, text)) ||
        !(await queryReflected(page, query, text)) ||
        (await resultsLoading(page)) ||
        outcome(text, query, await structuredResultSignature(page, site)) === 'unverified')) ||
    (verify && !(await verify()))
  )
    throw Error('OFFICIAL_QUERY_CHANGED_DURING_CAPTURE');
  return {
    kind,
    url: page.url(),
    title: (await page.title()).slice(0, 200),
    captured_at: new Date().toISOString(),
    page: pageNo,
    text,
    screenshot,
  };
}
async function structuredResultSignature(page: Page, site?: IntegritySite) {
  // MOT's observed search list has no total-count label. Recognize only its visible
  // result-title structure on the exact search page, never arbitrary subject text.
  const url = new URL(page.url());
  // Credit China's observed entity list may contain just one page and no count.
  // This is a search hit only; its information/adverse nature is assessed separately.
  if (
    site?.id === 'credit-china' &&
    ['creditchina.gov.cn', 'www.creditchina.gov.cn'].includes(url.hostname) &&
    url.pathname === '/xinyongxinxi/index.html'
  )
    return page.locator('#companylists > li.company-item:visible').evaluateAll((nodes) =>
      nodes
        .flatMap((node) => {
          const name = (
            node.querySelector('.company-name') as HTMLElement | null
          )?.innerText.trim();
          const info = (node.querySelector('.company-messages') as HTMLElement | null)?.innerText;
          return name && info && /统一社会信用代码[：:]/.test(info) && /主体类型[：:]/.test(info)
            ? [name + ' ' + info]
            : [];
        })
        .join('\n'),
    );
  if (
    site?.id !== 'transport' ||
    url.origin !== 'https://zs.mot.gov.cn' ||
    url.pathname !== '/mot/s'
  )
    return '';
  return page
    .locator('.search-result-header .result-header-title a[href]:visible')
    .evaluateAll((nodes) =>
      nodes
        .flatMap((node) => {
          const link = node as HTMLAnchorElement,
            title = link.innerText.replace(/\s+/g, ' ').trim();
          try {
            const target = new URL(link.href);
            if (
              title.length > 5 &&
              /^https?:$/.test(target.protocol) &&
              target.hostname.endsWith('.gov.cn') &&
              !target.username &&
              !target.password
            )
              return [title + ' ' + target.href];
          } catch {
            /* Invalid links cannot identify results. */
          }
          return [];
        })
        .join('\n'),
    );
}
function outcome(text: string, query: string, structured = ''): BrowserCollection['outcome'] {
  if (errors.test(text)) return 'failed';
  // A confirmed query can return fuzzy matches without echoing the name in body text.
  // Response, changed results and query reflection are checked by the caller; subject
  // association belongs to the evidence assessment, never to a navigation/feed count.
  if (count.test(text)) return 'results';
  if (zero.test(text)) return 'no_results';
  if (/共\s*(?:[2-9]|[1-9]\d+)\s*页/.test(text)) return 'results';
  if (
    text.includes(query + '的最新相关信息') &&
    /来源：[^\n]+时间：\s*\d{4}-\d{2}-\d{2}/.test(text)
  )
    return 'results';
  if (structured) return 'results';
  return 'unverified';
}
function resultSignature(text: string, query: string, structured = '') {
  return (
    text
      .split(/\n/)
      .map(clean)
      .filter(
        (line) =>
          zero.test(line) ||
          count.test(line) ||
          /共\s*(?:[2-9]|[1-9]\d+)\s*页/.test(line) ||
          line.includes(query),
      )
      .join('\n') +
    '\n' +
    structured
  );
}

/** Uses the product's own short-lived browser, never the developer/user browser profile. */
export const collectIntegrityWebsite: IntegrityCollector = async (site, subject, signal, options) =>
  integrityBrowserBoundary(signal, async (signal) => {
    signal.throwIfAborted();
    const cache = await mkdtemp(join(tmpdir(), 'bb-integrity-browser-'));
    let browser: Browser | undefined;
    let desktop: IntegrityDesktop | undefined;
    let proxy: Awaited<ReturnType<typeof integrityProxy>> | undefined;
    try {
      proxy = await integrityBrowserOperation('proxy', () =>
        integrityProxy(site, { upstreamUrl: process.env.BB_INTEGRITY_EGRESS_PROXY_URL }),
      );
      desktop = await integrityBrowserOperation('desktop', () =>
        startIntegrityDesktop(cache, integrityBrowserEnvironment(cache)),
      );
      signal.throwIfAborted();
      const browserEnv = desktop.env as Record<string, string>,
        server = proxy.server;
      browser = await integrityBrowserOperation('launch', () =>
        chromium.launch({
          headless: false,
          chromiumSandbox: true,
          env: browserEnv,
          proxy: { server },
          args: [
            '--window-size=1440,952',
            '--window-position=0,0',
            '--disable-quic',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--proxy-bypass-list=<-loopback>',
          ],
        }),
      );
      signal.throwIfAborted();
      const launched = browser;
      const context = await integrityBrowserOperation('context', () =>
        launched.newContext({
          viewport: null,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          acceptDownloads: false,
          serviceWorkers: 'block',
        }),
      );
      await context.route('**/*', (route) =>
        integrityBrowserUrlAllowed(site, route.request().url())
          ? route.continue()
          : route.abort('blockedbyclient'),
      );
      const abort = () => void context.close().catch(() => {});
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        return await collectInContext(context, site, subject, signal, {
          ...collectionLimits,
          captchaRecognizer: options?.captchaRecognizer,
          screenCapture: desktop.capture,
        });
      } finally {
        signal.removeEventListener('abort', abort);
        await integrityBrowserOperation('cleanup', () => context.close());
      }
    } finally {
      try {
        await integrityBrowserOperation('cleanup', async () => {
          await browser?.close();
        });
      } finally {
        const closed = await Promise.allSettled([desktop?.close(), proxy?.close()]);
        await rm(cache, { recursive: true, force: true });
        const failed = closed.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed)
          await integrityBrowserOperation('cleanup', async () => {
            throw failed.reason;
          });
      }
    }
  });

/** Injectable context only for controlled browser fixtures. Production always uses the protected proxy. */
export async function collectInContext(
  context: BrowserContext,
  site: IntegritySite,
  subject: Pick<IntegritySubject, 'name' | 'kind' | 'province' | 'city'>,
  signal: AbortSignal,
  limits: CollectionLimits = collectionLimits,
): Promise<BrowserCollection> {
  let result: BrowserCollection | undefined;
  const started = Date.now();
  const captchaSession: IntegrityCaptchaSession = {
    recognize: limits.captchaRecognizer,
    attempts: 0,
    imageRefreshes: 0,
  };
  const attempts = limits.attempts ?? collectionLimits.attempts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(600, undefined, { signal });
    // Official credit search entry observed from the portal's search button (2026-10-26).
    // A broken portal shell must not prevent the normal query form from loading.
    const entry =
      site.id === 'credit-china' && attempt > 0
        ? new URL('/xinyongxinxi/index.html', site.links[0].url).href
        : site.links[0].url;
    signal.throwIfAborted();
    result = await collectAttempt(context, site, subject, signal, limits, entry, captchaSession);
    if (result.diagnostic)
      Object.assign(result.diagnostic, { attempts: attempt + 1, elapsed_ms: Date.now() - started });
    if (!retryIntegrityCollection(result)) return result;
  }
  if (!result) throw Error('INVALID_COLLECTION_LIMITS');
  result.reason = `已自动尝试 ${attempts} 次。${result.reason}`;
  return result;
}
async function collectAttempt(
  context: BrowserContext,
  site: IntegritySite,
  subject: Pick<IntegritySubject, 'name' | 'kind' | 'province' | 'city'>,
  signal: AbortSignal,
  limits: CollectionLimits,
  entry: string,
  captchaSession: IntegrityCaptchaSession,
): Promise<BrowserCollection> {
  const capturePage = (
    page: Page,
    kind: BrowserCapture['kind'],
    n: number,
    verify?: () => Promise<boolean>,
  ) =>
    capture(
      page,
      kind,
      n,
      limits.screenCapture,
      kind === 'result' ? query : undefined,
      site,
      verify,
    );
  const query = integritySearchQuery(site, subject);
  const result: BrowserCollection = {
    query,
    search_performed: false,
    outcome: 'unverified',
    scope: `${site.name}官网站内查询；查询词：${query}。${site.topic}。`,
    limitation:
      (limits.screenCapture ? '截图保留采集时的完整屏幕内容；仅覆盖屏幕可见区域。' : '') +
      '仅覆盖实际截图的查询页面及已打开正文；不含登录后信息、未展示页或附件。全文搜索不等同于专项数据库核查，不能据此认定不存在违法失信。',
    reason: '未取得可核对的查询结果，无需上传补充证据。',
    captures: [],
  };
  let page = await context.newPage();
  page.setDefaultTimeout(Math.min(limits.waitMs, 15000));
  page.setDefaultNavigationTimeout(limits.waitMs);
  let onResponse: ((response: Response) => void) | undefined,
    onRequestFailed: ((request: Request) => void) | undefined,
    onRequest: ((request: Request) => void) | undefined,
    onRequestFinished: ((request: Request) => void) | undefined;
  let phase: IntegrityDiagnostic['phase'] = 'open';
  let queryObserver: ReturnType<typeof observeIntegrityQuery> | undefined;
  let acceptedAt = 0,
    completedAt = 0,
    recaptures = 0;
  const stableMs = limits.resultStableMs ?? INTEGRITY_RESULT_STABLE_MS,
    zeroMs = limits.zeroConfirmMs ?? INTEGRITY_ZERO_CONFIRM_MS;
  type StyleFailure = {
    frame: Frame;
    document: string;
    url: string;
    source: string;
    error?: string;
    status?: number;
  };
  const pendingScripts = new Set<Request>(),
    styleRequests = new WeakMap<Request, StyleFailure>(),
    failedStyles = new Map<Request, StyleFailure>(),
    latestStyles = new WeakMap<Frame, Map<string, Request>>();
  const scriptStarted = (request: Request) => {
    if (request.resourceType() === 'script') pendingScripts.add(request);
    if (request.resourceType() === 'stylesheet')
      try {
        const frame = request.frame(),
          url = request.url(),
          previous = request.redirectedFrom(),
          prior = previous ? styleRequests.get(previous) : undefined,
          source = prior?.source ?? url;
        styleRequests.set(request, {
          frame,
          document: prior?.document ?? frame.url(),
          url,
          source,
        });
        if (!latestStyles.has(frame)) latestStyles.set(frame, new Map());
        latestStyles.get(frame)!.set(source, request);
      } catch {
        /* Detached resource. */
      }
  };
  const scriptFinished = (request: Request) => {
    pendingScripts.delete(request);
  };
  const resourceFailed = (request: Request) => {
    scriptFinished(request);
    const style = failedStyles.get(request) ?? styleRequests.get(request);
    if (style)
      failedStyles.set(request, {
        ...style,
        error: request.failure()?.errorText.match(/net::[A-Z_]+/)?.[0],
      });
  };
  const resourceResponse = (response: Response) => {
    const request = response.request(),
      style = styleRequests.get(request);
    if (style) {
      if (response.ok()) failedStyles.delete(request);
      else if (response.status() >= 400)
        failedStyles.set(request, { ...style, status: response.status() });
    }
  };
  context.on('request', scriptStarted);
  context.on('requestfinished', scriptFinished);
  context.on('requestfailed', resourceFailed);
  context.on('response', resourceResponse);
  const navigationStatuses = new WeakMap<Page, number>(),
    navigationTimes = new WeakMap<Page, number>();
  const onNavigation = (response: Response) => {
    try {
      const frame = response.frame();
      if (response.request().isNavigationRequest() && frame === frame.page().mainFrame()) {
        navigationStatuses.set(frame.page(), response.status());
        navigationTimes.set(frame.page(), Date.now());
      }
    } catch {
      /* Popup navigation can precede creation of its frame. */
    }
  };
  const mark = (
    d: IntegrityDiagnostic,
    outcome: BrowserCollection['outcome'] = 'failed',
    explanation = '未取得可确认的查询结果。',
  ) => {
    result.diagnostic = d;
    result.outcome = outcome;
    result.reason = `${integrityDiagnosticLabel(d)}。${explanation} 无需补充信息或上传证据。`;
  };
  context.on('response', onNavigation);
  const captchaImages = observeCaptchaImages(context);
  const diagnostic = async () => {
    try {
      result.captures.push(await capturePage(page, 'blocker', 1));
    } catch {
      /* A blank/error document is never fabricated as evidence. */
    }
  };
  let captchaWaitMs = 0;
  const stopForVerification = async () => {
    const started = Date.now();
    const verification = await resolveCreditChinaCaptcha(
      page,
      captchaSession,
      signal,
      limits.waitMs,
      captchaImages,
    );
    if (verification.status === 'passed') captchaWaitMs += Date.now() - started;
    if (verification.status === 'image_failed') {
      mark(
        {
          code: 'captcha_required',
          phase,
          detail: verification.detail,
          ...(verification.http_status ? { http_status: verification.http_status } : {}),
        },
        verification.retryable ? 'failed' : 'blocked',
        '验证码图片未能正常显示，本项未完成查询。',
      );
      return true;
    }
    if (verification.status !== 'blocked') return false;
    mark(
      {
        code: 'captcha_required',
        phase,
        ...(captchaSession.attempts
          ? { detail: 'CAPTCHA_NOT_ACCEPTED_AFTER_BOUNDED_ATTEMPTS' }
          : {}),
      },
      'blocked',
      captchaSession.attempts
        ? '已尝试自动验证，仍未通过网站验证，本项未完成查询。'
        : '官网要求验证后才能继续，其他网站继续。',
    );
    return true;
  };
  let optionalPbcStyleFailed = false;
  const styleFailure = async () => {
    const frames = await visibleFrames(page);
    for (const [request, f] of failedStyles) {
      // Portal resources can fail while navigating to a new result page or popup.
      // Only a stylesheet still required by a visible, current document can block it.
      if (
        !frames.includes(f.frame) ||
        f.frame.url() !== f.document ||
        latestStyles.get(f.frame)?.get(f.source) !== request
      )
        continue;
      if (!(await activeStylesheet(f.frame, f.source))) continue;
      // Observed 2026-10-27: this PBC template references an absent, unused service
      // widget stylesheet (404). Its result layout comes from rmyh.css. Scope this
      // exception to that exact resource/template, intact main CSS and result DOM;
      // normal response/query/stability checks still decide whether results are valid.
      const resourceUrl = new URL(f.url),
        documentUrl = new URL(f.document);
      if (
        site.id === 'pbc' &&
        phase === 'results' &&
        f.status === 404 &&
        f.frame === page.mainFrame() &&
        documentUrl.origin === 'https://wzdig.pbc.gov.cn' &&
        documentUrl.pathname === '/search/pcRender' &&
        documentUrl.searchParams.get('pageId') === 'c177a85bd02b4114bebebd210809f691' &&
        resourceUrl.origin === documentUrl.origin &&
        resourceUrl.pathname ===
          '/search/fileDir/template/system/pageTemp/pc/commonresult/96e3f317e7f8427aa584841e0a84b8ed/fuwuxiang/fuwuxiang.css'
      ) {
        const intact = await f.frame
          .evaluate(
            () =>
              !document.querySelector('[class*=fuwu],[id*=fuwu],[class*=service],[id*=service]') &&
              [...document.styleSheets].some((sheet) => {
                if (
                  !sheet.href ||
                  sheet.disabled ||
                  (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches)
                )
                  return false;
                const url = new URL(sheet.href);
                if (
                  url.origin !== location.origin ||
                  url.pathname !== '/search/fileDir/sites/main/rmyh/rmyh.css'
                )
                  return false;
                try {
                  return sheet.cssRules.length > 0;
                } catch {
                  return false;
                }
              }),
          )
          .catch(() => false);
        if (
          intact &&
          (await page.locator('.result-count').isVisible()) &&
          (await page.locator('.default-result-list').isVisible())
        ) {
          optionalPbcStyleFailed = true;
          continue;
        }
      }
      const url = new URL(f.url);
      const resource = (url.origin + url.pathname).slice(0, 320);
      mark(
        {
          code: 'network_error',
          phase,
          detail: ['OFFICIAL_STYLESHEET_LOAD_FAILED', f.error, resource].filter(Boolean).join(' '),
          ...(f.status && f.status >= 400 ? { http_status: f.status } : {}),
        },
        'failed',
        '官网样式资源未能加载，页面及查询状态无法确认。',
      );
      return true;
    }
    return false;
  };
  try {
    signal.throwIfAborted();
    // Commit permits slow scripts/redirects to finish inside the readiness loop.
    await page.goto(entry, { waitUntil: 'commit' });
    let text = '',
      form: Awaited<ReturnType<typeof searchInput>>,
      openedSearch = false,
      waitingForForm = false;
    const readyDeadline = Date.now() + limits.waitMs;
    while (Date.now() < readyDeadline + captchaWaitMs) {
      signal.throwIfAborted();
      text = await visibleText(page);
      if (await stopForVerification()) {
        await diagnostic();
        return result;
      }
      text = await visibleText(page);
      if (errors.test(text)) {
        mark(pageFailure(text, navigationStatuses.get(page) ?? 0, phase));
        await diagnostic();
        return result;
      }
      const status = navigationStatuses.get(page) ?? 0;
      // Allow the site's automatic 412 interstitial and a short redirect grace.
      // A settled error document has no query form to wait 90 seconds for.
      if (
        status >= 400 &&
        status !== 412 &&
        Date.now() - (navigationTimes.get(page) ?? Date.now()) >= 1000 &&
        (await page
          .locator('body')
          .evaluate(() => document.readyState !== 'loading')
          .catch(() => false))
      ) {
        mark(pageFailure(text, status, phase));
        await diagnostic();
        return result;
      }
      if (await blocker(page, text)) {
        if (!(await domReady(page))) {
          await page.waitForTimeout(300);
          continue;
        }
        text = await visibleText(page);
        const gate = await blocker(page, text);
        if (await styleFailure()) {
          await diagnostic();
          return result;
        }
        if (gate) {
          mark({ code: gate, phase }, 'blocked', '自动查询已停止，其他网站继续。');
          await diagnostic();
          return result;
        }
      }
      form = await searchInput(page);
      waitingForForm = !!form && !(await domReady(form.frame));
      if (form && !waitingForForm) break;
      form = undefined;
      if (!openedSearch) {
        const opener = await firstVisible(
          page
            .getByRole('link', { name: /^(站内搜索|搜索|查询|信息查询)$/ })
            .or(page.getByRole('button', { name: /^(站内搜索|搜索|查询|信息查询)$/ })),
        );
        if (opener) {
          openedSearch = true;
          await opener.click({ noWaitAfter: true });
        }
      }
      const opened = context.pages().filter((p) => !p.isClosed());
      if (opened.length > 1) page = opened.at(-1)!;
      await page.waitForTimeout(300);
    }
    if (!form) {
      const status = navigationStatuses.get(page) ?? 0;
      if (status >= 400) mark(pageFailure(text, status, phase));
      else
        mark(
          {
            code: !text.trim()
              ? 'blank_page_timeout'
              : loadingOnly(text) ||
                  (await resultsLoading(page)) ||
                  waitingForForm ||
                  !(await domReady(page))
                ? 'page_load_timeout'
                : 'query_form_unavailable',
            phase,
          },
          'unverified',
          `等待 ${limits.waitMs / 1000} 秒后仍未能查询${loadingOnly(text) ? '，未保存空白或加载中的截图' : ''}。`,
        );
      await diagnostic();
      return result;
    }
    phase = 'query';
    captchaWaitMs = 0;
    // An iframe may expose an enabled field while deferred scripts are still loading.
    // DOM interactive alone does not mean its search handler has been registered.
    await form!.frame.waitForLoadState('domcontentloaded', { timeout: limits.waitMs });
    if (await styleFailure()) {
      await diagnostic();
      return result;
    }
    if (site.id === 'commerce-credit' && subject.kind === 'company')
      await companyNameCondition(form!.frame);
    if (site.id.startsWith('execution-')) {
      const region = await courtRegion(page, subject);
      if (region) {
        result.scope += ` 执行法院范围：${region}。`;
        if (region !== '全国')
          result.limitation += ` 官网要求选择地区，本次仅查询${region}，不覆盖其他地区执行案件。`;
      }
    }
    await form.input.fill(query);
    const baseline = resultSignature(
      await visibleText(page),
      query,
      await structuredResultSignature(page, site),
    );
    const beforePages = context.pages(),
      beforeUrl = page.url(),
      pendingRequests = new Set<Request>();
    let queryStatus = 0,
      queryNetworkError = '',
      queryFailureAt = 0,
      submitCount = 0,
      submittedAt = 0;
    const carriesQuery = (request: Request) => integrityRequestCarriesQuery(request, site, query);
    onRequest = (request: Request) => {
      if (['document', 'xhr', 'fetch'].includes(request.resourceType()))
        pendingRequests.add(request);
      if (carriesQuery(request)) result.search_performed = true;
    };
    context.on('request', onRequest);
    onRequestFinished = (request) => {
      pendingRequests.delete(request);
    };
    context.on('requestfinished', onRequestFinished);
    context.on('requestfailed', onRequestFinished);
    onResponse = (response: Response) => {
      if (carriesQuery(response.request())) {
        queryStatus = response.status();
        queryNetworkError = '';
        queryFailureAt = response.ok() ? 0 : Date.now();
      }
    };
    context.on('response', onResponse);
    onRequestFailed = (request: Request) => {
      if (carriesQuery(request)) {
        queryNetworkError =
          request.failure()?.errorText.match(/net::[A-Z_]+/)?.[0] ?? '查询请求未完成';
        queryFailureAt = Date.now();
      }
    };
    context.on('requestfailed', onRequestFailed);
    const submit = async () => {
      submitCount++;
      submittedAt = Date.now();
      const current = await searchInput(page);
      if (!current) return;
      await current.input.fill(query);
      const button = await searchButton(current.frame, current.input);
      if (button) await button.click({ noWaitAfter: true });
      else await current.input.press('Enter', { noWaitAfter: true });
    };
    queryObserver = observeIntegrityQuery(context, site, query);
    await submit();
    phase = 'results';
    const deadline = Date.now() + limits.waitMs;
    let previous = '',
      stableSince = 0,
      verified = false;
    const snapshot = async () => {
      const body = await visibleText(page),
        structured = await structuredResultSignature(page, site),
        area = await resultAreaText(page, body);
      const network = queryObserver!.snapshot(await visibleFrames(page));
      if (!acceptedAt) completedAt = network.finishedAt;
      const candidate = outcome(body, query, structured);
      return {
        body,
        network,
        candidate,
        signature: JSON.stringify([
          page.url(),
          resultSignature(body, query, structured),
          area,
          network.revision,
          candidate,
        ]),
      };
    };
    while (Date.now() < deadline + captchaWaitMs) {
      signal.throwIfAborted();
      await page.waitForTimeout(600);
      const opened = context.pages().filter((p) => !beforePages.includes(p) && !p.isClosed());
      if (opened.length) page = opened.at(-1)!;
      text = await visibleText(page).catch(() => '');
      if (await stopForVerification()) break;
      text = await visibleText(page).catch(() => '');
      if (!(await domReady(page))) continue;
      if (await styleFailure()) break;
      if (errors.test(text)) {
        mark(
          pageFailure(
            text,
            queryStatus >= 400 ? queryStatus : (navigationStatuses.get(page) ?? 0),
            phase,
          ),
        );
        break;
      }
      const gate = await blocker(page, text);
      if (gate) {
        mark({ code: gate, phase }, 'blocked', '官网要求验证后才能继续，其他网站继续。');
        break;
      }
      // A completed failed query has no response left to wait for. Keep a short
      // grace for the site's own recovery, then apply our bounded retry policy.
      if (queryFailureAt && !pendingRequests.size && Date.now() - queryFailureAt >= 1000) {
        if (queryStatus >= 400) mark(pageFailure(text, queryStatus, phase));
        else mark({ code: 'network_error', phase, detail: queryNetworkError });
        break;
      }
      const reflected = await queryReflected(page, query, text);
      const current = await snapshot(),
        { network, candidate } = current;
      const compact = resultSignature(text, query, await structuredResultSignature(page, site));
      // Some portals render enabled controls before attaching their delayed scripts.
      // Retry that inert click once; never resubmit a request already in flight.
      if (
        !result.search_performed &&
        !pendingRequests.size &&
        !pendingScripts.size &&
        submitCount < 2 &&
        Date.now() - submittedAt >= 1500 &&
        Date.now() + 1800 < deadline &&
        page.url() === beforeUrl &&
        context.pages().length === beforePages.length &&
        compact === baseline &&
        !(await resultsLoading(page))
      )
        await submit();
      // A completed new document or explicit API zero can legitimately repeat the
      // empty-search zero. An unchanged old label alone remains unverified.
      if (network.failed && !network.pending) {
        if (network.httpStatus && network.httpStatus >= 400)
          mark(pageFailure(text, network.httpStatus, phase));
        else
          mark(
            { code: 'network_error', phase, ...(network.error ? { detail: network.error } : {}) },
            'failed',
            '本次结果请求未能完整成功返回。',
          );
        break;
      }
      const ready =
        network.ready &&
        (compact !== baseline ||
          network.freshDocument ||
          (candidate === 'no_results' && network.explicitZero)) &&
        reflected &&
        ['results', 'no_results'].includes(candidate) &&
        !network.countConflict &&
        (candidate === 'no_results' ? network.zeroAllowed : network.positiveAllowed) &&
        !(await resultsLoading(page));
      if (!ready) {
        stableSince = 0;
        previous = '';
        continue;
      }
      if (current.signature !== previous) {
        previous = current.signature;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince < stableMs + (candidate === 'no_results' ? zeroMs : 0)) continue;
      const verify = async () => {
        const after = await snapshot();
        return (
          after.signature === current.signature &&
          after.network.ready &&
          Date.now() < deadline + captchaWaitMs &&
          (await queryReflected(page, query, after.body)) &&
          !(await resultsLoading(page)) &&
          !(await blocker(page, after.body)) &&
          (await domReady(page))
        );
      };
      try {
        const captured = await capturePage(page, 'result', 1, verify);
        result.captures.push(captured);
        result.outcome = candidate;
        acceptedAt = Date.parse(captured.captured_at);
        completedAt = network.finishedAt;
        verified = true;
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            'OFFICIAL_QUERY_CHANGED_DURING_CAPTURE',
            'OFFICIAL_PAGE_STILL_LOADING',
            'EMPTY_OFFICIAL_PAGE',
          ].includes(error.message)
        )
          throw error;
        recaptures++;
        stableSince = 0;
        previous = '';
      }
    }
    context.off('response', onResponse);
    if (result.outcome === 'blocked' || result.outcome === 'failed') {
      await diagnostic();
      return result;
    }
    if (!verified) {
      const status = queryStatus >= 400 ? queryStatus : (navigationStatuses.get(page) ?? 0),
        loading =
          loadingOnly(text) ||
          (await resultsLoading(page)) ||
          !(await domReady(page)) ||
          queryObserver.snapshot(await visibleFrames(page)).pending;
      if (!result.search_performed)
        mark(
          { code: 'operation_failed', phase: 'query' },
          'unverified',
          '查询控件尚未触发可确认的请求。',
        );
      else if (queryNetworkError) mark({ code: 'network_error', phase, detail: queryNetworkError });
      else if (status >= 400) mark(pageFailure(text, status, phase));
      else
        mark(
          {
            code: !text.trim()
              ? 'blank_page_timeout'
              : loading
                ? 'result_load_timeout'
                : 'result_unverified',
            phase,
          },
          'unverified',
          `已提交查询，等待 ${limits.waitMs / 1000} 秒后${loading ? '页面仍未加载完成' : '仍无法确认页面对应本次查询'}。`,
        );
      await diagnostic();
      return result;
    }
    result.diagnostic = {
      code: result.outcome === 'no_results' ? 'no_results' : 'results',
      phase,
      ...(optionalPbcStyleFailed ? { detail: 'OPTIONAL_PBC_WIDGET_STYLESHEET_HTTP_404' } : {}),
    };
    result.reason =
      result.outcome === 'no_results'
        ? '搜索无返回结果：官网已响应本次查询，页面明确显示无结果；仅限所列查询词和页面范围，不代表无风险。'
        : '搜索返回结果：官网已响应本次查询，具体事项与主体关联见下方记录。';
    if (result.outcome === 'no_results') return result;
    // Preserve subsequent pages when the site exposes a normal next-page control.
    for (let n = 2; n <= limits.maxPages; n++) {
      const next = await firstVisible(
        page
          .getByRole('link', { name: /^(下一页|下页|Next)\s*(?:>>|»|›)?$/i })
          .or(page.getByRole('button', { name: /^(下一页|下页|Next)\s*(?:>>|»|›)?$/i })),
      );
      if (!next) break;
      const old = await resultAreaText(page, await visibleText(page));
      await next.click({ noWaitAfter: true });
      const pageDeadline = Date.now() + limits.waitMs;
      let updated = false,
        last = '',
        steadySince = 0;
      while (Date.now() < pageDeadline) {
        signal.throwIfAborted();
        await page.waitForTimeout(600);
        text = await visibleText(page);
        if ((await blocker(page, text)) || errors.test(text)) {
          result.limitation += ' 翻页受限，后续页未完成查询。';
          result.captures.push(await capturePage(page, 'blocker', n));
          break;
        }
        const current = await snapshot();
        if (current.network.failed) break;
        if (
          !current.network.ready ||
          current.network.countConflict ||
          !current.network.positiveAllowed ||
          current.candidate !== 'results' ||
          !(await queryReflected(page, query, text)) ||
          (await resultsLoading(page)) ||
          !(await domReady(page)) ||
          (await resultAreaText(page, text)) === old
        ) {
          last = '';
          steadySince = 0;
          continue;
        }
        if (current.signature !== last) {
          last = current.signature;
          steadySince = Date.now();
        }
        if (Date.now() - steadySince < stableMs) continue;
        try {
          const captured = await capturePage(page, 'result', n, async () => {
            const after = await snapshot();
            return (
              after.signature === current.signature &&
              after.network.ready &&
              Date.now() < pageDeadline &&
              (await queryReflected(page, query, after.body)) &&
              !(await resultsLoading(page)) &&
              !(await blocker(page, after.body)) &&
              (await domReady(page))
            );
          });
          result.captures.push(captured);
          updated = true;
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            ![
              'OFFICIAL_QUERY_CHANGED_DURING_CAPTURE',
              'OFFICIAL_PAGE_STILL_LOADING',
              'EMPTY_OFFICIAL_PAGE',
            ].includes(error.message)
          )
            throw error;
          recaptures++;
          last = '';
          steadySince = 0;
        }
      }
      if (!updated) {
        result.limitation += ' 后续页结果未能确认，未保存为有效查询截图。';
        break;
      }
    }
    // Open at most three result links whose visible surrounding text contains the full subject.
    const links = await page.locator('a[href]').evaluateAll(
      (nodes, name) =>
        nodes
          .filter((n) => {
            const e = n as HTMLAnchorElement;
            return (
              (e.innerText + ' ' + (e.parentElement?.innerText ?? '')).includes(name) &&
              e.innerText.trim().length > 5
            );
          })
          .map((n) => ({
            url: (n as HTMLAnchorElement).href,
            title: (n as HTMLAnchorElement).innerText,
          })),
      subject.name,
    );
    for (const link of [...new Map(links.map((l) => [l.url, l])).values()]
      .filter((l) => integrityBrowserUrlAllowed(site, l.url) && l.url !== page.url())
      .slice(0, 3)) {
      signal.throwIfAborted();
      const detail = await context.newPage();
      try {
        const r = await detail.goto(link.url, {
          waitUntil: 'domcontentloaded',
          timeout: limits.waitMs,
        });
        const body = await visibleText(detail);
        if (r && r.status() < 400 && !(await blocker(detail, body)) && body.includes(subject.name))
          result.captures.push(await capturePage(detail, 'detail', result.captures.length + 1));
      } catch {
        result.limitation += ' 部分正文未能打开。';
      } finally {
        await detail.close();
      }
    }
    result.limitation += ` 本次保留 ${result.captures.filter((c) => c.kind === 'result').length} 页查询截图，最多采集 ${limits.maxPages} 页；未展示的结果不在本次核查范围内。`;
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IntegrityCaptchaInterruption) throw error;
    const network = error instanceof Error ? error.message.match(/net::[A-Z_]+/)?.[0] : undefined;
    if (
      result.captures.some((c) => c.kind === 'result') &&
      ['results', 'no_results'].includes(result.outcome)
    ) {
      result.limitation += ' 后续页面采集未完成，已取得的查询结果仍保留。';
      if (result.diagnostic && network) result.diagnostic.detail = network;
      return result;
    }
    const text = await visibleText(page).catch(() => ''),
      status = navigationStatuses.get(page) ?? 0;
    if (await creditChinaVerification(page)) {
      mark(
        { code: 'captcha_required', phase },
        'blocked',
        '官网要求验证后才能继续，本项未完成查询。',
      );
      await diagnostic();
      return result;
    }
    if (status >= 400 || errors.test(text)) mark(pageFailure(text, status, phase));
    else
      mark({
        code: network
          ? 'network_error'
          : error instanceof Error && error.name === 'TimeoutError'
            ? !text.trim()
              ? 'blank_page_timeout'
              : phase === 'open'
                ? 'page_load_timeout'
                : phase === 'results'
                  ? 'result_load_timeout'
                  : 'operation_failed'
            : 'operation_failed',
        phase,
        ...(network ? { detail: network } : {}),
      });
    await diagnostic();
    return result;
  } finally {
    if (queryObserver)
      result.timing = {
        query_started_at: new Date(queryObserver.startedAt).toISOString(),
        ...(completedAt ? { response_completed_at: new Date(completedAt).toISOString() } : {}),
        ...(acceptedAt ? { captured_at: new Date(acceptedAt).toISOString() } : {}),
        wait_ms: (acceptedAt || Date.now()) - queryObserver.startedAt,
        result_stable_ms: stableMs,
        zero_confirm_ms: zeroMs,
        discarded_captures: recaptures,
      };
    queryObserver?.close();
    captchaImages.close();
    context.off('request', scriptStarted);
    context.off('requestfinished', scriptFinished);
    context.off('requestfailed', resourceFailed);
    context.off('response', resourceResponse);
    context.off('response', onNavigation);
    if (onResponse) context.off('response', onResponse);
    if (onRequestFailed) context.off('requestfailed', onRequestFailed);
    if (onRequest) context.off('request', onRequest);
    if (onRequestFinished) {
      context.off('requestfinished', onRequestFinished);
      context.off('requestfailed', onRequestFinished);
    }
    await Promise.all(context.pages().map((p) => p.close().catch(() => {})));
  }
}
