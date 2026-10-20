import { esc } from '../ui';
import { consistencyParagraphs } from './consistency-model';
import { reviewParagraphs } from './review-model';
import { qaParagraphs } from './qa-model';
import { updateParagraphs } from './update-result';
import { integrityDocument } from './integrity-view';
import { downloadWord } from './word-export';
import type { DesignState, Project, ProjectFile } from './model';

export function fileDownloadLabel(file: ProjectFile) {
  if (file.deletedAt) return undefined;
  if (file.consistency) return '下载修订版';
  if (file.review) return file.type === 'review-clean' ? '下载清洁版' : '下载修订版';
  if (file.qa) return '下载回复文件';
  if (file.origin === 'update' && file.jobId) return '下载修订版';
  if (file.integrity) return '下载底稿示例';
  return undefined;
}
export function downloadUnavailable(file: ProjectFile) {
  return file.deletedAt ? '此版本已删除，可在项目文件中恢复。' : file.origin === 'upload' || file.origin === 'sample'
    ? '本地设计仅保存文件元数据，未保存原件，暂不可下载。'
    : '本轮仅有文件记录，尚未生成可下载正文。';
}
export function fileDownloadButton(file: ProjectFile, className = 'text-button', action = 'data-action="download-file"') {
  const label = fileDownloadLabel(file);
  return label ? `<button class="${className}" ${action} data-id="${file.id}">${label}</button>`
    : `<span class="pd-download-unavailable" title="${esc(downloadUnavailable(file))}">${file.deletedAt ? '已删除' : file.origin === 'upload' || file.origin === 'sample' ? '仅文件记录' : '暂无可下载正文'}</span>`;
}
export function downloadProjectFile(state: DesignState, p: Project, file: ProjectFile) {
  if (!p.files.includes(file) || !fileDownloadLabel(file)) throw new Error(downloadUnavailable(file));
  const title = file.name.replace(/\.[a-z0-9]+$/i, '') + '_v' + file.version;
  const job = state.jobs.find(j => j.id === file.jobId && j.projectId === p.id);
  if (file.consistency) downloadWord(title + '_一致性修订版', consistencyParagraphs(file), true);
  else if (file.review) downloadWord(title, reviewParagraphs(file.review, job?.reviewDecisions), file.type !== 'review-clean');
  else if (file.qa) downloadWord(title, qaParagraphs(file.qa));
  else if (file.origin === 'update' && job) downloadWord(title + '_修订版', updateParagraphs(job), true);
  else if (file.integrity) {
    const body = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + esc(title) + '</title><style>body{max-width:1000px;margin:40px auto;padding:24px;font:14px/1.8 sans-serif;color:#263c2e}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ddd;padding:10px;text-align:left}small{display:block;color:#687663}</style><h1>' + esc(file.name) + '</h1><p>本地设计稿 · 未执行真实核查 · 查询时间和截图尚未采集</p>' + integrityDocument(file.integrity).replace(/<details([^>]*)>/g, (_, attrs: string) => '<details' + attrs.replace(/\sopen\b/g, '') + ' open>') + '</html>';
    const url = URL.createObjectURL(new Blob([body], {type:'text/html;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = title.replace(/[\\/:*?"<>|]/g, '_') + '_设计示例.html'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  } else throw new Error('找不到此版本对应的成果记录。');
}
