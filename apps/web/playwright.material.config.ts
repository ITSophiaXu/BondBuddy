import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: 'project-execution.spec.ts',
  grep: /material workflow/,
  outputDir: join(tmpdir(), 'bondbuddy-material-video'),
  use: { ...base.use, video: { mode: 'on', size: { width: 1440, height: 960 } } }
});
