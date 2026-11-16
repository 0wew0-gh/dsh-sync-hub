/**
 * Session-store helpers for the settings "sessions" tab.
 *
 * DSH keeps one project directory per session workspace under
 * `$DSH_HOME/sessions/<projectKey(cwd)>/<session id>/session.v<version>.jsonl.zstd`
 * and the first zstd frame of that log is a JSON header carrying the original
 * absolute `cwd`. Renaming a project directory by hand therefore breaks the
 * header/path invariant the session backend checks on open, so relocation must
 * rewrite the header frame and move the directory together.
 *
 * The module also owns the session-aware path helpers used by the sessions tab
 * and by backup restore: per-session root paths are keyed by
 * `<deviceName>|<osUserName>`, and the legacy prefix mapping table is still
 * honored as a fallback.
 */
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { SyncError } from './errors.js'

const FRAME_MAGIC = 0xfd2fb528
export const SESSION_LOG_PATTERN = /^session\.v\d+\.jsonl\.zstd$/
const NO_CWD_DIR = '_no-cwd'
const USER_ROOT_PATTERN = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)([\\/]|$)/i
/** Session ids are the directory names under `sessions/<projectDir>/`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** Validate and normalize one session id; returns '' for an unsafe id. */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  const id = value.trim()
  if (!SESSION_ID_PATTERN.test(id) || id === '.' || id === '..') return ''
  return id
}

/** Normalize a list of session ids: trimmed, validated, de-duplicated. */
export function normalizeSelectedSessionIds(value) {
  if (!Array.isArray(value)) return []
  const ids = []
  const seen = new Set()
  for (const item of value) {
    const id = normalizeSessionId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 5000) break
  }
  return ids
}

/**
 * Split a manifest key of the sessions scope into its parts.
 *
 * @returns {{projectDir: string, sessionId: string, rest: string, rel: string}|null}
 */
export function parseSessionRel(rel) {
  const text = String(rel ?? '')
  const parts = text.split('/')
  if (parts.length < 4 || parts[0] !== 'sessions') return null
  const projectDir = parts[1]
  const sessionId = normalizeSessionId(parts[2])
  if (!projectDir || !sessionId) return null
  return { projectDir, sessionId, rest: parts.slice(3).join('/'), rel: text }
}

/**
 * Keep only the selected session ids when the sessions scope runs in
 * `selected` mode. `all` mode returns the map unchanged (historical behaviour).
 */
export function applySessionSelection(entries, settings) {
  const scope = settings?.scopes?.sessions ?? {}
  if (scope.mode !== 'selected') return entries
  const selected = new Set(normalizeSelectedSessionIds(scope.selectedSessionIds))
  for (const rel of [...entries.keys()]) {
    const parsed = parseSessionRel(rel)
    if (!parsed || !selected.has(parsed.sessionId)) entries.delete(rel)
  }
  return entries
}

/**
 * Key for the per-session path mapping: `<deviceName>|<osUserName>`.
 * Returns '' when either part is missing so an unset host value can never
 * write a malformed mapping.
 */
export function sessionPathKeyOf(deviceName, osUser) {
  const device = String(deviceName ?? '').trim()
  const user = String(osUser ?? '').trim()
  if (!device || !user || device.includes('|') || user.includes('|')) return ''
  if (device.length > 128 || user.length > 128) return ''
  return `${device}|${user}`
}

/** Explicit root path of one session for one device|user, or ''. */
export function sessionPathsFor(settings, sessionId, key) {
  if (!key) return ''
  const perSession = settings?.sessionPaths?.[key]
  if (!perSession || typeof perSession !== 'object') return ''
  const value = perSession[sessionId]
  return typeof value === 'string' ? value.trim() : ''
}

