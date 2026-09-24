import type { Recognition } from '@bondbuddy/contracts';
import {
  parseAuthorizedMaterial,
  type AuthorizedMaterialParseInput,
  type MaterialParserDependencies,
} from './material-parser.js';
import { HISTORICAL_NATIVE_RECOGNITION_VERSION, recognizeHistoricalNativeText } from './historical-native-recognition.js';
import {
  parseAndPersistAuthorizedMaterial,
  getParseSnapshotByParserVersion,
  type ParseEvidenceDependencies,
  type StoredParseSnapshot,
} from './parse-evidence-repository.js';
import {
  appendHistoricalRecognition,
  getLatestHistoricalProfile,
  type HistoricalProfileDependencies,
  type StoredHistoricalProfile,
} from './historical-profile-repository.js';

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

export interface HistoricalMaterialRecognitionDependencies {
  material: MaterialParserDependencies;
  evidence: ParseEvidenceDependencies;
  profiles: HistoricalProfileDependencies;
  /** Deployment-controlled parser identity; verified against each parse result. */
  parserVersion: string;
}

export interface StoredHistoricalMaterialRecognition {
  parseSnapshot: StoredParseSnapshot;
  profile: StoredHistoricalProfile;
}

/** Trusted worker composition: authorize, parse and persist evidence, then append recognition. */
export async function parsePersistAndRecognizeHistoricalMaterial(
  dependencies: HistoricalMaterialRecognitionDependencies,
  input: HistoricalMaterialPrecheckInput,
): Promise<StoredHistoricalMaterialRecognition> {
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1) throw new Error('INVALID_PROFILE_VERSION');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dependencies.parserVersion)) throw new Error('INVALID_PARSER_VERSION');
  const profileContext = {
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    materialId: input.materialId,
    materialVersion: input.version,
  };
  const existingProfile = await getLatestHistoricalProfile(dependencies.profiles, profileContext);
  const nativePrefix = `${HISTORICAL_NATIVE_RECOGNITION_VERSION}/`;
  const storedExtractorVersion = existingProfile?.recognition.source_market.provenance.extractor_version;
  if (existingProfile !== null && storedExtractorVersion === `${nativePrefix}${dependencies.parserVersion}`) {
    const parseSnapshot = await getParseSnapshotByParserVersion(dependencies.evidence, profileContext, dependencies.parserVersion);
    const optionsMatch = parseSnapshot !== null && (parseSnapshot.requestOptions.max_pages ?? null) === (input.options?.max_pages ?? null);
    if (parseSnapshot !== null && optionsMatch) return { parseSnapshot, profile: existingProfile };
  }
  const parseSnapshot = await parseAndPersistAuthorizedMaterial(dependencies.material, dependencies.evidence, {
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    materialId: input.materialId,
    version: input.version,
    requestId: input.requestId,
    ...(input.options === undefined ? {} : { options: input.options }),
    requiredRole: 'historical',
  });
  if (parseSnapshot.parserVersion !== dependencies.parserVersion) throw new Error('HISTORICAL_PARSER_VERSION_MISMATCH');
  const recognition = recognizeHistoricalNativeText(parseSnapshot.response, { profileVersion: input.profileVersion });
  const profile = await appendHistoricalRecognition(dependencies.profiles, { ...profileContext, requestId: input.requestId }, recognition);
  return { parseSnapshot, profile };
}
