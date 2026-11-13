/**
 * Small dependency-free helpers shared by the sync engine.
 *
 * Everything here is written against Node built-ins only: the plugin must stay
 * installable without a build step and without third-party supply chain.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** Hash a buffer with SHA-256 and return lowercase hex. */
export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Stream a file through SHA-256 (works for multi-hundred-MB session files). */
export function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Recursive mkdir that ignores "already exists". */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Write a file atomically: write to a sibling temp file, fsync, then rename.
 * A crash mid-write can never leave a truncated destination file.
 */
export async function atomicWrite(file, data, mode = 0o600) {
  await ensureDir(dirname(file))
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    const handle = await fsp.open(tmp, 'w', mode)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Read and parse JSON, returning `fallback` for missing/corrupt files. */
export async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return fallback
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

/** Serialize `value` and write it atomically. */
export async function writeJson(file, value, mode = 0o600) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Return true when `file` exists. */
export async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** stat() that returns undefined when missing. */
export async function statOrUndefined(file) {
  try {
    return await fsp.stat(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Convert OS separators to forward slashes for portable manifest keys. */
export function toPosix(path) {
  return path.split(sep).join('/')
}

/** Normalize a relative manifest key (posix slashes, no leading "./"). */
export function normalizeRel(rel) {
  return toPosix(rel).replace(/^\.\//, '')
}

/**
 * Convert a glob into a RegExp.
 *
 * Supported: `**` (any depth), `*` (one path segment), `?` (one character).
 * Patterns are matched against posix-style relative paths.
 */
export function globToRegExp(glob) {
  const source = toPosix(glob)
  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (char === '*') {
      if (source[i + 1] === '*') {
        i += 1
        if (source[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '/') {
      out += '/'
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** Test a list of glob patterns against a relative path. */
export function matchesAny(patterns, rel) {
  const normalized = normalizeRel(rel)
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalized)) return true
  }
  return false
}

/** Sleep helper. */
export function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Run `fn` up to `attempts` times with exponential backoff.
 * Intended for network targets; local-dir calls are effectively retry-free.
 */
export async function retry(fn, { attempts = 3, delayMs = 500 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt + 1 >= attempts) break
      await delay(delayMs * 3 ** attempt)
    }
  }
  throw lastError
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Stable timestamp usable in file names: 20261113-121500-123. */
export function timestampSlug(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    '-',
    pad(date.getUTCMilliseconds(), 3),
  ].join('')
}

/** ISO timestamp safe for object keys (no colons). */
export function isoKey(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Random id with a prefix, e.g. `t_ab12cd34`. */
export function shortId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** Ensure a value is a plain object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the DSH home directory (DSH_HOME wins, then ~/.dsh). */
export function resolveHomeFrom(env) {
  return resolve(env.DSH_HOME || join(env.USERPROFILE || env.HOME || '.', '.dsh'))
}
