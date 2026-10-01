import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'bondbuddy-web-test-results'),
  use: { baseURL: process.env.BB_E2E_BASE_URL ?? 'http://127.0.0.1:5173', ignoreHTTPSErrors: true },
  webServer: process.env.BB_E2E_BASE_URL ? undefined : {
    command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI
  }
});
