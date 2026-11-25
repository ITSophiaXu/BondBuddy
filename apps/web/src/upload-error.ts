import { ApiError, errorReference, friendlyError } from './api.js';
import { UserFacingError } from './user-facing-error.js';

export class InvalidUploadFileError extends UserFacingError {}

export function uploadNeedsReplacement(error: unknown): boolean {
  if (error instanceof InvalidUploadFileError) return true;
  if (!(error instanceof ApiError)) return false;
  return ['MATERIAL_FORMAT_UNSUPPORTED','MATERIAL_CONTENT_MISMATCH','MATERIAL_ENCRYPTED'].includes(error.code)
    || error.code === 'MATERIAL_UNREADABLE' && ['size_limit','encrypted_content','content_mismatch','unsupported_content','structure_invalid','external_link_invalid','scanned_pdf'].includes(String(error.details.uploadReason));
}

export function uploadErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return friendlyError(error, 'save');
  const reference = errorReference(error);
  if (error.code === 'MATERIAL_UNREADABLE') {
    switch (error.details.uploadReason) {
      case 'scanned_pdf':
        return `此 PDF 为图片扫描件，无法用于材料处理。请上传可选择、复制文字的电子版 PDF 或 Word 文件；财务表格请上传电子版 Excel。${reference}`;
      case 'external_link_invalid':
        return `文件含系统目前无法核验的外部工作簿引用，尚未保存。请保留原文件并联系支持。${reference}`;
      case 'inspection_queue_timeout':
      case 'inspection_timeout':
      case 'inspection_worker_failed':
        return `文件检查服务暂时未能完成，尚未确认保存。请稍后重试此文件。${reference}`;
      case 'size_limit':
        return `文件超出当前检查限制，尚未保存。请拆分文件后重试。${reference}`;
      case 'encrypted_content':
        return `文件内容已加密，服务器无法读取。请提供可读取的副本。${reference}`;
      case 'content_mismatch':
        return `文件内容与声明格式不一致，尚未保存。请核对所选文件。${reference}`;
      case 'unsupported_content':
        return `当前暂不支持此文件内容，尚未保存。请保留原文件并联系支持。${reference}`;
      case 'file_size_mismatch':
        return `收到的文件字节与声明大小不一致，尚未保存。请保留原文件并重试此文件。${reference}`;
      case 'structure_invalid':
        return `服务器目前无法核验文件结构，尚未保存。请保留原文件并联系支持。${reference}`;
      default:
        return `服务器未能完成文件核验，尚未确认保存。请保留原文件并联系支持。${reference}`;
    }
  }
  if (error.code === 'MATERIAL_CONTENT_MISMATCH') return `文件内容校验与声明不一致，尚未保存。请核对所选文件。${reference}`;
  if (error.code === 'MATERIAL_ENCRYPTED') return `服务器无法读取加密文件。请提供可读取的副本。${reference}`;
  if (error.code === 'MATERIAL_FORMAT_UNSUPPORTED') return error.details.prospectusDocxOnly
    ? friendlyError(error, 'save') : `服务器暂不支持此文件格式。${reference}`;
  if (error.code === 'VALIDATION_FAILED') return `上传请求不符合限制或会话已过期，请核对文件大小后重试。${reference}`;
  return friendlyError(error, 'save');
}
