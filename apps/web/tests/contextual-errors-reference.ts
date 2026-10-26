import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** Exact R39 api.ts and QA component in the current surrounding app.
 * The read-only error comparison does not exercise changed recovery dependencies. */
export async function installContextualErrorsReference(page: Page) {
  const verification = JSON.parse(await readFile(resolve(root, 'ux-evidence/contextual-errors-parent-verification.json'), 'utf8'));
  const freeze = JSON.parse(await readFile(resolve(root, 'ux-evidence/consistency-manual-reading-product-final-freeze.json'), 'utf8'));
  const loads: Record<string, number> = {}, sources: unknown[] = [];
  for (const path of ['apps/web/src/api.ts', 'apps/web/src/project-qa-workspace.ts']) {
    const backup = 'ux-evidence/contextual-errors-r39-source/' + path;
    const bytes = await readFile(resolve(root, backup));
    const record = verification.backups.find((item: {path:string}) => item.path === backup);
    expect(hash(bytes)).toBe(record.sha256); expect(bytes.length).toBe(record.bytes);
    expect(freeze.files.find((item: {path:string}) => item.path === path).sha256).toBe(record.sha256);
    const body = ts.transpileModule(bytes.toString(), { compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext} }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, 'from "/@fs/' + root.replaceAll('\\', '/') + '/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote:string, specifier:string) => {
        let target = resolve(dirname(resolve(root,path)),specifier).replaceAll('\\','/');
        if (!target.endsWith('.css')) target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';
        return quote+'/src/'+target.slice((root.replaceAll('\\','/')+'/apps/web/src/').length)+quote;
      });
    loads[path]=0; sources.push({...record,original_path:path});
    await page.route('**/src/'+basename(path)+'*', intercepted => { loads[path]++;return intercepted.fulfill({contentType:'text/javascript',body}); });
  }
  return () => {for (const path of Object.keys(loads)) expect(loads[path]).toBeGreaterThan(0); return {sources,loads,scope:'Exact R39 API and QA source pair; current surrounding application; synthetic read failure only.'};};
}
