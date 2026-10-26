import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..'), directory = join(root, 'ux-evidence/material-draft-comparison-reference-source');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Source = { path: string; bytes?: number; sha256: string };

/** Exact sealed R34 MaterialWorkspace only, inside the same current surrounding
 * application. Shared styles and main remain unchanged and are hash checked. */
export async function installMaterialDraftComparisonReference(page: Page) {
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const freezeText = await readFile(join(root, 'ux-evidence', provenance.sealed_freeze), 'utf8');
  expect(hash(freezeText)).toBe(provenance.sealed_freeze_sha256);
  const freeze = JSON.parse(freezeText), originals = new Map<string, string>(), loads = new Map<string, number>(), shared: Source[] = [];
  const currentOnlyLoads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (/\/src\/material-draft-comparison\.(?:ts|css)$/.test(path)) currentOnlyLoads.push(path); });
  for (const entry of provenance.sources as Source[]) {
    const source = await readFile(join(directory, entry.path), 'utf8');
    expect(hash(source)).toBe(entry.sha256);
    expect(freeze.source_snapshot.find((item: Source) => item.path === entry.path)?.sha256).toBe(entry.sha256);
    originals.set(entry.path, source);
    if (entry.path !== 'apps/web/src/material-workspace.ts') { expect(await readFile(join(root, entry.path), 'utf8')).toBe(source); shared.push(entry); continue; }
    loads.set(entry.path, 0);
    const body = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, 'from "/@fs/' + root.replaceAll('\\', '/') + '/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote: string, specifier: string) => {
        let target = resolve(dirname(join(root, entry.path)), specifier).replaceAll('\\', '/');
        if (!target.endsWith('.css')) target = target.replace(/\.js$/, '').replace(/\.ts$/, '') + '.ts';
        const sourceRoot = join(root, 'apps/web/src').replaceAll('\\', '/') + '/';
        return quote + (target.startsWith(sourceRoot) ? '/src/' + target.slice(sourceRoot.length) : '/@fs/' + target) + quote;
      });
    await page.route('**/src/' + basename(entry.path) + '*', route => { loads.set(entry.path, loads.get(entry.path)! + 1); return route.fulfill({ contentType: 'text/javascript', body }); });
  }
  expect([...loads.keys()]).toEqual(['apps/web/src/material-workspace.ts']);
  return async () => {
    const replaced = [];
    for (const [path, source] of originals) {
      const after = await readFile(join(directory, path), 'utf8'); expect(after).toBe(source);
      if (loads.has(path)) { expect(loads.get(path)).toBeGreaterThan(0); replaced.push({ path, sha256: hash(source), sha256_after: hash(after), loads: loads.get(path), immutable: true }); }
    }
    for (const entry of shared) expect(hash(await readFile(join(root, entry.path), 'utf8'))).toBe(entry.sha256);
    expect(currentOnlyLoads).toEqual([]);
    return { ...provenance, replaced_components: replaced, shared_dependencies: shared.map(entry => ({ ...entry, shared_unchanged: true })), current_only_module_requests: currentOnlyLoads,
      surrounding_application: 'Exact R34 MaterialWorkspace component with current shared surrounding application; this does not reconstruct the full R34 application.' };
  };
}

async function probeComparisonKeyboardFocus(page: Page) {
  const modal = page.locator('dialog[open]'), focusBefore = await page.locator(':focus').elementHandle();
  const observe = () => modal.evaluate(element => {
    const content = element.querySelector<HTMLElement>('[data-draft-comparison-content]')!, active = document.activeElement;
    const style = getComputedStyle(content), color = style.outlineColor;
    const alpha = color === 'transparent' ? 0 : color.includes('/') ? Number.parseFloat(color.split('/')[1])
      : color.startsWith('rgba(') ? Number(color.slice(5, -1).split(',')[3]) : 1;
    return { activeTag: active?.tagName ?? null, activeId: active?.id ?? null,
      activeAction: active?.getAttribute('data-draft-comparison-action') ?? null,
      activeTopClose: active?.hasAttribute('data-draft-comparison-top-close') ?? false,
      contentFocused: active === content, contentFocusVisible: content.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineWidthPx: Number.parseFloat(style.outlineWidth),
      outlineColor: color, outlineColorAlpha: alpha, outlineOffset: style.outlineOffset,
      dialogScrollTop: element.scrollTop, contentScrollTop: content.scrollTop };
  });
  const before = await observe(), tabSequence: Awaited<ReturnType<typeof observe>>[] = [];
  try {
    // Entry to the region uses actual keyboard navigation, even if a preceding
    // probe left it focused. No focus() call is used to obtain this evidence.
    for (let index = 0; index < 16; index++) {
      await page.keyboard.press('Tab'); const current = await observe(); tabSequence.push(current);
      if (current.contentFocused) break;
    }
    const focused = tabSequence.at(-1)!;
    expect(focused.contentFocused).toBe(true); expect(focused.contentFocusVisible).toBe(true);
    expect(focused.outlineStyle).not.toMatch(/^(none|hidden)$/); expect(focused.outlineWidthPx).toBeGreaterThanOrEqual(2);
    expect(focused.outlineColorAlpha).toBeGreaterThan(0); expect(Number.isFinite(Number.parseFloat(focused.outlineOffset))).toBe(true);
    return { phase: 'after-screenshot', entry: 'Real page.keyboard Tab presses only; programmatic focus is used solely to restore the prior capture state.',
      screenshot_scope: 'The PNG was taken before this probe and does not prove the focused outline. This record verifies keyboard focus and its computed outline.',
      before, tab_presses: tabSequence.length, tab_sequence: tabSequence, focused };
  } finally {
    if (focusBefore) { await focusBefore.evaluate(element => (element as HTMLElement).focus({ preventScroll: true })); await focusBefore.dispose(); }
    await modal.evaluate((element, saved) => { element.scrollTop = saved.dialogScrollTop; element.querySelector<HTMLElement>('[data-draft-comparison-content]')!.scrollTop = saved.contentScrollTop; }, before);
  }
}

