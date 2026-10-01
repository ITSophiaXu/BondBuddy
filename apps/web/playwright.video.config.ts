import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import base from './playwright.config';

// Record the actual Vite workflow with synthetic HTTP fixtures, not live acceptance.
export default defineConfig({
  ...base,
  outputDir: join(tmpdir(), 'bondbuddy-prototype-videos'),
  grep: /prototype dashboard leads|unknown blockers remain explicit|completed project shows/,
  use: { ...base.use, video: { mode: 'on', size: { width: 1440, height: 960 } } }
});
