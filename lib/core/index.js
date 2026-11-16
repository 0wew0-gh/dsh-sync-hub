/**
 * Public core entry (also exported as `dsh-sync-hub/core`).
 *
 * Keeps the host plugin, the CLI scripts and the tests on the same API.
 */

export { SyncEngine } from './engine.js'
export { SyncError } from './errors.js'
export { StateStore, defaultSettings, normalizeSettings, mergeSettings } from './state.js'
export { SCOPES, getScope, defaultScopeSettings, HARD_EXCLUDES, absPathForRel } from './scopes.js'
export { scanScope, estimateScopes } from './scan.js'
export { buildScopeManifest, planScope, mergeRemoteManifests, summarizeActions, emptyManifest, MANIFEST_SCHEMA } from './manifest.js'
export { createTarget, blobKey, manifestKey } from './targets/index.js'
export { listSnapshots, recordSnapshot, readSnapshot } from './history.js'
export { AutoSyncScheduler, autoSyncStatus, autoSyncIntervalMs } from './auto-sync.js'
export { resolveDshHome, resolveAgentsHome, assertSafeRel, normalizeTargetPath, isAbsoluteAnyPlatform, trimTrailingSeparators } from './paths.js'
export {
  applySessionSelection,
  normalizeSelectedSessionIds,
  normalizeSessionId,
  parseSessionRel,
  readSessionHeaderFile,
  sessionPathKeyOf,
  sessionPathsFor,
  suggestSessionCwd,
} from './sessions.js'
export { collapseSessionViews, canonicalSessionRel, groupSessionEntries, planSessionScope } from './session-plan.js'
export {
  appendRelation,
  chooseRestoreCwd,
  compareSessionsData,
  listLocalSessionData,
  overwriteSessions,
  readBackupSessionGroups,
  representativeLocalCopy,
  restoreSessionsFromBackup,
  syncSessionsToBackup,
} from './session-transfer.js'
export * as util from './util.js'
