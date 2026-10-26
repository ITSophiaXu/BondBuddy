import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  M1_UPLOAD_MATERIAL_ROLES, M4DocumentManifestSchema, ProjectMessageSetMemberSchema,
  ReviewDraftInputSchema, ReviewExecutionOriginSchema, ReviewMaterialPinSchema,
  RunSupplementChangeSchema, RunSupplementMaterialSchema, SourceProspectusSchema, UpdateDetailsSchema,
  emptyUpdateDetails, sourceProspectusInputGaps, updateDetailsErrors,
  type ReviewMaterialPin, type RunSupplementChange, type RunSupplementInputPreview, type RunSupplementMaterial,
  type RunSupplementDraftResponse, type SourceProspectus,
} from '@bondbuddy/contracts';
import { digest } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

type RecordValue = Record<string, any>;
type BaseMaterial = ReviewMaterialPin & { source_project_id: string; role?: string };
type Issue = RunSupplementInputPreview['issues'][number];
type Candidate = { manifest: Record<string, unknown>; reviewSnapshot: unknown | null };
type Result = { preview: RunSupplementInputPreview; candidate: Candidate | null };
type Args = {
  projectId: string; manifest: unknown; reviewSnapshot: unknown | null;
  resultMaterials: RunSupplementMaterial[]; changes: RunSupplementChange[];
};

const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const pin = (v: RecordValue): ReviewMaterialPin => ({ material_id: v.material_id, material_version: v.material_version, sha256: v.sha256 });
const key = (v: ReviewMaterialPin) => `${v.material_id}\0${v.material_version}\0${v.sha256}`;
const same = (a: unknown, b: unknown) => inputManifestHash(a ?? null) === inputManifestHash(b ?? null);
// Schema validation is a boolean boundary here: the cloned record also serves
// the non-M4 branches, so an M4 type predicate must not narrow their shared variable.
const validM4Document = (value: unknown): boolean => Value.Check(M4DocumentManifestSchema, value);
const issue = (code: Issue['code'], message: string, material_id: string | null = null): Issue => ({ code, message, material_id });
function output(status: RunSupplementInputPreview['status'], issues: Issue[] = [], candidate: Candidate | null = null): Result {
  const compiler_version = 'run-supplement-input-v1' as const;
  if (status === 'prepared' && candidate) return { preview: { compiler_version, status,
    issues: [], candidate_input_hash: inputManifestHash(candidate.manifest) }, candidate };
  if (status === 'unchanged') return { preview: { compiler_version, status, issues: [], candidate_input_hash: null }, candidate: null };
  if (status === 'needs_information') return { preview: { compiler_version, status, issues, candidate_input_hash: null }, candidate: null };
  return { preview: { compiler_version, status: 'unsupported', issues, candidate_input_hash: null }, candidate: null };
}
const unsupported = () => output('unsupported', [issue('input_unsupported', '当前任务的材料关联尚不能完整核对，草稿可以保存；暂不能采用。')]);

/** Frozen-input context only; current project declarations and automatic output selection are never consulted. */
export function runSupplementSourceContext(manifest: unknown): RunSupplementDraftResponse['source_context'] {
  if (!record(manifest) || manifest.review || manifest.version === 'm4-document-input-v1'
    || !record(manifest.authoring) || manifest.authoring.version !== 'unified_v1'
    || Object.hasOwn(manifest.authoring, 'review_result') || Object.hasOwn(manifest.authoring, 'review_revision')
    || !Value.Check(UpdateDetailsSchema, manifest.update_details) || manifest.update_details.authoring_mode !== 'unified_v1') return undefined;
  return { kind: 'm1_authoring', previous_output_bound: Object.hasOwn(manifest.authoring, 'previous_output')
    || Object.hasOwn(manifest.authoring, 'edit_baseline') };
}

/** Shared semantic validation for direct HTTP saves and the pure candidate compiler. */
export function validRunSupplementSourceChanges(manifest: unknown, changes: RunSupplementChange[], materials: RunSupplementMaterial[]): boolean {
  const context = runSupplementSourceContext(manifest);
  return changes.every(change => {
    if (change.source_prospectus === undefined && change.discard_previous_output === undefined) return true;
    const material = materials.find(value => key(value) === key(change.material));
    if (!context || !material || !['historical', 'reference'].includes(material.role)) return false;
    if (change.discard_previous_output !== undefined && !context.previous_output_bound) return false;
    const source = change.source_prospectus;
    return source === undefined || Value.Check(SourceProspectusSchema, source) && key(source) === key(change.material)
      && !updateDetailsErrors({ ...emptyUpdateDetails(), source_prospectuses: [source] }).length;
  });
}

