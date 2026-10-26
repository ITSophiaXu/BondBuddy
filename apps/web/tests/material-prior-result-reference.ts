import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const directory = join(root, 'ux-evidence/material-prior-result-reference-source');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Source = { path: string; sha256: string; bytes?: number };

/** Exact sealed R36 MaterialWorkspace with eight unchanged shared dependencies in the current surrounding app. */
export async function installMaterialPriorResultReference(page: Page) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const freezeRaw = await readFile(join(root, 'ux-evidence', provenance.sealed_freeze), 'utf8');
  expect(hash(freezeRaw)).toBe(provenance.sealed_freeze_sha256);
  const freeze = JSON.parse(freezeRaw), originals = new Map<string, string>(), loads = new Map<string, number>(), shared: Source[] = [], currentOnlyLoads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (/\/src\/material-prior-result\.(?:ts|css)$/.test(path)) currentOnlyLoads.push(path); });
  for (const source of provenance.sources as Source[]) {
    const text = await readFile(join(directory, source.path), 'utf8'); expect(hash(text)).toBe(source.sha256);
    expect(freeze.source_snapshot.find((entry: Source) => entry.path === source.path)?.sha256).toBe(source.sha256);
    originals.set(source.path, text);
    if (source.path !== 'apps/web/src/material-workspace.ts') { expect(hash(await readFile(join(root, source.path)))).toBe(source.sha256); shared.push(source); continue; }
    loads.set(source.path, 0);
    const body = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, 'from "/@fs/' + root.replaceAll('\\', '/') + '/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote: string, specifier: string) => {
        let target = resolve(dirname(join(root, source.path)), specifier).replaceAll('\\', '/');
        if (!target.endsWith('.css')) target = target.replace(/\.js$/, '').replace(/\.ts$/, '') + '.ts';
        const sourceRoot = join(root, 'apps/web/src').replaceAll('\\', '/') + '/';
        return quote + (target.startsWith(sourceRoot) ? '/src/' + target.slice(sourceRoot.length) : '/@fs/' + target) + quote;
      });
    await page.route('**/src/' + basename(source.path) + '*', route => { loads.set(source.path, loads.get(source.path)! + 1); return route.fulfill({ contentType: 'text/javascript', body }); });
  }
  expect(originals.size).toBe(9); expect(shared).toHaveLength(8); expect([...loads.keys()]).toEqual(['apps/web/src/material-workspace.ts']);
  return async () => {
    const replaced: unknown[] = [];
    for (const [path, text] of originals) {
      const after = await readFile(join(directory, path), 'utf8'); expect(after).toBe(text);
      if (loads.has(path)) { expect(loads.get(path)).toBeGreaterThan(0); replaced.push({ path, sha256: hash(text), sha256_after: hash(after), loads: loads.get(path), immutable: true }); }
    }
    for (const source of shared) expect(hash(await readFile(join(root, source.path)))).toBe(source.sha256);
    expect(currentOnlyLoads).toEqual([]);
    return { ...provenance, replaced_components: replaced, shared_dependencies: shared, current_only_module_requests: currentOnlyLoads,
      surrounding_application: 'Exact sealed R36 MaterialWorkspace inside the current surrounding application; not a reconstruction of the entire old application.' };
  };
}

export async function captureMaterialPriorResult(page: Page, output: string, name: string, audit: Record<string, unknown>) {
  await mkdir(output, { recursive: true });
  const facts = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-material-prior-result]'), panel = document.querySelector<HTMLElement>('.m4-delivery[data-run-id]');
    const action = card?.querySelector<HTMLButtonElement>('[data-m4-action="prior-artifact"]')
      ?? [...document.querySelectorAll<HTMLButtonElement>('[data-m4-action="artifact"]')].find(button => button.textContent === '查看此前成果');
    const measure = (element: HTMLElement | null | undefined) => {
      if (!element) return null; const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { box: box.toJSON(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowX: style.overflowX, overflowY: style.overflowY,
        fullyWithinViewport: box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1 };
    };
    const box = action?.getBoundingClientRect(), hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
    return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
      mounted_run: panel?.dataset.runId, panel: measure(panel), content: measure(document.querySelector<HTMLElement>('#m4-content')),
      card: card ? { ...measure(card), mode: card.dataset.priorMode, text: card.innerText, details_open: card.querySelector('details')?.open ?? false } : null,
      action: action ? { text: action.textContent, run: action.dataset.run ?? null, prior_pin: action.dataset.priorPin ?? null,
        old_artifact_key: action.dataset.artifact ?? null, disabled: action.disabled, box: box?.toJSON(), center_unobscured: !!hit && action.contains(hit) } : null,
      selected_tab: document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent,
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(style => style.dataset.viteDevId), text: document.body.innerText };
  });
  expect(facts.width).toBe(1440); expect(facts.height).toBe(960); expect(facts.scrollWidth).toBeLessThanOrEqual(1441); expect(facts.mounted_run).toBeTruthy();
  if (facts.card) { expect(facts.card.scrollWidth).toBeLessThanOrEqual(facts.card.clientWidth! + 1); expect(facts.card.fullyWithinViewport).toBe(true); }
  if (facts.action) { expect(facts.action.disabled).toBe(false); expect(facts.action.center_unobscured).toBe(true); }
  await page.screenshot({ path: join(output, name + '.png') }); const image = await readFile(join(output, name + '.png'));
  await writeFile(join(output, name + '.json'), JSON.stringify({ ...facts, audit, png_sha256: hash(image), png_bytes: image.length }, null, 2));
  return { ...facts, png_sha256: hash(image), png_bytes: image.length };
}
