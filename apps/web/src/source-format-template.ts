import { recommendFormatTemplate, sameFormatTemplate, type FormatTemplatePin, type SourceProspectus } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import { esc } from './ui.js';

type Material = Dto<'MaterialResponse'>;
export type SourceFormatContext = {
  materials: readonly Material[];
  sources?: readonly SourceProspectus[];
  template?: FormatTemplatePin | null;
  adoptedSource?: FormatTemplatePin | null;
  disabled?: boolean;
  group?: string;
  inheritedFromResult?: boolean;
};

export function selectedFormatTemplate(context: SourceFormatContext): Material | null {
  if (context.inheritedFromResult) return null;
  const candidates = context.materials.filter(m => ['historical', 'reference'].includes(m.role));
  if (context.adoptedSource) {
    if (context.template && !sameFormatTemplate(context.template, context.adoptedSource)) return null;
    return candidates.find(m => sameFormatTemplate(m, context.adoptedSource)) ?? null;
  }
  return context.template
    ? candidates.find(m => sameFormatTemplate(m, context.template)) ?? null
    : recommendFormatTemplate(candidates, context.sources ?? []);
}

export function formatTemplatePin(material: Material): FormatTemplatePin {
  return { material_id: material.material_id, material_version: material.material_version, sha256: material.sha256 };
}

/** Keep material choices consistent with the adopted manuscript and API input lock. */
export function formatTemplateLocked(material: Material, context: SourceFormatContext): boolean {
  return Boolean(context.disabled || context.adoptedSource && !sameFormatTemplate(material, context.adoptedSource));
}

export function formatTemplateDescription(material: Material, context: SourceFormatContext): string {
  if (context.adoptedSource && !sameFormatTemplate(material, context.adoptedSource)) return '参考稿用于补充内容，本轮沿用已采用稿格式。';
  return material.media_type === 'application/pdf' ? 'PDF 原稿将重建为可编辑 Word，版式可能有所变化。' : '沿用本稿的字体、段落和表格格式，按本期要求更新内容。';
}

export function formatTemplateChoice(material: Material, context: SourceFormatContext): string {
  if (!['historical', 'reference'].includes(material.role)) return '';
  const selected = sameFormatTemplate(material, selectedFormatTemplate(context));
  const locked = formatTemplateLocked(material, context);
  return `<div class="source-format-choice"${context.inheritedFromResult ? ' hidden' : ''}><label><input type="radio" name="${esc(context.group ?? 'source-format-template')}" data-format-template="${esc(material.material_id)}" value="${esc(material.material_id)}" aria-label="沿用${esc(material.filename)}格式"${selected ? ' checked' : ''}${locked ? ' data-format-template-locked' : ''}${locked || context.inheritedFromResult ? ' disabled' : ''}><span>沿用此稿格式${selected && !context.template ? '（自动选择）' : ''}</span></label><small>${formatTemplateDescription(material, context)}</small></div>`;
}

export function formatTemplateNotice(context: SourceFormatContext): string {
  const selected = selectedFormatTemplate(context);
  const conflict = context.adoptedSource && context.template && !sameFormatTemplate(context.template, context.adoptedSource);
  const description = conflict
    ? `<span class="source-format-warning" role="status">格式模板与当前已采用原稿不同，请恢复自动选择，或先改用对应原稿。</span><button type="button" class="text-button" data-format-template-auto${context.disabled ? ' disabled' : ''}>恢复自动选择</button>`
    : context.adoptedSource && !selected && !context.inheritedFromResult
    ? '<span class="source-format-warning" role="status">已采用原稿的准确材料版本尚未确认，请刷新已保存材料后再试。</span>'
    : context.template && !selected
    ? `<span class="source-format-warning" role="status">原格式模板已更换或移除，请重新选择。</span><button type="button" class="text-button" data-format-template-auto${context.disabled ? ' disabled' : ''}>重新自动选择</button>`
    : selected ? `${context.template ? '格式模板' : '自动采用格式'}：${esc(selected.filename)}${context.template ? `<button type="button" class="text-button" data-format-template-auto${context.disabled ? ' disabled' : ''}>恢复自动选择</button>` : ''}` : '';
  return `<div class="source-format-notice"><p data-format-template-result${context.inheritedFromResult ? '' : ' hidden'}>沿用所选成果格式，参考原稿仅用于补充内容。</p><p data-format-template-details${context.inheritedFromResult ? ' hidden' : ''}>${description}</p></div>`;
}

/** Keep the existing continuation selector authoritative without a second saved choice. */
export function syncFormatTemplateMode(root: ParentNode, inherited: boolean) {
  root.querySelectorAll<HTMLElement>('[data-format-template-result]').forEach(node => { node.hidden = !inherited; });
  root.querySelectorAll<HTMLElement>('[data-format-template-details],.source-format-choice').forEach(node => { node.hidden = inherited; });
  root.querySelectorAll<HTMLInputElement>('[data-format-template]').forEach(node => { node.disabled = inherited || node.hasAttribute('data-format-template-locked'); });
}
