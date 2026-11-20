import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { SyncEngine } from '../lib/core/engine.js'
import { assertSafeRel } from '../lib/core/paths.js'

async function writeFile(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

async function sha256(file) {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex')
}

async function makeHome(home, agentsHome) {
  await writeFile(join(home, 'AGENTS.md'), '# Global rules\n\n- be kind\n')
  await writeFile(
    join(home, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'profile', dependencies: { alpha: '1.0.0' } }, null, 2),
  )
  await writeFile(
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    '- id: alpha\n  config:\n    enabled: true\n',
  )
  await writeFile(join(home, 'plugins', 'demo', 'index.js'), 'export function apply() {}\n')
  await writeFile(join(agentsHome, 'skills', 'demo', 'SKILL.md'), '# Demo skill\n\nbody\n')
  await writeFile(join(agentsHome, '.skill-lock.json'), '{"version":3}\n')
  const frames = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"session","version":4}\n')),
    zstdCompressSync(Buffer.from('{"type":"user/message","seq":1}\n')),
  ])
  await writeFile(join(home, 'sessions', '--D-demo--', 'session-1', 'session.v4.jsonl.zstd'), frames)
  // Must never be synced.
  await writeFile(join(home, '.credentials.yaml'), 'token: should-not-sync\n')
  await writeFile(join(home, 'profiles', 'web', 'node_modules', 'x', 'index.js'), 'nope\n')
  await writeFile(join(home, 'temp', 'debug.log'), 'nope\n')
  await writeFile(join(home, 'plugins', 'demo', 'notes.log'), 'nope\n')
}

async function newEngine(root) {
  const home = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  const stateRoot = join(root, 'state')
  const backup = join(root, 'backup')
  const engine = await new SyncEngine({ dshHome: home, agentsHome, stateRoot }).init()
  return { engine, home, agentsHome, stateRoot, backup }
}

const SYNCED_PATHS = [
  ['agents-md', 'AGENTS.md'],
  ['plugin-settings', 'profiles/web/package.json'],
  ['plugin-settings', 'profiles/web/cordis.patch.yml'],
  ['plugin-files', 'plugins/demo/index.js'],
  ['skills', 'skills/demo/SKILL.md'],
  ['skills', '.skill-lock.json'],
  ['sessions', 'sessions/--D-demo--/session-1/session.v4.jsonl.zstd'],
]

const pathOf = (scopeId, rel, home, agentsHome) => (
  scopeId === 'skills' ? join(agentsHome, rel) : join(home, rel)
)

test('local backup, identical no-op and restore round trip', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const targets = await a.engine.upsertTarget({ name: 'local backup', path: a.backup })
  assert.equal(targets.length, 1)
  const targetId = targets[0].id

  const firstProgress = []
  const first = await a.engine.sync({
    targetId,
    direction: 'push',
    onProgress: (progress) => firstProgress.push(progress),
  })
  assert.ok(first.summary.uploaded >= 7, `expected uploads, got ${JSON.stringify(first.summary)}`)
  assert.equal(first.summary.conflicts, 0)
  assert.ok(firstProgress.length > 0, 'sync must report progress')
  const lastProgress = firstProgress[firstProgress.length - 1]
  assert.equal(lastProgress.phase, 'manifest')
  assert.equal(lastProgress.total, 7)
  assert.ok(lastProgress.bytesTotal > 0, 'planned transfer bytes must be reported')
  assert.equal(lastProgress.done, lastProgress.total)
  assert.ok(Number.isFinite(lastProgress.speedBytesPerSec))
  assert.ok(Number.isFinite(first.summary.durationMs))
  assert.ok(Number.isFinite(first.summary.avgBytesPerSec))

  // Repository layout exists and contains no excluded files.
  const targetPrefix = (await a.engine.getSettings()).targets[0].prefix
  const manifestPath = join(a.backup, targetPrefix, 'manifests', `${(await a.engine.getSettings()).deviceId}.json`)
  const manifestText = await fsp.readFile(manifestPath, 'utf8')
  const settingsAfterFirst = await a.engine.getSettings()
  assert.match(settingsAfterFirst.targets[0].prefix, /^dsh-sync-v/)
  const meta = JSON.parse(await fsp.readFile(join(a.backup, settingsAfterFirst.targets[0].prefix, 'meta.json'), 'utf8'))
  assert.ok(typeof meta.dshVersion === 'string' && meta.dshVersion.length > 0)
  const backupInfo = await a.engine.getBackupInfo(targets[0].id)
  assert.equal(backupInfo.prefix, targets[0].prefix)
  assert.equal(backupInfo.exists, true)
  assert.ok(typeof backupInfo.dshVersion === 'string' && backupInfo.dshVersion.length > 0)
  assert.ok(!manifestText.includes('credentials'))
  assert.ok(!manifestText.includes('node_modules'))
  assert.ok(!manifestText.includes('.log'))

  // Record mtimes, then run the same sync again: everything must be identical.
  const before = new Map()
  for (const [scopeId, rel] of SYNCED_PATHS) {
    const file = pathOf(scopeId, rel, a.home, a.agentsHome)
    before.set(file, (await fsp.stat(file)).mtimeMs)
  }
  const second = await a.engine.sync({ targetId })
  assert.equal(second.summary.uploaded, 0)
  assert.equal(second.summary.downloaded, 0)
  assert.equal(second.summary.identical, SYNCED_PATHS.length, JSON.stringify(second.summary))
  for (const [scopeId, rel] of SYNCED_PATHS) {
    const file = pathOf(scopeId, rel, a.home, a.agentsHome)
    assert.equal((await fsp.stat(file)).mtimeMs, before.get(file), `mtime changed for ${rel}`)
  }

  // Restore into a fresh empty home.
  const b = await newEngine(join(root, 'b'))
  const bTargets = await b.engine.upsertTarget({ name: 'restore', path: a.backup })
  const restored = await b.engine.sync({ targetId: bTargets[0].id, direction: 'pull' })
  assert.equal(restored.summary.conflicts, 0)
  for (const [scopeId, rel] of SYNCED_PATHS) {
    const source = pathOf(scopeId, rel, a.home, a.agentsHome)
    const destination = pathOf(scopeId, rel, b.home, b.agentsHome)
    assert.equal(await sha256(destination), await sha256(source), `restored ${rel} differs`)
  }
  // Excluded files were not restored.
  await assert.rejects(fsp.access(join(b.home, '.credentials.yaml')))
})

