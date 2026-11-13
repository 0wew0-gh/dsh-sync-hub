/**
 * Manifest construction and the three-way planner.
 *
 * A manifest maps a scope-relative path to `{size, mtimeMs, mode, sha256}`.
 * Planning compares local / base / remote views per path and only produces an
 * action when content really differs -- identical content is always a no-op
 * (see DESIGN §5.2.1).
 */

import { sha256File } from './util.js'

export const MANIFEST_SCHEMA = 'dsh-sync/v1/manifest'

/** Empty manifest skeleton. */
export function emptyManifest({ deviceId = '', deviceName = '' } = {}) {
  return {
    schema: MANIFEST_SCHEMA,
    deviceId,
    deviceName,
    updatedAt: new Date().toISOString(),
    scopes: {},
  }
}

/**
 * Build the manifest for one scope.
 *
 * Reuses `sha256` from the previous base manifest when size and mtime match,
 * so repeated scans do not re-hash hundreds of megabytes of session files.
 * A file whose size changes while it is being hashed (a live session append)
 * is marked `unstable` and skipped for this run.
 */
export async function buildScopeManifest(scopeId, entries, baseFiles = {}) {
  const files = {}
  let hashed = 0
  let reused = 0
  const unstable = []
  for (const [rel, entry] of entries) {
    const base = baseFiles[rel]
    if (base && base.size === entry.size && base.mtimeMs === entry.mtimeMs && base.sha256) {
      files[rel] = {
        scope: scopeId,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        mode: entry.mode,
        sha256: base.sha256,
      }
      reused += 1
      continue
    }
    let hash
    try {
      hash = await sha256File(entry.abs)
    } catch (error) {
      if (error.code === 'ENOENT') {
        unstable.push(rel)
        continue
      }
      throw error
    }
    let after
    try {
      after = await import('node:fs').then(({ promises }) => promises.stat(entry.abs))
    } catch {
      unstable.push(rel)
      continue
    }
    if (after.size !== entry.size) {
      // File is being appended to (live session). Skip it this round.
      unstable.push(rel)
      continue
    }
    files[rel] = {
      scope: scopeId,
      size: after.size,
      mtimeMs: after.mtimeMs,
      mode: entry.mode,
      sha256: hash,
    }
    hashed += 1
  }
  return { files, stats: { hashed, reused, unstable } }
}

/** Union remote manifests per scope; later entries win per path. */
export function mergeRemoteManifests(manifests) {
  const merged = {}
  const ordered = [...manifests]
    .filter(Boolean)
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')))
  for (const manifest of ordered) {
    for (const [scopeId, scope] of Object.entries(manifest.scopes ?? {})) {
      merged[scopeId] ??= {}
      // Apply tombstones first: a later manifest deleting a path wins over an
      // older manifest that still lists it.
      for (const rel of scope.removed ?? []) delete merged[scopeId][rel]
      for (const [rel, entry] of Object.entries(scope.files ?? {})) {
        merged[scopeId][rel] = entry
      }
    }
  }
  return merged
}

function changed(current, base) {
  const hasCurrent = Boolean(current)
  const hasBase = Boolean(base)
  if (!hasCurrent && !hasBase) return false
  if (hasCurrent !== hasBase) return true
  return current.sha256 !== base.sha256
}

/**
 * Plan actions for one scope.
 *
 * @returns {{ actions: object[], summary: object }}
 */
