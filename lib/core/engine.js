/**
 * Sync engine.
 *
 * The engine is deliberately UI-agnostic: the DSH host plugin, the test suite
 * and the backup scripts all drive the same class. It implements the
 * "same content is a no-op" contract from DESIGN §5.2.1: plans compare
 * local/base/remote manifests, and writes only happen when bytes differ
 * (or when the explicit `force` switch is on).
 */

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SyncError } from './errors.js'
import {
  absPathForRel,
  customItemPath,
  customScopeId,
  enabledCustomItems,
  findCustomItem,
  getScope,
  isCustomScope,
  listProfileNames,
  resolvePluginsProfile,
  SCOPES,
} from './scopes.js'
import { scanScope } from './scan.js'
import { buildScopeManifest, MANIFEST_SCHEMA, mergeRemoteManifests, planScope, summarizeActions } from './manifest.js'
import { mergeSettings, normalizeSettings, StateStore, targetPathForDevice } from './state.js'
import { createTarget, blobKey, manifestKey } from './targets/index.js'
import { listSnapshots, recordSnapshot } from './history.js'
import { assertSafeRel, decodeWorkspaceDir, defaultTargetPrefix, normalizeTargetPath, resolveDshVersion } from './paths.js'
import { applyPluginState, pluginStateKey, readPluginState } from './plugin-state.js'
import { SESSION_LOG_PATTERN, parseSessionRel, readSessionHeader, rewriteSessionCwd, sessionPathKeyOf } from './sessions.js'
import { collapseSessionViews } from './session-plan.js'
import {
  appendRelation,
  compareSessionsData,
  listLocalSessionData,
  overwriteSessions as overwriteSessionsOnTarget,
  readBackupSessionGroups,
  restoreSessionsFromBackup,
  syncSessionsToBackup,
} from './session-transfer.js'
import { atomicWrite, ensureDir, sha256Buffer, sha256File, statOrUndefined, timestampSlug } from './util.js'

const META_SCHEMA = 'dsh-sync/v1/meta'

/** npm package name encoded in a `plugins/<profile>/packages/<name>/...` key. */
function pluginPackageName(rel) {
  const match = /^plugins\/[^/]+\/packages\/(.+)$/.exec(String(rel ?? ''))
  if (!match) return ''
  const parts = match[1].split('/')
  const head = parts[0]
  return head && head.startsWith('@') && parts[1] ? head + '/' + parts[1] : head
}

/** Built-in capability configuration entries shown by DSH's own plugin page. */
const BUILTIN_PLUGIN_CONFIGS = [
  { id: 'subagent', name: '子智能体', description: '设置子智能体的递归层级、数量和模型' },
  { id: 'web', name: '网页搜索与获取', description: '选择网页搜索与网页获取使用的提供方' },
  { id: 'agent-loop', name: 'Agent 循环', description: '控制 Agent 派发工具调用的方式' },
  { id: 'terminal', name: '终端', description: '限制每条命令最多能跑多久、最多输出多少内容' },
]

const EXPERIMENTAL_PLUGIN_LABELS = {
  '@deepseek-ai/dsh-experimental-voice-input-bundle': '语音输入',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle': '自定义插件索引',
  '@deepseek-ai/dsh-experimental-auto-review': '自动授权审查',
  '@deepseek-ai/dsh-experimental-forge-bundle': '变更请求与工作树',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': '思考过程机器翻译',
  '@deepseek-ai/dsh-experimental-session-search': '会话搜索',
  '@deepseek-ai/dsh-experimental-ralph-bundle': 'Ralph',
  '@deepseek-ai/dsh-experimental-terminal-bundle': '持久终端',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': '徽章技能',
  '@deepseek-ai/dsh-experimental-session-titles-bundle': '会话标题',
  '@deepseek-ai/dsh-experimental-inspector-profile': 'Inspector Profile',
  '@deepseek-ai/dsh-experimental-liveshare': 'Live Share',
  '@deepseek-ai/dsh-experimental-tool-worktree': 'Worktree 工具',
  '@deepseek-ai/dsh-cua-bundle': 'CUA',
  '@deepseek-ai/dsh-personalized-recommendations': '个性化推荐',
}

function experimentalLabel(name) {
  if (EXPERIMENTAL_PLUGIN_LABELS[name]) return EXPERIMENTAL_PLUGIN_LABELS[name]
  return String(name)
    .replace(/^@deepseek-ai\//, '')
    .replace(/^dsh-experimental-/, '')
    .replace(/-bundle$/, '')
}

function parseJson(buffer, fallback) {
  if (!buffer) return fallback
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return fallback
  }
}

function countFiles(scopes) {
  return Object.values(scopes ?? {}).reduce(
    (total, scope) => total + Object.keys(scope.files ?? {}).length,
    0,
  )
}

/** Main entry point used by the host plugin and the scripts. */
export class SyncEngine {
  constructor({ dshHome, agentsHome, stateRoot, logger = null }) {
    this.dshHome = dshHome
    this.agentsHome = agentsHome
    this.stateRoot = stateRoot
    this.logger = logger
    this.store = new StateStore(stateRoot)
  }

  async init() {
    await this.store.ensure()
    const secrets = await this.store.loadSecrets()
    this._targetSecrets = secrets && typeof secrets.secrets === 'object' ? secrets.secrets : {}
    return this
  }

  /** Engine paths used for scope resolution and manifest key mapping. */
  get pathContext() {
    return {
      dshHome: this.dshHome,
      agentsHome: this.agentsHome,
      customItems: this._activeSettings?.customItems ?? [],
      deviceName: this._activeSettings?.deviceName ?? '',
    }
  }

  /** Provider for a target, using this device's configured directory. */
  providerFor(target, settings) {
    const deviceName = settings?.deviceName ?? ''
    const secret = target?.secretAccessKey
      || this._targetSecrets?.[target?.id]?.secretAccessKey
      || ''
    return createTarget({ ...target, path: targetPathForDevice(target, deviceName), secretAccessKey: secret })
  }

  /** Persist/remove one OSS target secret (never stored in settings.json). */
  async updateTargetSecret(targetId, secret, clear = false) {
    if (!targetId) return
    this._targetSecrets ??= {}
    if (clear) {
      delete this._targetSecrets[targetId]
    } else if (typeof secret === 'string' && secret !== '') {
      this._targetSecrets[targetId] = { secretAccessKey: secret }
    } else {
      return
    }
    await this.store.saveSecrets({ version: 1, secrets: this._targetSecrets })
  }

  async getSettings() {
    await this.init()
    return await this.store.loadSettings()
  }

  async saveSettings(patch) {
    const current = await this.getSettings()
    const next = mergeSettings(current, patch)
    for (const target of next.targets) {
      if (target.kind === 'local' && target.path) target.path = normalizeTargetPath(target.path)
      for (const [device, path] of Object.entries(target.devicePaths ?? {})) {
        if (path) target.devicePaths[device] = normalizeTargetPath(path)
      }
    }
    for (const item of next.customItems) {
      if (item.path) item.path = normalizeTargetPath(item.path)
      for (const [device, path] of Object.entries(item.devicePaths ?? {})) {
        if (path) item.devicePaths[device] = normalizeTargetPath(path)
      }
      if (item.type !== 'dir' && item.type !== 'file') item.type = 'dir'
    }
    return await this.store.saveSettings(next)
  }

  async requireTarget(targetId) {
    const settings = await this.getSettings()
    const target = settings.targets.find((item) => item.id === targetId)
    if (!target) throw new SyncError('target-not-found', `找不到同步目标: ${targetId}`)
    if (!target.enabled) throw new SyncError('target-disabled', `同步目标已停用: ${target.name}`)
    return { settings, target }
  }

  /** Resolve enabled scopes (built-in + enabled custom items), honoring a request. */
  resolveScopeIds(settings, requested) {
    const wanted = Array.isArray(requested) && requested.length > 0
      ? new Set(requested)
      : null
    const ids = []
    for (const scope of SCOPES) {
      if (!settings.scopes?.[scope.id]?.enabled) continue
      if (wanted && !wanted.has(scope.id)) continue
      ids.push(scope.id)
    }
    for (const item of enabledCustomItems(settings)) {
      const id = customScopeId(item.id)
      if (wanted && !wanted.has(id)) continue
      ids.push(id)
    }
    return ids
  }

