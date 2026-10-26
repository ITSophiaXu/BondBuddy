/** Explicit, locally authored business guidance that is safe to display.
 * Keep transport/native errors unchanged; this class only marks display text.
 */
export class UserFacingError extends Error {}

export type ErrorOperation = 'read' | 'save' | 'download' | 'submit' | 'action';

const fallback: Record<ErrorOperation, string> = {
  read: '读取暂未成功，请稍后重新读取。',
  save: '保存结果暂未确认，请重新读取当前记录后再继续。',
  download: '文件暂时未能下载，请稍后重试下载。',
  submit: '提交结果暂未确认，请先重新读取状态后再继续。',
  action: '操作结果暂未确认，请先重新读取当前状态后再继续。',
};

export function unknownErrorText(operation: ErrorOperation): string {
  return fallback[operation];
}
