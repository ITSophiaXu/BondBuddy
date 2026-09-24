import type { Recognition } from '@bondbuddy/contracts';
import {
  parseAuthorizedMaterial,
  type AuthorizedMaterialParseInput,
  type MaterialParserDependencies,
} from './material-parser.js';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';

/** Trusted worker context for an immutable historical-material precheck. */
export interface HistoricalMaterialPrecheckInput extends Omit<AuthorizedMaterialParseInput, 'requiredRole'> {
  profileVersion: number;
}

/**
 * Runs the bounded native-text precheck for one owner-authorized historical
 * material version. The historical partition is validated by the same DB
 * lookup that authorizes access to the private bytes.
 */
export async function precheckHistoricalMaterial(
  dependencies: MaterialParserDependencies,
  input: HistoricalMaterialPrecheckInput,
): Promise<Recognition> {
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1) {
    throw new Error('INVALID_PROFILE_VERSION');
  }
  const parsed = await parseAuthorizedMaterial(dependencies, {
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    materialId: input.materialId,
    version: input.version,
    requestId: input.requestId,
    ...(input.options === undefined ? {} : { options: input.options }),
    requiredRole: 'historical',
  });
  return recognizeHistoricalNativeText(parsed, { profileVersion: input.profileVersion });
}
