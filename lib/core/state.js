/**
 * Local state: settings.json, base manifests, snapshots index and secrets.
 *
 * State lives under `$DSH_HOME/dsh-sync-hub/` when running inside DSH; tests and
 * scripts point `stateRoot` somewhere temporary so a backup test never touches
 * the real profile.
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isAbsoluteAnyPlatform, trimTrailingSeparators } from './paths.js'
import { normalizeSessionId, normalizeSelectedSessionIds, sessionPathKeyOf } from './sessions.js'
import { defaultScopeSettings, SCOPES } from './scopes.js'
import { ensureDir, readJson, writeJson } from './util.js'

export const SETTINGS_SCHEMA = 'dsh-sync-hub/v1/settings'
export const BASE_SCHEMA = 'dsh-sync-hub/v1/base'

/** Fresh settings for a new installation. */
export function defaultSettings() {
  return {
    schema: SETTINGS_SCHEMA,
    version: 1,
    deviceId: randomUUID(),
    deviceName: hostname() || 'device',
    targets: [],
    customItems: [],
    scopes: defaultScopeSettings(),
    direction: 'both',
    strategy: 'smart',
    force: false,
    deleteMode: 'ask',
    /** Sidebar progress visibility: 'running' | 'always' | 'hidden'. */
    sidebarProgressMode: 'running',
    /** Seconds between sidebar pending-count scans; 0 disables periodic scans. */
    pendingRefreshSeconds: 600,
    /**
     * Session workspace path mappings: source prefix (another computer's user
     * directory) -> target prefix on this machine. Kept for compatibility; new
     * mappings are written to `sessionPaths` instead.
     */
    sessionPathMappings: {},
    /**
     * Per-session local root paths, keyed by session id and then by
     * `<deviceName>|<osUserName>`:
     *
     *   { "<sessionId>": { "PC-A|alice": "D:\\work\\demo" } }
     *
     * Restore/migration resolves a session's target path from this table first,
     * so the same session can live in a different place for every device/user.
     */
    sessionPaths: {},
    /**
     * When true, restore replaces an old user folder (`C:\Users\old\...`) with
     * the current user's folder without asking. Defaults to false: the user
     * presses the "快捷替换用户目录" button instead.
     */
    autoReplaceUserFolder: false,
    historyLimit: 30,
    exclude: { extra: [] },
    autoSync: { enabled: false, intervalMinutes: 60 },
  }
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('target must be an object')
  const kind = target.kind ?? 'local'
  if (kind !== 'local') {
    throw new Error(`unsupported target kind in v0.1: ${kind} (only "local" is implemented)`)
  }
  const devicePaths = {}
  if (target.devicePaths && typeof target.devicePaths === 'object' && !Array.isArray(target.devicePaths)) {
    for (const [device, value] of Object.entries(target.devicePaths)) {
      const name = String(device).trim()
      const path = typeof value === 'string' ? value.trim() : ''
      if (name && path) devicePaths[name] = path
    }
  }
  return {
    id: typeof target.id === 'string' && target.id.length > 0 ? target.id : `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: String(target.name ?? '本地目录'),
    kind,
    enabled: target.enabled !== false,
    path: String(target.path ?? ''),
    devicePaths,
    prefix: typeof target.prefix === 'string' && target.prefix.length > 0 ? target.prefix : 'dsh-sync/v1',
  }
}

/** Normalize one user-defined directory/file sync item. */
function normalizeCustomItem(item) {
  if (!item || typeof item !== 'object') throw new Error('custom item must be an object')
  const type = item.type === 'file' ? 'file' : 'dir'
  const devicePaths = {}
  if (item.devicePaths && typeof item.devicePaths === 'object' && !Array.isArray(item.devicePaths)) {
    for (const [device, value] of Object.entries(item.devicePaths)) {
      const name = String(device).trim()
      const path = typeof value === 'string' ? value.trim() : ''
      if (name && path) devicePaths[name] = path
    }
  }
  return {
    id: typeof item.id === 'string' && item.id.length > 0
      ? item.id
      : `c_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    name: String(item.name ?? '自定义同步项').trim() || '自定义同步项',
    type,
    path: String(item.path ?? ''),
    devicePaths,
    enabled: item.enabled !== false,
  }
}