  /** Display name for a built-in or custom scope id. */
  scopeName(settings, scopeId) {
    if (isCustomScope(scopeId)) {
      return findCustomItem(scopeId, settings?.customItems)?.name ?? scopeId
    }
    return getScope(scopeId)?.name ?? scopeId
  }

  async buildScanContext(settings) {
    const ignore = await this.store.loadIgnorePatterns()
    return {
      dshHome: this.dshHome,
      agentsHome: this.agentsHome,
      settings,
      extraExcludes: [...(settings.exclude?.extra ?? []), ...ignore],
    }
  }

  async estimateScopes({ targetId } = {}) {
    const settings = await this.getSettings()
    this._activeSettings = settings
    const ids = this.resolveScopeIds(settings, null)
    const context = await this.buildScanContext(settings)
    const rows = []
    for (const scopeId of ids) {
      const name = this.scopeName(settings, scopeId)
      try {
        const entries = await scanScope(scopeId, context)
        let bytes = 0
        for (const entry of entries.values()) bytes += entry.size
        rows.push({
          id: scopeId,
          name,
          custom: isCustomScope(scopeId),
          enabled: settings.scopes?.[scopeId]?.enabled !== false,
          files: entries.size,
          bytes,
        })
      } catch (error) {
        rows.push({ id: scopeId, name, custom: isCustomScope(scopeId), enabled: true, files: 0, bytes: 0, error: String(error?.message ?? error) })
      }
    }
    return { targetId: targetId ?? null, scopes: rows }
  }

  async loadRemote(provider, deviceId) {
    const meta = parseJson(await provider.get('meta.json'), { schema: META_SCHEMA, devices: {} })
    meta.devices ??= {}
    const deviceIds = new Set([...Object.keys(meta.devices), deviceId])
    const manifests = []
    for (const id of deviceIds) {
      const manifest = parseJson(await provider.get(manifestKey(id)), null)
      if (manifest && manifest.schema === MANIFEST_SCHEMA) manifests.push(manifest)
    }
    return {
      meta,
      manifests,
      merged: mergeRemoteManifests(manifests),
      self: manifests.find((item) => item.deviceId === deviceId) ?? null,
    }
  }

  async scanAndPlan({ settings, provider, targetId, scopeIds, direction, onProgress, isCancelled, deleteModeOverride }) {
    this._activeSettings = settings
    const base = await this.store.loadBaseManifest(targetId)
    const remote = await this.loadRemote(provider, settings.deviceId)
    const context = await this.buildScanContext(settings)
    const planned = []
    let hashed = 0
    let reused = 0
    for (const scopeId of scopeIds) {
      if (isCancelled?.()) throw new SyncError('cancelled', '同步已取消')
      onProgress?.({ phase: 'scan', scope: scopeId })
      let entries = await scanScope(scopeId, context)
      let baseFiles = base.scopes?.[scopeId]?.files ?? {}
      let remoteFiles = remote.merged[scopeId] ?? {}
      let local = await buildScopeManifest(scopeId, entries, baseFiles)
      hashed += local.stats.hashed
      reused += local.stats.reused
      let sessionDuplicates = []
      if (scopeId === 'sessions') {
        // One session id = one session, no matter how many project directories
        // currently contain a copy of it.
        const collapsed = collapseSessionViews({ entries, localFiles: local.files, remoteFiles, baseFiles })
        entries = collapsed.entries
        local = { ...local, files: collapsed.localFiles }
        remoteFiles = collapsed.remoteFiles
        baseFiles = collapsed.baseFiles
        sessionDuplicates = collapsed.duplicates
      }
      if (scopeId === 'plugins') {
        // The plugins scope is a *selected* subset. Unselected plugins already in
        // the backup must not be planned as deletions: keep their remote entry in
        // the local view so the plan reports identical and the manifest retains
        // them when the selection changes.
        const selected = new Set(
          Array.isArray(settings.scopes?.plugins?.selectedPlugins)
            ? settings.scopes.plugins.selectedPlugins
            : [],
        )
        for (const [rel, entry] of Object.entries(remoteFiles)) {
          const name = pluginPackageName(rel)
          if (!name || selected.has(name)) continue
          if (!(rel in local.files)) local.files[rel] = entry
        }
        for (const [rel, entry] of Object.entries(baseFiles)) {
          const name = pluginPackageName(rel)
          if (!name || selected.has(name)) continue
          if (!(rel in local.files)) local.files[rel] = entry
        }
      }
      const policy = getScope(scopeId)?.policy ?? 'newer'
      let plan = planScope({
        scopeId,
        policy,
        localFiles: local.files,
        baseFiles,
        remoteFiles,
        direction,
        deviceName: settings.deviceName,
        stamp: timestampSlug(),
        deleteMode: deleteModeOverride ?? settings.deleteMode,
        force: settings.force === true,
        maxActions: 100000,
      })
      if (scopeId === 'sessions' && plan.actions.some((action) => action.type === 'conflict')) {
        plan = await this.promoteAppendOnlyConflicts({ provider, plan, entries, localFiles: local.files, remoteFiles })
      }
      planned.push({
        scopeId,
        entries,
        local,
        baseFiles,
        remoteFiles,
        actions: plan.actions,
        summary: plan.summary,
        policy,
        sessionDuplicates,
      })
    }
    return { base, remote, planned, stats: { hashed, reused } }
  }

  /**
   * Append-only session logs can be fast-forwarded instead of reported as a
   * conflict: one log contains the other byte for byte, so adopting the longer
   * side is the only lossless choice. Forked logs stay conflicts (keep-both).
   */
  async promoteAppendOnlyConflicts({ provider, plan, entries, localFiles, remoteFiles }) {
    const actions = []
    let changed = false
    for (const action of plan.actions) {
      if (action.type !== 'conflict' || action.resolution !== 'keep-both') {
        actions.push(action)
        continue
      }
      const source = entries.get(action.path)
      const localEntry = localFiles[action.path]
      const remoteEntry = remoteFiles[action.path]
      if (!source || !localEntry || !remoteEntry) {
        actions.push(action)
        continue
      }
      const relation = await appendRelation({ provider, localAbs: source.abs, remoteEntry, localSize: localEntry.size })
      // `appendRelation` reports the state of a log relative to the other side:
      // local-ahead -> upload, backup-ahead -> download.
      if (relation === 'local-ahead') {
        actions.push({ type: 'upload', scope: action.scope, path: action.path, reason: 'append-fast-forward' })
        changed = true
        continue
      }
      if (relation === 'backup-ahead') {
        actions.push({ type: 'download', scope: action.scope, path: action.path, reason: 'append-fast-forward' })
        changed = true
        continue
      }
      actions.push(action)
    }
    if (!changed) return plan
    return { ...plan, actions, summary: summarizeActions(actions) }
  }

