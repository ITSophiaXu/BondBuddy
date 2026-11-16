import { expect, type Page } from '@playwright/test';

/** Advance the existing browser retry timers; never shorten product retries or
 * expand the original UI/test timeout. Each counter is consumed by real HTTP. */
export async function settleUploadConfirmationFault(page: Page, remaining: Map<string, number>) {
  await expect.poll(() => remaining.size).toBeGreaterThan(0);
  await expect.poll(async () => {
    await page.clock.runFor(2_000);
    return [...remaining.values()].every(value => value === 0);
  }).toBe(true);
}
