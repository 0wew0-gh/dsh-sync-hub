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
import { dirname, join } from 'node:path'
import { SyncError } from './errors.js'
import {
  absPathForRel,
  customItemPath,
  customScopeId,
  enabledCustomItems,
  findCustomItem,
  getScope,
  isCustomScope,
  SCOPES,
} from './scopes.js'
import { scanScope } from './scan.js'
import { buildScopeManifest, MANIFEST_SCHEMA, mergeRemoteManifests, planScope, summarizeActions } from './manifest.js'
import { mergeSettings, normalizeSettings, StateStore, targetPathForDevice } from './state.js'
import { createTarget, blobKey, manifestKey } from './targets/index.js'
import { listSnapshots, recordSnapshot } from './history.js'
import { assertSafeRel, normalizeTargetPath } from './paths.js'
import { atomicWrite, ensureDir, sha256Buffer, sha256File, statOrUndefined, timestampSlug } from './util.js'

const META_SCHEMA = 'dsh-sync/v1/meta'

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
    return createTarget({ ...target, path: targetPathForDevice(target, deviceName) })
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
      const entries = await scanScope(scopeId, context)
      const baseFiles = base.scopes?.[scopeId]?.files ?? {}
      const local = await buildScopeManifest(scopeId, entries, baseFiles)
      hashed += local.stats.hashed
      reused += local.stats.reused
      const remoteFiles = remote.merged[scopeId] ?? {}
      const policy = getScope(scopeId)?.policy ?? 'newer'
      const { actions, summary } = planScope({
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
      planned.push({ scopeId, entries, local, baseFiles, remoteFiles, actions, summary, policy })
    }
    return { base, remote, planned, stats: { hashed, reused } }
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
    for (const scope of planned) {
      for (const action of scope.actions) {
        if (action.type === 'upload') counts.upload += 1
        else if (action.type === 'download') counts.download += 1
        else if (action.type === 'conflict') counts.conflict += 1
        else if (action.type === 'choice') counts.choice += 1
      }
    }
    return {
      targetId: target.id,
      ...counts,
      total: counts.upload + counts.download + counts.conflict + counts.choice,
    }
  }

  /** Read-only preview: plan only, no writes. */
  async preview({ targetId, scopeIds, direction, deleteChoice } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
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
    return {
      targetId,
      direction: dir,
      summary,
      stats,
      choices: actions.filter((action) => action.type === 'choice'),
      actions: actions.slice(0, 2000),
      truncated: actions.length > 2000,
    }
  }

  async ensureBlob(provider, absPath, sha256, stats) {
    const key = blobKey(sha256)
    if (await provider.head(key)) return false
    const buffer = await fsp.readFile(absPath)
    const actual = sha256Buffer(buffer)
    if (actual !== sha256) {
      throw new SyncError('content-changed', `文件在同步过程中发生变化，跳过本轮: ${absPath}`)
    }
    await provider.put(key, buffer)
    stats.bytesUploaded += buffer.length
    return true
  }

  /**
   * Download one blob to `absPath`.
   *
   * Returns the fresh stat entry, or `undefined` when the destination already
   * holds identical bytes and `force` is off (the "do not overwrite identical
   * content" rule).
   */
  async downloadFile({ provider, remoteEntry, absPath, force, stats }) {
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
    await ensureDir(dirname(absPath))
    await atomicWrite(absPath, blob, remoteEntry.mode ?? 0o600)
    const stat = await fsp.stat(absPath)
    stats.bytesDownloaded += stat.size
    return { size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 }
  }

  async uploadScope({ provider, scopeId, entries, localFiles, actions, stats, onAction }) {
    for (const action of actions) {
      const needUpload = action.type === 'upload'
        || (action.type === 'conflict' && action.resolution === 'keep-local')
      if (!needUpload) continue
      const rel = assertSafeRel(action.path)
      const entry = entries.get(rel)
      const meta = localFiles[rel]
      if (!entry || !meta) continue
      const uploaded = await this.ensureBlob(provider, entry.abs, meta.sha256, stats)
      if (uploaded) stats.uploaded += 1
      onAction?.(1)
    }
  }

  async downloadScope({ provider, scope, entries, localFiles, remoteFiles, actions, settings, stats, onAction }) {
    const next = { ...localFiles }
    for (const action of actions) {
      if (action.type !== 'download' && action.type !== 'conflict') continue
      const rel = assertSafeRel(action.path)
      const remote = remoteFiles[rel]
      if (!remote) continue
      if (action.type === 'conflict' && action.resolution === 'keep-local') continue

      if (action.type === 'download' || action.resolution === 'restore-remote') {
        const abs = absPathForRel(scope, rel, this.pathContext)
        const written = await this.downloadFile({
          provider,
          remoteEntry: remote,
          absPath: abs,
          force: settings.force === true,
          stats,
        })
        if (written) {
          next[rel] = { scope, size: written.size, mtimeMs: written.mtimeMs, mode: written.mode, sha256: remote.sha256 }
          stats.downloaded += 1
        } else if (!next[rel] && entries.has(rel)) {
          // Destination already had identical bytes but the file was not in the
          // scanned view (should be rare); keep the scanned metadata.
          const entry = entries.get(rel)
          next[rel] = { scope, size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, sha256: remote.sha256 }
        }
        onAction?.(1)
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

      emit('upload', { scope: scope.scopeId }, true)
      await this.uploadScope({
        provider,
        scopeId: scope.scopeId,
        entries: scope.entries,
        localFiles: scope.local.files,
        actions: scope.actions,
        stats: counters,
        onAction: actionCallback('upload', scope.scopeId),
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

    const meta = remote.meta ?? { schema: META_SCHEMA, devices: {} }
    meta.schema = META_SCHEMA
    meta.devices ??= {}
    meta.devices[settings.deviceId] = {
      name: settings.deviceName,
      lastSeenAt: new Date().toISOString(),
    }
    meta.updatedAt = new Date().toISOString()
    await provider.put('meta.json', Buffer.from(JSON.stringify(meta), 'utf8'))

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
        effectivePath: targetPathForDevice(target, settings.deviceName),
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
    const target = {
      id: typeof input?.id === 'string' && input.id ? input.id : undefined,
      name: String(input?.name ?? existing?.name ?? '本地目录').trim() || '本地目录',
      kind: input?.kind ?? existing?.kind ?? 'local',
      enabled: input?.enabled !== false,
      path: effectiveInputPath,
      devicePaths,
      prefix: typeof input?.prefix === 'string' && input.prefix.trim() ? input.prefix.trim() : (existing?.prefix ?? 'dsh-sync/v1'),
    }
    if (target.kind !== 'local') throw new SyncError('unsupported-target', 'v0.1 仅支持本地目录目标')
    if (existingIndex >= 0) settings.targets[existingIndex] = { ...existing, ...target }
    else settings.targets.push({ ...target, id: target.id ?? `t_${Math.random().toString(16).slice(2, 10)}` })
    const saved = await this.store.saveSettings(normalizeSettings(settings))
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

  async testTarget(input) {
    const settings = await this.getSettings()
    this._activeSettings = settings
    const stored = input?.id ? settings.targets.find((item) => item.id === input.id) : undefined
    const target = stored ? { ...stored, ...input, devicePaths: stored.devicePaths } : input
    const effectivePath = targetPathForDevice(target, settings.deviceName)
    if (!effectivePath) throw new SyncError('bad-target', '目标路径不能为空')
    const provider = createTarget({ ...target, path: effectivePath })
    return await provider.probe()
  }

  async listSnapshots({ targetId } = {}) {
    const { settings, target } = await this.requireTarget(targetId)
    this._activeSettings = settings
    const provider = this.providerFor(target, settings)
    return { targetId, snapshots: await listSnapshots(provider) }
  }

  async status() {
    const settings = await this.getSettings()
    let lastRun = null
    const first = settings.targets[0]
    if (first) lastRun = await this.store.loadLastRun(first.id)
    return {
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      targetCount: settings.targets.length,
      lastRun,
    }
  }
}