/** Validate and normalize a settings object. */
export function normalizeSettings(input) {
  const base = defaultSettings()
  const next = { ...base, ...input }
  next.targets = Array.isArray(next.targets) ? next.targets.map(normalizeTarget) : []
  next.customItems = Array.isArray(next.customItems)
    ? next.customItems.filter((item) => item && typeof item === 'object').map(normalizeCustomItem)
    : []
  next.scopes = { ...base.scopes }
  for (const [scopeId, value] of Object.entries(input?.scopes ?? {})) {
    if (!next.scopes[scopeId] || typeof value !== 'object') continue
    next.scopes[scopeId] = { ...next.scopes[scopeId], ...value }
  }
  for (const scope of SCOPES) {
    if (!next.scopes[scope.id]) next.scopes[scope.id] = { enabled: scope.enabledByDefault }
    if (scope.profiles && !Array.isArray(next.scopes[scope.id].profiles)) {
      next.scopes[scope.id].profiles = [...scope.profiles]
    }
  }
  // Sessions: 'all' keeps the historical full-sync behaviour; 'selected' only
  // syncs the listed ids so a newly created session is never added silently.
  const sessionScope = next.scopes.sessions ?? { enabled: true }
  if (!['all', 'selected'].includes(sessionScope.mode)) sessionScope.mode = 'all'
  sessionScope.selectedSessionIds = normalizeSelectedSessionIds(sessionScope.selectedSessionIds)
  next.scopes.sessions = sessionScope
  if (!['both', 'push', 'pull'].includes(next.direction)) next.direction = 'both'
  next.strategy = 'smart'
  next.force = next.force === true
  if (!['restore', 'mirror', 'ignore', 'ask'].includes(next.deleteMode)) next.deleteMode = 'ask'
  if (!['running', 'always', 'hidden'].includes(next.sidebarProgressMode)) next.sidebarProgressMode = 'running'
  const pendingSeconds = Number(next.pendingRefreshSeconds)
  next.pendingRefreshSeconds = Number.isFinite(pendingSeconds) && pendingSeconds >= 0
    ? Math.min(3600, Math.round(pendingSeconds))
    : 600
  const mappings = {}
  if (next.sessionPathMappings && typeof next.sessionPathMappings === 'object' && !Array.isArray(next.sessionPathMappings)) {
    for (const [source, target] of Object.entries(next.sessionPathMappings)) {
      const from = String(source).trim().replace(/[\\/]+$/, '')
      const to = typeof target === 'string' ? target.trim().replace(/[\\/]+$/, '') : ''
      if (from && to) mappings[from] = to
    }
  }
  next.sessionPathMappings = mappings
  // Session root paths: { "<device>|<user>": { "<sessionId>": "<absolute>" } }.
  // The legacy session-first shape (sessionId -> device map) is converted on
  // read so existing settings keep working after the 2026-11-16 inversion.
  // Every key/value is validated here (server side), so a malformed settings
  // patch can never introduce a relative path or an unknown session id.
  const sessionPaths = {}
  if (next.sessionPaths && typeof next.sessionPaths === 'object' && !Array.isArray(next.sessionPaths)) {
    let keyCount = 0
    for (const [rawKey, rawMap] of Object.entries(next.sessionPaths)) {
      if (keyCount >= 64) break
      if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) continue
      const legacySessionId = normalizeSessionId(rawKey)
      const legacyShape = !!legacySessionId
        && Object.keys(rawMap).some((innerKey) => String(innerKey).includes('|'))
      if (legacyShape) {
        let mappingCount = 0
        for (const [rawDeviceKey, rawValue] of Object.entries(rawMap)) {
          if (mappingCount >= 16) break
          const separator = String(rawDeviceKey).indexOf('|')
          if (separator <= 0) continue
          const key = sessionPathKeyOf(String(rawDeviceKey).slice(0, separator), String(rawDeviceKey).slice(separator + 1))
          const value = typeof rawValue === 'string' ? rawValue.trim() : ''
          if (!key || !isAbsoluteAnyPlatform(value)) continue
          sessionPaths[key] ??= {}
          sessionPaths[key][legacySessionId] = trimTrailingSeparators(value)
          mappingCount += 1
        }
        if (mappingCount > 0) keyCount += 1
        continue
      }
      const separator = String(rawKey).indexOf('|')
      if (separator <= 0) continue
      const key = sessionPathKeyOf(String(rawKey).slice(0, separator), String(rawKey).slice(separator + 1))
      if (!key) continue
      const perSession = {}
      let sessionCount = 0
      for (const [rawSessionId, rawValue] of Object.entries(rawMap)) {
        if (sessionCount >= 5000) break
        const sessionId = normalizeSessionId(rawSessionId)
        const value = typeof rawValue === 'string' ? rawValue.trim() : ''
        if (!sessionId || !isAbsoluteAnyPlatform(value)) continue
        perSession[sessionId] = trimTrailingSeparators(value)
        sessionCount += 1
      }
      if (sessionCount > 0) {
        sessionPaths[key] = perSession
        keyCount += 1
      }
    }
  }
  next.sessionPaths = sessionPaths
  next.autoReplaceUserFolder = next.autoReplaceUserFolder === true
  next.historyLimit = Math.min(200, Math.max(1, Number(next.historyLimit) || 30))
  next.exclude = {
    extra: Array.isArray(next.exclude?.extra)
      ? next.exclude.extra.filter((item) => typeof item === 'string' && item.length > 0)
      : [],
  }
  next.autoSync = {
    enabled: next.autoSync?.enabled === true,
    intervalMinutes: Math.min(1440, Math.max(15, Number(next.autoSync?.intervalMinutes) || 60)),
  }
  return next
}

