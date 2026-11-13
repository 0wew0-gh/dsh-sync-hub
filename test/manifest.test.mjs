import test from 'node:test'
import assert from 'node:assert/strict'
import { planScope } from '../lib/core/manifest.js'

const file = (sha, size = 10, mtimeMs = 1000, scope = 's') => ({ scope, size, mtimeMs, mode: 0o644, sha256: sha })

test('first sync uploads local-only files', () => {
  const { actions, summary } = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('a1') },
    baseFiles: {},
    remoteFiles: {},
    direction: 'both',
  })
  assert.deepEqual(summary, { identical: 0, upload: 1, download: 0, conflict: 0, skip: 0, delete: 0, choice: 0 })
  assert.equal(actions[0].type, 'upload')
})

test('identical content is a no-op even when metadata changed', () => {
  const { actions, summary } = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('same', 10, 2000) },
    baseFiles: { 'skills/a/SKILL.md': file('same', 10, 1000) },
    remoteFiles: { 'skills/a/SKILL.md': file('same', 10, 3000) },
    direction: 'both',
  })
  assert.equal(summary.identical, 1)
  assert.equal(actions[0].type, 'identical')
})

test('one-sided change fast-forwards without conflict', () => {
  const base = { 'skills/a/SKILL.md': file('base') }
  const upload = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('local') },
    baseFiles: base,
    remoteFiles: { 'skills/a/SKILL.md': file('base') },
    direction: 'both',
  })
  assert.equal(upload.summary.upload, 1)

  const download = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('base') },
    baseFiles: base,
    remoteFiles: { 'skills/a/SKILL.md': file('remote') },
    direction: 'both',
  })
  assert.equal(download.summary.download, 1)
})

test('both sides changed with identical bytes is still a no-op', () => {
  const { actions } = planScope({
    scopeId: 'agents-md',
    localFiles: { 'AGENTS.md': file('x', 10, 2000) },
    baseFiles: { 'AGENTS.md': file('base', 10, 1000) },
    remoteFiles: { 'AGENTS.md': file('x', 10, 3000) },
    direction: 'both',
  })
  assert.equal(actions[0].type, 'identical')
})

test('keep-both produces a conflict copy path and never overwrites the local file', () => {
  const { actions, summary } = planScope({
    scopeId: 'sessions',
    policy: 'keep-both',
    localFiles: { 'sessions/a/session.v4.jsonl.zstd': file('local', 10, 2000) },
    baseFiles: { 'sessions/a/session.v4.jsonl.zstd': file('base', 10, 1000) },
    remoteFiles: { 'sessions/a/session.v4.jsonl.zstd': file('remote', 10, 3000) },
    direction: 'both',
    deviceName: 'pc1',
    stamp: '20260101-000000-000',
  })
  assert.equal(summary.conflict, 1)
  assert.equal(actions[0].type, 'conflict')
  assert.equal(actions[0].resolution, 'keep-both')
  assert.match(actions[0].conflictPath, /\.conflict-pc1-20260101-000000-000$/)
})

test('newer policy picks the newer mtime and falls back to local on ties', () => {
  const newerRemote = planScope({
    scopeId: 'agents-md',
    policy: 'newer',
    localFiles: { 'AGENTS.md': file('local', 10, 1000) },
    baseFiles: { 'AGENTS.md': file('base', 10, 500) },
    remoteFiles: { 'AGENTS.md': file('remote', 10, 2000) },
    direction: 'both',
  })
  assert.equal(newerRemote.actions[0].type, 'download')

  const tie = planScope({
    scopeId: 'agents-md',
    policy: 'newer',
    localFiles: { 'AGENTS.md': file('local', 10, 1000) },
    baseFiles: { 'AGENTS.md': file('base', 10, 500) },
    remoteFiles: { 'AGENTS.md': file('remote', 10, 1000) },
    direction: 'both',
  })
  assert.equal(tie.actions[0].type, 'upload')
})

test('one-sided deletion follows the delete mode', () => {
  const localDeleted = {
    scopeId: 'skills',
    localFiles: {},
    baseFiles: { 'skills/a/SKILL.md': file('base') },
    remoteFiles: { 'skills/a/SKILL.md': file('base') },
    direction: 'both',
  }

  // Default restore: bring the missing local file back from the target.
  const restored = planScope({ ...localDeleted, deleteMode: 'restore' })
  assert.equal(restored.actions[0].type, 'download')
  assert.equal(restored.actions[0].reason, 'restore-deleted-local')

  // Ignore: keep the v0.1 skip behaviour.
  const ignored = planScope({ ...localDeleted, deleteMode: 'ignore' })
  assert.equal(ignored.actions[0].type, 'skip')
  assert.equal(ignored.actions[0].reason, 'deletion-ignored')

  // Ask: no write happens until the user answers the prompt.
  const asked = planScope({ ...localDeleted, deleteMode: 'ask' })
  assert.equal(asked.actions[0].type, 'choice')
  assert.equal(asked.actions[0].side, 'local-missing')
  assert.equal(asked.summary.choice, 1)

  // Force always restores, even when the mode would otherwise skip.
  const forced = planScope({ ...localDeleted, deleteMode: 'ask', force: true })
  assert.equal(forced.actions[0].type, 'download')

  // Mirror: propagate the deletion to the other side.
  const mirrored = planScope({ ...localDeleted, deleteMode: 'mirror' })
  assert.equal(mirrored.actions[0].type, 'delete')
  assert.equal(mirrored.actions[0].side, 'remote')
})

test('remote deletion mirrors or restores according to mode and direction', () => {
  const remoteDeleted = {
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('base') },
    baseFiles: { 'skills/a/SKILL.md': file('base') },
    remoteFiles: {},
    direction: 'both',
  }
  assert.equal(planScope({ ...remoteDeleted, deleteMode: 'restore' }).actions[0].type, 'upload')
  assert.equal(planScope({ ...remoteDeleted, deleteMode: 'mirror' }).actions[0].side, 'local')
  assert.equal(planScope({ ...remoteDeleted, direction: 'pull' }).actions[0].side, 'local')
  assert.equal(planScope({ ...remoteDeleted, direction: 'push' }).actions[0].type, 'upload')
})

test('push-only and pull-only never download/upload respectively', () => {
  const push = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('local') },
    baseFiles: { 'skills/a/SKILL.md': file('base') },
    remoteFiles: { 'skills/a/SKILL.md': file('remote') },
    direction: 'push',
    policy: 'newer',
  })
  assert.ok(push.actions.every((action) => action.type !== 'download'))

  const pull = planScope({
    scopeId: 'skills',
    localFiles: { 'skills/a/SKILL.md': file('local') },
    baseFiles: { 'skills/a/SKILL.md': file('base') },
    remoteFiles: { 'skills/a/SKILL.md': file('remote') },
    direction: 'pull',
    policy: 'newer',
  })
  assert.ok(pull.actions.every((action) => action.type !== 'upload'))
})
