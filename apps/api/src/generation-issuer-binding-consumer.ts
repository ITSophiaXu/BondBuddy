/**
 * #33 guard-style consumption seam for an approved generation issuer binding.
 *
 * This module deliberately owns no persistence and no request schema. It only connects the
 * already-reviewed binding ledger (`generation-issuer-binding.ts`) to the generation input
 * gate: an exact, explicitly provided ref is re-verified against the caller's locked input
 * revision/hash before its issuer subject may be used. Missing, unreviewed, withdrawn,
 * conflicting, re-parsed, re-materialised or cross-account bindings fail closed with the
 * stable `issuer_identity_not_bound` code. Browser names, reference issuers and annual
 * business profiles never supply the subject.
 *
 * #17 owns the durable input-lock transaction and the eventual request field. Until that
 * lands this seam is injectable and off by default, so production keeps its current
 * rejection behavior and no public DTO changes.
 */
import {
  GENERATION_ISSUER_MATERIAL_ROLES,
  type GenerationIssuerBindingExpectedInput,
  type GenerationIssuerBindingRef,
  type GenerationIssuerBindingResponse,
} from '@bondbuddy/contracts';
import {
  loadApprovedGenerationIssuerBinding,
  type GenerationIssuerBindingPool,
} from './generation-issuer-binding.js';

export interface GenerationIssuerBindingScope {
  /** Authenticated principal; never request JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
}

/**
 * #17 stand-in for the explicit `generation_issuer_binding_ref` field: the trusted boundary that
 * provides the exact ref (and the locked input it targets). A browser or request body value is
 * never used directly. Returning null means fail closed.
 */
export interface GenerationIssuerBindingRefProvider {
  provide(input: GenerationIssuerBindingScope & { readonly inputRevision: number; readonly inputHash: string }):
    Promise<GenerationIssuerBindingRef | null>;
}

export type GenerationIssuerBindingLoader = (
  pool: Pick<GenerationIssuerBindingPool, 'query'>,
  scope: GenerationIssuerBindingScope,
  ref: GenerationIssuerBindingRef,
  expectedInput: GenerationIssuerBindingExpectedInput,
) => Promise<GenerationIssuerBindingResponse | null>;

/** Injected seam installed by #17/tests; absent means the current fail-closed behavior. */
export interface GenerationIssuerBindingSeam {
  readonly provider: GenerationIssuerBindingRefProvider;
  /** Trusted loader override for focused tests; production uses the real fail-closed loader. */
  readonly load?: GenerationIssuerBindingLoader;
}

export type GenerationIssuerBindingConsumption =
  | { readonly status: 'not_bound'; readonly reason: 'issuer_identity_not_bound' }
  | {
      readonly status: 'approved';
      readonly ref: GenerationIssuerBindingRef;
      readonly binding: GenerationIssuerBindingResponse;
      readonly issuer_entity_id: string;
    };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const issuerRoles = new Set<string>(GENERATION_ISSUER_MATERIAL_ROLES);

const notBound = (): GenerationIssuerBindingConsumption => ({ status: 'not_bound', reason: 'issuer_identity_not_bound' });

function isRefShape(value: GenerationIssuerBindingRef): boolean {
  return idPattern.test(value.binding_id) && Number.isSafeInteger(value.version) && value.version >= 1 && shaPattern.test(value.content_sha256);
}

/**
 * Re-verify an explicitly provided generation issuer binding and return its subject only when the
 * trusted loader confirms this exact ref for this exact locked input. Every failure path returns
 * the same stable `not_bound` value; callers must not fall back to any other subject source.
 */
export async function consumeGenerationIssuerBinding(
  pool: Pick<GenerationIssuerBindingPool, 'query'>,
  scope: GenerationIssuerBindingScope,
  seam: GenerationIssuerBindingSeam,
  expectedInput: GenerationIssuerBindingExpectedInput,
): Promise<GenerationIssuerBindingConsumption> {
  if (expectedInput.owner_user_id !== scope.ownerUserId || expectedInput.project_id !== scope.projectId ||
      !Number.isSafeInteger(expectedInput.input_revision) || expectedInput.input_revision < 1 ||
      !shaPattern.test(expectedInput.input_hash)) return notBound();
  let ref: GenerationIssuerBindingRef | null;
  try {
    ref = await seam.provider.provide({ ...scope, inputRevision: expectedInput.input_revision, inputHash: expectedInput.input_hash });
  } catch {
    return notBound();
  }
  if (!ref || !isRefShape(ref)) return notBound();
  const load = seam.load ?? loadApprovedGenerationIssuerBinding;
  let binding: GenerationIssuerBindingResponse | null;
  try {
    binding = await load(pool, scope, ref, expectedInput);
  } catch {
    return notBound();
  }
  if (!binding || binding.status !== 'approved' || !binding.issuer_entity_id) return notBound();
  // The loader already enforces these anchors; re-assert them so an injected override can never widen authority.
  if (binding.binding_id !== ref.binding_id || binding.version !== ref.version || binding.content_sha256 !== ref.content_sha256 ||
      binding.owner_user_id !== scope.ownerUserId || binding.project_id !== scope.projectId ||
      binding.input_revision !== expectedInput.input_revision || binding.input_hash !== expectedInput.input_hash) return notBound();
  if (!binding.selected_materials.length ||
      binding.selected_materials.some(pin => !issuerRoles.has(pin.role) || pin.identity_coverage !== 'complete' ||
        pin.identity_uncertainties.length > 0 || !shaPattern.test(pin.material_sha256))) return notBound();
  return {
    status: 'approved',
    ref: { binding_id: binding.binding_id, version: binding.version, content_sha256: binding.content_sha256 },
    binding,
    issuer_entity_id: binding.issuer_entity_id,
  };
}