/** Join a base directory and a suffix without resolving relative paths. */
export function joinPathLike(base, suffix) {
  const root = String(base || '').trim().replace(/[\\/]+$/, '')
  const tail = String(suffix || '')
  if (!root) return tail
  if (!tail) return root
  const separator = root.includes('\\') ? '\\' : '/'
  const normalized = tail.replace(/[\\/]+/g, separator)
  return normalized.startsWith(separator) ? root + normalized : root + separator + normalized
}

/**
 * Suggest the local path of one session.
 *
 * Resolution order (confirmed with the user on 2026-11-16):
 * 1. per-device `sessionPaths['<device>|<user>'][<sessionId>]`;
 * 2. the legacy `sessionPathMappings[<old user root>]` table;
 * 3. replacing the recorded user folder (`C:\Users\old`) with the current one.
 */
export function suggestSessionCwd(sessionId, cwd, options = {}) {
  const { settings = {}, deviceName = '', osUser = '', homeDir = homedir() } = options
  const value = String(cwd || '')
  const mapped = sessionPathsFor(settings, sessionId, sessionPathKeyOf(deviceName, osUser))
  if (mapped) return { cwd: mapped, source: 'session-path', replaced: mapped !== value }
  const oldRoot = userRootOf(value)
  if (!oldRoot) return { cwd: value, source: 'none', replaced: false }
  const legacy = settings?.sessionPathMappings?.[oldRoot]
  if (legacy) return { cwd: joinPathLike(legacy, value.slice(oldRoot.length)), source: 'legacy-mapping', replaced: true }
  const currentRoot = userRootOf(homeDir) || String(homeDir || '')
  if (currentRoot && currentRoot.toLowerCase() !== oldRoot.toLowerCase()) {
    return { cwd: joinPathLike(currentRoot, value.slice(oldRoot.length)), source: 'current-user', replaced: true }
  }
  return { cwd: value, source: 'none', replaced: false }
}

/**
 * Encode a workspace path the same way DSH's session backend does. The mapping
 * is intentionally lossy: separator runs become one `-`, non-safe code units
 * become `~XXXX` escapes, the readable part is capped at 251 characters.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new SyncError('bad-cwd', '会话目录不能为空')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Length of one zstd frame starting at `offset`, or 0 when the bytes are not a
 * standard frame. Only the outer block walk is needed: we slice the first frame
 * and let zlib decompress it independently.
 */
function frameLength(buffer, offset = 0) {
  if (buffer.length - offset < 8) return 0
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) return 0
  let pointer = offset + 4
  const descriptor = buffer[pointer]
  pointer += 1
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (!singleSegment) pointer += 1
  pointer += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
  pointer += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (pointer > buffer.length) return 0
  for (;;) {
    if (pointer + 3 > buffer.length) return 0
    const header = buffer.readUIntLE(pointer, 3)
    pointer += 3
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 0 || blockType === 2) {
      pointer += blockSize
    } else if (blockType === 1) {
      pointer += 1
    } else {
      return 0
    }
    if (pointer > buffer.length) return 0
    if (lastBlock) break
  }
  if (checksum) pointer += 4
  return pointer - offset
}

/**
 * Read the JSON header of a session log file.
 *
 * The first zstd frame is small in practice, so reading a bounded prefix is
 * enough for the header; the whole file is only read when the first frame is
 * larger than that prefix (defensive fallback).
 */
export async function readSessionHeaderFile(file, prefixBytes = 256 * 1024) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch (error) {
    throw new SyncError('bad-session', '无法打开会话文件: ' + String(error && error.message ? error.message : error))
  }
  try {
    const buffer = Buffer.alloc(prefixBytes)
    const { bytesRead } = await handle.read(buffer, 0, prefixBytes, 0)
    const prefix = buffer.subarray(0, bytesRead)
    const length = frameLength(prefix, 0)
    if (length > 0 && length <= bytesRead) return readSessionHeader(prefix.subarray(0, length))
  } finally {
    await handle.close()
  }
  return readSessionHeader(await fsp.readFile(file))
}

