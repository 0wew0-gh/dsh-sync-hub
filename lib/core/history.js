/**
 * Snapshot history.
 *
 * Every successful sync that actually moved data records a small manifest
 * snapshot under `snapshots/<key>/manifest.json` and appends an entry to
 * `snapshots/index.json`. Content blobs are shared, so a snapshot costs one
 * manifest object rather than a full copy.
 */

import { isoKey, readJson } from './util.js'

export const SNAPSHOT_SCHEMA = 'dsh-sync/v1/snapshot'

function parseJson(buffer, fallback) {
  if (!buffer) return fallback
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return fallback
  }
}

/** Record a snapshot; trims the index to `historyLimit` entries. */
export async function recordSnapshot(target, manifest, { deviceName = '', historyLimit = 30 } = {}) {
  const key = isoKey(new Date())
  const entry = {
    key,
    createdAt: new Date().toISOString(),
    deviceName,
    files: Object.values(manifest.scopes ?? {}).reduce(
      (total, scope) => total + Object.keys(scope.files ?? {}).length,
      0,
    ),
  }
  await target.put(`snapshots/${key}/manifest.json`, Buffer.from(JSON.stringify(manifest), 'utf8'))
  const index = parseJson(await target.get('snapshots/index.json'), { schema: SNAPSHOT_SCHEMA, entries: [] })
  index.schema = SNAPSHOT_SCHEMA
  index.entries = [entry, ...(index.entries ?? []).filter((item) => item.key !== key)]
  index.entries = index.entries.slice(0, Math.max(1, historyLimit))
  await target.put('snapshots/index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'))
  return entry
}

/** List snapshots newest first. */
export async function listSnapshots(target) {
  const index = parseJson(await target.get('snapshots/index.json'), { schema: SNAPSHOT_SCHEMA, entries: [] })
  return Array.isArray(index.entries) ? index.entries : []
}

/** Read one snapshot manifest. */
export async function readSnapshot(target, key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(key)) {
    throw new Error(`invalid snapshot key: ${key}`)
  }
  return parseJson(await target.get(`snapshots/${key}/manifest.json`), null)
}