test('concurrent edits keep both sides instead of overwriting', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-conflict-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const targetId = (await a.engine.upsertTarget({ name: 'backup', path: a.backup }))[0].id
  await a.engine.sync({ targetId })

  const b = await newEngine(join(root, 'b'))
  const bTargetId = (await b.engine.upsertTarget({ name: 'backup', path: a.backup }))[0].id
  await b.engine.sync({ targetId: bTargetId, direction: 'pull' })

  const rel = 'sessions/--D-demo--/session-1/session.v4.jsonl.zstd'
  const remoteFile = join(b.home, rel)
  const localFile = join(a.home, rel)
  const remoteBytes = Buffer.concat([
    await fsp.readFile(remoteFile),
    zstdCompressSync(Buffer.from('{"type":"user/message","seq":2}\n')),
  ])
  await fsp.writeFile(remoteFile, remoteBytes)
  await b.engine.sync({ targetId: bTargetId, direction: 'push' })

  const localBytes = Buffer.concat([
    await fsp.readFile(localFile),
    zstdCompressSync(Buffer.from('{"type":"user/message","seq":3}\n')),
  ])
  await fsp.writeFile(localFile, localBytes)

  const result = await a.engine.sync({ targetId })
  assert.equal(result.summary.conflicts, 1, JSON.stringify(result.summary))
  assert.deepEqual(await fsp.readFile(localFile), localBytes, 'local session must not be overwritten')

  const dir = dirname(localFile)
  const entries = await fsp.readdir(dir)
  const conflictName = entries.find((entry) => entry.includes('.conflict-'))
  assert.ok(conflictName, `expected a conflict copy, got: ${entries.join(', ')}`)
  assert.deepEqual(await fsp.readFile(join(dir, conflictName)), remoteBytes)
})

test('pendingCounts exposes the changed session ids for the sidebar tooltip', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-pending-details-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const targetId = (await a.engine.upsertTarget({ name: 'backup', path: a.backup }))[0].id
  await a.engine.sync({ targetId })

  const sessionFile = join(a.home, 'sessions', '--D-demo--', 'session-1', 'session.v4.jsonl.zstd')
  await fsp.appendFile(sessionFile, zstdCompressSync(Buffer.from('{"type":"user/message","seq":2}\n')))

  const pending = await a.engine.pendingCounts({ targetId })
  assert.ok(pending.total > 0)
  assert.ok(Array.isArray(pending.details.sessions))
  assert.ok(pending.details.sessions.some((row) => row.id === 'session-1' && row.upload > 0))
  assert.ok(pending.details.scopes.some((row) => row.id === 'sessions'))

  const plan = await a.engine.preview({ targetId })
  assert.ok(!plan.actions.some((action) => action.type === 'identical'))
})

test('preview and sync persist the last selected target', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-last-target-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const first = (await a.engine.upsertTarget({ name: 'first', path: join(root, 'backup-a') }))[0]
  const [second] = await a.engine.saveSettings({}).then((settings) => {
    const targets = settings.targets
    return targets
  }).then(async () => await a.engine.upsertTarget({ name: 'second', path: join(root, 'backup-b') }))
  await a.engine.preview({ targetId: second.id, scopeIds: ['agents-md'], direction: 'push' })
  assert.equal((await a.engine.getSettings()).lastTargetId, second.id)
  assert.equal((await a.engine.status()).defaultTargetId, second.id)
  await a.engine.sync({ targetId: first.id, scopeIds: ['agents-md'], direction: 'push' })
  assert.equal((await a.engine.getSettings()).lastTargetId, first.id)
  assert.equal((await a.engine.status()).defaultTargetId, first.id)
})

