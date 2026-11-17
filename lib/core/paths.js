/**
 * Path resolution and safety checks.
 *
 * All manifest keys are posix-style relative paths rooted at the DSH home or
 * the agents home; absolute paths never enter manifests so a backup stays
 * portable across machines and drive letters.
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pluginManifest = require('../../package.json')

/**
 * Minimal asar reader for a single entry.
 *
 * The desktop host runs on a plain Node runtime, so `readFileSync` cannot see
 * files inside `app.asar`. Reading the archive header directly keeps the DSH
 * version available without Electron's patched fs.
 *
 * @param {string} filePath - absolute path that contains an `.asar` segment
 * @returns {Buffer|null} entry bytes, or null when the archive/entry is missing
 */
export function readAsarEntry(filePath) {
  const marker = filePath.toLowerCase().indexOf('.asar')
  if (marker < 0) return null
  const archive = filePath.slice(0, marker + 5)
  const inner = filePath.slice(marker + 5).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean)
  if (inner.length === 0) return null
  let fd
  try {
    fd = openSync(archive, 'r')
    const sizeBuffer = Buffer.alloc(8)
    readSync(fd, sizeBuffer, 0, 8, 0)
    const headerSize = sizeBuffer.readUInt32LE(4)
    if (!headerSize || headerSize > 64 * 1024 * 1024) return null
    const headerBuffer = Buffer.alloc(headerSize)
    readSync(fd, headerBuffer, 0, headerSize, 8)
    // Chromium stores the JSON inside a Pickle: a small binary prefix precedes
    // the JSON object, and NUL padding follows it.
    const headerText = headerBuffer.toString('utf8')
    const jsonStart = headerText.indexOf('{')
    if (jsonStart < 0) return null
    const header = JSON.parse(headerText.slice(jsonStart).replace(/\0+$/, '').trim())
    let node = header
    for (const segment of inner) {
      if (!node || !node.files || !node.files[segment]) return null
      node = node.files[segment]
    }
    const size = node ? Number(node.size) : NaN
    const offset = node ? Number(node.offset) : NaN
    if (!node || !Number.isFinite(size) || !Number.isFinite(offset) || node.unpacked) return null
    const data = Buffer.alloc(size)
    readSync(fd, data, 0, size, 8 + headerSize + offset)
    return data
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Closing a read-only descriptor is best effort.
      }
    }
  }
}

/** Read a JSON file that may live inside an Electron `app.asar` archive. */
function readJsonMaybeAsar(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    const buffer = readAsarEntry(filePath)
    if (!buffer) return null
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      return null
    }
  }
}

/** Resolve the DSH home directory. */
export function resolveDshHome(options = {}) {
  if (options.dshHome) return resolve(options.dshHome)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/**
 * Version of the running DSH runtime, used in the default target prefix and the
 * backup meta document. Reads `DSH_INSTALL_DIR/package.json` (set by the host
 * runtime); falls back to `DSH_VERSION`, then `unknown`.
 */
export function resolveDshVersion(env = process.env) {
  if (env.DSH_VERSION) return String(env.DSH_VERSION)
  const candidates = []
  if (env.DSH_INSTALL_DIR) candidates.push(join(env.DSH_INSTALL_DIR, 'package.json'))
  // The host may run without DSH_INSTALL_DIR, but its argv still points into
  // app.asar; the archive root package and the bundled dsh package both carry
  // the release version.
  for (const value of [process.argv && process.argv[1], process.execPath, ...(process.argv || [])]) {
    if (typeof value !== 'string') continue
    const marker = value.toLowerCase().indexOf('.asar')
    if (marker < 0) continue
    const archive = value.slice(0, marker + 5)
    candidates.push(join(archive, 'package.json'))
    candidates.push(join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  // Desktop hosts may run as a plain Node child of the Electron binary; probe
  // the app.asar next to that executable and the default per-user install.
  const execDir = process.execPath ? dirname(process.execPath) : ''
  if (execDir) {
    candidates.push(join(execDir, 'resources', 'app.asar', 'package.json'))
    candidates.push(join(execDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  const localAppData = env.LOCALAPPDATA
    || (env.APPDATA ? join(env.APPDATA, '..', 'Local') : '')
    || ''
  if (localAppData) {
    candidates.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'package.json'))
    candidates.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  for (const file of candidates) {
    const manifest = readJsonMaybeAsar(file)
    if (manifest && typeof manifest.version === 'string' && manifest.version) return manifest.version
  }
  // Web/CLI hosts usually have the dsh package resolvable from the profile.
  try {
    const manifest = require('@deepseek-ai/dsh/package.json')
    if (manifest && typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch {
    // Fall through to unknown.
  }
  return 'unknown'
}

/** Version of this plugin package (read at module load). */
export function resolvePluginVersion() {
  const version = pluginManifest && typeof pluginManifest.version === 'string' ? pluginManifest.version : 'unknown'
  return version || 'unknown'
}

/** Default repository prefix, versioned by this plugin release. */
export function defaultTargetPrefix() {
  const version = resolvePluginVersion().replace(/[^0-9A-Za-z._-]+/g, '-')
  return `dsh-sync-v${version}`
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
  const normalizedRoot = resolvedRoot.replace(/[\\/]+$/, '') || resolvedRoot
  const resolved = resolve(root, child)
  if (normalizedRoot === sep) {
    if (resolved.startsWith(sep)) return resolved
    throw new Error(`path escapes its root: ${child}`)
  }
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
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

/** Normalize an object-storage prefix (`a/b`, no leading/trailing slash). */
export function normalizeObjectPrefix(prefix) {
  return String(prefix ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
}
