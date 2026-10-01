import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import base from './playwright.config';
export default defineConfig({
  ...base,
  testMatch: 'prototype-corrections.spec.ts',
  grep: /quarter selection -> create/,
  outputDir: join(tmpdir(),'bondbuddy-370-video'),
  use: {...base.use, video:{mode:'on',size:{width:1440,height:960}}}
});
