import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const provenancePath = 'ux-evidence/prospectus-saved-reentry-reference-provenance.json';
const component = 'apps/web/src/prospectus-panel.ts';
const parentSeal = { path: 'ux-evidence/material-task-draft-delivery-seal.json', bytes: 37432,
  sha256: '860a4b77d513a8297e657337876ac29c7763a649f8d31ee66c996bac979e5b0c' };
const sourceNames = [component, 'apps/web/src/api.ts', 'apps/web/src/user-facing-error.ts',
  'apps/web/src/artifact-download.ts', 'apps/web/src/ui.ts', 'apps/web/src/upload-recovery.ts',
  'apps/web/src/update-entry.css'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type FileIdentity = { path: string; bytes: number; sha256: string };
type Source = FileIdentity & { original: string };

/** Mount only the exact sealed R42 ProspectusPanel in the current native route.
 * Its six local direct imports remain shared, with exact byte identity checked.
 * Runtime contracts and transitive imports belong to the surrounding current app. */
export async function installProspectusSavedReentryReference(page: Page) {
  const provenanceBytes = await readFile(join(root, provenancePath));
  const provenance = JSON.parse(provenanceBytes.toString('utf8')) as { round: string; reference: string; files: Source[] };
  expect(provenance.round).toBe('R43');
  expect(provenance.files.map(source => source.original).sort()).toEqual([...sourceNames].sort());
  const sealed = async (identity: FileIdentity) => {
    const bytes = await readFile(join(root, identity.path));
    expect(bytes.length, identity.path).toBe(identity.bytes);
    expect(hash(bytes), identity.path).toBe(identity.sha256);
    expect(JSON.parse(bytes.toString('utf8')).round).toBe('R42');
    return bytes;
  };
  const parent = JSON.parse((await sealed(parentSeal)).toString('utf8'));
  const freeze = JSON.parse((await sealed(parent.final_freeze)).toString('utf8'));
  const originals = new Map<string, Buffer>(), shared: Source[] = [], forbiddenRequests: string[] = [];
  let componentLoads = 0, mainLoads = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/src/main.ts') mainLoads++;
    if (path.endsWith('/prospectus-saved-reentry.css')) forbiddenRequests.push(path);
  });
  for (const source of provenance.files) {
    expect(source.path).toBe('ux-evidence/prospectus-saved-reentry-reference-source/' + source.original);
    expect(originals.has(source.original), 'Unique reference source ' + source.original).toBe(false);
    const bytes = await readFile(join(root, source.path));
    expect(bytes.length, source.path).toBe(source.bytes); expect(hash(bytes), source.path).toBe(source.sha256);
    const matches = (freeze.files as FileIdentity[]).filter(file => file.path === source.original);
    expect(matches, 'Exact R42 frozen source ' + source.original).toHaveLength(1);
    expect(matches[0]!.sha256, source.original).toBe(source.sha256);
    originals.set(source.original, bytes);
    if (source.original !== component) {
      expect((await readFile(join(root, source.original))).equals(bytes), 'Unchanged shared direct import ' + source.original).toBe(true);
      shared.push(source); continue;
    }
    const body = ts.transpileModule(bytes.toString('utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, 'from "/@fs/' + root.replaceAll('\\', '/') + '/packages/contracts/dist/index.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote: string, specifier: string) => {
        let target = resolve(dirname(join(root, source.original)), specifier).replaceAll('\\', '/');
        if (!target.endsWith('.css')) target = target.replace(/\.js$/, '').replace(/\.ts$/, '') + '.ts';
        const sourceRoot = join(root, 'apps/web/src').replaceAll('\\', '/') + '/';
        return quote + (target.startsWith(sourceRoot) ? '/src/' + target.slice(sourceRoot.length) : '/@fs/' + target) + quote;
      });
    await page.route(url => url.pathname === '/src/prospectus-panel.ts', route => {
      componentLoads++; return route.fulfill({ contentType: 'text/javascript', body });
    });
  }
  expect(originals.size).toBe(7); expect(shared).toHaveLength(6);
  return async () => {
    expect((await readFile(join(root, provenancePath))).equals(provenanceBytes)).toBe(true);
    await sealed(parentSeal); await sealed(parent.final_freeze);
    for (const source of provenance.files) {
      expect((await readFile(join(root, source.path))).equals(originals.get(source.original)!), 'Immutable reference copy ' + source.path).toBe(true);
    }
    for (const source of shared) {
      const bytes = await readFile(join(root, source.original));
      expect(bytes.length, source.original).toBe(source.bytes); expect(hash(bytes), source.original).toBe(source.sha256);
    }
    expect(componentLoads, 'Native main route requested the exact R42 panel').toBeGreaterThan(0);
    expect(mainLoads, 'Current native main route loaded').toBeGreaterThan(0);
    expect(forbiddenRequests, 'R42 panel must not load the new saved-version stylesheet').toEqual([]);
    const mount = await page.evaluate(() => ({ hash: location.hash,
      workbenches: document.querySelectorAll('.project-workbench').length,
      panels: document.querySelectorAll('#pw-prospectus .prospectus-panel').length }));
    expect(mount.hash).toMatch(/^#\/projects\/[^/?]+\/files(?:\?|$)/);
    expect(mount.workbenches).toBe(1); expect(mount.panels).toBe(1);
    const bytes = originals.get(component)!;
    return { ...provenance, reference_round: 'R42', parent_seal: parentSeal, parent_freeze: parent.final_freeze,
      replaced_components: [{ path: component, bytes: bytes.length, sha256: hash(bytes), loads: componentLoads, immutable: true }],
      shared_dependencies: shared.map(source => ({ ...source, shared_unchanged: true })), forbidden_requests: forbiddenRequests,
      native_mount: { ...mount, main_loads: mainLoads, component_loads: componentLoads },
      surrounding_application: 'Exact R42 ProspectusPanel plus six unchanged local direct imports, mounted by the current native project-files route.',
      limits: 'Synthetic HTTP/file/receipt fixture only. Not the complete R42 app or its transitive/runtime dependencies, a prototype, real services, Word/WPS, billing-ledger or overall UX acceptance.' };
  };
}