/** Read the JSON header out of a session log without decoding later frames. */
export function readSessionHeader(buffer) {
  const length = frameLength(buffer, 0)
  if (!length) throw new SyncError('bad-session', '无法解析会话文件头（不是有效的 zstd 帧）')
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(0, length)).toString('utf8')
  } catch (error) {
    throw new SyncError('bad-session', '会话文件头解压失败: ' + String(error && error.message ? error.message : error))
  }
  const line = text.split('\n').find((entry) => entry.trim())
  if (!line) throw new SyncError('bad-session', '会话文件头为空')
  let header
  try {
    header = JSON.parse(line)
  } catch {
    throw new SyncError('bad-session', '会话文件头不是合法 JSON')
  }
  if (!header || header.type !== 'session' || typeof header.cwd !== 'string') {
    throw new SyncError('bad-session', '会话文件头缺少 cwd 字段')
  }
  return { header, frameBytes: length }
}

/** Rewrite only the first frame with a new cwd, keeping every later byte intact. */
export function rewriteSessionCwd(buffer, newCwd) {
  const { header, frameBytes } = readSessionHeader(buffer)
  const nextHeader = { ...header, cwd: newCwd }
  const nextFrame = zstdCompressSync(Buffer.from(JSON.stringify(nextHeader) + '\n'))
  return Buffer.concat([nextFrame, buffer.subarray(frameBytes)])
}

async function pathExists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

async function sessionLogFiles(dir) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && SESSION_LOG_PATTERN.test(entry.name))
    .map((entry) => entry.name)
}

/**
 * List session project directories with their decoded cwd.
 *
 * `exists` reports whether the recorded cwd still exists on this machine; the
 * settings tab renders a red dot when it does not (restored sessions point at
 * another computer's paths until relocated).
 */
export async function listSessionGroups(sessionsDir) {
  let projects
  try {
    projects = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { sessionsDir, groups: [] }
    throw error
  }
  const groups = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dirName = project.name
    const projectPath = join(sessionsDir, dirName)
    let sessions = []
    try {
      sessions = await fsp.readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    const rows = []
    let cwd = ''
    let readError = ''
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectPath, session.name)
      const logs = await sessionLogFiles(sessionDir)
      if (logs.length === 0) continue
      const logName = logs[0]
      const file = join(sessionDir, logName)
      let header = null
      try {
        header = await readSessionHeaderFile(file)
      } catch (error) {
        readError = String(error && error.message ? error.message : error)
      }
      if (header && !cwd) cwd = header.header.cwd
      let size = 0
      let mtimeMs = 0
      try {
        const stat = await fsp.stat(file)
        size = stat.size
        mtimeMs = stat.mtimeMs
      } catch {
        // The session directory may change while it is being listed.
      }
      rows.push({
        id: session.name,
        file: logName,
        createdAt: header && Number.isFinite(header.header.createdAt) ? header.header.createdAt : null,
        cwd: header ? header.header.cwd : '',
        size,
        mtimeMs,
      })
    }
    if (rows.length === 0) continue
    const effectiveCwd = cwd || ''
    const exists = effectiveCwd ? await pathExists(effectiveCwd) : false
    groups.push({
      dirName,
      cwd: effectiveCwd,
      exists,
      noCwd: dirName === NO_CWD_DIR || effectiveCwd === '',
      readError,
      sessions: rows,
    })
  }
  groups.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)))
  return { sessionsDir, userHome: homedir(), groups, duplicates: duplicateSessions(groups) }
}

