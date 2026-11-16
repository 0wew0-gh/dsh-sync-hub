/**
 * Filesystem scanning for one scope.
 *
 * Produces manifest entries without writing anything. Directory pruning keeps
 * the big ignored trees (node_modules, pnpm store, runtimes, caches) cheap to
 * skip even when a user points the plugin at a large home directory.
 */

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import {
  HARD_EXCLUDES,
  SKIP_DIR_NAMES,
  customItemPath,
  findCustomItem,
  isCustomScope,
  scopeSources,
} from './scopes.js'
import { applySessionSelection } from './sessions.js'
import { matchesAny, normalizeRel } from './util.js'

function isExcluded(patterns, rel, isDir) {
  if (matchesAny(patterns, rel)) return true
  // Directory-only patterns such as `**/node_modules/**` are tested with a
  // synthetic child so the `/**` suffix can match.
  if (isDir && matchesAny(patterns, `${rel}/x`)) return true
  return false
}

/**
 * Walk `rootAbs` and collect file entries under `relPrefix`.
 *
 * Symlinks are skipped on purpose: following them could pull files from
 * outside the selected scope root into a backup.
 */
async function walkDirectory(rootAbs, relPrefix, excludes, out) {
  async function visit(dirAbs, relDir) {
    let items
    try {
      items = await fsp.readdir(dirAbs, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const item of items) {
      const rel = normalizeRel(relDir ? `${relDir}/${item.name}` : item.name)
      const abs = join(dirAbs, item.name)
      if (item.isDirectory()) {
        if (SKIP_DIR_NAMES.has(item.name)) continue
        if (isExcluded(excludes, rel, true)) continue
        await visit(abs, rel)
      } else if (item.isFile()) {
        if (isExcluded(excludes, rel, false)) continue
        const stat = await fsp.stat(abs)
        if (!stat.isFile()) continue
        out.set(rel, {
          rel,
          scope: relPrefix.split('/')[0],
          abs,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode & 0o777,
          isDir: false,
        })
      }
    }
  }
  await visit(rootAbs, relPrefix)
}

/**
 * Scan one scope.
 *
 * @param {string} scopeId
 * @param {{ dshHome: string, agentsHome: string, settings?: object, extraExcludes?: string[] }} context
 * @returns {Promise<Map<string, object>>} map of relative path -> entry
 */
export async function scanScope(scopeId, context) {
  if (isCustomScope(scopeId)) return await scanCustomScope(scopeId, context)
  const excludes = [...HARD_EXCLUDES, ...(context.extraExcludes ?? [])]
  const sources = await scopeSources(scopeId, context)
  const entries = new Map()
  for (const source of sources) {
    if (source.kind === 'file') {
      const rel = normalizeRel(source.rel)
      if (isExcluded(excludes, rel, false)) continue
      let stat
      try {
        stat = await fsp.stat(source.abs)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (!stat.isFile()) continue
      entries.set(rel, {
        rel,
        scope: scopeId,
        abs: source.abs,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777,
        isDir: false,
      })
    } else {
      await walkDirectory(source.abs, normalizeRel(source.relPrefix), excludes, entries)
    }
  }
  // Session selection is applied after the walk: the walk is cheap because it
  // only stats files, and filtering here keeps every other scope untouched.
  if (scopeId === 'sessions') applySessionSelection(entries, context.settings)
  return entries
}

/**
 * Scan one user-defined directory or file item.
 *
 * The manifest path is namespaced as `custom/<itemId>/...` so two custom items
 * never collide, and an item rename never moves its backup data.
 */
async function scanCustomScope(scopeId, context) {
  const item = findCustomItem(scopeId, context.settings?.customItems)
  if (!item) return new Map()
  const base = customItemPath(item, context.settings?.deviceName)
  if (!base) return new Map()
  const excludes = [...HARD_EXCLUDES, ...(context.extraExcludes ?? [])]
  const entries = new Map()
  const relPrefix = `custom/${item.id}`
  if (item.type === 'file') {
    // Fixed relative name: the item path may differ per device, but the backup
    // key must stay stable so every device reads the same object.
    const rel = normalizeRel(`${relPrefix}/file`)
    if (isExcluded(excludes, rel, false)) return entries
    let stat
    try {
      stat = await fsp.stat(base)
    } catch (error) {
      if (error.code === 'ENOENT') return entries
      throw error
    }
    if (!stat.isFile()) return entries
    entries.set(rel, {
      rel,
      scope: scopeId,
      abs: base,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
      isDir: false,
    })
    return entries
  }
  await walkDirectory(base, relPrefix, excludes, entries)
  return entries
}

/** Scan multiple scopes; returns a map scopeId -> entries. */
export async function scanScopes(scopeIds, context) {
  const result = new Map()
  for (const scopeId of scopeIds) {
    result.set(scopeId, await scanScope(scopeId, context))
  }
  return result
}

/** Cheap size/count estimate without hashing. */
export async function estimateScopes(scopeIds, context) {
  const rows = []
  for (const scopeId of scopeIds) {
    let files = 0
    let bytes = 0
    try {
      const entries = await scanScope(scopeId, context)
      files = entries.size
      for (const entry of entries.values()) bytes += entry.size
    } catch (error) {
      rows.push({ id: scopeId, files: 0, bytes: 0, error: String(error?.message ?? error) })
      continue
    }
    rows.push({ id: scopeId, files, bytes })
  }
  return rows
}
