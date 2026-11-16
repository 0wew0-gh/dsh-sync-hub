/**
 * Session-level transfer for the `sessions` scope.
 *
 * Three user-facing operations live here:
 *
 * 1. `compareSessionsData()` compares the local store with the newest backup
 *    manifest, one row per session id. Rows carry size / mtime / sha256 and
 *    whether one side is a byte prefix of the other (an append-only log can be
 *    fast-forwarded, a forked log cannot).
 * 2. `syncSessionsToBackup()` pushes selected session directories into the
 *    target repository (content-addressed blobs + this device's manifest).
 * 3. `restoreSessionsFromBackup()` pulls sessions back, rewriting the session
 *    header cwd to the chosen local path, moving any existing copy of the same
 *    session id into the local backup folder first, and writing atomically.
 *
 * Session logs are zstd frame sequences, so they are transferred as opaque
 * bytes and never merged at the frame level.
 */
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { SyncError } from './errors.js'
import { recordSnapshot } from './history.js'
import { MANIFEST_SCHEMA, mergeRemoteManifests } from './manifest.js'
import { blobKey, manifestKey } from './targets/index.js'
import {
  assertSafeRel,
  decodeWorkspaceDir,
  isAbsoluteAnyPlatform,
  resolveInside,
  resolveDshVersion,
  trimTrailingSeparators,
} from './paths.js'
import {
  SESSION_LOG_PATTERN,
  normalizeSelectedSessionIds,
  normalizeSessionId,
  parseSessionRel,
  projectKey,
  readSessionHeader,
  readSessionHeaderFile,
  rewriteSessionCwd,
  sessionPathKeyOf,
  sessionPathsFor,
  userRootOf,
} from './sessions.js'
import { atomicWrite, ensureDir, sha256Buffer, sha256File, timestampSlug } from './util.js'

const META_SCHEMA = 'dsh-sync/v1/meta'

function parseJson(buffer, fallback) {
  if (!buffer) return fallback
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return fallback
  }
}

async function pathExists(file) {
  try {
    await fsp.stat(file)
    return true
  } catch {
    return false
  }
}

async function sha256OrEmpty(file) {
  try {
    return await sha256File(file)
  } catch {
    return ''
  }
}

/** Join a base directory and a path suffix, keeping the base separator style. */
function joinLike(base, suffix) {
  const root = trimTrailingSeparators(String(base || ''))
  const tail = String(suffix || '')
  if (!tail) return root
  const separator = root.includes('\\') ? '\\' : '/'
  const normalized = tail.replace(/[\\/]+/g, separator)
  return normalized.startsWith(separator) ? root + normalized : root + separator + normalized
}

/** Move a directory, falling back to copy + remove across devices. */
async function moveDir(from, to) {
  try {
    await fsp.rename(from, to)
    return 'rename'
  } catch (error) {
    if (error && error.code !== 'EXDEV' && error.code !== 'EPERM') throw error
  }
  await copyDir(from, to)
  await fsp.rm(from, { recursive: true, force: true })
  return 'copy'
}

async function copyDir(from, to) {
  await ensureDir(to)
  const entries = await fsp.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) await copyDir(source, destination)
    else if (entry.isFile()) {
      await ensureDir(dirname(destination))
      await fsp.copyFile(source, destination)
    }
  }
}

async function removeDirIfEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir)
    if (entries.length === 0) await fsp.rm(dir, { recursive: true, force: true })
  } catch {
    // The project directory may already be gone.
  }
}

/** Read this device's manifest, or a fresh skeleton when it does not exist. */
async function readSelfManifest(provider, deviceId) {
  const manifest = parseJson(await provider.get(manifestKey(deviceId)), null)
  if (manifest && manifest.schema === MANIFEST_SCHEMA) {
    return {
      schema: MANIFEST_SCHEMA,
      deviceId,
      deviceName: manifest.deviceName ?? '',
      updatedAt: manifest.updatedAt ?? '',
      scopes: { ...(manifest.scopes ?? {}) },
    }
  }
  return { schema: MANIFEST_SCHEMA, deviceId, deviceName: '', updatedAt: '', scopes: {} }
}

