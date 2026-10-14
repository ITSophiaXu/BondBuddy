import type { Dto } from './api';
import { esc } from './ui';
import '../../../product-prototype/public/duplicate-upload-feedback.css';

export type DuplicateUploadNotice = { filename: string; material: Dto<'MaterialResponse'> };

// Completion returns the original upload ID when the server reuses identical bytes
// in the same project and role. Replaying one's own completion is not a duplicate.
export function isReusedUpload(material: Dto<'MaterialResponse'>, session?: Dto<'UploadSessionResponse'>) {
  return Boolean(session?.upload_id && material.upload_id && material.upload_id !== session.upload_id);
}

export function duplicateUploadMessage(filename: string, savedFilename: string) {
  return `${filename}：重复文件，已存在，未重复添加。${filename === savedFilename ? '已保留原文件。' : `已保留原文件“${savedFilename}”。`}`;
}

export function duplicateUploadNotices(notices: DuplicateUploadNotice[]) {
  return notices.map(({ filename, material }) => `<li class="duplicate-upload-notice" role="status">${esc(duplicateUploadMessage(filename, material.filename))}</li>`).join('');
}