/** Capture the actual desktop viewport without scrolling, expanding details,
 * changing focus, switching a version or invoking an available action. */
export async function captureProspectusSavedReentry(page: Page, output: string, name: string, audit: Record<string, unknown>) {
  expect(name).toMatch(/^prospectus-saved-reentry-(?:reference|current)-[a-z0-9-]+$/);
  await mkdir(output, { recursive: true });
  const facts = await page.evaluate(() => {
    const measure = (node: Element | null | undefined) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const displayed = node.checkVisibility() && rect.width > 0 && rect.height > 0;
      return { box: rect.toJSON(), displayed,
        visible: displayed && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
        fullyWithinViewport: displayed && rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.left >= -1 && rect.right <= innerWidth + 1,
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: style.overflowX, overflowY: style.overflowY };
    };
    const panel = document.querySelector<HTMLElement>('#pw-prospectus .prospectus-panel');
    const detail = (node: HTMLDetailsElement) => ({ open: node.open, data: { ...node.dataset },
      summary: node.querySelector(':scope > summary')?.textContent ?? null,
      text: node.textContent, ...measure(node) });
    const actions = (node: Element | null | undefined) => [...(node?.querySelectorAll<HTMLButtonElement>('button') ?? [])].map(button => {
      const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { text: button.textContent, data: { ...button.dataset }, disabled: button.disabled,
        centerUnobscured: !!hit && button.contains(hit), ...measure(button) };
    });
    const history = panel?.querySelector<HTMLDetailsElement>('[data-prospectus-history]') ?? panel?.querySelector<HTMLDetailsElement>('details');
    const notice = panel?.querySelector<HTMLElement>('[data-prospectus-saved-notice]');
    const chooser = panel?.querySelector<HTMLInputElement>('#prospectus-version-file');
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { width: innerWidth, height: innerHeight, scrollY: window.scrollY, scrollX: window.scrollX,
      scrollWidth: document.documentElement.scrollWidth, hash: location.hash,
      workbenches: document.querySelectorAll('.project-workbench').length, panels: document.querySelectorAll('#pw-prospectus .prospectus-panel').length,
      projectTitle: document.querySelector('h1')?.textContent ?? null,
      currentSource: document.querySelector('#pw-current-source')?.textContent ?? null,
      panel: panel ? { text: panel.innerText, content: panel.textContent, ...measure(panel) } : null,
      notice: notice ? { text: notice.innerText, actions: actions(notice), ...measure(notice) } : null,
      history: history ? detail(history) : null,
      details: [...(panel?.querySelectorAll<HTMLDetailsElement>('details') ?? [])].map(detail),
      rows: [...(panel?.querySelectorAll<HTMLElement>('.prospectus-version') ?? [])].map(row => ({
        version: row.dataset.prospectusVersion ?? null, name: row.querySelector('strong')?.textContent ?? null,
        text: row.innerText, content: row.textContent,
        selectionState: row.querySelector('[data-prospectus-selection-state]')?.textContent ?? null,
        references: [...row.querySelectorAll<HTMLDetailsElement>('[data-prospectus-ref]')].map(detail),
        actions: actions(row), ...measure(row) })),
      actions: actions(panel), status: panel?.querySelector('#prospectus-status')?.textContent ?? null,
      chooser: chooser ? { files: [...(chooser.files ?? [])].map(file => ({ name: file.name, bytes: file.size, type: file.type, lastModified: file.lastModified })),
        disabled: chooser.disabled, parentOpen: chooser.closest('details')?.open ?? null, ...measure(chooser) } : null,
      focus: active ? { tag: active.tagName, id: active.id, text: active.textContent, data: { ...active.dataset },
        referenceKey: active.closest<HTMLElement>('[data-prospectus-key]')?.dataset.prospectusKey ?? null, ...measure(active) } : null,
      dialogs: [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].map(dialog => ({ text: dialog.innerText, actions: actions(dialog), ...measure(dialog) })),
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(node => node.dataset.viteDevId),
      text: document.body.innerText };
  });
  expect(facts.width).toBe(1440); expect(facts.height).toBe(960); expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  expect(facts.workbenches).toBe(1); expect(facts.panels).toBe(1);
  expect(facts.hash).toMatch(/^#\/projects\/[^/?]+\/files(?:\?|$)/);
  const path = join(output, name + '.png'); await page.screenshot({ path, fullPage: false });
  const png = await readFile(path), captured = { ...facts, png_bytes: png.length, png_sha256: hash(png) };
  await writeFile(join(output, name + '.json'), JSON.stringify({ ...captured, audit,
    capture_scope: 'Actual 1440x960 native project-files viewport. Capture does not alter scroll, details, focus, chooser or selection. Synthetic fixture only; no real-service or prototype acceptance claim.' }, null, 2) + '\n');
  return captured;
}