/** Write this device's manifest and refresh `meta.json`. */
async function writeSelfManifest({ provider, settings, manifest }) {
  const next = {
    ...manifest,
    schema: MANIFEST_SCHEMA,
    deviceId: settings.deviceId,
    deviceName: settings.deviceName,
    updatedAt: new Date().toISOString(),
  }
  await provider.put(manifestKey(settings.deviceId), Buffer.from(JSON.stringify(next), 'utf8'))
  const meta = parseJson(await provider.get('meta.json'), { schema: META_SCHEMA, devices: {} })
  meta.schema = META_SCHEMA
  meta.dshVersion = resolveDshVersion()
  meta.devices ??= {}
  meta.devices[settings.deviceId] = { name: settings.deviceName, lastSeenAt: new Date().toISOString() }
  meta.updatedAt = new Date().toISOString()
  await provider.put('meta.json', Buffer.from(JSON.stringify(meta), 'utf8'))
  return next
}

/**
 * Read every manifest in the target repository and group its session files by
 * session id. One session id always yields one group even when several devices
 * or project directories reference it: the copy with the newest log wins.
 */
export async function readBackupSessionGroups({ provider, selfDeviceId }) {
  const meta = parseJson(await provider.get('meta.json'), { schema: META_SCHEMA, devices: {} })
  const deviceIds = new Set([...Object.keys(meta.devices ?? {}), selfDeviceId])
  const manifests = []
  for (const deviceId of deviceIds) {
    const manifest = parseJson(await provider.get(manifestKey(deviceId)), null)
    if (manifest && manifest.schema === MANIFEST_SCHEMA) manifests.push(manifest)
  }
  const merged = mergeRemoteManifests(manifests)
  const sessions = new Map()
  // Walk manifests oldest-first so the newest manifest that references a
  // project directory decides which copy of a session id is canonical.
  for (const manifest of [...manifests].sort((left, right) => String(left.updatedAt ?? '').localeCompare(String(right.updatedAt ?? '')))) {
    for (const [rel, entry] of Object.entries(manifest.scopes?.sessions?.files ?? {})) {
      const parsed = parseSessionRel(rel)
      if (!parsed) continue
      let group = sessions.get(parsed.sessionId)
      if (!group) {
        group = { sessionId: parsed.sessionId, byProject: new Map(), projectDirs: new Set(), files: new Map(), totalSize: 0, mtimeMs: 0, logSha: '', projectDir: '' }
        sessions.set(parsed.sessionId, group)
      }
      group.projectDirs.add(parsed.projectDir)
      let bucket = group.byProject.get(parsed.projectDir)
      if (!bucket) {
        bucket = { updatedAt: '', records: new Map() }
        group.byProject.set(parsed.projectDir, bucket)
      }
      bucket.updatedAt = String(manifest.updatedAt ?? '')
      bucket.records.set(parsed.rest, { rel, fileName: parsed.rest, projectDir: parsed.projectDir, entry })
    }
  }
  for (const group of sessions.values()) {
    let best = null
    for (const [projectDir, bucket] of group.byProject) {
      let logSize = -1
      let logMtime = -1
      let logSha = ''
      let totalSize = 0
      let mtimeMs = 0
      for (const record of bucket.records.values()) {
        const size = Number(record.entry?.size) || 0
        const mtime = Number(record.entry?.mtimeMs) || 0
        totalSize += size
        mtimeMs = Math.max(mtimeMs, mtime)
        if (SESSION_LOG_PATTERN.test(record.fileName) && (size > logSize || (size === logSize && mtime > logMtime))) {
          logSize = size
          logMtime = mtime
          logSha = String(record.entry?.sha256 ?? '')
        }
      }
      const rank = { projectDir, updatedAt: bucket.updatedAt, logSize, logMtime, logSha, totalSize, mtimeMs, files: bucket.records }
      if (
        !best
        || rank.updatedAt > best.updatedAt
        || (rank.updatedAt === best.updatedAt && rank.logSize > best.logSize)
        || (rank.updatedAt === best.updatedAt && rank.logSize === best.logSize && rank.logMtime > best.logMtime)
      ) {
        best = rank
      }
    }
    if (!best) continue
    group.projectDir = best.projectDir
    group.files = best.files
    group.totalSize = best.totalSize
    group.mtimeMs = best.mtimeMs
    group.logSha = best.logSha
  }
  return { meta, manifests, merged, sessions }
}

