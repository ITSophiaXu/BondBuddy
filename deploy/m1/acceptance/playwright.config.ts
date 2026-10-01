import { defineConfig, devices } from '@playwright/test';

// Real-browser acceptance against a deployed M1 stack over HTTPS (staging only, synthetic data).
const out = process.env.BB_EVIDENCE_DIR ?? '../evidence/local';
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  workers: 1,
  outputDir: `${out}/raw/test-results`,
  reporter: [['list'], ['json', { outputFile: `${out}/raw/playwright-report.json` }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BB_STAGING_URL,
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
    locale: 'zh-CN',
  },
});