/** A candidate is preparation only. This compiler neither adopts inputs nor grants execution authority. */
export function compileRunSupplementInput(args: Args): Result {
  const { projectId, manifest, reviewSnapshot, changes, resultMaterials } = args;
  if (!changes.length) return output('unchanged');
  if (!projectId || !Value.Check(Type.Array(RunSupplementChangeSchema, { maxItems: 60 }), changes)
    || !Value.Check(Type.Array(RunSupplementMaterialSchema, { maxItems: 300 }), resultMaterials)) return unsupported();
  if (!validRunSupplementSourceChanges(manifest, changes, resultMaterials)) return unsupported();
  const unavailable = resultMaterials.filter(material => !material.available)
    .map(material => issue('material_unavailable', '这份材料暂时无法读取，请恢复材料后再继续。', material.material_id));
  if (unavailable.length) return output('needs_information', unavailable);
  if (!record(manifest)) return unsupported();

  const m = structuredClone(manifest);
  const snapshot = structuredClone(reviewSnapshot);
  const isM4 = m.version === 'm4-document-input-v1';
  let base: BaseMaterial[];
  if (isM4) {
    if (!validM4Document(m)) return unsupported();
    base = [...m.input.materials, ...(m.input.source_material ? [m.input.source_material] : []),
      ...(m.template_material ? [m.template_material] : [])];
  } else {
    if (!Array.isArray(m.materials) || !m.materials.every((value: unknown) => record(value)
      && Value.Check(ReviewMaterialPinSchema, pin(value))
      && (M1_UPLOAD_MATERIAL_ROLES as readonly string[]).includes(value.role))) return unsupported();
    base = m.materials.map((value: RecordValue) => ({ ...pin(value), role: value.role, source_project_id: projectId }));
  }
  // The public replacement pin has no project field, so an ambiguous cross-project pin cannot be guessed.
  const byPin = new Map<string, BaseMaterial>();
  for (const material of base) {
    const prior = byPin.get(key(material));
    if (prior && prior.source_project_id !== material.source_project_id) return unsupported();
    if (!prior) byPin.set(key(material), material);
  }
  base = [...byPin.values()];
  const replacements = new Map<string, RunSupplementMaterial>();
  const additions: RunSupplementMaterial[] = [];
  const changedIds = new Set<string>();
  for (const change of changes) {
    const material = resultMaterials.find(value => key(value) === key(change.material) && value.source_project_id === projectId);
    if (!material || changedIds.has(material.material_id) || byPin.has(key(material))) return unsupported();
    changedIds.add(material.material_id);
    if (change.replaces) {
      const previous = byPin.get(key(change.replaces));
      if (!previous || replacements.has(key(previous)) || previous.role && previous.role !== material.role
        || base.some(value => value.material_id === material.material_id && value.material_id !== previous.material_id)) return unsupported();
      replacements.set(key(previous), material);
    } else {
      if (base.some(value => value.material_id === material.material_id)) return unsupported();
      additions.push(material);
    }
  }
  const expected = [...base.map(value => replacements.get(key(value)) ?? value), ...additions];
  if (expected.length !== resultMaterials.length || expected.some((value, index) => {
    const result = resultMaterials[index];
    return key(value) !== key(result) || value.source_project_id !== result.source_project_id || value.role && value.role !== result.role;
  })) return unsupported();

  const replacePins = (materials: RecordValue[], scoped: boolean) => [
    ...materials.map(value => {
      const replacement = replacements.get(key(pin(value)));
      return replacement ? scoped ? { ...pin(replacement), source_project_id: replacement.source_project_id }
        : { ...pin(replacement), role: replacement.role } : value;
    }),
    ...additions.map(value => scoped ? { ...pin(value), source_project_id: value.source_project_id } : { ...pin(value), role: value.role }),
  ];

  if (isM4) {
    const bound: Issue[] = [];
    for (const change of changes) {
      if (!change.replaces) continue;
      if (m.input.source_material && key(change.replaces) === key(m.input.source_material))
        bound.push(issue('m4_source_bound', '主文档已固定到原任务，请先确认新的主文档来源后再继续。', change.replaces.material_id));
      if (m.template_material && key(change.replaces) === key(m.template_material))
        bound.push(issue('m4_template_bound', '文书模板已固定到原任务，请先确认新的模板后再继续。', change.replaces.material_id));
    }
    if (bound.length) return output('needs_information', bound);
    m.input.materials = replacePins(m.input.materials, true);
    if (m.input.materials.length > 60) return output('needs_information', [issue('material_limit', '本次文书材料最多支持 60 份，请调整补充材料。')]);
    if (!validM4Document(m)) return unsupported();
    return output('prepared', [], { manifest: m, reviewSnapshot: snapshot });
  }

  const scopeBound = record(m.authoring) && (Object.hasOwn(m.authoring, 'review_result') || Object.hasOwn(m.authoring, 'review_revision'));
  if (scopeBound || record(m.review) && (m.review.operation === 'revision' || m.review.origin?.accepted_proposal
    || record(m.review.file_delivery) && Object.hasOwn(m.review.file_delivery, 'export')))
    return output('needs_information', [issue('review_scope_bound', '原任务包含已确认的复核范围，补料采用前需要保留并重新确认对应依据。')]);

  if (m.review) {
    const review = m.review;
    if (!record(review) || review.version !== 'review_v1' || !['full_review', 'differential_review'].includes(review.operation)
      || !Value.Check(ReviewDraftInputSchema, review.input) || !record(snapshot) || !same(snapshot.input, review.input)
      || !same(snapshot.origin ?? null, review.origin ?? null)
      || !same(review.input.material_versions, m.materials.map(pin))
      || !review.input.source_material_ref || !base.some(value => key(value) === key(review.input.source_material_ref))) return unsupported();
    if (review.origin !== undefined && (!Value.Check(ReviewExecutionOriginSchema, review.origin)
      || review.origin.entrypoint !== 'quick_action' || review.origin.accepted_proposal !== null)) return unsupported();
    const linkedReplacements = new Map<string, ReviewMaterialPin>();
    for (const link of review.input.evidence_links ?? []) {
      if (!review.input.material_versions.some((value: ReviewMaterialPin) => key(value) === key(link.material_ref))) return unsupported();
      if (replacements.has(key(link.material_ref))) linkedReplacements.set(key(link.material_ref), link.material_ref);
    }
    if (linkedReplacements.size) return output('needs_information', [...linkedReplacements.values()].map(value => issue('review_scope_bound',
      '这份材料已关联到原复核问题，替换前需要重新确认对应的证据关联。', value.material_id)));
    const sourceReplacement = replacements.get(key(review.input.source_material_ref));
    if (sourceReplacement && !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(sourceReplacement.media_type))
      return output('needs_information', [issue('review_scope_bound', '复核原稿需要使用 DOCX 或 PDF，请调整这份替换材料。', sourceReplacement.material_id)]);
    m.materials = replacePins(m.materials, false);
    if (m.materials.length > 60) return output('needs_information', [issue('material_limit', '本次复核材料最多支持 60 份，请调整补充材料。')]);
    review.input.material_versions = m.materials.map(pin);
    if (sourceReplacement) review.input.source_material_ref = pin(sourceReplacement);
    snapshot.input = structuredClone(review.input);
    if (!Value.Check(ReviewDraftInputSchema, review.input)) return unsupported();
    return output('prepared', [], { manifest: m, reviewSnapshot: snapshot });
  }

  const authoring = m.authoring;
  if (!record(authoring) || authoring.version !== 'unified_v1' || !Value.Check(UpdateDetailsSchema, m.update_details)
    || m.update_details.authoring_mode !== 'unified_v1'
    || !Value.Check(Type.Array(SourceProspectusSchema, { maxItems: 60 }), authoring.source_prospectuses)
    || !Value.Check(Type.Array(ProjectMessageSetMemberSchema, { maxItems: 500 }), authoring.requirements)
    || authoring.knowledge_status !== 'authoring_reference_not_compliance_approval' || !Array.isArray(authoring.knowledge)
    || !authoring.knowledge.every((value: unknown) => record(value) && typeof value.path === 'string' && value.path.length > 0
      && typeof value.markdown === 'string' && typeof value.sha256 === 'string' && digest(value.markdown) === value.sha256)) return unsupported();
  const sourceChanges = changes.filter(change => {
    const material = resultMaterials.find(value => key(value) === key(change.material))!;
    return ['historical', 'reference'].includes(material.role);
  });
  m.materials = replacePins(m.materials, false);
  if (m.materials.length > 60) return output('needs_information', [issue('material_limit', '本次编制材料最多支持 60 份，请调整补充材料。')]);
  const sourceIssues: Issue[] = [];
  if (sourceChanges.length) {
    const changed = new Set(sourceChanges.map(change => key(change.material)));
    const candidateSources: SourceProspectus[] = m.materials.filter((material: RecordValue) => ['historical', 'reference'].includes(material.role))
      .flatMap((material: RecordValue) => {
        if (changed.has(key(pin(material)))) {
          const declaration = sourceChanges.find(change => key(change.material) === key(pin(material)))?.source_prospectus;
          return declaration ? [structuredClone(declaration)] : [];
        }
        // An unchanged source retains only its exact frozen declaration; no ID-only/version fallback.
        return authoring.source_prospectuses.filter((source: SourceProspectus) => key(source) === key(pin(material)));
      });
    for (const gap of sourceProspectusInputGaps(m.materials, candidateSources)) sourceIssues.push(issue('source_information_required',
      `历史／参考募集书更换或补充后，需要重新填写这份原稿的信息：${gap.missing.join('、')}。`, gap.material_id));
    if (runSupplementSourceContext(manifest)?.previous_output_bound) {
      for (const change of sourceChanges) if (!change.discard_previous_output) sourceIssues.push(issue('source_baseline_choice_required',
        '原任务仍关联旧成果。请明确本次候选输入放弃旧成果关联，再按本次原稿准备。', change.material.material_id));
      // Only the cloned candidate loses its inherited output. The original run and files are untouched.
      delete authoring.previous_output;
      delete authoring.edit_baseline;
    }
    authoring.source_prospectuses = candidateSources;
    m.update_details.source_prospectuses = structuredClone(candidateSources);
  }
  if (sourceIssues.length) return output('needs_information', sourceIssues);
  return output('prepared', [], { manifest: m, reviewSnapshot: snapshot });
}
