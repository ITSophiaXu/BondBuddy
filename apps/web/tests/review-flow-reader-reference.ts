import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..'), directory = join(root, 'ux-evidence/review-flow-reference-source');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Only the three changed reader modules and their exact R26 CSS are replaced.
// Other components belong to the same surrounding application in both captures.
export async function installReaderFlowReference(page: Page) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const sealedText = await readFile(join(root, 'ux-evidence', provenance.sealed_command), 'utf8');
  expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed = JSON.parse(sealedText), originals = new Map<string, string>(), loads = new Map<string, number>();
  for (const file of ['review-readable.ts', 'review-business-view.ts', 'review-workspace.ts', 'review-readable.css']) {
    const relative = 'apps/web/src/' + file, source = await readFile(join(directory, file), 'utf8');
    expect(hash(source)).toBe(provenance.sources.find((item: { path: string }) => item.path === relative)?.sha256);
    expect(hash(source)).toBe(sealed.source_before.find((item: { path: string }) => item.path === relative)?.sha256);
    originals.set(file, source); loads.set(file, 0);
    const body = file.endsWith('.css')
      ? `const css=${JSON.stringify(source)};const style=document.createElement('style');style.dataset.reviewFlowReference='';style.textContent=css;document.head.append(style);export default css;`
      : ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
        .replace(/from ['"]@bondbuddy\/contracts['"]/g, `from "/@fs/${root.replaceAll('\\', '/')}/packages/contracts/dist/index.js"`)
        .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
        .replace(/(['"])\.\/([^'"]+)\1/g, (_match, quote, name: string) => quote + '/src/' + (name.endsWith('.css') || name.endsWith('.ts') ? name : name.replace(/\.js$/, '') + '.ts') + quote);
    await page.route(`**/src/${file}*`, route => { loads.set(file, loads.get(file)! + 1); return route.fulfill({ contentType: 'text/javascript', body }); });
  }
  return async () => {
    const sources = [];
    for (const [file, source] of originals) {
      const after = await readFile(join(directory, file), 'utf8'); expect(after).toBe(source); expect(loads.get(file), file + ' must load exact R26 source').toBeGreaterThan(0);
      sources.push({ path: 'apps/web/src/' + file, sha256: hash(source), sha256_after: hash(after), loads: loads.get(file), immutable: true });
    }
    return { ...provenance, sources, scope: 'Exact R26 reader modules and CSS in the current surrounding app; synthetic HTTP data, no real Word or professional acceptance.' };
  };
}