/** Merge a partial settings patch (targets replaced, scopes merged per id). */
export function mergeSettings(current, patch) {
  const next = { ...current }
  if (Array.isArray(patch?.targets)) next.targets = patch.targets
  if (Array.isArray(patch?.customItems)) next.customItems = patch.customItems
  if (patch?.scopes && typeof patch.scopes === 'object') {
    next.scopes = { ...current.scopes }
    for (const [scopeId, value] of Object.entries(patch.scopes)) {
      if (!next.scopes[scopeId] || typeof value !== 'object') continue
      next.scopes[scopeId] = { ...next.scopes[scopeId], ...value }
    }
  }
  if (patch?.exclude && Array.isArray(patch.exclude.extra)) {
    next.exclude = { extra: patch.exclude.extra }
  }
  if (patch?.autoSync && typeof patch.autoSync === 'object') {
    next.autoSync = { ...current.autoSync, ...patch.autoSync }
  }
  for (const key of ['deviceName', 'direction', 'force', 'deleteMode', 'sidebarProgressMode', 'pendingRefreshSeconds', 'sessionPathMappings', 'sessionPaths', 'autoReplaceUserFolder', 'historyLimit']) {
    if (patch?.[key] !== undefined) next[key] = patch[key]
  }
  return normalizeSettings(next)
}

/** Resolve the directory a target uses on one device. */
export function targetPathForDevice(target, deviceName) {
  if (!target) return ''
  const mapped = target.devicePaths && deviceName ? target.devicePaths[deviceName] : ''
  return mapped || target.path || ''
}

/** Settings + state files for one installation. */
export class StateStore {
  constructor(stateRoot) {
    this.root = stateRoot
  }

  get settingsPath() {
    return join(this.root, 'settings.json')
  }

  get secretsPath() {
    return join(this.root, 'secrets.json')
  }

  get ignorePath() {
    return join(this.root, '.dshsyncignore')
  }

  targetDir(targetId) {
    return join(this.root, 'state', targetId)
  }

  baseManifestPath(targetId) {
    return join(this.targetDir(targetId), 'base-manifest.json')
  }

  lastRunPath(targetId) {
    return join(this.targetDir(targetId), 'last-run.json')
  }

  autoSyncStatePath() {
    return join(this.root, 'state', 'auto-sync.json')
  }

  async loadAutoSyncState() {
    return await readJson(this.autoSyncStatePath(), null)
  }

  async saveAutoSyncState(state) {
    await writeJson(this.autoSyncStatePath(), state)
    return state
  }

  backupsDir(stamp) {
    return join(this.root, 'backups', stamp)
  }

  async ensure() {
    await ensureDir(this.root)
  }

  async loadSettings() {
    const stored = await readJson(this.settingsPath, null)
    const settings = stored ? normalizeSettings(stored) : defaultSettings()
    if (!stored) await this.saveSettings(settings)
    return settings
  }

  async saveSettings(settings) {
    const normalized = normalizeSettings(settings)
    await writeJson(this.settingsPath, normalized)
    return normalized
  }

  async loadBaseManifest(targetId) {
    return await readJson(this.baseManifestPath(targetId), {
      schema: BASE_SCHEMA,
      targetId,
      updatedAt: '',
      scopes: {},
    })
  }

  async saveBaseManifest(targetId, manifest) {
    const value = { ...manifest, schema: BASE_SCHEMA, targetId, updatedAt: new Date().toISOString() }
    await writeJson(this.baseManifestPath(targetId), value)
    return value
  }

  async saveLastRun(targetId, result) {
    await writeJson(this.lastRunPath(targetId), result)
  }

  async loadLastRun(targetId) {
    return await readJson(this.lastRunPath(targetId), null)
  }

  /** Extra excludes from `$DSH_HOME/dsh-sync-hub/.dshsyncignore`. */
  async loadIgnorePatterns() {
    try {
      const { promises: fsp } = await import('node:fs')
      const text = await fsp.readFile(this.ignorePath, 'utf8')
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Reserved for future WebDAV/S3 targets; unused by local-dir in v0.1. */
  async loadSecrets() {
    return await readJson(this.secretsPath, { version: 1, secrets: {} })
  }

  async saveSecrets(value) {
    await writeJson(this.secretsPath, value)
    return value
  }
}
