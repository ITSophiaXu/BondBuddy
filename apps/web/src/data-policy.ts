import type { DataPolicy } from '@bondbuddy/contracts';
import type { ApiClient } from './api';
import { dataPolicyCopy } from './data-policy-copy';
import { esc } from './ui';

// #6: upload-area notice, data-policy page and deletion actions. Copy is rendered from the API policy only.
let cached: Promise<DataPolicy> | undefined;
function policy(api: ApiClient) {
  cached ??= api.dataPolicy().catch(error => { cached = undefined; throw error; });
  return cached;
}
const unavailable = '暂时无法读取数据保存与删除说明，请稍后刷新。上传的文件会保存在平台服务器并在服务端处理。';

export function renderUploadPolicyNote(_api: ApiClient, target: HTMLElement | null) {
  if (target) target.innerHTML = '<a href="#/account?section=data">数据保存与删除说明</a>';
}

export async function renderDataPolicyPage(api: ApiClient, shell: (content: string, section: string) => void, current: () => boolean) {
  shell('<p role="status">正在读取数据说明…</p>', 'policy');
  let copy: ReturnType<typeof dataPolicyCopy>;
  try { copy = dataPolicyCopy(await policy(api)); }
  catch { if (current()) shell(`<div class="empty-state"><h1>数据保存与删除说明</h1><p>${esc(unavailable)}</p></div>`, 'policy'); return; }
  if (!current()) return;
  const section = (title: string, text: string) => `<section class="panel data-policy-section"><h2>${title}</h2><p>${esc(text)}</p></section>`;
  shell(`<a class="back-link" href="#/">← 返回我的项目</a><div class="page-heading"><div><p class="eyebrow">数据政策</p><h1>数据保存与删除说明</h1><p class="muted">以下时限来自平台当前服务配置。</p></div></div>
    ${section('上传与云端处理', copy.processing)}${section('保存期限', copy.retention)}${section('如何删除', copy.deletion)}${section('备份', copy.backup)}`, 'policy');
}

/** Delegated handlers for `data-delete-material` buttons and the `#delete-project` button on the project page. */
export function bindDeletionActions(api: ApiClient, projectId: string, done: { material: () => void; project: () => void; error: (error: unknown) => void }) {
  document.querySelector('#materials-title')?.closest('section')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-material]');
    if (!button || button.matches(':disabled') || !window.confirm('删除后这份材料立即无法访问，原件和衍生内容会按数据说明中的时限清理，无法恢复。确定删除吗？')) return;
    button.disabled = true;
    api.deleteMaterial(projectId, button.dataset.deleteMaterial!).then(done.material, error => { button.disabled = false; done.error(error); });
  });
  const projectButton = document.querySelector<HTMLButtonElement>('#delete-project');
  projectButton?.addEventListener('click', () => {
    if (!window.confirm('删除项目会同时删除其全部材料和成果，立即无法访问，并按数据说明中的时限从平台存储中清理，无法恢复。确定删除吗？')) return;
    projectButton.disabled = true;
    api.deleteProject(projectId).then(done.project, error => {
      projectButton.disabled = false;
      done.error(error);
    });
  });
}
