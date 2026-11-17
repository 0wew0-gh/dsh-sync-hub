/**
 * Local directory target.
 *
 * The remote repository is a plain folder: manifests and content-addressed
 * blobs. It works on a normal disk, a UNC share, a mapped network drive or a
 * folder managed by a cloud-sync client (OneDrive / Nutstore / etc.).
 */

import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { atomicWrite, ensureDir, retry } from '../util.js'
import { defaultTargetPrefix, normalizeTargetPath, resolveInside } from '../paths.js'

export const BLOB_PREFIX = 'blobs'

/** Object key for a content-addressed blob (two levels of fan-out). */
export function blobKey(sha256) {
  return `${BLOB_PREFIX}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`
}

/** Object key for one device manifest. */
export function manifestKey(deviceId) {
  return `manifests/${deviceId}.json`
}

/** Create a target provider backed by a local folder. */
export function createLocalDirTarget({ path, prefix = defaultTargetPrefix() }) {
  const root = normalizeTargetPath(path)
  const repoRoot = resolveInside(root, prefix)

  const keyPath = (key) => {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\\')) {
      throw new Error(`invalid object key: ${key}`)
    }
    return resolveInside(repoRoot, key)
  }

  return {
    kind: 'local',
    root,
    repoRoot,
    prefix,

    /** Verify the target is writable by writing and removing a probe object. */
    async probe() {
      await ensureDir(repoRoot)
      const probePath = join(repoRoot, `.probe-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      await fsp.writeFile(probePath, 'dsh-sync-hub probe\n')
      const text = await fsp.readFile(probePath, 'utf8')
      await fsp.rm(probePath, { force: true })
      if (!text.includes('probe')) throw new Error('probe read-back mismatch')
      return { ok: true, detail: repoRoot }
    },

    async head(key) {
      try {
        const stat = await fsp.stat(keyPath(key))
        return { size: stat.size, mtimeMs: stat.mtimeMs }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    },

    async get(key) {
      try {
        return await fsp.readFile(keyPath(key))
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    },

    async put(key, buffer, options = {}) {
      const file = keyPath(key)
      await ensureDir(dirname(file))
      await retry(() => atomicWrite(file, buffer, 0o644), { attempts: 2, delayMs: 200 })
      if (typeof options.onProgress === 'function') options.onProgress(buffer.length)
      return { ok: true }
    },

    async remove(key) {
      await fsp.rm(keyPath(key), { force: true })
    },

    async list(prefixKey) {
      const dir = keyPath(prefixKey)
      const out = []
      async function walk(abs, rel) {
        let items
        try {
          items = await fsp.readdir(abs, { withFileTypes: true })
        } catch (error) {
          if (error.code === 'ENOENT') return
          throw error
        }
        for (const item of items) {
          const childRel = rel ? `${rel}/${item.name}` : item.name
          if (item.isDirectory()) await walk(join(abs, item.name), childRel)
          else if (item.isFile()) out.push(childRel)
        }
      }
      await walk(dir, '')
      return out
    },
  }
}
