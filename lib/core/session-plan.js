/**
 * Session-aware planning for the `sessions` scope.
 *
 * DSH identifies a session by its session id, not by the encoded project
 * directory name. After a restore or an interrupted relocation the same id can
 * appear under more than one project directory, and the generic three-way
 * planner (which compares manifest paths byte for byte) would treat those
 * copies as unrelated files and duplicate them in the backup.
 *
 * `collapseSessionViews()` rewrites every local / remote / base entry so that
 * all copies of one session id share a single canonical project directory
 * before planning. The canonical directory prefers the local copy (so files
 * are written back where the user already has them), then the newest remote
 * copy. The caller then runs the ordinary `planScope()` on the collapsed views;
 * uploads resolve their absolute path from the canonical entries map and
 * downloads land in the canonical session directory.
 */
import { planScope } from './manifest.js'
import { SESSION_LOG_PATTERN, parseSessionRel } from './sessions.js'

/** Manifest prefix used by the sessions scope. */
const SESSION_PREFIX = 'sessions/'

/** Build a canonical manifest key for one file inside a session directory. */
export function canonicalSessionRel(projectDir, sessionId, rest) {
  return `${SESSION_PREFIX}${projectDir}/${sessionId}/${rest}`
}

/** Last path segment of a posix relative path. */
function baseName(rel) {
  const index = rel.lastIndexOf('/')
  return index >= 0 ? rel.slice(index + 1) : rel
}

/** Group manifest records by session id. */
export function groupSessionEntries(files) {
  const groups = new Map()
  for (const [rel, entry] of Object.entries(files ?? {})) {
    const parsed = parseSessionRel(rel)
    if (!parsed) continue
    const fileName = baseName(parsed.rel)
    let group = groups.get(parsed.sessionId)
    if (!group) {
      group = { sessionId: parsed.sessionId, records: [], projectDirs: new Set() }
      groups.set(parsed.sessionId, group)
    }
    group.records.push({ rel, entry, projectDir: parsed.projectDir, rest: parsed.rest, fileName })
    group.projectDirs.add(parsed.projectDir)
  }
  return groups
}

/**
 * Rank one project directory of a session.
 *
 * The session log file is the biggest file in practice and the only one that
 * carries the header, so "largest log, then newest mtime" is a cheap and
 * stable way to pick the copy a user is actually using.
 */
function rankProjectDir(group, projectDir) {
  let size = -1
  let mtime = -1
  for (const record of group.records) {
    if (record.projectDir !== projectDir) continue
    if (!SESSION_LOG_PATTERN.test(record.fileName)) continue
    const recordSize = Number(record.entry?.size) || 0
    const recordMtime = Number(record.entry?.mtimeMs) || 0
    if (recordSize > size || (recordSize === size && recordMtime > mtime)) {
      size = recordSize
      mtime = recordMtime
    }
  }
  return { projectDir, size, mtime }
}

/** Pick the project directory that represents a local or remote copy set. */
function chooseProjectDir(group) {
  let best = null
  for (const projectDir of group.projectDirs) {
    const rank = rankProjectDir(group, projectDir)
    if (!best || rank.size > best.size || (rank.size === best.size && rank.mtime > best.mtime)) {
      best = rank
    }
  }
  return best ? best.projectDir : ''
}

/**
 * Collapse local / remote / base manifests so one session id uses one project
 * directory everywhere.
 *
 * @returns {{
 *   entries: Map<string, object>,
 *   localFiles: object,
 *   remoteFiles: object,
 *   baseFiles: object,
 *   sessions: Map<string, {sessionId: string, canonicalProjectDir: string}>,
 *   duplicates: Array<{sessionId: string, localProjectDirs: string[], remoteProjectDirs: string[], canonicalProjectDir: string}>
 * }}
 */
export function collapseSessionViews({ entries, localFiles = {}, remoteFiles = {}, baseFiles = {} }) {
  const localGroups = groupSessionEntries(localFiles)
  const remoteGroups = groupSessionEntries(remoteFiles)
  const baseGroups = groupSessionEntries(baseFiles)
  const sessionIds = new Set([
    ...localGroups.keys(),
    ...remoteGroups.keys(),
    ...baseGroups.keys(),
  ])

  const canonicalEntries = new Map()
  const canonicalLocal = {}
  const canonicalRemote = {}
  const canonicalBase = {}
  const sessions = new Map()
  const duplicates = []

  for (const sessionId of sessionIds) {
    const localGroup = localGroups.get(sessionId)
    const remoteGroup = remoteGroups.get(sessionId)
    const baseGroup = baseGroups.get(sessionId)
    const canonicalProjectDir = localGroup
      ? chooseProjectDir(localGroup)
      : chooseProjectDir(remoteGroup)
    if (!canonicalProjectDir) continue
    sessions.set(sessionId, { sessionId, canonicalProjectDir })

    // Local: prefer the canonical copy, but keep a file that only exists in
    // another local copy so it cannot be lost silently.
    if (localGroup) {
      for (const record of localGroup.records) {
        const key = canonicalSessionRel(canonicalProjectDir, sessionId, record.rest)
        if (record.projectDir !== canonicalProjectDir && key in canonicalLocal) continue
        canonicalLocal[key] = record.entry
        const entry = entries.get(record.rel)
        if (entry && (!canonicalEntries.has(key) || record.projectDir === canonicalProjectDir)) {
          canonicalEntries.set(key, entry)
        }
      }
    }

    // Remote: map every copy, newest entry wins per relative file.
    if (remoteGroup) {
      for (const record of remoteGroup.records) {
        const key = canonicalSessionRel(canonicalProjectDir, sessionId, record.rest)
        const existing = canonicalRemote[key]
        if (!existing || (Number(record.entry?.mtimeMs) || 0) > (Number(existing?.mtimeMs) || 0)) {
          canonicalRemote[key] = record.entry
        }
      }
    }

    // Base: map every copy, first one wins per relative file.
    if (baseGroup) {
      for (const record of baseGroup.records) {
        const key = canonicalSessionRel(canonicalProjectDir, sessionId, record.rest)
        if (!(key in canonicalBase)) canonicalBase[key] = record.entry
      }
    }

    const localProjectDirs = localGroup ? [...localGroup.projectDirs] : []
    const remoteProjectDirs = remoteGroup ? [...remoteGroup.projectDirs] : []
    if (
      localProjectDirs.length > 1
      || remoteProjectDirs.length > 1
      || (localProjectDirs.length === 1 && remoteProjectDirs.length === 1
        && localProjectDirs[0] !== remoteProjectDirs[0])
    ) {
      duplicates.push({ sessionId, localProjectDirs, remoteProjectDirs, canonicalProjectDir })
    }
  }

  return {
    entries: canonicalEntries,
    localFiles: canonicalLocal,
    remoteFiles: canonicalRemote,
    baseFiles: canonicalBase,
    sessions,
    duplicates,
  }
}

/**
 * Plan one sessions scope after collapsing duplicate copies.
 *
 * Returns the ordinary planner result plus the collapse metadata so the caller
 * can report which sessions were reconciled.
 */
export function planSessionScope(options) {
  const collapsed = collapseSessionViews({
    entries: options.entries,
    localFiles: options.localFiles,
    remoteFiles: options.remoteFiles,
    baseFiles: options.baseFiles,
  })
  const plan = planScope({
    ...options,
    localFiles: collapsed.localFiles,
    remoteFiles: collapsed.remoteFiles,
    baseFiles: collapsed.baseFiles,
  })
  return { ...plan, collapsed }
}