export async function captureMaterialDraftComparison(page: Page, directory: string, name: string, audit: unknown) {
  await mkdir(directory, { recursive: true });
  const facts = await page.evaluate(() => {
    const modal = document.querySelector<HTMLDialogElement>('dialog[open]');
    const content = modal?.querySelector<HTMLElement>('[data-draft-comparison-content]') ?? null;
    const inside = (box: DOMRect, bounds: DOMRect, tolerance = 1) => box.top >= bounds.top - tolerance && box.bottom <= bounds.bottom + tolerance && box.left >= bounds.left - tolerance && box.right <= bounds.right + tolerance;
    const fullyWithin = (element: Element) => { const box = element.getBoundingClientRect(), bounds = modal?.getBoundingClientRect(); return !!bounds && inside(box, bounds) && box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1; };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect(), bounds = modal?.getBoundingClientRect(), clip = content?.contains(element) ? content.getBoundingClientRect() : null;
      return element.checkVisibility() && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY') && box.bottom > 0 && box.top < innerHeight
        && (!bounds || box.bottom > bounds.top && box.top < bounds.bottom) && (!clip || box.bottom > clip.top && box.top < clip.bottom);
    };
    const measure = (element: HTMLElement | null) => element ? { box: element.getBoundingClientRect().toJSON(), scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflowY: getComputedStyle(element).overflowY, overflowX: getComputedStyle(element).overflowX, fullyWithinDialogAndViewport: fullyWithin(element) } : null;
    const marker = (pre: HTMLElement, needle: string) => {
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let node: Node | null;
      while ((node = walker.nextNode())) {
        const index = node.textContent?.indexOf(needle) ?? -1; if (index < 0) continue;
        const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + needle.length);
        const box = range.getBoundingClientRect(), clip = pre.getBoundingClientRect(), bounds = modal?.getBoundingClientRect();
        const visibleWithinScroller = box.width > 0 && box.height > 0 && box.bottom > clip.top && box.top < clip.bottom && box.right > clip.left && box.left < clip.right;
        return { needle, found: true, box: box.toJSON(), visibleWithinScroller, inViewport: visibleWithinScroller && box.bottom > 0 && box.top < innerHeight && (!bounds || box.bottom > bounds.top && box.top < bounds.bottom) };
      }
      return { needle, found: false, box: null, visibleWithinScroller: false, inViewport: false };
    };
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollY, dialogs: document.querySelectorAll('dialog[open]').length,
      dialog: modal ? { text: modal.innerText, box: modal.getBoundingClientRect().toJSON(), scrollTop: modal.scrollTop, scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight, scrollWidth: modal.scrollWidth, clientWidth: modal.clientWidth, horizontalOverflow: modal.scrollWidth > modal.clientWidth + 1, name: modal.getAttribute('aria-labelledby'), preCount: modal.querySelectorAll('pre').length } : null,
      comparisonContent: measure(content), header: measure(modal?.querySelector<HTMLElement>('[data-draft-comparison-header]') ?? null), footer: measure(modal?.querySelector<HTMLElement>('[data-draft-comparison-footer]') ?? null),
      changedRowCount: modal?.querySelectorAll('[data-draft-comparison-changed] [data-draft-comparison-row]').length ?? null,
      rows: [...document.querySelectorAll<HTMLElement>('[data-draft-comparison-row]')].map(element => ({ key: element.dataset.draftComparisonRow, change: element.dataset.comparisonChange, text: element.textContent, renderable: element.checkVisibility() && !element.closest('details:not([open])'), inViewport: visible(element), box: element.getBoundingClientRect().toJSON() })),
      equalGroups: [...document.querySelectorAll<HTMLDetailsElement>('[data-draft-comparison-same]')].map(element => ({ open: element.open, text: element.querySelector(':scope>summary')?.textContent })),
      actions: [...(modal?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { text: element.textContent, action: element.dataset.draftComparisonAction ?? null, primary: element.classList.contains('primary'), topClose: element.hasAttribute('data-draft-comparison-top-close'), disabled: element.disabled, inViewport: visible(element), fullyWithinDialogAndViewport: fullyWithin(element), centerUnobscured: !!hit && element.contains(hit), box: box.toJSON() };
      }),
      references: [...document.querySelectorAll<HTMLElement>('[data-comparison-reference]')].map(element => ({ text: element.textContent, box: element.getBoundingClientRect().toJSON() })),
      requirementParagraphs: [...document.querySelectorAll<HTMLElement>('[data-draft-comparison-row="requirements"] p')].map(element => ({ text: element.textContent, whiteSpace: getComputedStyle(element).whiteSpace, overflowWrap: getComputedStyle(element).overflowWrap, inViewport: visible(element), box: element.getBoundingClientRect().toJSON() })),
      legacyPre: [...(modal?.querySelectorAll<HTMLPreElement>('pre') ?? [])].map((element, index) => ({ index, ...(measure(element)!), requirementsLabel: marker(element, '"requirements":'), requirementText: marker(element, '第一行：金额以万元列示'), endMarker: marker(element, 'LONG_REQUIREMENT_END_') })),
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(element => element.dataset.viteDevId),
      injected: !!(window as unknown as { comparisonInjected?: boolean }).comparisonInjected, text: document.body.innerText };
  });
  expect(facts.width).toBe(1440); expect(facts.height).toBe(960); expect(facts.scrollWidth).toBeLessThanOrEqual(1441); expect(facts.injected).toBe(false);
  if (facts.dialog?.name === 'm4-draft-comparison-title') {
    expect(facts.dialog.horizontalOverflow).toBe(false);
    expect(facts.comparisonContent).not.toBeNull(); expect(facts.header).not.toBeNull(); expect(facts.footer).not.toBeNull();
    const content = facts.comparisonContent!, header = facts.header!, footer = facts.footer!;
    expect(content.clientHeight).toBeGreaterThan(0); expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1); expect(content.overflowY).toMatch(/auto|scroll/);
    expect(header.fullyWithinDialogAndViewport).toBe(true); expect(footer.fullyWithinDialogAndViewport).toBe(true); expect(content.fullyWithinDialogAndViewport).toBe(true);
    expect(header.box.bottom).toBeLessThanOrEqual(content.box.top + 1); expect(content.box.bottom).toBeLessThanOrEqual(footer.box.top + 1);
    const noChanges = facts.changedRowCount === 0, expectedActions = noChanges ? ['server', 'reload', 'close'] : ['keep', 'server', 'reload', 'close'];
    expect(facts.actions.filter(value => value.action !== null).map(value => value.action)).toEqual(expectedActions);
    expect(facts.actions.filter(value => value.action === (noChanges ? 'server' : 'keep') && value.primary)).toHaveLength(1);
    expect(facts.actions.filter(value => value.topClose)).toHaveLength(1);
    for (const value of facts.actions) { expect(value.inViewport, value.text ?? '').toBe(true); expect(value.fullyWithinDialogAndViewport, value.text ?? '').toBe(true); expect(value.centerUnobscured, value.text ?? '').toBe(true); }
    const complete = facts.requirementParagraphs.filter(value => value.text?.includes('LONG_REQUIREMENT_END_'));
    expect(complete).toHaveLength(2);
    for (const value of complete) { expect(value.whiteSpace).toBe('pre-wrap'); expect(value.overflowWrap).toBe('anywhere'); expect(value.text).toContain('\n'); }
  } else if (name.includes('-requirements-')) {
    expect(facts.legacyPre).toHaveLength(2);
    for (const pre of facts.legacyPre) { expect(pre.scrollTop).toBeGreaterThan(0); expect(pre.requirementsLabel.visibleWithinScroller).toBe(true); expect(pre.requirementsLabel.inViewport).toBe(true); }
  }
  await page.screenshot({ path: join(directory, name + '.png') });
  const keyboardFocusProbe = facts.dialog?.name === 'm4-draft-comparison-title' ? await probeComparisonKeyboardFocus(page) : null;
  const captured = { ...facts, keyboardFocusProbe };
  await writeFile(join(directory, name + '.json'), JSON.stringify({ ...captured, audit }, null, 2)); return captured;
}
