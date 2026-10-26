import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const directory = join(root, 'ux-evidence/material-reference-picker-reference-source');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Source = { path: string; sha256: string; bytes?: number };

/** Accurate sealed R35 MaterialWorkspace inside the current surrounding app.
 * No hidden libraryHtml producer is added to the reference. */
export async function installMaterialReferencePickerReference(page: Page) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const freezeRaw = await readFile(join(root, 'ux-evidence', provenance.sealed_freeze), 'utf8');
  expect(hash(freezeRaw)).toBe(provenance.sealed_freeze_sha256);
  const freeze = JSON.parse(freezeRaw), originals = new Map<string, string>(), loads = new Map<string, number>(), shared: Source[] = [], currentOnlyLoads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (/\/src\/material-reference-picker\.(?:ts|css)$/.test(path)) currentOnlyLoads.push(path); });
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
  expect([...loads.keys()]).toEqual(['apps/web/src/material-workspace.ts']);
  return async () => {
    const replaced: unknown[] = [];
    for (const [path, text] of originals) {
      const after = await readFile(join(directory, path), 'utf8'); expect(after).toBe(text);
      if (loads.has(path)) { expect(loads.get(path)).toBeGreaterThan(0); replaced.push({ path, sha256: hash(text), sha256_after: hash(after), loads: loads.get(path), immutable: true }); }
    }
    for (const source of shared) expect(hash(await readFile(join(root, source.path)))).toBe(source.sha256);
    expect(currentOnlyLoads).toEqual([]);
    return { ...provenance, replaced_components: replaced, shared_dependencies: shared, current_only_module_requests: currentOnlyLoads,
      surrounding_application: 'Accurate R35 MaterialWorkspace with unchanged shared dependencies in the current surrounding application; not a full old app reconstruction.' };
  };
}

export async function captureMaterialReferencePicker(page: Page, output: string, name: string, audit: Record<string, unknown>) {
  await mkdir(output, { recursive: true });
  const facts = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    const content = dialog?.querySelector<HTMLElement>('[data-picker-content]') ?? dialog?.querySelector<HTMLElement>('#m4-picker-materials') ?? null;
    const within = (box: DOMRect, bounds: DOMRect) => box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect(), bounds = dialog?.getBoundingClientRect(), clip = content?.contains(element) ? content.getBoundingClientRect() : null;
      return element.checkVisibility() && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY')
        && box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 && box.left < innerWidth && box.right > 0
        && (!bounds || box.top < bounds.bottom && box.bottom > bounds.top && box.left < bounds.right && box.right > bounds.left)
        && (!clip || box.top < clip.bottom && box.bottom > clip.top && box.left < clip.right && box.right > clip.left);
    };
    const measure = (element: HTMLElement | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect(), bounds = dialog?.getBoundingClientRect(), style = getComputedStyle(element);
      return { box: box.toJSON(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowX: style.overflowX, overflowY: style.overflowY,
        visible: visible(element), fullyWithinDialogAndViewport: !!bounds && within(box, bounds) && box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1 };
    };
    const controls = [...(dialog?.querySelectorAll<HTMLElement>('button,input,select') ?? [])].map(element => {
      const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: element.textContent, id: element.id, adopt: element.dataset.adoptPin ?? null, close: element.hasAttribute('data-close-picker'),
        disabled: (element as HTMLButtonElement).disabled, visible: visible(element), centerUnobscured: !!hit && element.contains(hit), box: box.toJSON() };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollY,
      dialog: dialog ? { purpose: dialog.dataset.pickerPurpose ?? null, text: dialog.innerText, box: dialog.getBoundingClientRect().toJSON(),
        scrollTop: dialog.scrollTop, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
        content: measure(content), header: measure(dialog.querySelector<HTMLElement>('[data-picker-header]')), footer: measure(dialog.querySelector<HTMLElement>('[data-picker-footer]')),
        labelledBy: dialog.getAttribute('aria-labelledby'), project: dialog.querySelector<HTMLSelectElement>('#m4-picker-project')?.value,
        selectedProjectName: dialog.querySelector<HTMLSelectElement>('#m4-picker-project')?.selectedOptions[0]?.textContent,
        projectQuery: dialog.querySelector<HTMLInputElement>('#m4-picker-project-query')?.value,
        materialQuery: dialog.querySelector<HTMLInputElement>('#m4-picker-material-query')?.value,
        rows: [...dialog.querySelectorAll<HTMLElement>('[data-adopt-pin]')].map(button => ({ key: button.dataset.adoptPin, action: button.textContent,
          rowText: button.closest('li,article')?.textContent, detailsOpen: button.closest('li,article')?.querySelector('details')?.open ?? false,
          visible: visible(button), disabled: (button as HTMLButtonElement).disabled })), controls, lastAction: controls.filter(control => control.adopt).at(-1) ?? null } : null,
      currentType: document.querySelector<HTMLInputElement>('[data-m4-type]:checked')?.value, focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(style => style.dataset.viteDevId), text: document.body.innerText };
  });
  expect(facts.width).toBe(1440); expect(facts.height).toBe(960); expect(facts.scrollWidth).toBeLessThanOrEqual(1441); expect(facts.dialog).not.toBeNull();
  expect(facts.dialog!.scrollWidth).toBeLessThanOrEqual(facts.dialog!.clientWidth + 1);
  if (facts.dialog!.purpose) {
    expect(facts.dialog!.content).not.toBeNull(); expect(facts.dialog!.header).not.toBeNull(); expect(facts.dialog!.footer).not.toBeNull();
    expect(facts.dialog!.content!.scrollWidth).toBeLessThanOrEqual(facts.dialog!.content!.clientWidth + 1);
    expect(facts.dialog!.header!.fullyWithinDialogAndViewport).toBe(true); expect(facts.dialog!.footer!.fullyWithinDialogAndViewport).toBe(true);
  }
  await page.screenshot({ path: join(output, name + '.png') });
  const image = await readFile(join(output, name + '.png'));
  await writeFile(join(output, name + '.json'), JSON.stringify({ ...facts, audit, png_sha256: hash(image), png_bytes: image.length }, null, 2));
  return { ...facts, png_sha256: hash(image), png_bytes: image.length };
}
