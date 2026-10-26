import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), '../..');
const directory = join(root, 'ux-evidence/material-task-draft-reference-source');
const component = 'apps/web/src/material-workspace.ts';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type FileIdentity = { path: string; bytes: number; sha256: string };
type Source = FileIdentity & { parent_freeze_verified: boolean; role: string };

/** Replace only the native route's MaterialWorkspace with the exact sealed R41
 * component. The other 24 direct imports remain unchanged shared current bytes. */
export async function installMaterialTaskDraftReference(page: Page) {
  const provenanceBytes = await readFile(join(directory, 'provenance.json'));
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  expect(provenance.round).toBe('R42'); expect(provenance.reference_round).toBe('R41');
  expect(provenance.component_replaced).toBe(component);
  expect(provenance.source_count).toBe(25); expect(provenance.shared_dependencies).toBe(24);
  const sealed = async (identity: FileIdentity) => {
    const bytes = await readFile(join(root, identity.path));
    expect(bytes.length, identity.path).toBe(identity.bytes); expect(hash(bytes), identity.path).toBe(identity.sha256);
    expect(JSON.parse(bytes.toString('utf8')).round).toBe('R41'); return bytes;
  };
  const parent = JSON.parse((await sealed(provenance.parent_seal)).toString('utf8'));
  const freeze = JSON.parse((await sealed(provenance.parent_freeze)).toString('utf8'));
  expect(parent.final_freeze).toEqual(provenance.parent_freeze);
  const originals = new Map<string, Buffer>(), shared: Source[] = [], forbiddenRequests: string[] = [];
  let componentLoads = 0, mainLoads = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/src/main.ts') mainLoads++;
    if (path.endsWith('/material-task-draft.css')) forbiddenRequests.push(path);
  });
  for (const source of provenance.sources as Source[]) {
    expect(originals.has(source.path), 'Unique reference source ' + source.path).toBe(false);
    const bytes = await readFile(join(directory, source.path));
    expect(bytes.length, source.path).toBe(source.bytes); expect(hash(bytes), source.path).toBe(source.sha256);
    originals.set(source.path, bytes);
    if (source.parent_freeze_verified) {
      const matches = (freeze.files as { path: string; sha256: string }[]).filter(file => file.path === source.path);
      expect(matches, 'Exact parent frozen source ' + source.path).toHaveLength(1);
      expect(matches[0]!.sha256).toBe(source.sha256);
    } else {
      // This shared CSS lies outside the parent's frozen source roots. Its exact
      // backup/current identity is still checked; it is not relabelled frozen.
      expect(source.path).toBe('product-prototype/public/material-results.css');
    }
    if (source.path !== component) {
      expect((await readFile(join(root, source.path))).equals(bytes), 'Unchanged shared import ' + source.path).toBe(true);
      shared.push(source); continue;
    }
    const body = ts.transpileModule(bytes.toString('utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g, 'from "/@fs/' + root.replaceAll('\\', '/') + '/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, quote: string, specifier: string) => {
        let target = resolve(dirname(join(root, source.path)), specifier).replaceAll('\\', '/');
        if (!target.endsWith('.css')) target = target.replace(/\.js$/, '').replace(/\.ts$/, '') + '.ts';
        const sourceRoot = join(root, 'apps/web/src').replaceAll('\\', '/') + '/';
        return quote + (target.startsWith(sourceRoot) ? '/src/' + target.slice(sourceRoot.length) : '/@fs/' + target) + quote;
      });
    await page.route(url => url.pathname === '/src/material-workspace.ts', route => {
      componentLoads++; return route.fulfill({ contentType: 'text/javascript', body });
    });
  }
  expect(originals.size).toBe(25); expect(shared).toHaveLength(24); expect(originals.has(component)).toBe(true);
  expect((provenance.sources as Source[]).filter(source => !source.parent_freeze_verified).map(source => source.path))
    .toEqual(['product-prototype/public/material-results.css']);
  return async () => {
    expect((await readFile(join(directory, 'provenance.json'))).equals(provenanceBytes)).toBe(true);
    await sealed(provenance.parent_seal); await sealed(provenance.parent_freeze);
    for (const [path, bytes] of originals) expect((await readFile(join(directory, path))).equals(bytes), 'Immutable backup ' + path).toBe(true);
    for (const source of shared) {
      const bytes = await readFile(join(root, source.path));
      expect(bytes.length, source.path).toBe(source.bytes); expect(hash(bytes), source.path).toBe(source.sha256);
    }
    expect(componentLoads, 'Native main route requested the exact R41 component').toBeGreaterThan(0);
    expect(mainLoads, 'Current native main route was loaded').toBeGreaterThan(0);
    expect(forbiddenRequests, 'R41 must not load the new task/draft stylesheet').toEqual([]);
    const mount = await page.evaluate(() => ({ hash: location.hash, workspaces: document.querySelectorAll('#m4-workspace').length }));
    expect(mount.hash).toMatch(/^#generate\?/); expect(mount.workspaces).toBe(1);
    const bytes = originals.get(component)!;
    return { ...provenance, replaced_components: [{ path: component, bytes: bytes.length, sha256: hash(bytes), loads: componentLoads, immutable: true }],
      shared_dependencies: shared.map(source => ({ ...source, shared_unchanged: true })), forbidden_requests: forbiddenRequests,
      native_mount: { ...mount, main_loads: mainLoads, component_loads: componentLoads },
      surrounding_application: 'Exact R41 MaterialWorkspace component + 24 unchanged shared direct imports inside the current native main route.',
      limits: 'Synthetic HTTP/OOXML/mock receipts only. Not the complete R41 application, a prototype, real services, Word/WPS, billing-ledger or overall UX acceptance. One shared prototype CSS is exact-byte checked but outside parent frozen source roots.' };
  };
}

