import { createHash } from 'node:crypto';
import type { BrowserContext, Frame, Request, Response } from 'playwright';
import type { creditChinaVerificationControls } from './integrity-browser-page.js';

type Controls = NonNullable<Awaited<ReturnType<typeof creditChinaVerificationControls>>>;
type ImageRequest = { sequence: number; pending: boolean; http_status?: number };
/** Observe existing browser requests; never fetch a challenge outside its browser session. */
export function observeCaptchaImages(context: BrowserContext) {
  const frames = new WeakMap<Frame, Map<string, ImageRequest>>(),
    requests = new WeakMap<Request, ImageRequest>();
  let sequence = 0;
  const started = (request: Request) => {
    if (request.resourceType() !== 'image') return;
    try {
      const frame = request.frame(),
        images = frames.get(frame) ?? new Map<string, ImageRequest>();
      frames.set(frame, images);
      const value = { sequence: ++sequence, pending: true };
      requests.set(request, value);
      images.delete(request.url());
      images.set(request.url(), value);
      if (images.size > 128) images.delete(images.keys().next().value!);
    } catch {
      /* A detached frame cannot provide a visible verification image. */
    }
  };
  const responded = (response: Response) => {
    if (response.status() < 400) return;
    // The img source can keep its original URL after an HTTP redirect.
    for (
      let request: Request | null = response.request();
      request;
      request = request.redirectedFrom()
    ) {
      const value = requests.get(request);
      if (value) value.http_status = response.status();
    }
  };
  const finished = (request: Request) => {
    const value = requests.get(request);
    if (value) value.pending = false;
  };
  context.on('request', started);
  context.on('response', responded);
  context.on('requestfinished', finished);
  context.on('requestfailed', finished);
  return {
    get: (frame: Frame, src: string) => frames.get(frame)?.get(src),
    close: () => {
      context.off('request', started);
      context.off('response', responded);
      context.off('requestfinished', finished);
      context.off('requestfailed', finished);
    },
  };
}
export type CaptchaImageObserver = ReturnType<typeof observeCaptchaImages>;
export type CaptchaImageVersion = { src: string; sequence: number; sha256?: string };
export type CaptchaImageFailure = {
  status: 'image_failed';
  detail:
    | 'CAPTCHA_IMAGE_LOAD_FAILED'
    | 'CAPTCHA_IMAGE_LOAD_TIMEOUT'
    | 'CAPTCHA_IMAGE_ACCESS_DENIED'
    | 'CAPTCHA_IMAGE_RATE_LIMITED'
    | 'CAPTCHA_IMAGE_REFRESH_FAILED';
  http_status?: number;
  retryable: boolean;
  version: CaptchaImageVersion;
};
type ImageResult =
  | { status: 'ready'; png: Buffer; version: CaptchaImageVersion & { sha256: string } }
  | { status: 'gone' }
  | CaptchaImageFailure;
const digest = (png: Buffer) => createHash('sha256').update(png).digest('hex');

/** A refresh can leave old pixels visible until its new request finishes. Require a new
 * source, request or pixel digest before recognizing, including when a URL is reused. */
export async function readCaptchaImage(
  controls: Controls,
  observer: CaptchaImageObserver,
  signal: AbortSignal,
  waitMs: number,
  previous?: CaptchaImageVersion,
): Promise<ImageResult> {
  const deadline = Date.now() + Math.min(waitMs, 15000);
  let version: CaptchaImageVersion = { src: '', sequence: 0 },
    http_status: number | undefined,
    broken = false,
    unchanged = false;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    unchanged = false;
    if (!(await controls.popup.isVisible())) return { status: 'gone' };
    const state = await controls.image
      .evaluate((e) => {
        const i = e as HTMLImageElement;
        return {
          src: i.currentSrc || i.src,
          complete: i.complete,
          width: i.naturalWidth,
          height: i.naturalHeight,
        };
      })
      .catch(() => undefined);
    if (!state) {
      await controls.image.page().waitForTimeout(100);
      continue;
    }
    const request = observer.get(controls.frame, state.src);
    version = { src: state.src, sequence: request?.sequence ?? 0 };
    http_status = request?.http_status;
    if (http_status === 403 || http_status === 429)
      return {
        status: 'image_failed',
        detail: http_status === 403 ? 'CAPTCHA_IMAGE_ACCESS_DENIED' : 'CAPTCHA_IMAGE_RATE_LIMITED',
        http_status,
        retryable: false,
        version,
      };
    const newRequest =
      !previous || version.src !== previous.src || version.sequence !== previous.sequence;
    broken = !!state.src && state.complete && (!state.width || !state.height);
    if (newRequest && broken && !request?.pending)
      return {
        status: 'image_failed',
        detail: 'CAPTCHA_IMAGE_LOAD_FAILED',
        ...(http_status ? { http_status } : {}),
        retryable: true,
        version,
      };
    if (
      state.complete &&
      state.width > 0 &&
      state.width <= 1024 &&
      state.height > 0 &&
      state.height <= 1024 &&
      !request?.pending
    ) {
      const box = await controls.image.boundingBox();
      if (box && box.width > 0 && box.width <= 1024 && box.height > 0 && box.height <= 1024) {
        const png = await controls.image
          .screenshot({
            type: 'png',
            animations: 'disabled',
            timeout: Math.max(1, Math.min(3000, deadline - Date.now())),
          })
          .catch(() => undefined);
        signal.throwIfAborted();
        if (png) {
          const current = await controls.image
            .evaluate((e) => {
              const i = e as HTMLImageElement;
              return {
                src: i.currentSrc || i.src,
                loaded: i.complete && i.naturalWidth > 0 && i.naturalHeight > 0,
              };
            })
            .catch(() => undefined);
          const latest = current && observer.get(controls.frame, current.src);
          const sha256 = digest(png);
          version = { ...version, sha256 };
          unchanged = !newRequest && sha256 === previous?.sha256;
          if (
            current?.loaded &&
            current.src === version.src &&
            (latest?.sequence ?? 0) === version.sequence &&
            !latest?.pending &&
            (newRequest || sha256 !== previous?.sha256)
          )
            return { status: 'ready', png, version: { ...version, sha256 } };
        }
      }
    }
    await controls.image.page().waitForTimeout(150);
  }
  signal.throwIfAborted();
  return {
    status: 'image_failed',
    detail: broken
      ? 'CAPTCHA_IMAGE_LOAD_FAILED'
      : unchanged
        ? 'CAPTCHA_IMAGE_REFRESH_FAILED'
        : 'CAPTCHA_IMAGE_LOAD_TIMEOUT',
    ...(http_status ? { http_status } : {}),
    retryable: true,
    version,
  };
}
