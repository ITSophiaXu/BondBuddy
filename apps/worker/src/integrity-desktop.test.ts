import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { startIntegrityDesktop } from './integrity-desktop.js';
import { integrityBrowserEnvironment } from './integrity-browser.js';
import { integrityWebsiteFixture } from './integrity-browser-fixture.js';

test(
  'native light taskbar stays below the browser and shows an advancing Beijing date/time in the captured pixels',
  { skip: !process.env.BB_TEST_INTEGRITY_DESKTOP, timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bb-desktop-test-'));
    const desktop = await startIntegrityDesktop(dir, integrityBrowserEnvironment(dir));
    let browser;
    try {
      browser = await chromium.launch({
        headless: false,
        chromiumSandbox: true,
        env: desktop.env as Record<string, string>,
      });
      const context = await browser.newContext({ viewport: null });
      await integrityWebsiteFixture(context, 'zero');
      const page = await context.newPage();
      await page.goto('https://www.chinatax.gov.cn/');
      const clockTime = (date: Date) =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(date);
      const before = Date.now();
      const bytes = await desktop.capture(page),
        path = join(dir, 'proof.png');
      const after = Date.now();
      assert.equal(bytes.readUInt32BE(16), 1440);
      assert.equal(bytes.readUInt32BE(20), 1000);
      await writeFile(path, bytes);
      // Read only the bottom-right system clock. A top panel or website timestamp cannot pass.
      // Crop/enlarge only a QA copy; the captured evidence remains unchanged.
      const ocrPath = join(dir, 'ocr-only.png');
      const readClock = async () => {
        await promisify(execFile)(
          process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
          [
            '-c',
            'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); pixels=list(im.crop((600,960,1100,998)).getdata()); assert sum(min(p)>180 for p in pixels)/len(pixels)>0.9, "bottom taskbar must be light"; im.crop((im.width-220,im.height-48,im.width,im.height)).resize((880,192)).save(sys.argv[2])',
            path,
            ocrPath,
          ],
          { timeout: 5000 },
        );
        // The date and time use different native font sizes, so read them as sparse lines.
        return (
          await promisify(execFile)(
            'tesseract',
            [
              ocrPath,
              'stdout',
              '-l',
              'eng',
              '--psm',
              '11',
              '-c',
              'tessedit_char_whitelist=0123456789:-',
            ],
            { timeout: 15000 },
          )
        ).stdout;
      };
      const assertLiveClock = (text: string, start: number, end: number) => {
        const possible = [];
        for (let t = start - 1000; t <= end + 1000; t += 1000)
          possible.push(clockTime(new Date(t)));
        assert.ok(
          possible.some((time) => text.includes(time)),
          text,
        );
        const dates = [start, end].map((t) => new Date(t + 8 * 3600000).toISOString().slice(0, 10));
        assert.ok(
          dates.some((date) => text.includes(date)),
          text,
        );
      };
      const firstClock = await readClock();
      assertLiveClock(firstClock, before, after);
      const windows = await promisify(execFile)('wmctrl', ['-l', '-G', '-x'], {
        env: desktop.env,
        timeout: 5000,
      });
      const panelWindows = windows.stdout.split('\n').filter((line) => /xfce4-panel/i.test(line));
      assert.equal(panelWindows.length, 1, 'one bottom taskbar; no top panel or hidden dock');
      const panelFields = panelWindows[0]!.trim().split(/\s+/);
      assert.equal(Number(panelFields[3]) + Number(panelFields[5]), 1000);
      assert.ok(Number(panelFields[3]) >= 940);
      assert.equal(Number(panelFields[4]), 1440);
      const browserWindow = windows.stdout
        .split('\n')
        .find((line) => /chromium/i.test(line))!
        .trim()
        .split(/\s+/);
      assert.ok(
        Number(browserWindow[3]) + Number(browserWindow[5]) <= Number(panelFields[3]),
        'maximized browser must leave the taskbar visible',
      );
      await page.waitForTimeout(1600);
      const nextBefore = Date.now();
      await writeFile(path, await desktop.capture(page));
      const nextAfter = Date.now();
      const nextClock = await readClock();
      assertLiveClock(nextClock, nextBefore, nextAfter);
      assert.notEqual(
        nextClock.match(/\d{2}:\d{2}:\d{2}/)?.[0],
        firstClock.match(/\d{2}:\d{2}:\d{2}/)?.[0],
        'clock must advance between screenshots',
      );
      const { stdout: pageText } = await promisify(execFile)(
        'tesseract',
        [path, 'stdout', '-l', 'eng'],
        { timeout: 15000 },
      );
      assert.match(
        pageText,
        /chinatax\.gov\.cn/,
        'first native capture includes the rendered browser, not its blank startup window',
      );
      assert.equal(desktop.env.TZ, 'Asia/Shanghai');
      assert.ok(!desktop.env.AZURE_STORAGE_CONNECTION_STRING && !desktop.env.BB_COPILOT_OAUTH_FILE);
    } finally {
      await browser?.close();
      await desktop.close();
      await assert.rejects(access('/tmp/.X11-unix/X' + desktop.env.DISPLAY!.slice(1)));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
