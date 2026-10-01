/**
 * Compatibility entry point retained for worker call sites. The repository is
 * owned by the API package so HTTP and background orchestration share the
 * same owner-scoped queries, lock checks, and idempotency behavior.
 */
export {
  createUpdateDifficultySnapshot,
  createUpdateDifficultySnapshotWithClient,
  getCurrentUpdateDifficultySnapshot,
  getCurrentUpdateDifficultySnapshotWithClient,
  getUpdateDifficultySnapshot,
  getUpdateDifficultySnapshotWithClient,
  loadLockedUpdateDifficultyInput,
  loadLockedUpdateDifficultyInputWithClient,
} from '@bondbuddy/api/update-difficulty-repository';
export type {
  LockedUpdateDifficultyRequest,
  StoredUpdateDifficultySnapshot,
  TrustedUpdateDifficultyInput,
  UpdateDifficultyClient,
  UpdateDifficultyClientOptions,
  UpdateDifficultyDependencies,
  UpdateDifficultyPool,
} from '@bondbuddy/api/update-difficulty-repository';
