import {UserFacingError} from './user-facing-error.js';
import { MARKET_LABELS, OFFERING_LABELS, type ProspectusVersion, type TargetReportingPeriod } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import type { DraftFields } from './draft.js';
import { esc } from './ui.js';

export type ContinuationChoice = 'result' | 'current';
export type ContinuationBasis = {
  choice: ContinuationChoice;
  selectionRevision: number;
  version: ProspectusVersion | null;
  editBase: Exclude<Dto<'InputRevisionCreateRequest'>['edit_base'], undefined>;
  key: string;
};

/** Ordinary assistant preparation uses the current manuscript default unless a result was explicitly selected. */
export function assistantAuthoringEditBase(base: NonNullable<Dto<'InputRevisionCreateRequest'>['edit_base']> | null | undefined):
  Pick<Dto<'InputRevisionCreateRequest'>, 'edit_base'> {
  return base ? { edit_base: { artifact_id: base.artifact_id, artifact_version: base.artifact_version, sha256: base.sha256 } } : {};
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim().length > 0;
const positiveRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function checkedVersion(version: ProspectusVersion): ProspectusVersion {
  if (!validId(version.version_id) || !positiveRevision(version.sequence) || typeof version.filename !== 'string' || !validHash(version.sha256)) {
    throw new UserFacingError('募集书版本记录不完整，请重新读取后再继续。');
  }
  if (version.origin === 'generated') {
    if (!validId(version.run_id) || !validId(version.revision_artifact_id) || !validId(version.artifact_id) ||
        !positiveRevision(version.artifact_version) || version.artifact_id === version.revision_artifact_id) {
      throw new UserFacingError('清洁版成果的准确版本尚未确认，请重新读取后再继续。');
    }
  } else if (version.origin === 'upload') {
    if (!validId(version.material_id) || !positiveRevision(version.material_version)) {
      throw new UserFacingError('募集书原文件的准确版本尚未确认，请重新读取后再继续。');
    }
  } else {
    throw new UserFacingError('募集书版本来源无法确认，请重新读取后再继续。');
  }
  return { ...version };
}

/** Resolve an explicit pin; omission must never re-enable the server's automatic baseline choice. */
export function resolveContinuationBasis(
  versions: Dto<'ProspectusVersionsResponse'>,
  projectId: string,
  run: Dto<'RunResponse'>,
  choice: ContinuationChoice,
): ContinuationBasis {
  if (!validId(projectId) || versions.project_id !== projectId || run.project_id !== projectId) {
    throw new UserFacingError('项目版本记录与当前项目不一致，请重新读取后再继续。');
  }
  if (!Number.isSafeInteger(versions.selection_revision) || versions.selection_revision < 0 ||
      versions.current_version_id !== null && !validId(versions.current_version_id) || !Array.isArray(versions.versions)) {
    throw new UserFacingError('项目当前稿状态无法确认，请重新读取后再继续。');
  }
  let version: ProspectusVersion | null;
  if (choice === 'result') {
    if (run.state !== 'succeeded' || run.channel !== 'production' || !validId(run.run_id) || !validId(run.artifact_id)) {
      throw new UserFacingError('本轮尚无成功交付的正式清洁版，请选择项目当前稿。');
    }
    const matches = versions.versions.filter(item => item.origin === 'generated' && item.run_id === run.run_id);
    if (!matches.length) throw new UserFacingError('未找到本轮成果的清洁版记录，请重新读取后再继续。');
    if (matches.length !== 1) throw new UserFacingError('本轮成果的清洁版记录不唯一，请重新读取后再继续。');
    version = checkedVersion(matches[0]);
    if (version.revision_artifact_id !== run.artifact_id) {
      throw new UserFacingError('本轮成果与募集书版本记录不一致，请重新读取后再继续。');
    }
    if (versions.versions.filter(item => item.version_id === version!.version_id).length !== 1) {
      throw new UserFacingError('募集书版本记录不唯一，请重新读取后再继续。');
    }
  } else if (choice === 'current') {
    if (versions.current_version_id === null) version = null;
    else {
      const matches = versions.versions.filter(item => item.version_id === versions.current_version_id);
      if (!matches.length) throw new UserFacingError('未找到项目当前稿的准确版本，请重新读取后再继续。');
      if (matches.length !== 1) throw new UserFacingError('项目当前稿的版本记录不唯一，请重新读取后再继续。');
      version = checkedVersion(matches[0]);
    }
  } else {
    throw new UserFacingError('请选择本轮采用的募集书版本。');
  }
  const editBase: ContinuationBasis['editBase'] = version?.origin === 'generated'
    ? { artifact_id: version.artifact_id!, artifact_version: version.artifact_version!, sha256: version.sha256 }
    : null;
  const key = JSON.stringify([choice, projectId, versions.selection_revision, versions.current_version_id,
    version ? [version.version_id, version.sequence, version.origin, version.material_id, version.material_version,
      version.artifact_id, version.artifact_version, version.sha256, version.revision_artifact_id, version.run_id] : null]);
  return { choice, selectionRevision: versions.selection_revision, version, editBase, key };
}

function periodSummary(period: TargetReportingPeriod): string {
  const kind = period.period_kind === 'annual' ? '年度' : period.period_kind === 'interim' ? '一期' : '期间类型待填写';
  const scope = period.scope === 'consolidated' ? '合并口径' : period.scope === 'parent' ? '母公司口径' : '口径待填写';
  const status = period.status === 'needs_confirmation' ? '待确认' : '用户填写';
  return [period.start ?? '起始日待填写', '至', period.end ?? '截止日待填写', '·', kind, '·', scope, '·', status].map(esc).join(' ');
}

/** Describe the supplied draft and saved receipts without inferring financial coverage or review. */
export function renderContinuationSummary(basis: ContinuationBasis, fields: DraftFields, materials: readonly Dto<'MaterialResponse'>[]): string {
  const version = basis.version;
  const periods = fields.update_details.target_reporting_periods ?? [];
  const market = fields.market ? MARKET_LABELS[fields.market] : '市场待填写';
  const offering = fields.offering ? OFFERING_LABELS[fields.offering] : '品种待填写';
  return `<section class="continuation-summary" aria-label="本轮材料与要求"><h3>本轮材料与要求</h3><dl><dt>本轮采用</dt><dd>${version
    ? `V${esc(version.sequence)} · ${esc(version.filename)} · ${version.origin === 'generated' ? '清洁版' : '原文件'}`
    : '项目尚未采用募集书，本轮按发行人材料编制。'}</dd><dt>目标发行人</dt><dd>${esc(fields.issuer_name || '待填写')}</dd><dt>目标市场与品种</dt><dd>${esc(market)} · ${esc(offering)}</dd><dt>目标报告期</dt><dd>${periods.length
      ? `<ul>${periods.map(period => `<li>${periodSummary(period)}</li>`).join('')}</ul>`
      : `尚未填写目标报告期。${fields.update_details.reporting_cutoff ? `财务截止日：${esc(fields.update_details.reporting_cutoff)}。` : ''}`}</dd><dt>已保存材料</dt><dd>${esc(materials.length)} 份</dd></dl><details><summary>查看已保存材料（${esc(materials.length)} 份）</summary>${materials.length
        ? `<ul>${materials.map(material => `<li>${esc(material.filename)} · 材料版本 ${esc(material.material_version)}</li>`).join('')}</ul>`
        : '<p>尚无已保存材料。</p>'}</details></section>`;
}
