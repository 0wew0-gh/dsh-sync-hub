/**
 * Path resolution and safety checks.
 *
 * All manifest keys are posix-style relative paths rooted at the DSH home or
 * the agents home; absolute paths never enter manifests so a backup stays
 * portable across machines and drive letters.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Resolve the DSH home directory. */
export function resolveDshHome(options = {}) {
  if (options.dshHome) return resolve(options.dshHome)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** Resolve the agents home directory (where global skills live). */
export function resolveAgentsHome(options = {}) {
  if (options.agentsHome) return resolve(options.agentsHome)
  if (process.env.DSH_AGENTS_HOME) return resolve(process.env.DSH_AGENTS_HOME)
  if (process.env.AGENTS_HOME) return resolve(process.env.AGENTS_HOME)
  return join(homedir(), '.agents')
}

/** Convert a native path to posix separators. */
export function toPosixPath(path) {
  return path.split(sep).join('/')
}

/** Resolve `child` against `root` and require it to stay inside `root`. */
export function resolveInside(root, child) {
  const resolvedRoot = resolve(root)
  const resolved = resolve(root, child)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes its root: ${child}`)
  }
  return resolved
}

/**
 * Validate a manifest-relative path.
 *
 * Rejects absolute paths, drive letters, backslashes, empty segments and any
 * `.`/`..` segment. This runs on remote-provided keys before any write, so a
 * compromised backup can never write outside the selected scope roots.
 */
export function assertSafeRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('empty relative path')
  if (rel.includes('\\')) throw new Error(`backslash in relative path: ${rel}`)
  if (rel.startsWith('/')) throw new Error(`absolute relative path: ${rel}`)
  if (/^[A-Za-z]:/.test(rel)) throw new Error(`drive letter in relative path: ${rel}`)
  if (rel.includes('\0')) throw new Error('NUL byte in relative path')
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`unsafe path segment in: ${rel}`)
    }
  }
  return rel
}

/** Normalize a user-supplied target directory (supports UNC paths). */
export function normalizeTargetPath(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('target path is required')
  }
  const trimmed = input.trim()
  if (!isAbsolute(trimmed) && !/^\\\\/.test(trimmed)) {
    throw new Error('target path must be absolute (e.g. D:\\backup or \\\\nas\\share)')
  }
  return resolve(trimmed)
}

/**
 * True when `input` is an absolute path on either platform family.
 *
 * Paths saved for other computers/users are validated here without resolving
 * them: `path.resolve()` on Windows would rewrite a POSIX path like `/home/me`
 * into a drive-relative path and corrupt the saved value.
 */
export function isAbsoluteAnyPlatform(input) {
  if (typeof input !== 'string' || input.trim().length === 0) return false
  const value = input.trim()
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\[^\\]/.test(value)) return true
  return value.startsWith('/')
}

/** Trim trailing separators, but keep a bare POSIX root (`/`) intact. */
export function trimTrailingSeparators(input) {
  const value = String(input ?? '').trim()
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return value.replace(/[\\/]+$/, '') || value
  return value.replace(/[\\/]+$/, '')
}

/** Decode a session workspace directory name back to an absolute path. */
export function decodeWorkspaceDir(name) {
  return name
    .replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/^--/, '')
    .replace(/--$/, '')
    .replace(/-/g, '\\')
}
