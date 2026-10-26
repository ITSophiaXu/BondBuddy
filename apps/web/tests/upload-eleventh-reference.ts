import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const directory = join(root, 'ux-evidence/upload-eleventh-reference-r10-source');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** Exact old components, current surrounding helpers. This is not a new approved prototype. */
export async function installEleventhReference(page: Page, modules: ('integrity-workspace' | 'project-qa-workspace' | 'project-assistant')[]) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const originals = new Map<string, string>(), loads = new Map<string, number>();
  for (const module of modules) for (const extension of ['.ts', '.css']) {
    const file = module + extension, relative = 'apps/web/src/' + file;
    const source = await readFile(join(directory, relative), 'utf8');
    expect(sha256(source)).toBe(provenance.sources.find((item: { path: string }) => item.path === relative)?.sha256);
    originals.set(file, source); loads.set(file, 0);
    let body: string;
    if (extension === '.css') body = `import {updateStyle} from '/@vite/client'; updateStyle(${JSON.stringify('eleventh-reference-' + module)},${JSON.stringify(source)});`;
    else body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, `from "/@fs/${root.replaceAll('\\', '/')}/packages/contracts/dist/index.js"`)
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g, (_match, quote, name: string) => {
        const filename = name.endsWith('.css') || name.endsWith('.ts') ? name : name.replace(/\.js$/, '') + '.ts';
        return quote + '/src/' + filename + quote;
      }).replace(/(['"])(\.\.\/[^'"]+)\1/g, (_match, quote, name: string) => quote + '/@fs/' + resolve(root, 'apps/web/src', name).replaceAll('\\', '/') + quote);
    await page.route(`**/src/${file}*`, route => { loads.set(file, loads.get(file)! + 1); return route.fulfill({ contentType: 'text/javascript', body }); });
  }
  return async () => {
    const sources = [];
    for (const [file, source] of originals) {
      const after = await readFile(join(directory, 'apps/web/src', file), 'utf8');
      expect(after).toBe(source); expect(loads.get(file)).toBeGreaterThan(0);
      sources.push({ path: 'apps/web/src/' + file, sha256: sha256(source), sha256_after: sha256(after), loads: loads.get(file), immutable: true });
    }
    return { baseline_sha: provenance.baseline_sha, tenth_patch_sha256: provenance.tenth_patch_sha256,
      scope: 'Exact reconstructed tenth-slice component TS/CSS with current surrounding helpers and synthetic HTTP.',
      approval: 'Old-component comparison; no approved new upload recovery prototype or human signoff.', sources };
  };
}