/** Case-insensitive Windows path-prefix check on a separator boundary. */
function isUnderPrefix(path, prefix) {
  const normalizedPath = String(path).replace(/\//g, '\\').toLowerCase()
  const normalizedPrefix = String(prefix).replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(normalizedPrefix + '\\')
}

/** Extract `D:\Users\<name>` from a workspace path, when it is a user folder. */
export function userRootOf(cwd) {
  const match = USER_ROOT_PATTERN.exec(String(cwd || ''))
  return match ? match[1] : ''
}

/**
 * Batch-relocate every session directory whose cwd sits under one user root.
 *
 * Used by the settings tab's "统一改到本机用户目录" action: an old machine's
 * `C:\Users\alice\...` becomes this machine's `C:\Users\bob\...`, preserving
 * the relative suffix. Missing destination directories are created.
 */
export async function relocateUserGroups({ sessionsDir, fromPrefix, toPrefix, confirm }) {
  if (confirm !== true) throw new SyncError('need-confirm', '请先确认统一的会话路径')
  const from = String(fromPrefix || '').trim().replace(/[\\/]+$/, '')
  const to = String(toPrefix || '').trim().replace(/[\\/]+$/, '')
  if (!from || !isAbsolute(from)) throw new SyncError('bad-cwd', '旧用户目录必须是绝对路径')
  if (!to || !isAbsolute(to)) throw new SyncError('bad-cwd', '新用户目录必须是绝对路径')
  const fromKey = from.replace(/\//g, '\\').toLowerCase()
  const toKey = to.replace(/\//g, '\\').toLowerCase()
  if (fromKey === toKey) throw new SyncError('bad-cwd', '新旧用户目录相同')
  const { groups } = await listSessionGroups(sessionsDir)
  const selected = groups.filter((group) => group.cwd && isUnderPrefix(group.cwd, from))
  let moved = 0
  const failed = []
  for (const group of selected) {
    const suffix = group.cwd.slice(from.length).replace(/^[\\/]+/, '')
    const targetCwd = suffix ? join(to, suffix) : to
    try {
      await fsp.mkdir(targetCwd, { recursive: true })
      const result = await relocateSessionGroup({ sessionsDir, dirName: group.dirName, newCwd: targetCwd, confirm: true })
      moved += result.moved
    } catch (error) {
      failed.push({ dirName: group.dirName, cwd: group.cwd, error: String(error && error.message ? error.message : error) })
    }
  }
  return {
    moved,
    selected: selected.length,
    failed,
    fromPrefix: from,
    toPrefix: to,
  }
}

/**
 * Move one project directory to a new local cwd.
 *
 * Session logs are updated in place and then the project directory is renamed
 * with `fs.rename` (never copied), so the same session id can never exist in two
 * project directories at once. `confirm` must be true: the settings UI presents
 * the suggested path per group and the user confirms it explicitly.
 */
export async function relocateSessionGroup({ sessionsDir, dirName, newCwd, confirm }) {
  if (confirm !== true) throw new SyncError('need-confirm', '请先确认新的会话路径')
  const oldName = String(dirName || '').trim()
  const targetCwd = String(newCwd || '').trim()
  if (!oldName) throw new SyncError('bad-session', '缺少会话目录名')
  if (!targetCwd || !isAbsolute(targetCwd)) throw new SyncError('bad-cwd', '新的会话目录必须是绝对路径')
  const stat = await fsp.stat(targetCwd).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new SyncError('bad-cwd', `新的会话目录不存在或不是目录: ${targetCwd}`)
  const oldDir = join(sessionsDir, oldName)
  const oldStat = await fsp.stat(oldDir).catch(() => null)
  if (!oldStat || !oldStat.isDirectory()) throw new SyncError('session-not-found', `找不到会话目录: ${oldName}`)
  const newName = projectKey(targetCwd)
  const newDir = join(sessionsDir, newName)

  const sessionDirs = (await fsp.readdir(oldDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (sessionDirs.length === 0) throw new SyncError('session-not-found', `会话目录为空: ${oldName}`)

  const plans = []
  for (const sessionId of sessionDirs) {
    const sessionPath = join(oldDir, sessionId)
    const logs = await sessionLogFiles(sessionPath)
    if (logs.length === 0) continue
    const logName = logs[0]
    const buffer = await fsp.readFile(join(sessionPath, logName))
    plans.push({ sessionId, logName, buffer, sessionPath })
  }
  if (plans.length === 0) throw new SyncError('session-not-found', `没有可迁移的会话文件: ${oldName}`)

  const sameDir = newDir === oldDir
  if (!sameDir) {
    const targetExists = await pathExists(newDir)
    if (targetExists) {
      for (const plan of plans) {
        if (await pathExists(join(newDir, plan.sessionId))) {
          throw new SyncError('session-conflict', `目标目录已存在同一会话: ${plan.sessionId}（请先清理重复会话）`)
        }
      }
    }
  }

  // Rewrite headers first; keep the original bytes for rollback.
  const rewritten = plans.map((plan) => ({ plan, next: rewriteSessionCwd(plan.buffer, targetCwd) }))
  try {
    for (const item of rewritten) {
      await fsp.writeFile(join(item.plan.sessionPath, item.plan.logName), item.next)
    }
  } catch (error) {
    for (const item of rewritten) {
      await fsp.writeFile(join(item.plan.sessionPath, item.plan.logName), item.plan.buffer).catch(() => {})
    }
    throw new SyncError('relocate-failed', '改写会话文件头失败: ' + String(error && error.message ? error.message : error))
  }

  let moved = plans.length
  try {
    if (!sameDir) {
      if (await pathExists(newDir)) {
        for (const plan of plans) {
          await fsp.rename(join(oldDir, plan.sessionId), join(newDir, plan.sessionId))
        }
        await fsp.rm(oldDir, { recursive: true, force: true })
      } else {
        await fsp.rename(oldDir, newDir)
      }
    }
  } catch (error) {
    // Best effort: put the cwd back so DSH does not see a header/path mismatch.
    const dirs = [oldDir, newDir]
    for (const plan of plans) {
      for (const base of dirs) {
        const logFile = join(base, plan.sessionId, plan.logName)
        if (await pathExists(logFile)) {
          await fsp.writeFile(logFile, plan.buffer).catch(() => {})
        }
      }
    }
    throw new SyncError('relocate-failed', '移动会话目录失败: ' + String(error && error.message ? error.message : error))
  }
  return { dirName: newName, cwd: targetCwd, moved }
}

/**
 * Find session ids that exist in more than one project directory. Restored
 * copies (or an interrupted older relocate) can produce this state, and DSH
 * cannot initialize a session whose id appears twice.
 */
function duplicateSessions(groups) {
  const seen = new Map()
  for (const group of groups) {
    for (const session of group.sessions) {
      const list = seen.get(session.id) ?? []
      list.push({ dirName: group.dirName, cwd: group.cwd, exists: group.exists })
      seen.set(session.id, list)
    }
  }
  return Array.from(seen.entries())
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({ id, copies: list }))
}

/**
 * Quarantine duplicate copies: keep the copy whose cwd exists on this machine
 * (otherwise the first one), move the others under a timestamped backup folder
 * inside the sessions root, and remove now-empty project directories.
 */
export async function dedupeSessions({ sessionsDir }) {
  const { groups } = await listSessionGroups(sessionsDir)
  const duplicates = duplicateSessions(groups)
  const backupRoot = join(sessionsDir, '.dedupe-backup-' + new Date().toISOString().replace(/[:.]/g, '-'))
  let moved = 0
  for (const duplicate of duplicates) {
    const copies = duplicate.copies
    let keeper = copies.find((copy) => copy.exists) ?? copies[0]
    for (const copy of copies) {
      if (copy === keeper) continue
      const source = join(sessionsDir, copy.dirName, duplicate.id)
      if (!(await pathExists(source))) continue
      const destination = join(backupRoot, copy.dirName, duplicate.id)
      await fsp.mkdir(join(backupRoot, copy.dirName), { recursive: true })
      await fsp.rename(source, destination)
      moved += 1
      const dir = join(sessionsDir, copy.dirName)
      const rest = await fsp.readdir(dir).catch(() => [])
      if (rest.length === 0) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  return { moved, duplicates: duplicates.length, backupRoot: moved > 0 ? backupRoot : '' }
}
