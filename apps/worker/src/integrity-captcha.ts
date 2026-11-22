import type { Page } from 'playwright';
import { creditChinaVerificationControls } from './integrity-browser-page.js';
import {
  readCaptchaImage,
  type CaptchaImageObserver,
  type CaptchaImageVersion,
  type CaptchaImageFailure,
} from './integrity-captcha-image.js';
import type { ModelImageInput } from './model-image-input.js';
import type { StageOutcome } from './run-pipeline.js';

export type IntegrityCaptchaRecognizer = (image: ModelImageInput) => Promise<string | null>;
/** Model cancellation, reconciliation and storage failures must never become site observations. */
export class IntegrityCaptchaInterruption extends Error {
  constructor(readonly outcome: Exclude<StageOutcome, { kind: 'done' }>) {
    super('INTEGRITY_CAPTCHA_INTERRUPTED');
  }
}
export type IntegrityCaptchaSession = {
  recognize?: IntegrityCaptchaRecognizer;
  attempts: number;
  imageRefreshes: number;
};
type Resolution = { status: 'absent' | 'passed' | 'blocked' } | CaptchaImageFailure;
export async function resolveCreditChinaCaptcha(
  page: Page,
  session: IntegrityCaptchaSession,
  signal: AbortSignal,
  waitMs: number,
  images: CaptchaImageObserver,
): Promise<Resolution> {
  let controls = await creditChinaVerificationControls(page);
  if (!controls) return { status: 'absent' };
  let previous: CaptchaImageVersion | undefined;
  const refresh = async (version: CaptchaImageVersion) => {
    if ((await controls!.refresh.count()) !== 1) return false;
    await controls!.refresh.click({ timeout: 2000, noWaitAfter: true });
    previous = version;
    return true;
  };
  const image = async () => {
    let value = await readCaptchaImage(controls!, images, signal, waitMs, previous);
    // One image reload across collection attempts. Loading failures spend no model calls.
    if (value.status === 'image_failed' && value.retryable && session.imageRefreshes < 1) {
      session.imageRefreshes++;
      if (await refresh(value.version))
        value = await readCaptchaImage(controls!, images, signal, waitMs, previous);
    }
    previous = undefined;
    return value;
  };
  while (session.attempts < 2) {
    signal.throwIfAborted();
    let value = await image();
    if (value.status === 'image_failed') return value;
    if (value.status === 'gone') return { status: 'passed' };
    if (!session.recognize) return { status: 'blocked' };
    if (/已失效|已过期/.test(await controls.error.innerText({ timeout: 100 }).catch(() => ''))) {
      if (!(await refresh(value.version))) return { status: 'blocked' };
      value = await image();
      if (value.status === 'image_failed') return value;
      if (value.status === 'gone') return { status: 'passed' };
    }
    session.attempts++;
    const code = await session.recognize({ png: value.png, sha256: value.version.sha256 });
    signal.throwIfAborted();
    controls = await creditChinaVerificationControls(page);
    if (!controls) return { status: 'passed' };
    const current = await readCaptchaImage(controls, images, signal, waitMs);
    if (current.status === 'image_failed') return current;
    if (current.status === 'gone') return { status: 'passed' };
    // Request identity also catches a changed challenge served at the same image URL.
    if (
      value.version.src !== current.version.src ||
      value.version.sequence !== current.version.sequence ||
      value.version.sha256 !== current.version.sha256
    )
      continue;
    if (!code || !/^[a-zA-Z0-9]{4}$/.test(code)) {
      if (session.attempts < 2) await refresh(current.version);
      continue;
    }
    if (/已失效|已过期/.test(await controls.error.innerText({ timeout: 100 }).catch(() => ''))) {
      if (session.attempts < 2) await refresh(current.version);
      continue;
    }
    await controls.input.fill(code, { timeout: 2000 });
    await controls.submit.click({ timeout: 2000, noWaitAfter: true });
    const acceptedUntil = Date.now() + Math.min(waitMs, 5000);
    let rejected = false;
    while (Date.now() < acceptedUntil) {
      signal.throwIfAborted();
      await page.waitForTimeout(100);
      controls = await creditChinaVerificationControls(page);
      if (!controls) return { status: 'passed' };
      if (
        value.version.src !==
        (await controls.image.evaluate(
          (e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src,
        ))
      ) {
        rejected = true;
        break;
      }
      if (
        /错误|不正确|失败|已失效|已过期/.test(
          await controls.error.innerText({ timeout: 100 }).catch(() => ''),
        )
      ) {
        rejected = true;
        break;
      }
    }
    // A slow validation response is not a rejection: never send a duplicate request.
    if (!rejected) return { status: 'blocked' };
    if (
      session.attempts < 2 &&
      value.version.src ===
        (await controls!.image.evaluate(
          (e) => (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src,
        ))
    )
      await refresh(current.version);
  }
  return { status: 'blocked' };
}