  /**
   * Pending transfer counts for the sidebar, computed with the same read-only
   * plan as preview but without materializing the action list.
   */
  async pendingCounts({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    const ids = this.resolveScopeIds(settings, null)
    const empty = { targetId: target.id, upload: 0, download: 0, conflict: 0, choice: 0, total: 0 }
    if (ids.length === 0) return empty
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const { planned } = await this.scanAndPlan({
      settings,
      provider,
      targetId: target.id,
      scopeIds: ids,
      direction: settings.direction,
    })
    const counts = { upload: 0, download: 0, conflict: 0, choice: 0 }
    const scopeRows = new Map()
    const sessionRows = new Map()
    const items = []
    for (const scope of planned) {
      const row = { id: scope.scopeId, upload: 0, download: 0, conflict: 0, choice: 0 }
      for (const action of scope.actions) {
        if (action.type === 'upload') {
          counts.upload += 1
          row.upload += 1
        } else if (action.type === 'download') {
          counts.download += 1
          row.download += 1
        } else if (action.type === 'conflict') {
          counts.conflict += 1
          row.conflict += 1
        } else if (action.type === 'choice') {
          counts.choice += 1
          row.choice += 1
        } else {
          continue
        }
        if (items.length < 300) items.push({ scope: scope.scopeId, path: action.path })
        if (scope.scopeId !== 'sessions') continue
        const parts = String(action.path ?? '').split('/')
        if (parts[0] !== 'sessions' || parts.length < 3) continue
        const sessionId = parts[2]
        if (!sessionRows.has(sessionId)) {
          sessionRows.set(sessionId, { id: sessionId, projectDir: parts[1], upload: 0, download: 0, conflict: 0, choice: 0 })
        }
        sessionRows.get(sessionId)[action.type] += 1
      }
      if (row.upload + row.download + row.conflict + row.choice > 0) scopeRows.set(scope.scopeId, row)
    }
    return {
      targetId: target.id,
      ...counts,
      total: counts.upload + counts.download + counts.conflict + counts.choice,
      // Hover details for the sidebar widget: which sessions/scopes changed.
      details: {
        scopes: [...scopeRows.values()],
        sessions: [...sessionRows.values()].slice(0, 50),
        items,
      },
    }
  }

  /** Read-only preview: plan only, no writes. */
  async preview({ targetId, scopeIds, direction, deleteChoice } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    if (settings.lastTargetId !== target.id) {
      settings.lastTargetId = target.id
      await this.store.saveSettings(normalizeSettings(settings))
    }
    const ids = this.resolveScopeIds(settings, scopeIds)
    if (ids.length === 0) throw new SyncError('no-scopes', '没有启用的同步项')
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const dir = direction ?? settings.direction
    const { planned, stats } = await this.scanAndPlan({
      settings,
      provider,
      targetId,
      scopeIds: ids,
      direction: dir,
      deleteModeOverride: deleteChoice,
    })
    const actions = []
    for (const scope of planned) {
      for (const action of scope.actions) {
        actions.push({
          type: action.type,
          scope: action.scope,
          path: action.path,
          side: action.side,
          reason: action.reason ?? action.resolution,
          conflictPath: action.conflictPath,
        })
      }
    }
    const summary = summarizeActions(actions)
    const sessionDuplicates = []
    for (const scope of planned) {
      for (const duplicate of scope.sessionDuplicates ?? []) sessionDuplicates.push(duplicate)
    }
    // `identical` entries are summaries, not work: keeping them here would let
    // a large unchanged tree crowd the real changes out of the 2000-row cap.
    const actionable = actions.filter((action) => action.type !== 'identical')
    return {
      targetId,
      direction: dir,
      summary,
      stats,
      choices: actions.filter((action) => action.type === 'choice'),
      actions: actionable.slice(0, 2000),
      truncated: actionable.length > 2000,
      sessionDuplicates: sessionDuplicates.slice(0, 200),
    }
  }

  async ensureBlob(provider, absPath, sha256, stats, onBytes) {
    const key = blobKey(sha256)
    if (await provider.head(key)) return false
    const buffer = await fsp.readFile(absPath)
    const actual = sha256Buffer(buffer)
    const putOptions = onBytes ? { onProgress: (delta) => onBytes(delta) } : undefined
    if (actual !== sha256) {
      // The file changed while the run was in flight (active session log, plugin
      // edit, ...). Upload the bytes we actually read under their real hash and
      // let the caller refresh the manifest entry instead of failing the run.
      const changedKey = blobKey(actual)
      await provider.put(changedKey, buffer, putOptions)
      if (!onBytes) stats.bytesUploaded += buffer.length
      return 'changed'
    }
    await provider.put(key, buffer, putOptions)
    if (!onBytes) stats.bytesUploaded += buffer.length
    return true
  }

  /**
   * Download one blob to `absPath`.
   *
   * Returns the fresh stat entry, or `undefined` when the destination already
   * holds identical bytes and `force` is off (the "do not overwrite identical
   * content" rule).
   */
  async downloadFile({ provider, remoteEntry, absPath, force, stats, rewriteCwd = '' }) {
    const existing = await statOrUndefined(absPath)
    if (existing && !force) {
      const existingSha = await sha256File(absPath)
      if (existingSha === remoteEntry.sha256) return undefined
    }
    const blob = await provider.get(blobKey(remoteEntry.sha256))
    if (!blob) {
      throw new SyncError('missing-blob', `远端缺少内容块 ${remoteEntry.sha256}（备份可能不完整）`)
    }
    const actual = sha256Buffer(blob)
    if (actual !== remoteEntry.sha256) {
      throw new SyncError('corrupt-blob', `内容块校验失败: ${remoteEntry.sha256}`)
    }
    let payload = blob
    let sha256 = remoteEntry.sha256
    if (rewriteCwd) {
      // A restored session log must keep the header cwd of the local copy it
      // overwrites, otherwise DSH sees a header/path mismatch on open.
      try {
        payload = rewriteSessionCwd(blob, rewriteCwd)
        sha256 = sha256Buffer(payload)
      } catch {
        payload = blob
        sha256 = remoteEntry.sha256
      }
    }
    await ensureDir(dirname(absPath))
    await atomicWrite(absPath, payload, remoteEntry.mode ?? 0o600)
    const stat = await fsp.stat(absPath)
    stats.bytesDownloaded += stat.size
    return { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777, sha256 }
  }

  /**
   * Cwd of the local session log that a download would overwrite.
   *
   * Only the header of the first zstd frame is needed; when the destination is
   * missing (new session) no rewrite happens.
   */
  async localSessionCwdForDownload(scopeId, rel, absPath) {
    if (scopeId !== 'sessions') return ''
    const parsed = parseSessionRel(rel)
    if (!parsed || !SESSION_LOG_PATTERN.test(basename(parsed.rest))) return ''
    const existing = await statOrUndefined(absPath)
    if (!existing) return ''
    try {
      return readSessionHeader(await fsp.readFile(absPath)).header.cwd
    } catch {
      return ''
    }
  }

  async uploadScope({ provider, scopeId, entries, localFiles, actions, stats, onAction, onFile, onTransfer }) {
    for (const action of actions) {
      const needUpload = action.type === 'upload'
        || (action.type === 'conflict' && action.resolution === 'keep-local')
      if (!needUpload) continue
      const rel = assertSafeRel(action.path)
      const entry = entries.get(rel)
      const meta = localFiles[rel]
      if (!entry || !meta) continue
      const startedAt = Date.now()
      let transferred = 0
      let lastReportAt = 0
      const onBytes = (delta) => {
        if (!delta) return
        transferred += delta
        stats.bytesUploaded += delta
        const now = Date.now()
        if (onTransfer && now - lastReportAt >= 900) {
          lastReportAt = now
          onTransfer({ path: rel, size: meta.size, transferred, startedAt })
        }
      }
      const uploaded = await this.ensureBlob(provider, entry.abs, meta.sha256, stats, onBytes)
      if (uploaded && transferred === 0) stats.bytesUploaded += meta.size
      if (uploaded) stats.uploaded += 1
      if (onTransfer) onTransfer(null)
      if (uploaded === 'changed') {
        try {
          const stat = await fsp.stat(entry.abs)
          const freshSha = await sha256File(entry.abs)
          localFiles[rel] = { ...meta, sha256: freshSha, size: stat.size, mtimeMs: stat.mtimeMs }
          entry.sha256 = freshSha
          entry.size = stat.size
          entry.mtimeMs = stat.mtimeMs
        } catch {
          // The file vanished again; leave the planned entry for the next run.
        }
      }
      onAction?.(1)
      if (onFile) await onFile(rel, localFiles[rel])
    }
  }

  async downloadScope({ provider, scope, entries, localFiles, remoteFiles, actions, settings, stats, onAction, onFile, onTransfer }) {
    const next = { ...localFiles }
    for (const action of actions) {
      if (action.type !== 'download' && action.type !== 'conflict') continue
      const rel = assertSafeRel(action.path)
      const remote = remoteFiles[rel]
      if (!remote) continue
      if (action.type === 'conflict' && action.resolution === 'keep-local') continue

      if (action.type === 'download' || action.resolution === 'restore-remote') {
        const abs = absPathForRel(scope, rel, this.pathContext)
        if (onTransfer) onTransfer({ path: rel, size: Number(remote.size) || 0, transferred: 0, startedAt: Date.now() })
        const written = await this.downloadFile({
          provider,
          remoteEntry: remote,
          absPath: abs,
          force: settings.force === true,
          stats,
          rewriteCwd: await this.localSessionCwdForDownload(scope, rel, abs),
        })
        if (written) {
          next[rel] = { scope, size: written.size, mtimeMs: written.mtimeMs, mode: written.mode, sha256: written.sha256 ?? remote.sha256 }
          stats.downloaded += 1
        } else if (!next[rel] && entries.has(rel)) {
          // Destination already had identical bytes but the file was not in the
          // scanned view (should be rare); keep the scanned metadata.
          const entry = entries.get(rel)
          next[rel] = { scope, size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, sha256: remote.sha256 }
        }
        onAction?.(1)
        if (onFile && next[rel]) await onFile(rel, next[rel])
        if (onTransfer) onTransfer(null)
        continue
      }

      if (action.resolution === 'keep-both') {
        // Keep the local file, save the remote version under a conflict name.
        const localEntry = entries.get(rel)
        const localMeta = localFiles[rel]
        if (localEntry && localMeta) {
          const uploaded = await this.ensureBlob(provider, localEntry.abs, localMeta.sha256, stats)
          if (uploaded) stats.uploaded += 1
        }
        const conflictRel = assertSafeRel(action.conflictPath ?? `${rel}.conflict-${settings.deviceName}-${timestampSlug()}`)
        const abs = absPathForRel(scope, conflictRel, this.pathContext)
        const written = await this.downloadFile({ provider, remoteEntry: remote, absPath: abs, force: false, stats })
        if (written) {
          next[conflictRel] = { scope, size: written.size, mtimeMs: written.mtimeMs, mode: written.mode, sha256: remote.sha256 }
        }
        stats.conflicts += 1
        onAction?.(2)
        if (onFile && next[conflictRel]) await onFile(conflictRel, next[conflictRel])
      }
    }
    return next
  }

  /**
   * Run a two-way sync.
   *
   * Steps: scan + hash -> plan -> uploads -> downloads/conflicts -> write base
   * manifest -> write remote manifest/meta -> optional snapshot.
   */
  async sync({ targetId, scopeIds, direction, onProgress, isCancelled, deleteChoice } = {}) {
    await this.init()
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    // Remember the target server-side as well: a failed run must not make the
    // settings page fall back to another target on reopen.
    if (settings.lastTargetId !== target.id) {
      settings.lastTargetId = target.id
      await this.store.saveSettings(normalizeSettings(settings))
    }
    const dir = direction ?? settings.direction
    if (!['both', 'push', 'pull'].includes(dir)) throw new SyncError('bad-direction', `无效方向: ${dir}`)
    if (deleteChoice !== undefined && !['restore', 'mirror', 'ignore'].includes(deleteChoice)) {
      throw new SyncError('bad-delete-choice', `无效的删除处理方式: ${deleteChoice}`)
    }
    const ids = this.resolveScopeIds(settings, scopeIds)
    if (ids.length === 0) throw new SyncError('no-scopes', '没有启用的同步项')

    const provider = this.providerFor(target, settings)
    await provider.probe()

    onProgress?.({ phase: 'plan' })
    const { base, remote, planned, stats } = await this.scanAndPlan({
      settings,
      provider,
      targetId,
      scopeIds: ids,
      direction: dir,
      onProgress,
      isCancelled,
      deleteModeOverride: deleteChoice,
    })

    const startedAt = Date.now()
    const counters = {
      identical: 0,
      upload: 0,
      download: 0,
      conflict: 0,
      skip: 0,
      choice: 0,
      deleted: 0,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      bytesUploaded: 0,
      bytesDownloaded: 0,
      hashed: stats.hashed,
      reused: stats.reused,
    }
    const allActions = []
    const afterScopes = { ...(base.scopes ?? {}) }
    // Progressive manifest checkpoint: persist completed session/plugin files as
    // they finish, so an interrupted run keeps its progress instead of falling
    // back to the previous (possibly empty) manifest.
    const checkpointScopes = {}
    for (const [scopeId, data] of Object.entries(base.scopes ?? {})) {
      checkpointScopes[scopeId] = {
        files: { ...(data.files ?? {}) },
        removed: [...(data.removed ?? [])],
      }
    }
    let lastCheckpointAt = 0
    const flushCheckpoint = async (force = false) => {
      const now = Date.now()
      if (!force && now - lastCheckpointAt < 1500) return
      lastCheckpointAt = now
      const manifest = {
        schema: MANIFEST_SCHEMA,
        deviceId: settings.deviceId,
        deviceName: settings.deviceName,
        updatedAt: new Date().toISOString(),
        scopes: checkpointScopes,
      }
      await this.store.saveBaseManifest(targetId, { scopes: checkpointScopes })
      await provider.put(manifestKey(settings.deviceId), Buffer.from(JSON.stringify(manifest), 'utf8'))
    }

    // Planned transfer volume for progress and speed. Identical/skip actions are
    // not counted: the bar must only move when bytes actually move.
    let totalFiles = 0
    let totalBytes = 0
    for (const scope of planned) {
      for (const action of scope.actions) {
        if (action.type === 'upload' || (action.type === 'conflict' && action.resolution === 'keep-local')) {
          totalFiles += 1
          totalBytes += scope.local.files[action.path]?.size ?? 0
        } else if (action.type === 'download' || (action.type === 'conflict' && action.resolution === 'restore-remote')) {
          totalFiles += 1
          totalBytes += scope.remoteFiles[action.path]?.size ?? 0
        } else if (action.type === 'conflict' && action.resolution === 'keep-both') {
          totalFiles += 2
          totalBytes += (scope.local.files[action.path]?.size ?? 0)
            + (scope.remoteFiles[action.path]?.size ?? 0)
        }
      }
    }

    let processed = 0
    let lastEmitAt = 0
    const samples = [{ at: startedAt, bytes: 0 }]
    const currentSpeed = () => {
      const now = Date.now()
      const cutoff = now - 2500
      while (samples.length > 2 && samples[0].at < cutoff) samples.shift()
      const first = samples[0]
      if (!first || now - first.at < 200) return 0
      const bytes = counters.bytesUploaded + counters.bytesDownloaded
      return Math.max(0, Math.round((bytes - first.bytes) / ((now - first.at) / 1000)))
    }
    let currentTransfer = null
    const emit = (phase, extra = {}, force = false) => {
      const now = Date.now()
      if (!force && now - lastEmitAt < 280) return
      lastEmitAt = now
      const bytesDone = counters.bytesUploaded + counters.bytesDownloaded
      samples.push({ at: now, bytes: bytesDone })
      onProgress?.({
        phase,
        done: processed,
        total: totalFiles,
        bytesDone,
        bytesTotal: totalBytes,
        speedBytesPerSec: currentSpeed(),
        elapsedMs: now - startedAt,
        currentFile: currentTransfer,
        ...extra,
      })
    }
    const actionCallback = (phase, scopeId) => (count) => {
      processed += count
      emit(phase, { scope: scopeId })
    }
    emit('plan', { done: 0, total: totalFiles, bytesDone: 0, bytesTotal: totalBytes }, true)

    for (const scope of planned) {
      if (isCancelled?.()) throw new SyncError('cancelled', '同步已取消')
      const summary = scope.summary
      counters.identical += summary.identical ?? 0
      counters.upload += summary.upload ?? 0
      counters.download += summary.download ?? 0
      counters.conflict += summary.conflict ?? 0
      counters.skip += summary.skip ?? 0
      counters.choice = (counters.choice ?? 0) + (summary.choice ?? 0)
      counters.deleted = (counters.deleted ?? 0) + (summary.delete ?? 0)
      allActions.push(...scope.actions)

      const currentScopeId = scope.scopeId
      currentTransfer = null
      const markTransfer = (state) => {
        currentTransfer = state
        emit('upload', { scope: currentScopeId })
      }
      const markCheckpoint = async (rel, entry) => {
        if (!entry) return
        checkpointScopes[currentScopeId] ??= { files: {}, removed: [] }
        checkpointScopes[currentScopeId].files[rel] = entry
        await flushCheckpoint().catch(() => {})
      }

      emit('upload', { scope: scope.scopeId }, true)
      await this.uploadScope({
        provider,
        scopeId: scope.scopeId,
        entries: scope.entries,
        localFiles: scope.local.files,
        actions: scope.actions,
        stats: counters,
        onAction: actionCallback('upload', scope.scopeId),
        onFile: markCheckpoint,
        onTransfer: markTransfer,
      })

      emit('download', { scope: scope.scopeId }, true)
      const nextFiles = await this.downloadScope({
        provider,
        scope: scope.scopeId,
        entries: scope.entries,
        localFiles: scope.local.files,
        remoteFiles: scope.remoteFiles,
        actions: scope.actions,
        settings,
        stats: counters,
        onAction: actionCallback('download', scope.scopeId),
        onFile: markCheckpoint,
        onTransfer: markTransfer,
      })

      // Deletions: restore actions were planned as upload/download above; here
      // we apply the "mirror" side effects and record tombstones.
      const removedSet = new Set()
      for (const action of scope.actions) {
        if (action.type !== 'delete') continue
        const rel = assertSafeRel(action.path)
        removedSet.add(rel)
        delete nextFiles[rel]
        if (action.side === 'local') {
          const abs = absPathForRel(scope.scopeId, rel, this.pathContext)
          const backup = join(this.store.backupsDir(timestampSlug()), rel)
          try {
            await ensureDir(dirname(backup))
            await fsp.copyFile(abs, backup)
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          await fsp.rm(abs, { force: true })
        }
        processed += 1
        emit('delete', { scope: scope.scopeId, rel })
      }

      // Skips and unanswered deletion choices must not erase the base/remote
      // record of a file: keep the previous base entry so a later run can still
      // restore or ask again.
      for (const action of scope.actions) {
        if (action.type !== 'skip' && action.type !== 'choice') continue
        const rel = action.path
        if (rel in nextFiles) continue
        const baseEntry = scope.baseFiles[rel]
        if (baseEntry) nextFiles[rel] = baseEntry
      }
      const previousRemoved = base.scopes?.[scope.scopeId]?.removed ?? []
      const removed = [...new Set([...previousRemoved, ...removedSet])]
        .filter((rel) => !(rel in nextFiles))
      afterScopes[scope.scopeId] = { files: nextFiles, removed }
      checkpointScopes[scope.scopeId] = { files: nextFiles, removed: [...removed] }
      await flushCheckpoint(true).catch(() => {})
    }

    processed = totalFiles
    emit('manifest', {}, true)
    const afterManifest = {
      schema: MANIFEST_SCHEMA,
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      updatedAt: new Date().toISOString(),
      scopes: afterScopes,
    }
    await this.store.saveBaseManifest(targetId, { scopes: afterScopes })
    await provider.put(manifestKey(settings.deviceId), Buffer.from(JSON.stringify(afterManifest), 'utf8'))

    // Record the running DSH version in the backup metadata. This runs on every
    // backup, so a DSH upgrade is reflected after the next sync.
    await this.writeBackupMeta(provider, settings)

    // Plugin enable/disable state (bundles + built-in `disabled` overrides) is a
    // small per-profile document rather than a file in the manifest, because it
    // is derived from two different profile files.
    if (ids.includes('plugins')) {
      try {
        await this.syncPluginState({ provider, settings, direction: dir })
      } catch {
        // State syncing is best-effort; the file sync itself already succeeded.
      }
    }

    const moved = (counters.uploaded + counters.downloaded + counters.conflicts) > 0
    let snapshot = null
    if (moved) {
      snapshot = await recordSnapshot(provider, afterManifest, {
        deviceName: settings.deviceName,
        historyLimit: settings.historyLimit,
      })
    }

    const finishedAt = new Date().toISOString()
    const durationMs = Math.max(0, Date.now() - startedAt)
    const bytesMoved = counters.bytesUploaded + counters.bytesDownloaded
    const result = {
      targetId,
      direction: dir,
      scopes: ids,
      summary: {
        identical: counters.identical,
        upload: counters.upload,
        download: counters.download,
        conflict: counters.conflict,
        skip: counters.skip,
        choice: counters.choice ?? 0,
        delete: counters.deleted ?? 0,
        uploaded: counters.uploaded,
        downloaded: counters.downloaded,
        conflicts: counters.conflicts,
        bytesUploaded: counters.bytesUploaded,
        bytesDownloaded: counters.bytesDownloaded,
        bytesMoved,
        durationMs,
        avgBytesPerSec: durationMs > 0 ? Math.round(bytesMoved / (durationMs / 1000)) : 0,
        files: countFiles(afterScopes),
      },
      stats,
      snapshot,
      actions: allActions.slice(0, 500),
      finishedAt,
    }
    await this.store.saveLastRun(targetId, { state: 'succeeded', ...result })
    return result
  }

  /** Targets with secrets masked and the last run summary attached for the UI. */
  async listTargets() {
    const settings = await this.getSettings()
    const targets = []
    for (const target of settings.targets) {
      const lastRun = await this.store.loadLastRun(target.id)
      targets.push({
        ...target,
        deviceName: settings.deviceName,
        effectivePath: target.kind === 'local' ? targetPathForDevice(target, settings.deviceName) : '',
        secretStored: Boolean(this._targetSecrets?.[target.id]?.secretAccessKey),
        lastSyncAt: lastRun?.finishedAt ?? null,
        lastSync: lastRun?.summary ?? null,
      })
    }
    return targets
  }

  async upsertTarget(input) {
    const settings = await this.getSettings()
    const deviceName = settings.deviceName
    const existingIndex = input?.id ? settings.targets.findIndex((item) => item.id === input.id) : -1
    const existing = existingIndex >= 0 ? settings.targets[existingIndex] : null
    const kind = input?.kind ?? existing?.kind ?? 'local'
    const prefix = typeof input?.prefix === 'string' && input.prefix.trim()
      ? input.prefix.trim()
      : (existing?.prefix ?? defaultTargetPrefix())
    const targetId = typeof input?.id === 'string' && input.id
      ? input.id
      : (existing?.id ?? `t_${Math.random().toString(16).slice(2, 10)}`)
    let target
    if (kind === 'local') {
      const devicePaths = {
        ...(existing?.devicePaths ?? {}),
        ...(input?.devicePaths && typeof input.devicePaths === 'object' ? input.devicePaths : {}),
      }
      for (const [device, value] of Object.entries(devicePaths)) {
        const name = String(device).trim()
        const path = typeof value === 'string' ? value.trim() : ''
        if (name && path) devicePaths[name] = path
        else delete devicePaths[name]
      }
      const effectiveInputPath = String(input?.path ?? '').trim()
        ? normalizeTargetPath(input.path)
        : (devicePaths[deviceName] || existing?.path || '')
      if (!effectiveInputPath) throw new SyncError('bad-target', '目标路径不能为空')
      if (effectiveInputPath) devicePaths[deviceName] = effectiveInputPath
      target = {
        id: targetId,
        name: String(input?.name ?? existing?.name ?? '本地目录').trim() || '本地目录',
        kind,
        enabled: input?.enabled !== false,
        path: effectiveInputPath,
        devicePaths,
        prefix,
      }
    } else if (kind === 'oss') {
      const endpoint = String(input?.endpoint ?? existing?.endpoint ?? '').trim()
      const bucket = String(input?.bucket ?? existing?.bucket ?? '').trim()
      const accessKeyId = String(input?.accessKeyId ?? existing?.accessKeyId ?? '').trim()
      if (!endpoint) throw new SyncError('bad-target', 'OSS endpoint 不能为空')
      if (!bucket) throw new SyncError('bad-target', 'OSS bucket 不能为空')
      if (!accessKeyId) throw new SyncError('bad-target', 'OSS AccessKey ID 不能为空')
      if (!this._targetSecrets?.[targetId]?.secretAccessKey && !input?.secretAccessKey && input?.clearSecretAccessKey !== true) {
        throw new SyncError('bad-target', 'OSS AccessKey Secret 不能为空')
      }
      target = {
        id: targetId,
        name: String(input?.name ?? existing?.name ?? 'OSS 备份').trim() || 'OSS 备份',
        kind,
        enabled: input?.enabled !== false,
        endpoint,
        region: String(input?.region ?? existing?.region ?? '').trim(),
        bucket,
        accessKeyId,
        prefix,
      }
    } else {
      throw new SyncError('unsupported-target', '仅支持本地目录与 OSS 目标')
    }
    if (existingIndex >= 0) settings.targets[existingIndex] = { ...existing, ...target }
    else settings.targets.push(target)
    const saved = await this.store.saveSettings(normalizeSettings(settings))
    if (kind === 'oss') {
      await this.updateTargetSecret(
        targetId,
        input?.secretAccessKey,
        input?.clearSecretAccessKey === true,
      )
    }
    const savedTarget = saved.targets.find((item) => item.id === targetId)
    if (savedTarget && savedTarget.kind === 'local') {
      try {
        this._activeSettings = saved
        await this.writeBackupMeta(this.providerFor(savedTarget, saved), saved)
      } catch {
        // The target may be offline; the next backup still records the version.
      }
    }
    return saved.targets
  }

  async removeTarget(id) {
    const settings = await this.getSettings()
    settings.targets = settings.targets.filter((item) => item.id !== id)
    const saved = await this.store.saveSettings(normalizeSettings(settings))
    return saved.targets
  }

  /** Custom directory/file sync items, for the settings UI and agent tools. */
  async listCustomItems() {
    const settings = await this.getSettings()
    return settings.customItems
  }

  /**
   * Create or update one custom item.
   *
   * Lookup is by `id` when supplied, otherwise by case-insensitive name. The
   * path being added must exist locally and match `type`; per-device paths are
   * not probed because they belong to other machines.
   */
  async upsertCustomItem(input) {
    const settings = await this.getSettings()
    const items = [...settings.customItems]
    const id = typeof input?.id === 'string' ? input.id : ''
    const name = String(input?.name ?? '').trim()
    const createOnly = input?.create === true
    const existingIndex = id
      ? items.findIndex((item) => item.id === id)
      : (createOnly ? -1 : (name ? items.findIndex((item) => item.name.toLowerCase() === name.toLowerCase()) : -1))
    const existing = existingIndex >= 0 ? items[existingIndex] : null
    const finalName = name || existing?.name || ''
    if (!finalName) throw new SyncError('bad-custom-item', '自定义同步项名称不能为空')
    if (items.some((item, index) => index !== existingIndex && item.name.toLowerCase() === finalName.toLowerCase())) {
      throw new SyncError('duplicate-name', `已存在同名自定义同步项: ${finalName}`)
    }
    const type = input?.type === 'file' ? 'file' : (input?.type === 'dir' ? 'dir' : (existing?.type ?? 'dir'))
    const rawPath = input?.path !== undefined ? String(input.path).trim() : (existing?.path ?? '')
    if (!rawPath) throw new SyncError('bad-custom-item', '自定义同步项路径不能为空')
    const absolute = normalizeTargetPath(rawPath)
    const stat = await statOrUndefined(absolute)
    if (!stat) throw new SyncError('path-missing', `路径不存在: ${absolute}`)
    if (type === 'dir' && !stat.isDirectory()) throw new SyncError('path-type', `不是目录: ${absolute}`)
    if (type === 'file' && !stat.isFile()) throw new SyncError('path-type', `不是文件: ${absolute}`)
    const devicePaths = { ...(existing?.devicePaths ?? {}) }
    if (input?.devicePaths && typeof input.devicePaths === 'object' && !Array.isArray(input.devicePaths)) {
      for (const [device, value] of Object.entries(input.devicePaths)) {
        const deviceName = String(device).trim()
        const devicePath = typeof value === 'string' ? value.trim() : ''
        if (deviceName && devicePath) devicePaths[deviceName] = normalizeTargetPath(devicePath)
      }
    }
    const item = {
      id: existing?.id || id || `c_${Math.random().toString(16).slice(2, 12)}`,
      name: finalName,
      type,
      path: absolute,
      devicePaths,
      enabled: input?.enabled !== undefined ? input.enabled !== false : (existing?.enabled !== false),
    }
    if (existingIndex >= 0) items[existingIndex] = item
    else items.push(item)
    await this.saveSettings({ customItems: items })
    return item
  }

  /** Remove a custom item by id or case-insensitive name. */
  async removeCustomItem(idOrName) {
    const settings = await this.getSettings()
    const lookup = String(idOrName ?? '').trim().toLowerCase()
    if (!lookup) throw new SyncError('bad-custom-item', '缺少自定义同步项 id 或名称')
    const items = settings.customItems
    const target = items.find((item) => item.id.toLowerCase() === lookup)
      ?? items.find((item) => item.name.toLowerCase() === lookup)
    if (!target) throw new SyncError('custom-item-not-found', `找不到自定义同步项: ${idOrName}`)
    await this.saveSettings({ customItems: items.filter((item) => item.id !== target.id) })
    return target
  }

  /**
   * Merge the running DSH version into the backup's `meta.json`.
   *
   * Called on target probe and on every sync; failures stay non-fatal so a
   * read-only or temporarily unreachable target never breaks the operation.
   */
  async writeBackupMeta(provider, settings) {
    try {
      const meta = parseJson(await provider.get('meta.json'), { schema: META_SCHEMA, devices: {} })
      meta.schema = META_SCHEMA
      meta.dshVersion = resolveDshVersion()
      meta.updatedAt = new Date().toISOString()
      meta.devices ??= {}
      meta.devices[settings.deviceId] = {
        name: settings.deviceName,
        lastSeenAt: new Date().toISOString(),
      }
      await provider.put('meta.json', Buffer.from(JSON.stringify(meta), 'utf8'))
      this._backupInfoCache = null
    } catch {
      // Metainfo is informative only; never fail the caller for it.
    }
  }

  /** Refresh `meta.json` on every enabled target (used once at plugin startup). */
  async touchAllBackupMeta() {
    const settings = await this.getSettings()
    this._activeSettings = settings
    for (const target of settings.targets.filter((item) => item.enabled !== false && item.kind === 'local')) {
      try {
        await this.writeBackupMeta(this.providerFor(target, settings), settings)
      } catch {
        // Offline targets are refreshed by their next backup.
      }
    }
  }

  async testTarget(input) {
    const settings = await this.getSettings()
    this._activeSettings = settings
    const stored = input?.id ? settings.targets.find((item) => item.id === input.id) : undefined
    const target = stored ? { ...stored, ...input, devicePaths: stored.devicePaths } : input
    const secretAccessKey = target?.secretAccessKey
      || (target?.id ? this._targetSecrets?.[target.id]?.secretAccessKey : '')
      || ''
    let provider
    if (target?.kind === 'oss') {
      provider = createTarget({ ...target, secretAccessKey })
    } else {
      const effectivePath = targetPathForDevice(target, settings.deviceName)
      if (!effectivePath) throw new SyncError('bad-target', '目标路径不能为空')
      provider = createTarget({ ...target, path: effectivePath })
    }
    const result = await provider.probe()
    // Record the running DSH version as soon as the target is reachable, so the
    // settings page can show it before the first full backup run.
    await this.writeBackupMeta(provider, settings)
    return result
  }

  async listSnapshots({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    return { targetId, snapshots: await listSnapshots(provider) }
  }

  async status() {
    const settings = await this.getSettings()
    const remembered = settings.targets.find(
      (item) => item.id === settings.lastTargetId && item.enabled !== false,
    )
    const preferred = remembered
      || settings.targets.find((item) => item.enabled !== false)
      || settings.targets[0]
      || null
    const lastRun = preferred ? await this.store.loadLastRun(preferred.id) : null
    return {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      targetCount: settings.targets.length,
      lastTargetId: settings.lastTargetId,
      defaultTargetId: preferred ? preferred.id : null,
      lastRun,
    }
  }

  /** Remote repository metadata for the settings page's backup-info card. */
  async getBackupInfo(targetId) {
    const settings = await this.getSettings()
    const target = targetId
      ? settings.targets.find((item) => item.id === targetId)
      : (settings.targets.find((item) => item.enabled !== false) ?? settings.targets[0])
    if (!target) return null
    const cached = this._backupInfoCache
    const cacheTtl = target.kind === 'oss' ? 5 * 60 * 1000 : 3000
    if (cached && cached.targetId === target.id && Date.now() - cached.at < cacheTtl) return cached.value
    const info = {
      targetId: target.id,
      targetName: target.name,
      kind: target.kind,
      prefix: target.prefix,
      repoRoot: null,
      exists: false,
      dshVersion: null,
      updatedAt: null,
      devices: [],
      error: null,
    }
    try {
      this._activeSettings = settings
      const provider = this.providerFor(target, settings)
      info.repoRoot = provider.repoRoot ?? null
      const meta = parseJson(await provider.get('meta.json'), null)
      if (meta && typeof meta === 'object') {
        info.exists = true
        if (typeof meta.dshVersion === 'string' && meta.dshVersion) info.dshVersion = meta.dshVersion
        if (typeof meta.updatedAt === 'string' && meta.updatedAt) info.updatedAt = meta.updatedAt
        info.devices = Object.entries(meta.devices && typeof meta.devices === 'object' ? meta.devices : {}).map(
          ([id, value]) => ({
            id,
            name: value && typeof value.name === 'string' ? value.name : '',
            lastSeenAt: value && typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null,
          }),
        )
      }
    } catch (error) {
      info.error = String(error?.message ?? error)
    }
    this._backupInfoCache = { targetId: target.id, at: Date.now(), value: info }
    return info
  }

  /**
   * Upload/download the profile's plugin enable state.
   *
   * Direction semantics mirror file sync: `push` uploads, `pull` applies the
   * remote document, `both` lets the newer `updatedAt` win (local mtime versus
   * the remote document timestamp).
   */
  async syncPluginState({ provider, settings, direction }) {
    const profile = await resolvePluginsProfile(this.dshHome, settings.scopes?.plugins?.profile)
    const key = pluginStateKey(profile)
    const local = await readPluginState(this.dshHome, profile)
    let remote = null
    try {
      remote = JSON.parse((await provider.get(key)).toString('utf8'))
    } catch {
      remote = null
    }
    const localTime = Date.parse(local.updatedAt) || 0
    const remoteTime = remote ? (Date.parse(remote.updatedAt) || 0) : 0
    if (direction !== 'pull' && (direction === 'push' || !remote || remoteTime <= localTime)) {
      await provider.put(key, Buffer.from(JSON.stringify(local), 'utf8'))
    }
    if (direction !== 'push' && remote && (direction === 'pull' || remoteTime > localTime)) {
      await applyPluginState(this.dshHome, profile, remote)
    }
    return { profile, uploaded: direction !== 'pull', remoteApplied: direction !== 'push' && Boolean(remote) }
  }

  /** Sessions in the backup, tagged with the device that backed them up. */
  async sessionsInventory({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const remote = await this.loadRemote(provider, settings.deviceId)
    const localSessions = await listLocalSessionData(join(this.dshHome, 'sessions'))
    const devices = new Map([[settings.deviceId, settings.deviceName]])
    const rows = new Map()
    for (const manifest of remote.manifests) {
      const deviceId = manifest.deviceId
      const deviceName = manifest.deviceName || deviceId
      devices.set(deviceId, deviceName)
      const files = manifest.scopes?.sessions?.files ?? {}
      for (const [rel, entry] of Object.entries(files)) {
        const parsed = parseSessionRel(rel)
        if (!parsed) continue
        const key = deviceId + '|' + parsed.sessionId
        const previous = rows.get(key)
        const size = Number(entry.size) || 0
        const mtimeMs = Number(entry.mtimeMs) || 0
        if (previous) {
          previous.size += size
          previous.mtimeMs = Math.max(previous.mtimeMs, mtimeMs)
          continue
        }
        rows.set(key, {
          id: parsed.sessionId,
          projectDir: parsed.projectDir,
          deviceId,
          deviceName,
          cwd: decodeWorkspaceDir(parsed.projectDir),
          size,
          mtimeMs,
          own: deviceId === settings.deviceId,
          synced: localSessions.has(parsed.sessionId),
        })
      }
    }
    return {
      targetId: target.id,
      devices: [...devices.entries()].map(([id, name]) => ({ id, name })),
      sessions: [...rows.values()].sort((left, right) => right.mtimeMs - left.mtimeMs),
    }
  }

  /** Plugin packages present in other devices' backups. */
  async listBackupPlugins({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const remote = await this.loadRemote(provider, settings.deviceId)
    const devices = new Map([[settings.deviceId, settings.deviceName]])
    const rows = new Map()
    for (const manifest of remote.manifests) {
      const deviceId = manifest.deviceId
      const deviceName = manifest.deviceName || deviceId
      devices.set(deviceId, deviceName)
      const files = manifest.scopes?.plugins?.files ?? {}
      const packages = new Map()
      for (const [rel, entry] of Object.entries(files)) {
        const match = /^plugins\/([^/]+)\/packages\/(.+)\/package\.json$/.exec(rel)
        if (!match) continue
        const profile = match[1]
        const name = match[2]
        const key = deviceId + '|' + profile + '|' + name
        let row = rows.get(key)
        if (!row) {
          row = { name, profile, deviceId, deviceName, version: '', sizeBytes: 0, own: deviceId === settings.deviceId }
          rows.set(key, row)
        }
        row.sizeBytes += Number(entry.size) || 0
      }
      // Versions and local-install state need one blob read per package.
      for (const [key, row] of rows) {
        if (!key.startsWith(deviceId + '|')) continue
        const manifestEntry = files[`plugins/${row.profile}/packages/${row.name}/package.json`]
        if (manifestEntry) {
          try {
            const buffer = await provider.get(blobKey(manifestEntry.sha256))
            const pkg = JSON.parse(buffer.toString('utf8'))
            row.version = typeof pkg.version === 'string' ? pkg.version : ''
          } catch {
            row.version = ''
          }
        }
        let installed = false
        try {
          await fsp.stat(join(this.dshHome, 'profiles', row.profile, 'node_modules', row.name, 'package.json'))
          installed = true
        } catch {
          installed = false
        }
        row.synced = installed
      }
    }
    for (const row of rows.values()) {
      if (typeof row.synced !== 'boolean') row.synced = false
    }
    return {
      targetId: target.id,
      devices: [...devices.entries()].map(([id, name]) => ({ id, name })),
      plugins: [...rows.values()].sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  /** Copy one plugin package from a device's backup into the local profile. */
  async installBackupPlugin({ targetId, deviceId, name } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const remote = await this.loadRemote(provider, settings.deviceId)
    const manifest = remote.manifests.find((item) => item.deviceId === deviceId)
    if (!manifest) throw new SyncError('not-found', '备份中找不到该设备')
    const files = manifest.scopes?.plugins?.files ?? {}
    const prefix = Object.keys(files).find((rel) => /^plugins\/[^/]+\/packages\/.+\/package\.json$/.test(rel) && rel.includes('/packages/' + name + '/'))
    if (!prefix) throw new SyncError('not-found', '备份中找不到该插件')
    const profile = /^plugins\/([^/]+)\//.exec(prefix)[1]
    const packagePrefix = prefix.slice(0, prefix.indexOf('/package.json') + 1)
    let copied = 0
    let packageJson = null
    for (const [rel, entry] of Object.entries(files)) {
      if (!rel.startsWith(packagePrefix)) continue
      const relative = rel.slice(packagePrefix.length)
      const destination = join(this.dshHome, 'profiles', profile, 'node_modules', name, relative)
      await ensureDir(dirname(destination))
      const blob = await provider.get(blobKey(entry.sha256))
      if (!blob) throw new SyncError('missing-blob', '备份缺少内容块: ' + entry.sha256)
      await atomicWrite(destination, blob, 0o644)
      copied += 1
      if (relative === 'package.json') {
        try {
          packageJson = JSON.parse(blob.toString('utf8'))
        } catch {
          packageJson = null
        }
      }
    }
    // Register the package so the next DSH start can load it. Enabling inside a
    // running DSH still needs a restart, which the UI states explicitly.
    const profilePackage = join(this.dshHome, 'profiles', profile, 'package.json')
    try {
      const pkg = JSON.parse(await fsp.readFile(profilePackage, 'utf8'))
      pkg.dependencies ??= {}
      if (packageJson && packageJson.version) pkg.dependencies[name] = packageJson.version
      else pkg.dependencies[name] ??= '*'
      if (packageJson && packageJson.dsh && packageJson.dsh.bundle) {
        pkg.dsh ??= {}
        pkg.dsh.profile ??= {}
        const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
        if (!bundles.includes(name)) bundles.push(name)
        pkg.dsh.profile.bundles = bundles
      }
      await atomicWrite(profilePackage, JSON.stringify(pkg, null, 2) + '\n', 0o644)
    } catch {
      // A read-only profile still gets the package files on disk.
    }
    return { ok: true, profile, name, files: copied }
  }

  /** Installed plugins of the active profile plus their backup versions. */
  async listPlugins({ targetId } = {}) {
    const settings = await this.getSettings()
    this._activeSettings = settings
    const cache = this._pluginsCache
    const cacheKey = `${targetId ?? ''}|${settings.scopes?.plugins?.profile ?? ''}`
    if (cache && cache.key === cacheKey && Date.now() - cache.at < 5000) return cache.value
    const profile = await resolvePluginsProfile(this.dshHome, settings.scopes?.plugins?.profile)
    const profileDir = join(this.dshHome, 'profiles', profile)
    let profilePkg = {}
    try {
      profilePkg = JSON.parse(await fsp.readFile(join(profileDir, 'package.json'), 'utf8'))
    } catch {
      profilePkg = {}
    }
    const bundles = Array.isArray(profilePkg?.dsh?.profile?.bundles) ? profilePkg.dsh.profile.bundles : []
    const dependencies = Object.keys(profilePkg?.dependencies ?? {})
    const scopeSettings = settings.scopes?.plugins ?? {}
    const selected = new Set(Array.isArray(scopeSettings.selectedPlugins) ? scopeSettings.selectedPlugins : [])
    const settingsPlugins = new Set(Array.isArray(scopeSettings.settingsPlugins) ? scopeSettings.settingsPlugins : [])
    const rows = []
    for (const name of dependencies.sort()) {
      const dir = join(profileDir, 'node_modules', name)
      let manifest
      try {
        manifest = JSON.parse(await fsp.readFile(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      const isBundle = Boolean(manifest?.dsh?.bundle)
      rows.push({
        name,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        bundle: isBundle,
        enabled: bundles.includes(name) || !isBundle,
        selected: selected.has(name),
        settingsSync: settingsPlugins.has(name),
        sizeBytes: await this.pluginDirectorySize(dir),
        backupVersion: null,
        backupExists: false,
      })
    }
    let resolvedTargetId = targetId ?? null
    try {
      const state = await readPluginState(this.dshHome, profile)
      const disabled = state.disabled ?? {}
      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(disabled, row.name)) row.enabled = !disabled[row.name]
      }
      rows.sort((left, right) => left.name.localeCompare(right.name))
      const target = targetId
        ? settings.targets.find((item) => item.id === targetId)
        : (settings.targets.find((item) => item.enabled !== false) ?? settings.targets[0])
      resolvedTargetId = target ? target.id : null
      if (target) {
        const provider = this.providerFor(target, settings)
        const remote = await this.loadRemote(provider, settings.deviceId)
        const entries = remote.merged?.plugins ?? {}
        for (const row of rows) {
          const rel = `plugins/${profile}/packages/${row.name}/package.json`
          const entry = entries[rel]
          if (!entry) continue
          row.backupExists = true
          try {
            const buffer = await provider.get(blobKey(entry.sha256))
            const manifest = JSON.parse(buffer.toString('utf8'))
            row.backupVersion = typeof manifest.version === 'string' ? manifest.version : ''
          } catch {
            row.backupVersion = ''
          }
        }
      }
    } catch {
      // A missing/unreachable target still lets the user manage selection.
    }
    const experimental = bundles
      .filter((name) => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
      .filter((name) => name.includes('experimental') || EXPERIMENTAL_PLUGIN_LABELS[name])
      .map((name) => ({ id: name, name: experimentalLabel(name), enabled: true }))
    const value = {
      profile,
      profiles: await listProfileNames(this.dshHome),
      targetId: resolvedTargetId,
      rows,
      // Built-in capability pages are not on/off plugins; show them as built-in
      // config entries, and list only the experimental bundles that are on.
      builtins: BUILTIN_PLUGIN_CONFIGS.map((item) => ({ ...item, enabled: true })),
      experimental,
    }
    this._pluginsCache = { key: cacheKey, at: Date.now(), value }
    return value
  }

  /** Persist the plugin checkbox selection for the plugins scope. */
  async savePluginsSelection(input = {}) {
    const settings = await this.getSettings()
    const current = settings.scopes?.plugins ?? {}
    const clean = (list, fallback) => {
      const source = Array.isArray(list) ? list : (Array.isArray(fallback) ? fallback : [])
      return [...new Set(source.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))]
    }
    const plugins = {
      ...current,
      selectedPlugins: clean(input.selectedPlugins, current.selectedPlugins),
      settingsPlugins: clean(input.settingsPlugins, current.settingsPlugins),
    }
    if (typeof input.profile === 'string' && input.profile.trim()) plugins.profile = input.profile.trim()
    const scopes = { plugins }
    // Plugin configs travel through the plugin-settings scope; checking any
    // per-plugin config flag must therefore keep that scope enabled.
    if (plugins.settingsPlugins.length > 0) scopes['plugin-settings'] = { enabled: true }
    const saved = await this.saveSettings({ scopes })
    this._pluginsCache = null
    return saved
  }

  /** Recursive on-disk size of one plugin package (symlinks and nested deps skipped). */
  async pluginDirectorySize(dir) {
    const now = Date.now()
    this._pluginSizeCache ??= new Map()
    const cached = this._pluginSizeCache.get(dir)
    if (cached && now - cached.at < 60000) return cached.size
    const walk = async (current) => {
      let total = 0
      let items
      try {
        items = await fsp.readdir(current, { withFileTypes: true })
      } catch {
        return 0
      }
      for (const item of items) {
        if (item.isSymbolicLink()) continue
        const child = join(current, item.name)
        if (item.isDirectory()) {
          if (item.name === 'node_modules') continue
          total += await walk(child)
        } else if (item.isFile()) {
          try {
            total += (await fsp.stat(child)).size
          } catch {
            // Race with a removal; ignore the vanished file.
          }
        }
      }
      return total
    }
    const size = await walk(dir)
    this._pluginSizeCache.set(dir, { at: now, size })
    return size
  }

  /** Sessions available in the newest target manifest, for the restore dialog. */
  async listBackupSessions({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const backup = await readBackupSessionGroups({ provider, selfDeviceId: settings.deviceId })
    const sessions = [...backup.sessions.values()].map((group) => ({
      sessionId: group.sessionId,
      projectDir: group.projectDir,
      projectDirs: [...group.projectDirs],
      cwd: decodeWorkspaceDir(group.projectDir),
      files: group.files.size,
      size: group.totalSize,
      mtimeMs: group.mtimeMs,
      logSha256: group.logSha,
    }))
    sessions.sort((left, right) => String(left.cwd).localeCompare(String(right.cwd)))
    return { targetId, sessions }
  }

  /**
   * Compare the local store with the newest target manifest, grouped by session
   * id. Rows carry size / mtime / sha256 and the append-only relation.
   */
  async compareSessions({ targetId, sessionIds, osUser = '' } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    const localSessions = await listLocalSessionData(join(this.dshHome, 'sessions'))
    const backup = await readBackupSessionGroups({ provider, selfDeviceId: settings.deviceId })
    const base = await this.store.loadBaseManifest(targetId)
    const rows = await compareSessionsData({
      provider,
      settings,
      localSessions,
      backupSessions: backup.sessions,
      baseScopeFiles: base.scopes?.sessions?.files ?? {},
      sessionIds,
      osUser,
    })
    const counts = {
      same: 0,
      localOnly: 0,
      backupOnly: 0,
      localAhead: 0,
      backupAhead: 0,
      localNewer: 0,
      backupNewer: 0,
      divergent: 0,
    }
    for (const row of rows) {
      if (row.status === 'same') counts.same += 1
      else if (row.status === 'local-only') counts.localOnly += 1
      else if (row.status === 'backup-only') counts.backupOnly += 1
      else if (row.status === 'local-ahead') counts.localAhead += 1
      else if (row.status === 'backup-ahead') counts.backupAhead += 1
      else if (row.status === 'local-newer') counts.localNewer += 1
      else if (row.status === 'backup-newer') counts.backupNewer += 1
      else if (row.status === 'divergent') counts.divergent += 1
    }
    return {
      targetId,
      rows,
      counts,
      sessionPathKey: sessionPathKeyOf(settings.deviceName, osUser),
    }
  }

  /** Push the given sessions into the target (explicit, per-session action). */
  async syncSessions({ targetId, sessionIds, confirm } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    return await syncSessionsToBackup({ engine: this, provider, settings, targetId, sessionIds, confirm })
  }

  /** Pull sessions back from the target, backing up local copies first. */
  async restoreSessions({ targetId, sessionIds, targetPath = '', autoReplaceUserFolder, confirm, osUser = '' } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    return await restoreSessionsFromBackup({
      engine: this,
      provider,
      settings,
      targetId,
      sessionIds,
      targetPath,
      autoReplaceUserFolder: autoReplaceUserFolder === undefined
        ? settings.autoReplaceUserFolder === true
        : autoReplaceUserFolder === true,
      confirm,
      osUser,
    })
  }

  /** Overwrite one side with the other after an explicit confirmation. */
  async overwriteSessions({ targetId, sessionIds, side, confirm, targetPath = '', autoReplaceUserFolder, osUser = '' } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    return await overwriteSessionsOnTarget({
      engine: this,
      provider,
      settings,
      targetId,
      sessionIds,
      side,
      confirm,
      targetPath,
      autoReplaceUserFolder: autoReplaceUserFolder === undefined
        ? settings.autoReplaceUserFolder === true
        : autoReplaceUserFolder === true,
      osUser,
    })
  }
}