/** Recursively collect the files of one session directory. */
async function walkSessionFiles(dirAbs, relPrefix, out, depth = 0) {
  if (depth > 4) return
  let entries
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dirAbs, entry.name)
    const rest = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await walkSessionFiles(abs, rest, out, depth + 1)
    } else if (entry.isFile()) {
      let stat
      try {
        stat = await fsp.stat(abs)
      } catch {
        continue
      }
      out.push({ rest, abs, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
}

/**
 * Walk the local session store and group the directories by session id.
 * Copies with the same id (restored duplicates, interrupted relocations) are
 * kept in `copies` so the caller can back them up or report them.
 */
export async function listLocalSessionData(sessionsDir) {
  const sessions = new Map()
  let projects
  try {
    projects = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return sessions
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith('.dedupe-backup-')) continue
    const projectAbs = join(sessionsDir, project.name)
    let entries
    try {
      entries = await fsp.readdir(projectAbs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = normalizeSessionId(entry.name)
      if (!sessionId) continue
      const dirAbs = join(projectAbs, entry.name)
      const files = []
      await walkSessionFiles(dirAbs, '', files)
      if (files.length === 0) continue
      let logFile = ''
      let logSize = 0
      for (const file of files) {
        if (SESSION_LOG_PATTERN.test(basename(file.rest)) && file.size > logSize) {
          logFile = file.rest
          logSize = file.size
        }
      }
      let cwd = ''
      if (logFile) {
        try {
          cwd = (await readSessionHeaderFile(join(dirAbs, logFile))).header.cwd
        } catch {
          cwd = ''
        }
      }
      const exists = cwd ? await pathExists(cwd) : false
      const size = files.reduce((total, file) => total + file.size, 0)
      const mtimeMs = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0)
      let session = sessions.get(sessionId)
      if (!session) {
        session = { sessionId, copies: [] }
        sessions.set(sessionId, session)
      }
      session.copies.push({ projectDir: project.name, dirAbs, cwd, exists, files, logFile, logSize, size, mtimeMs })
    }
  }
  return sessions
}

/** Pick the copy a user is most likely using: existing cwd, biggest log, newest. */
export function representativeLocalCopy(session) {
  const copies = Array.isArray(session?.copies) ? session.copies : []
  if (copies.length === 0) return null
  return [...copies].sort((left, right) => (
    (Number(right.exists) - Number(left.exists))
    || (Number(right.logSize) - Number(left.logSize))
    || (Number(right.mtimeMs) - Number(left.mtimeMs))
  ))[0]
}

/** Log record of one backup group (the file that carries the header). */
function backupLogRecord(group) {
  let best = null
  for (const record of group.files.values()) {
    if (!SESSION_LOG_PATTERN.test(record.fileName)) continue
    if (!best || (Number(record.entry?.size) || 0) > (Number(best.entry?.size) || 0)) best = record
  }
  return best
}

/** Group base-manifest entries into a set of log sha256 values per session id. */
function baseLogShas(baseScopeFiles) {
  const shas = new Map()
  for (const [rel, entry] of Object.entries(baseScopeFiles ?? {})) {
    const parsed = parseSessionRel(rel)
    if (!parsed || !SESSION_LOG_PATTERN.test(basename(parsed.rest))) continue
    let set = shas.get(parsed.sessionId)
    if (!set) {
      set = new Set()
      shas.set(parsed.sessionId, set)
    }
    if (entry?.sha256) set.add(entry.sha256)
  }
  return shas
}

/**
 * Check whether one session log is a byte prefix of the other.
 *
 * @returns {'local-ahead'|'backup-ahead'|'same'|''} `local-ahead` means the
 *   local log contains the backup log as a prefix (append-only fast-forward).
 */
async function prefixRelation({ provider, localCopy, backupGroup }) {
  const record = backupLogRecord(backupGroup)
  if (!record?.entry?.sha256) return ''
  const logPath = localCopy.logFile ? join(localCopy.dirAbs, localCopy.logFile) : ''
  if (!logPath) return ''
  let local
  try {
    local = await fsp.readFile(logPath)
  } catch {
    return ''
  }
  const remote = await provider.get(blobKey(record.entry.sha256))
  if (!remote) return ''
  const shorter = local.length <= remote.length ? local : remote
  const longer = local.length <= remote.length ? remote : local
  if (!shorter.equals(longer.subarray(0, shorter.length))) return ''
  if (local.length === remote.length) return 'same'
  return local.length > remote.length ? 'local-ahead' : 'backup-ahead'
}

/**
 * Append-only relation between a local session log and one remote manifest
 * entry. Only the shorter side is read in full, so a large log is not loaded
 * twice just to detect a fast-forward.
 *
 * @returns {'local-ahead'|'backup-ahead'|''} `local-ahead` means the backup is
 *   a byte prefix of the local log (upload can fast-forward).
 */
export async function appendRelation({ provider, localAbs, remoteEntry, localSize }) {
  if (!localAbs || !remoteEntry?.sha256) return ''
  const remote = await provider.get(blobKey(remoteEntry.sha256))
  if (!remote) return ''
  const size = Number(localSize)
  const length = Number.isFinite(size) && size >= 0 ? Math.min(size, remote.length) : remote.length
  let localPrefix
  try {
    const handle = await fsp.open(localAbs, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      localPrefix = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
  if (Number.isFinite(size) && size > remote.length) return localPrefix.equals(remote) ? 'local-ahead' : ''
  if (Number.isFinite(size) && size < remote.length) {
    return remote.subarray(0, size).equals(localPrefix) ? 'backup-ahead' : ''
  }
  return ''
}

/**
 * Compare the local store with the newest backup manifest, one row per session
 * id. Both copies of a duplicate id are reported on the same row.
 */
export async function compareSessionsData({
  provider,
  settings,
  localSessions,
  backupSessions,
  baseScopeFiles = {},
  sessionIds,
  osUser = '',
}) {
  const requested = normalizeSelectedSessionIds(sessionIds)
  const wanted = requested.length > 0 ? new Set(requested) : null
  const baseShas = baseLogShas(baseScopeFiles)
  const ids = new Set([...localSessions.keys(), ...backupSessions.keys()])
  const scope = settings.scopes?.sessions ?? {}
  const selectedIds = new Set(scope.mode === 'selected' ? normalizeSelectedSessionIds(scope.selectedSessionIds) : [...ids])
  const rows = []
  for (const sessionId of [...ids].sort()) {
    if (wanted && !wanted.has(sessionId)) continue
    const localSession = localSessions.get(sessionId) ?? null
    const backupGroup = backupSessions.get(sessionId) ?? null
    const localCopy = representativeLocalCopy(localSession)
    let local = null
    if (localCopy) {
      const logAbs = localCopy.logFile ? join(localCopy.dirAbs, localCopy.logFile) : ''
      local = {
        exists: true,
        cwd: localCopy.cwd,
        cwdExists: localCopy.exists,
        projectDir: localCopy.projectDir,
        projectDirs: localSession.copies.map((copy) => copy.projectDir),
        copies: localSession.copies.length,
        logFile: localCopy.logFile,
        size: localCopy.logSize,
        totalSize: localCopy.size,
        mtimeMs: localCopy.mtimeMs,
        sha256: logAbs ? await sha256OrEmpty(logAbs) : '',
      }
    }
    let backup = null
    if (backupGroup) {
      const log = backupLogRecord(backupGroup)
      backup = {
        exists: true,
        cwd: decodeWorkspaceDir(backupGroup.projectDir),
        cwdSource: 'project-dir',
        projectDir: backupGroup.projectDir,
        projectDirs: [...backupGroup.projectDirs],
        files: backupGroup.files.size,
        logFile: log?.fileName ?? '',
        size: Number(log?.entry?.size) || 0,
        totalSize: backupGroup.totalSize,
        mtimeMs: backupGroup.mtimeMs,
        sha256: backupGroup.logSha,
      }
    }

    let status = 'same'
    let appendOnly = ''
    let recommended = 'none'
    if (local && backup) {
      if (local.sha256 && backup.sha256 && local.sha256 === backup.sha256) {
        status = 'same'
        recommended = 'none'
      } else {
        const relation = await prefixRelation({ provider, localCopy, backupGroup })
        if (relation === 'local-ahead') {
          status = 'local-ahead'
          appendOnly = 'local'
          recommended = 'backup'
        } else if (relation === 'backup-ahead') {
          status = 'backup-ahead'
          appendOnly = 'backup'
          recommended = 'local'
        } else {
          const base = baseShas.get(sessionId) ?? new Set()
          const localChanged = base.size > 0 ? !base.has(local.sha256) : null
          const backupChanged = base.size > 0 ? !base.has(backup.sha256) : null
          if (localChanged === true && backupChanged === false) {
            status = 'local-newer'
            recommended = 'backup'
          } else if (localChanged === false && backupChanged === true) {
            status = 'backup-newer'
            recommended = 'local'
          } else if (localChanged === true && backupChanged === true) {
            status = 'divergent'
            recommended = 'choose'
          } else {
            // No base record for this device: both sides exist with different
            // bytes and neither is a prefix, so the direction is genuinely
            // unknown. Never guess from mtime here.
            status = 'divergent'
            recommended = 'choose'
          }
        }
      }
    } else if (local) {
      status = 'local-only'
      recommended = 'backup'
    } else if (backup) {
      status = 'backup-only'
      recommended = 'local'
    }

    rows.push({
      sessionId,
      selected: selectedIds.has(sessionId),
      status,
      appendOnly,
      recommended,
      local,
      backup,
      diff: {
        sizeDelta: local && backup ? local.size - backup.size : null,
        mtimeDeltaMs: local && backup ? local.mtimeMs - backup.mtimeMs : null,
        sha256Equal: Boolean(local && backup && local.sha256 && local.sha256 === backup.sha256),
      },
    })
  }
  return rows
}

/**
 * Push the given sessions into the target repository.
 *
 * Replaces this device's manifest entries for each session id (including stale
 * project directories left by earlier restores) and updates the local base
 * manifest so the next ordinary sync sees them as already synchronized.
 */
export async function syncSessionsToBackup({ engine, provider, settings, targetId, sessionIds, confirm }) {
  if (confirm !== true) throw new SyncError('need-confirm', '同步会话前请确认（会写入目标端备份）')
  const requested = normalizeSelectedSessionIds(sessionIds)
  if (requested.length === 0) throw new SyncError('bad-sessions', '请选择要同步的会话')
  const scope = settings.scopes?.sessions ?? {}
  const selected = new Set(scope.mode === 'selected' ? normalizeSelectedSessionIds(scope.selectedSessionIds) : [])
  const localSessions = await listLocalSessionData(join(engine.dshHome, 'sessions'))
  const manifest = await readSelfManifest(provider, settings.deviceId)
  const currentFiles = { ...(manifest.scopes?.sessions?.files ?? {}) }
  const removed = new Set(manifest.scopes?.sessions?.removed ?? [])
  const baseManifest = await engine.store.loadBaseManifest(targetId)
  const baseScopes = { ...(baseManifest.scopes ?? {}) }
  const baseFiles = { ...(baseScopes.sessions?.files ?? {}) }
  const baseRemoved = new Set(baseScopes.sessions?.removed ?? [])
  const stats = { sessions: 0, files: 0, bytes: 0, uploaded: 0, bytesUploaded: 0 }
  for (const sessionId of requested) {
    const session = localSessions.get(sessionId)
    if (!session) throw new SyncError('session-not-found', `本机找不到会话: ${sessionId}`)
    if (scope.mode === 'selected' && !selected.has(sessionId)) {
      throw new SyncError('session-not-selected', `会话未勾选同步: ${sessionId}`)
    }
    const copy = representativeLocalCopy(session)
    if (!copy) throw new SyncError('session-not-found', `本机会话没有文件: ${sessionId}`)
    const oldKeys = Object.keys(currentFiles).filter((rel) => parseSessionRel(rel)?.sessionId === sessionId)
    const oldBaseKeys = Object.keys(baseFiles).filter((rel) => parseSessionRel(rel)?.sessionId === sessionId)
    const written = {}
    for (const file of copy.files) {
      assertSafeRel(file.rest)
      const rel = `sessions/${copy.projectDir}/${sessionId}/${file.rest}`
      const sha = await sha256File(file.abs)
      const uploaded = await engine.ensureBlob(provider, file.abs, sha, stats)
      if (uploaded) stats.uploaded += 1
      const stat = await fsp.stat(file.abs)
      written[rel] = { scope: 'sessions', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777, sha256: sha }
      stats.files += 1
      stats.bytes += stat.size
    }
    for (const rel of oldKeys) delete currentFiles[rel]
    for (const rel of oldBaseKeys) delete baseFiles[rel]
    for (const rel of [...oldKeys, ...oldBaseKeys]) if (!(rel in written)) removed.add(rel)
    Object.assign(currentFiles, written)
    Object.assign(baseFiles, written)
    stats.sessions += 1
  }
  const nextScopes = {
    ...(manifest.scopes ?? {}),
    sessions: { files: currentFiles, removed: [...removed].filter((rel) => !(rel in currentFiles)) },
  }
  await writeSelfManifest({ provider, settings, manifest: { ...manifest, scopes: nextScopes } })
  baseScopes.sessions = {
    files: baseFiles,
    removed: [...baseRemoved].filter((rel) => !(rel in baseFiles)),
  }
  await engine.store.saveBaseManifest(targetId, { scopes: baseScopes })
  let snapshot = null
  if (stats.uploaded > 0) {
    snapshot = await recordSnapshot(
      provider,
      { schema: MANIFEST_SCHEMA, deviceId: settings.deviceId, deviceName: settings.deviceName, updatedAt: new Date().toISOString(), scopes: nextScopes },
      { deviceName: settings.deviceName, historyLimit: settings.historyLimit },
    )
  }
  return { targetId, sessionIds: requested, ...stats, snapshot }
}

/** Case-insensitive path-prefix check on a separator boundary. */
function isUnderPath(child, parent) {
  const normalizedChild = String(child || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  const normalizedParent = String(parent || '').replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  if (!normalizedChild || !normalizedParent) return false
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + '\\')
}

/** Suffix of a workspace path below its user root, including the separator. */
function userRootSuffix(cwd) {
  const root = userRootOf(cwd)
  return root ? String(cwd).slice(root.length) : ''
}

/** Replace a foreign user folder in `cwd` with the current user's folder. */
function replaceForeignUserRoot(cwd, homeDir) {
  const value = String(cwd || '')
  const oldRoot = userRootOf(value)
  if (!oldRoot) return value
  const currentRoot = userRootOf(homeDir) || String(homeDir || '')
  if (!currentRoot || currentRoot.toLowerCase() === oldRoot.toLowerCase()) return value
  return joinLike(currentRoot, value.slice(oldRoot.length))
}

/**
 * Resolve the local workspace path for one restored session.
 *
 * Priority: explicit target path from the dialog, per-session path mapping for
 * the current device|user, legacy `sessionPathMappings`, then the path recorded
 * in the backup header.
 *
 * `singleTarget` means the dialog restored exactly one session, so the target
 * path is used verbatim. For several sessions the target path is a base
 * directory and the old user-folder suffix is preserved so sessions keep their
 * relative layout.
 *
 * With `autoReplaceUserFolder` on, a foreign user folder in the chosen path
 * (`C:\Users\old\...`) is replaced with the current user's folder, so a
 * previously remembered mapping also follows the current user.
 */
export function chooseRestoreCwd(sessionId, cwd, options = {}) {
  const {
    settings = {},
    deviceName = '',
    osUser = '',
    homeDir = homedir(),
    targetPath = '',
    autoReplaceUserFolder = false,
    singleTarget = false,
  } = options
  const target = String(targetPath || '').trim()
  let resolved = ''
  if (target) {
    if (singleTarget) {
      resolved = target
    } else if (isUnderPath(cwd, target)) {
      resolved = String(cwd || '')
    } else {
      const suffix = userRootSuffix(cwd)
      resolved = suffix ? joinLike(target, suffix) : joinLike(target, sessionId)
    }
  } else {
    const mapped = sessionPathsFor(settings, sessionId, sessionPathKeyOf(deviceName, osUser))
    const oldRoot = userRootOf(cwd)
    const legacy = oldRoot ? (settings.sessionPathMappings ?? {})[oldRoot] : ''
    if (mapped) resolved = mapped
    else if (legacy) resolved = joinLike(legacy, oldRoot ? String(cwd).slice(oldRoot.length) : '')
    else resolved = String(cwd || '')
  }
  if (autoReplaceUserFolder) resolved = replaceForeignUserRoot(resolved, homeDir)
  return resolved
}

/**
 * Restore sessions from the newest target manifest into the local store.
 *
 * Every existing copy of a selected session id is moved into
 * `<state>/backups/<timestamp>/sessions/` before the new copy is written, so a
 * duplicate session id can never remain on disk. Files are written atomically
 * and the session log header is rewritten to the chosen cwd.
 */
export async function restoreSessionsFromBackup({
  engine,
  provider,
  settings,
  targetId,
  sessionIds,
  targetPath = '',
  autoReplaceUserFolder = false,
  confirm,
  osUser = '',
  homeDir = homedir(),
}) {
  if (confirm !== true) throw new SyncError('need-confirm', '恢复会话前请确认（会覆盖本机同名会话）')
  const requested = normalizeSelectedSessionIds(sessionIds)
  if (requested.length === 0) throw new SyncError('bad-sessions', '请选择要恢复的会话')
  const basePath = String(targetPath || '').trim()
  if (basePath && !isAbsoluteAnyPlatform(basePath)) throw new SyncError('bad-target', '目标路径必须是绝对路径')
  const backup = await readBackupSessionGroups({ provider, selfDeviceId: settings.deviceId })
  const sessionsDir = join(engine.dshHome, 'sessions')
  await ensureDir(sessionsDir)
  const localSessions = await listLocalSessionData(sessionsDir)
  const deviceName = settings.deviceName
  const key = sessionPathKeyOf(deviceName, osUser)
  const backupRoot = join(engine.store.root, 'backups', timestampSlug(), 'sessions')
  const manifest = await readSelfManifest(provider, settings.deviceId)
  const currentFiles = { ...(manifest.scopes?.sessions?.files ?? {}) }
  const removed = new Set(manifest.scopes?.sessions?.removed ?? [])
  const baseManifest = await engine.store.loadBaseManifest(targetId)
  const baseScopes = { ...(baseManifest.scopes ?? {}) }
  const baseFiles = { ...(baseScopes.sessions?.files ?? {}) }
  const results = []

  for (const sessionId of requested) {
    const group = backup.sessions.get(sessionId)
    if (!group) throw new SyncError('session-not-found', `备份里找不到会话: ${sessionId}`)
    const files = []
    let downloadedCwd = ''
    for (const record of [...group.files.values()].sort((left, right) => left.fileName.localeCompare(right.fileName))) {
      const entry = record.entry
      const blob = await provider.get(blobKey(entry.sha256))
      if (!blob) throw new SyncError('missing-blob', `备份缺少内容块: ${entry.sha256}`)
      if (sha256Buffer(blob) !== entry.sha256) throw new SyncError('corrupt-blob', `内容块校验失败: ${entry.sha256}`)
      const isLog = SESSION_LOG_PATTERN.test(record.fileName)
      if (isLog && !downloadedCwd) {
        try {
          downloadedCwd = readSessionHeader(blob).header.cwd
        } catch {
          downloadedCwd = ''
        }
      }
      files.push({ rest: record.fileName, blob, entry, isLog })
    }
    const oldCwd = downloadedCwd || decodeWorkspaceDir(group.projectDir)
    const finalCwd = chooseRestoreCwd(sessionId, oldCwd, {
      settings,
      deviceName,
      osUser,
      homeDir,
      targetPath: basePath,
      autoReplaceUserFolder,
      singleTarget: requested.length === 1,
    })
    if (!finalCwd || !isAbsoluteAnyPlatform(finalCwd)) {
      throw new SyncError('bad-cwd', `无法确定会话 ${sessionId} 的目标路径`)
    }
    const projectDirName = projectKey(finalCwd)
    const targetDir = resolveInside(sessionsDir, join(projectDirName, sessionId))

    // Move every existing copy of this session id out of the session store
    // first: DSH cannot initialize a session whose id exists twice.
    const backedUp = []
    for (const copy of localSessions.get(sessionId)?.copies ?? []) {
      const destination = join(backupRoot, copy.projectDir, sessionId)
      await ensureDir(dirname(destination))
      await moveDir(copy.dirAbs, destination)
      backedUp.push(destination)
      await removeDirIfEmpty(join(sessionsDir, copy.projectDir))
    }

    const written = {}
    for (const file of files) {
      let payload = file.blob
      if (file.isLog) {
        try {
          payload = rewriteSessionCwd(payload, finalCwd)
        } catch {
          payload = file.blob
        }
      }
      const filePath = resolveInside(targetDir, file.rest.split('/').join(sep))
      await atomicWrite(filePath, payload, file.entry.mode ?? 0o600)
      if (file.entry.mtimeMs) {
        await fsp.utimes(filePath, new Date(), new Date(Number(file.entry.mtimeMs))).catch(() => {})
      }
      const stat = await fsp.stat(filePath)
      const sha256 = await sha256File(filePath)
      // A rewritten header produces new bytes: make sure the target has a blob
      // for them before the manifest starts referencing that sha256.
      if (sha256 !== file.entry.sha256) {
        const checked = await provider.head(blobKey(sha256))
        if (!checked) {
          const buffer = await fsp.readFile(filePath)
          if (sha256Buffer(buffer) !== sha256) {
            throw new SyncError('content-changed', `恢复期间文件发生变化: ${file.rest}`)
          }
          await provider.put(blobKey(sha256), buffer)
        }
      }
      const rel = `sessions/${projectDirName}/${sessionId}/${file.rest}`
      written[rel] = {
        scope: 'sessions',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777,
        sha256,
      }
    }

    for (const rel of Object.keys(currentFiles)) {
      if (parseSessionRel(rel)?.sessionId !== sessionId) continue
      delete currentFiles[rel]
      removed.add(rel)
    }
    for (const rel of Object.keys(baseFiles)) {
      if (parseSessionRel(rel)?.sessionId === sessionId) delete baseFiles[rel]
    }
    Object.assign(currentFiles, written)
    Object.assign(baseFiles, written)

    results.push({
      sessionId,
      cwd: finalCwd,
      previousCwd: oldCwd,
      projectDir: projectDirName,
      targetDir,
      files: files.length,
      backedUp,
      replacedCwd: finalCwd !== oldCwd,
    })

    // Remember where this session lives for the current device|user.
    if (key) {
      settings.sessionPaths ??= {}
      settings.sessionPaths[key] = {
        ...(settings.sessionPaths[key] ?? {}),
        [sessionId]: trimTrailingSeparators(finalCwd),
      }
    }
  }

  const nextScopes = {
    ...(manifest.scopes ?? {}),
    sessions: { files: currentFiles, removed: [...removed].filter((rel) => !(rel in currentFiles)) },
  }
  await writeSelfManifest({ provider, settings, manifest: { ...manifest, scopes: nextScopes } })
  baseScopes.sessions = {
    files: baseFiles,
    removed: [...(baseScopes.sessions?.removed ?? [])].filter((rel) => !(rel in baseFiles)),
  }
  await engine.store.saveBaseManifest(targetId, { scopes: baseScopes })
  if (key && Object.keys(settings.sessionPaths ?? {}).length > 0) {
    await engine.saveSettings({ sessionPaths: settings.sessionPaths })
  }
  return {
    targetId,
    restored: results.length,
    sessions: results,
    backupRoot: results.length > 0 ? backupRoot : '',
    restartRequired: results.length > 0,
    hint: results.length > 0
      ? '恢复完成：请完全退出并重启 DSH，或在「会话」页清理投影缓存后再打开这些会话。'
      : '没有恢复任何会话。',
  }
}

/** Overwrite one side with the other after an explicit confirmation. */
export async function overwriteSessions({
  engine,
  provider,
  settings,
  targetId,
  sessionIds,
  side,
  confirm,
  targetPath = '',
  autoReplaceUserFolder = false,
  osUser = '',
}) {
  if (confirm !== true) throw new SyncError('need-confirm', '覆盖前请二次确认')
  if (side === 'local') {
    return await restoreSessionsFromBackup({
      engine,
      provider,
      settings,
      targetId,
      sessionIds,
      targetPath,
      autoReplaceUserFolder,
      confirm: true,
      osUser,
    })
  }
  if (side === 'backup') {
    return await syncSessionsToBackup({ engine, provider, settings, targetId, sessionIds, confirm: true })
  }
  throw new SyncError('bad-side', `未知覆盖方向: ${side}`)
}
