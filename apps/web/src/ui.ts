export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
