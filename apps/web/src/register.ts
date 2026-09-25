import { ApiError } from './api.js';

// #7 registration form: client-side checks mirror RegisterRequest; the API remains the authority.
export const USERNAME_PATTERN = '[A-Za-z][A-Za-z0-9_]{2,31}';
export const USERNAME_HELP = '3–32 位，以字母开头，只能包含字母、数字和下划线，不区分大小写。';
export const PASSWORD_HELP = '12–128 个字符。';
export type RegisterInput = { username: string; password: string; confirm: string; agreed: boolean };

export function validateRegister(input: RegisterInput): string {
  if (!new RegExp(`^${USERNAME_PATTERN}$`).test(input.username)) return `用户名格式不正确：${USERNAME_HELP}`;
  if (input.password.length < 12 || input.password.length > 128) return `密码长度不符合要求：${PASSWORD_HELP}`;
  if (input.password !== input.confirm) return '两次输入的密码不一致。';
  if (!input.agreed) return '请阅读并勾选同意用户协议后再注册。';
  return '';
}

export function registerErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return '网络连接中断，无法确认是否注册成功。请检查网络后重试；如提示用户名已被使用，请直接登录。';
  if (error.status === 409) return '该用户名已被使用，请换一个用户名。';
  if (error.status === 422 && error.code === 'AGREEMENT_REQUIRED') return '用户协议已更新，请刷新页面，阅读新版本后重新勾选。';
  if (error.status === 422) return `填写内容不符合要求：用户名${USERNAME_HELP}密码${PASSWORD_HELP}`;
  if (error.status === 429) return '尝试次数过多，请稍后再试。';
  if (error.code === 'CAPABILITY_NOT_READY') return '注册暂未开放，请稍后再试。';
  if (error.code === 'CSRF_DENIED') return '页面验证未通过，请刷新页面后重试。';
  return '暂时无法完成注册，请稍后重试。';
}

/** Only a same-origin path or an https URL from the API becomes a link; anything else falls back to the policy page. */
export function agreementHref(value: string): string {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try { return new URL(value).protocol === 'https:' ? value : '/#/data-policy'; } catch { return '/#/data-policy'; }
}
