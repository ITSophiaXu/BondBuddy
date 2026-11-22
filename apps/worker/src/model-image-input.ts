import { createHash } from 'node:crypto';
import type { PrivateBlobs } from '@bondbuddy/api/data';

/** One small host-captured PNG; never an arbitrary path or remote image URL. */
export type ModelImageInput = { png: Buffer; sha256: string };
export type ModelImageRef = { sha256: string; byte_size: number };
type Scope = { owner_user_id: string; project_id: string; id: string };
const maxBytes = 1024 * 1024;
export function validateModelImage(image: ModelImageInput) {
  const b = image.png;
  if (
    !Buffer.isBuffer(b) ||
    b.length < 33 ||
    b.length > maxBytes ||
    !b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    b.toString('ascii', 12, 16) !== 'IHDR' ||
    b.readUInt32BE(16) < 1 ||
    b.readUInt32BE(20) < 1 ||
    b.readUInt32BE(16) > 1024 ||
    b.readUInt32BE(20) > 1024 ||
    createHash('sha256').update(b).digest('hex') !== image.sha256
  )
    throw Error('MODEL_IMAGE_INPUT_INVALID');
}
function key(scope: Scope, sha: string) {
  if (
    !/^[a-f0-9]{64}$/.test(sha) ||
    ![scope.owner_user_id, scope.project_id, scope.id].every((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  )
    throw Error('MODEL_IMAGE_INPUT_INVALID');
  return `owners/${scope.owner_user_id}/projects/${scope.project_id}/runs/${scope.id}/model-images/${sha}.png`;
}
export async function saveModelImage(
  blobs: PrivateBlobs,
  scope: Scope,
  image: ModelImageInput,
): Promise<ModelImageRef> {
  validateModelImage(image);
  const ref = { sha256: image.sha256, byte_size: image.png.length };
  await blobs.put(key(scope, image.sha256), image.png, 'image/png');
  await loadModelImage(blobs, scope, ref);
  return ref;
}
export async function loadModelImage(
  blobs: PrivateBlobs,
  scope: Scope,
  value: unknown,
): Promise<ModelImageInput> {
  const ref = value as ModelImageRef | undefined;
  if (
    !ref ||
    typeof ref.sha256 !== 'string' ||
    !Number.isSafeInteger(ref.byte_size) ||
    ref.byte_size < 33 ||
    ref.byte_size > maxBytes
  )
    throw Error('MODEL_IMAGE_INPUT_INVALID');
  const png = await blobs.getIfExistsBounded(key(scope, ref.sha256), maxBytes);
  if (!png || png.length !== ref.byte_size) throw Error('MODEL_IMAGE_INPUT_INVALID');
  const image = { png, sha256: ref.sha256 };
  validateModelImage(image);
  return image;
}