export function planScope({
  scopeId,
  policy = 'newer',
  localFiles = {},
  baseFiles = {},
  remoteFiles = {},
  direction = 'both',
  deviceName = 'device',
  stamp = 'now',
  deleteMode = 'restore',
  force = false,
  maxActions = 2000,
}) {
  const actions = []
  const summary = { identical: 0, upload: 0, download: 0, conflict: 0, skip: 0, delete: 0, choice: 0 }
  const keys = new Set([
    ...Object.keys(localFiles),
    ...Object.keys(baseFiles),
    ...Object.keys(remoteFiles),
  ])

  /**
   * Decide what a one-sided deletion means.
   *
   * `restore` is the default: a deleted-but-unchanged side is restored from the
   * surviving copy, so an accidental local delete never destroys the backup.
   * `mirror` propagates the deletion, `ignore` skips it, and `ask` emits a
   * `choice` action so the UI can ask the user before anything is written.
   * `force` always chooses restore, which is what users expect from the
   * "overwrite" switch.
   */
  const deletionChoice = (side) => {
    if (force) return side === 'local-missing' ? 'restore-local' : 'restore-remote'
    if (deleteMode === 'ask' && direction === 'both') return 'ask'
    if (side === 'local-missing') {
      if (direction === 'push') return 'mirror-remote'
      if (direction === 'pull') return 'restore-local'
      if (deleteMode === 'mirror') return 'mirror-remote'
      if (deleteMode === 'ignore') return 'ignore'
      return 'restore-local'
    }
    if (direction === 'pull') return 'mirror-local'
    if (direction === 'push') return 'restore-remote'
    if (deleteMode === 'mirror') return 'mirror-local'
    if (deleteMode === 'ignore') return 'ignore'
    return 'restore-remote'
  }

  const pushAction = (action) => {
    summary[action.type] ??= 0
    summary[action.type] += 1
    if (actions.length < maxActions) actions.push(action)
  }

  const pushDeletion = (rel, side) => {
    const choice = deletionChoice(side)
    if (choice === 'ask') {
      pushAction({ type: 'choice', scope: scopeId, path: rel, side, reason: 'deletion-needs-choice' })
    } else if (choice === 'restore-local') {
      pushAction({ type: 'download', scope: scopeId, path: rel, reason: 'restore-deleted-local' })
    } else if (choice === 'restore-remote') {
      pushAction({ type: 'upload', scope: scopeId, path: rel, reason: 'restore-deleted-remote' })
    } else if (choice === 'mirror-remote') {
      pushAction({ type: 'delete', scope: scopeId, path: rel, side: 'remote', reason: 'deleted-locally' })
    } else if (choice === 'mirror-local') {
      pushAction({ type: 'delete', scope: scopeId, path: rel, side: 'local', reason: 'deleted-remotely' })
    } else {
      pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'deletion-ignored' })
    }
  }

  for (const rel of [...keys].sort()) {
    const local = localFiles[rel]
    const base = baseFiles[rel]
    const remote = remoteFiles[rel]

    if (local && remote && local.sha256 === remote.sha256) {
      pushAction({ type: 'identical', scope: scopeId, path: rel })
      continue
    }

    const localChanged = changed(local, base)
    const remoteChanged = changed(remote, base)

    if (!localChanged && !remoteChanged) {
      if (local && remote) pushAction({ type: 'identical', scope: scopeId, path: rel })
      else pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'not-present-on-one-side' })
      continue
    }

    if (localChanged && !remoteChanged) {
      if (!local) {
        pushDeletion(rel, 'local-missing')
      } else if (direction === 'pull') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'local-change (pull-only)' })
      } else {
        pushAction({ type: 'upload', scope: scopeId, path: rel })
      }
      continue
    }

    if (!localChanged && remoteChanged) {
      if (!remote) {
        pushDeletion(rel, 'remote-missing')
      } else if (direction === 'push') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'remote-change (push-only)' })
      } else {
        pushAction({ type: 'download', scope: scopeId, path: rel })
      }
      continue
    }

    // Both sides changed and content differs -> conflict resolution.
    if (!local && !remote) {
      pushAction({ type: 'identical', scope: scopeId, path: rel })
      continue
    }
    if (!local && remote) {
      // Locally deleted, remotely modified: restoring the remote copy keeps the
      // only surviving content. `force` makes that choice explicit.
      if (force) {
        pushAction({ type: 'download', scope: scopeId, path: rel, reason: 'force-restore-remote' })
      } else if (direction === 'push') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'delete-vs-modify (push-only)' })
      } else {
        pushAction({ type: 'conflict', scope: scopeId, path: rel, resolution: 'restore-remote', reason: 'delete-vs-modify' })
      }
      continue
    }
    if (local && !remote) {
      // Remotely deleted, locally modified: keep the local copy.
      if (force) {
        pushAction({ type: 'upload', scope: scopeId, path: rel, reason: 'force-restore-local' })
      } else if (direction === 'pull') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'modify-vs-delete (pull-only)' })
      } else {
        pushAction({ type: 'conflict', scope: scopeId, path: rel, resolution: 'keep-local', reason: 'modify-vs-delete' })
      }
      continue
    }

    if (policy === 'keep-both') {
      if (direction === 'push' || direction === 'pull') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'conflict (one-way sync)' })
      } else {
        pushAction({
          type: 'conflict',
          scope: scopeId,
          path: rel,
          resolution: 'keep-both',
          conflictPath: `${rel}.conflict-${deviceName}-${stamp}`,
        })
      }
      continue
    }

    if (policy === 'local') {
      if (direction === 'pull') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'conflict (pull-only)' })
      } else {
        pushAction({ type: 'upload', scope: scopeId, path: rel, reason: 'policy=local' })
      }
      continue
    }
    if (policy === 'remote') {
      if (direction === 'push') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'conflict (push-only)' })
      } else {
        pushAction({ type: 'download', scope: scopeId, path: rel, reason: 'policy=remote' })
      }
      continue
    }

    // policy === 'newer': pick the newer mtime; ties go to local.
    if ((local.mtimeMs ?? 0) >= (remote.mtimeMs ?? 0)) {
      if (direction === 'pull') {
        pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'newer-local (pull-only)' })
      } else {
        pushAction({ type: 'upload', scope: scopeId, path: rel, reason: 'newer' })
      }
    } else if (direction === 'push') {
      pushAction({ type: 'skip', scope: scopeId, path: rel, reason: 'newer-remote (push-only)' })
    } else {
      pushAction({ type: 'download', scope: scopeId, path: rel, reason: 'newer' })
    }
  }

  return { actions, summary }
}

/** Summarize action lists from several scopes. */
export function summarizeActions(actions) {
  const summary = { identical: 0, upload: 0, download: 0, conflict: 0, skip: 0, delete: 0 }
  for (const action of actions) summary[action.type] = (summary[action.type] ?? 0) + 1
  return summary
}