test('an interrupted sync persists completed files in the manifest', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-checkpoint-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const [target] = await a.engine.upsertTarget({ name: 'backup', path: a.backup })

  const originalUpload = a.engine.uploadScope.bind(a.engine)
  a.engine.uploadScope = async (...args) => {
    await originalUpload(...args)
    throw new Error('simulated crash after upload')
  }

  await assert.rejects(() => a.engine.sync({ targetId: target.id, scopeIds: ['agents-md'], direction: 'push' }))
  const settings = await a.engine.getSettings()
  const manifest = JSON.parse(await fsp.readFile(
    join(a.backup, target.prefix, 'manifests', settings.deviceId + '.json'),
    'utf8',
  ))
  assert.ok(Object.keys(manifest.scopes['agents-md'].files).length >= 1)
})

test('uploadScope stops before the next file once cancelled', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-cancel-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const engine = new SyncEngine({ dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), stateRoot: join(root, 'state') })
  const first = join(root, 'a.txt')
  const second = join(root, 'b.txt')
  await fsp.writeFile(first, 'a')
  await fsp.writeFile(second, 'b')
  const entries = new Map([
    ['agents-md/a.txt', { abs: first, size: 1, mtimeMs: 1 }],
    ['agents-md/b.txt', { abs: second, size: 1, mtimeMs: 1 }],
  ])
  const actions = [
    { type: 'upload', scope: 'agents-md', path: 'agents-md/a.txt' },
    { type: 'upload', scope: 'agents-md', path: 'agents-md/b.txt' },
  ]
  const puts = []
  const provider = {
    async head() { return undefined },
    async put(key, buffer) { puts.push(key); },
  }
  let processed = 0
  await assert.rejects(
    () => engine.uploadScope({
      provider,
      scopeId: 'agents-md',
      entries,
      localFiles: {
        'agents-md/a.txt': { size: 1, mtimeMs: 1, sha256: sha256Hex('a') },
        'agents-md/b.txt': { size: 1, mtimeMs: 1, sha256: sha256Hex('b') },
      },
      actions,
      stats: { uploaded: 0, bytesUploaded: 0 },
      onAction: () => { processed += 1 },
      isCancelled: () => processed >= 1,
    }),
    (error) => error.code === 'cancelled',
  )
  assert.equal(puts.length, 1)
})

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

test('a deleted local file is asked about, then restored or skipped by choice', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-delete-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const targetId = (await a.engine.upsertTarget({ name: 'backup', path: a.backup }))[0].id
  await a.engine.sync({ targetId })

  const original = await fsp.readFile(join(a.home, 'AGENTS.md'))
  await fsp.rm(join(a.home, 'AGENTS.md'))

  // Default settings use deleteMode "ask": the plan reports a choice instead of
  // silently skipping or restoring.
  const plan = await a.engine.preview({ targetId, scopeIds: ['agents-md'], direction: 'both' })
  assert.equal(plan.summary.choice, 1, JSON.stringify(plan.summary))
  assert.equal(plan.choices[0].side, 'local-missing')

  // "ignore" leaves the file missing and keeps the base/remote record.
  const ignored = await a.engine.sync({ targetId, scopeIds: ['agents-md'], direction: 'both', deleteChoice: 'ignore' })
  assert.equal(ignored.summary.downloaded, 0)
  await assert.rejects(fsp.access(join(a.home, 'AGENTS.md')))

  // The record survived, so the next run can still ask and restore.
  const planAgain = await a.engine.preview({ targetId, scopeIds: ['agents-md'], direction: 'both' })
  assert.equal(planAgain.summary.choice, 1)

  const restored = await a.engine.sync({ targetId, scopeIds: ['agents-md'], direction: 'both', deleteChoice: 'restore' })
  assert.equal(restored.summary.downloaded, 1)
  assert.deepEqual(await fsp.readFile(join(a.home, 'AGENTS.md')), original)
})

test('pendingCounts reports pending uploads without writing', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-pending-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const a = await newEngine(join(root, 'a'))
  await makeHome(a.home, a.agentsHome)
  const [target] = await a.engine.upsertTarget({ name: 'pending', path: a.backup })
  await a.engine.sync({ targetId: target.id, direction: 'push' })

  const clean = await a.engine.pendingCounts({ targetId: target.id })
  assert.equal(clean.upload, 0)
  assert.equal(clean.download, 0)
  assert.equal(clean.total, 0)

  await fsp.writeFile(join(a.home, 'AGENTS.md'), '# changed rules\n')
  const pending = await a.engine.pendingCounts({ targetId: target.id })
  assert.equal(pending.upload, 1)
  assert.ok(pending.total >= 1)
  // Read-only: the changed file is still local only and nothing was written.
  assert.equal(await fsp.readFile(join(a.home, 'AGENTS.md'), 'utf8'), '# changed rules\n')
})

test('paths from a manifest cannot escape their root', () => {
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:\\x', 'a\\b', 'a//b', './x']) {
    assert.throws(() => assertSafeRel(bad), undefined, `should reject ${bad}`)
  }
  assert.equal(assertSafeRel('skills/demo/SKILL.md'), 'skills/demo/SKILL.md')
})
