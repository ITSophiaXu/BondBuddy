import assert from 'node:assert/strict';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, devices} from '@playwright/test';

const local=dirname(fileURLToPath(import.meta.url)), root=resolve(local,'../..');
const baseURL='http://127.0.0.1:15531', runs=resolve(local,'runs');
const evidence=process.env.BB_EDITOR_BROWSER_EVIDENCE_DIR;
assert(evidence&&isAbsolute(evidence),'Use the browser-editor verifier mode with a dedicated evidence directory');
const evidenceRoot=resolve(evidence),inside=relative(runs,evidenceRoot);
assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Browser evidence must stay inside this verification run directory');
assert.equal(process.env.BB_E2E_BASE_URL,baseURL,'Synthetic fixture origin must match the dedicated Vite origin');
const vite=resolve(root,'node_modules/vite/bin/vite.js');
for(const path of [process.execPath,vite])assert(!/["\r\n]/.test(path),'Unexpected shell character in the fixed executable path');

export default defineConfig({
  testDir: resolve(root,'apps/web/tests'),
  testMatch: ['review-editor.spec.ts','review-editor-recovery.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: resolve(evidenceRoot,'test-results'),
  reporter: [
    ['list'],
    ['json',{outputFile:resolve(evidenceRoot,'results.json')}],
    ['html',{outputFolder:resolve(evidenceRoot,'html-report'),open:'never'}],
  ],
  use: {baseURL,headless:true,ignoreHTTPSErrors:false,trace:'retain-on-failure',screenshot:'only-on-failure',video:'off'},
  projects: [{name:'desktop-chromium',use:{...devices['Desktop Chrome'],browserName:'chromium'}}],
  webServer: {
    command: `"${process.execPath}" "${vite}" --host 127.0.0.1 --port 15531 --strictPort --clearScreen false`,
    cwd: resolve(root,'apps/web'),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