/** Record the actual viewport and DOM without scrolling, opening details,
 * changing focus, returning to a draft, or inventing unavailable R41 actions. */
export async function captureMaterialTaskDraft(page: Page, output: string, name: string, audit: Record<string, unknown>) {
  expect(name).toMatch(/^material-task-draft-(?:reference|current)-[a-z0-9-]+$/);
  await mkdir(output, { recursive: true });
  const facts = await page.evaluate(() => {
    const measure = (node: Element | null | undefined) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const displayed = node.checkVisibility() && rect.width > 0 && rect.height > 0;
      return { box: rect.toJSON(), displayed, visible: displayed && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
        fullyWithinViewport: displayed && rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.left >= -1 && rect.right <= innerWidth + 1,
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: style.overflowX, overflowY: style.overflowY, whiteSpace: style.whiteSpace };
    };
    const text = (selector: string) => document.querySelector<HTMLElement>(selector)?.innerText ?? null;
    const detail = (node: HTMLDetailsElement) => ({ key: node.dataset.m4Detail ?? null, open: node.open,
      summary: node.querySelector(':scope > summary')?.textContent ?? null, text: node.textContent, ...measure(node) });
    const content = document.querySelector<HTMLElement>('#m4-content');
    const taskPanel = content?.querySelector<HTMLElement>('.m4-delivery[data-run-id]');
    const comparison = content?.querySelector<HTMLElement>('[data-material-task-draft]');
    const rows = [...(content?.querySelectorAll<HTMLElement>('[data-task-draft-row]') ?? [])].map(row => {
      const side = (value: 'submitted' | 'current') => row.querySelector<HTMLElement>('[data-task-draft-side="' + value + '"]');
      const submitted = side('submitted'), current = side('current');
      const references = (node: HTMLElement | null) => [...(node?.querySelectorAll<HTMLDetailsElement>('details[data-m4-detail^="task-draft-ref-"]') ?? [])].map(detail);
      return { key: row.dataset.taskDraftRow, change: row.dataset.comparisonChange ?? row.dataset.taskDraftChange ?? null,
        changed: !!row.closest('[data-task-draft-changed]'), label: row.querySelector('h4')?.textContent ?? null,
        submitted: submitted?.innerText ?? null, current: current?.innerText ?? null,
        submittedText: submitted?.textContent ?? null, currentText: current?.textContent ?? null,
        references: { submitted: references(submitted), current: references(current) },
        submittedBox: measure(submitted), currentBox: measure(current), ...measure(row) };
    });
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    const selected = document.querySelector<HTMLInputElement>('input[data-m4-type]:checked');
    const selectedTab = document.querySelector<HTMLElement>('#m4-tabs [role="tab"][aria-selected="true"]');
    const details = [...(content?.querySelectorAll<HTMLDetailsElement>('details[data-m4-detail]') ?? [])].map(detail);
    const source = content?.querySelector<HTMLElement>('.m4-source-file');
    const requirements = content?.querySelector<HTMLTextAreaElement>('#m4-requirements');
    const returnActions = [...(content?.querySelectorAll<HTMLButtonElement>('[data-task-return], [data-m4-action="prepare"]') ?? [])].map(button => {
      const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { text: button.textContent, action: button.dataset.m4Action ?? null, run: button.dataset.run ?? null,
        taskReturn: button.hasAttribute('data-task-return'), disabled: button.disabled, centerUnobscured: !!hit && button.contains(hit), ...measure(button) };
    });
    return { width: innerWidth, height: innerHeight, scrollY: window.scrollY, scrollX: window.scrollX,
      scrollWidth: document.documentElement.scrollWidth, hash: location.hash, workspaces: document.querySelectorAll('#m4-workspace').length,
      selected: selected?.value ?? null, selectedType: selected?.value ?? null,
      typeRadios: [...document.querySelectorAll<HTMLInputElement>('input[data-m4-type]')].map(node => ({ type: node.value, checked: node.checked, disabled: node.disabled })),
      selectedTab: selectedTab?.textContent ?? null,
      activeTab: selectedTab ? { text: selectedTab.textContent, key: selectedTab.dataset.key ?? null, ...measure(selectedTab) } : null,
      taskRun: taskPanel?.dataset.runId ?? null, mounted_run: taskPanel?.dataset.runId ?? null,
      taskPanel: taskPanel ? { title: taskPanel.querySelector('h2')?.textContent ?? null, text: taskPanel.innerText, ...measure(taskPanel) } : null,
      content: measure(content), summary: comparison?.innerText ?? null,
      comparison: comparison ? { text: comparison.textContent, ...measure(comparison) } : null,
      rows, summaryRows: rows, details,
      comparisonDetails: details.filter(node => node.key === 'task-draft'), sameDetails: details.filter(node => node.key === 'task-draft-same'),
      referenceDetails: details.filter(node => node.key?.startsWith('task-draft-ref-')), fixedDetails: details.filter(node => node.key === 'input'),
      returnActions, status: text('#m4-status'), dialogs: document.querySelectorAll('dialog[open]').length,
      focus: active ? { tag: active.tagName, id: active.id, text: active.textContent, action: active.dataset.m4Action ?? null,
        detail: active.closest<HTMLElement>('details[data-m4-detail]')?.dataset.m4Detail ?? null,
        row: active.closest<HTMLElement>('[data-task-draft-row]')?.dataset.taskDraftRow ?? null,
        value: editable?.value ?? null, selectionStart: editable?.selectionStart ?? null, selectionEnd: editable?.selectionEnd ?? null,
        selectionDirection: editable?.selectionDirection ?? null, ...measure(active) } : null,
      draftForm: { requirements: requirements?.value ?? null, requirementsBox: measure(requirements), source: source?.innerText ?? null,
        sourcePin: source?.querySelector<HTMLElement>('[data-pin]')?.dataset.pin ?? null, sourceBox: measure(source),
        base: content?.querySelector<HTMLElement>('.m4-accepted')?.innerText ?? null,
        materials: [...(content?.querySelectorAll<HTMLInputElement>('[data-m4-material]') ?? [])].map(node => ({ pin: node.dataset.m4Material, checked: node.checked, disabled: node.disabled, text: node.closest('label')?.textContent })),
        fields: [...(content?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-m4-field], #m4-template') ?? [])].map(node => ({ field: node.dataset.m4Field ?? node.id, value: node.value })),
        text: requirements ? content?.innerText ?? null : null },
      styles: [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(node => node.dataset.viteDevId), text: document.body.innerText };
  });
  expect(facts.width).toBe(1440); expect(facts.height).toBe(960); expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  expect(facts.workspaces).toBe(1); expect(facts.hash).toMatch(/^#generate\?/);
  const path = join(output, name + '.png'); await page.screenshot({ path, fullPage: false });
  const png = await readFile(path), captured = { ...facts, png_bytes: png.length, png_sha256: hash(png) };
  await writeFile(join(output, name + '.json'), JSON.stringify({ ...captured, audit,
    capture_scope: 'Actual 1440x960 native-route viewport. Capture does not change scroll, details, focus or draft. Synthetic fixture only; no real-service or prototype acceptance claim.' }, null, 2) + '\n');
  return captured;
}
