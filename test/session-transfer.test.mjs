import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { SyncEngine } from '../lib/core/engine.js'
import { mergeSettings, normalizeSettings } from '../lib/core/state.js'
import {
  joinPathLike,
  normalizeSelectedSessionIds,
  normalizeSessionId,
  projectKey,
  readSessionHeader,
  sessionPathKeyOf,
  suggestSessionCwd,
  userRootOf,
} from '../lib/core/sessions.js'
import {
  chooseRestoreCwd,
  listLocalSessionData,
  readBackupSessionGroups,
} from '../lib/core/session-transfer.js'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function sessionBuffer(cwd, events = ['first'], createdAt = 1700000000000) {
  const header = { type: 'session', version: 4, id: 'session-test', createdAt, cwd }
  const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))]
  for (const event of events) {
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify({ type: 'event', event }) + '\n')))
  }
  return Buffer.concat(frames)
}

async function writeSession(home, projectDir, sessionId, buffer) {
  const dir = join(home, 'sessions', projectDir, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  await fsp.writeFile(file, buffer)
  return file
}

async function newEngine(root) {
  const home = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  const stateRoot = join(root, 'state')
  const backup = join(root, 'backup')
  const engine = await new SyncEngine({ dshHome: home, agentsHome, stateRoot }).init()
  return { engine, home, agentsHome, stateRoot, backup }
}

function manifestPath(backup, deviceId, prefix) {
  return join(backup, prefix, 'manifests', `${deviceId}.json`)
}

async function readManifest(backup, deviceId, prefix) {
  return JSON.parse(await fsp.readFile(manifestPath(backup, deviceId, prefix), 'utf8'))
}

function sessionProjectDirs(files, sessionId) {
  const dirs = new Set()
  for (const rel of Object.keys(files ?? {})) {
    const parts = rel.split('/')
    if (parts[0] === 'sessions' && parts[2] === sessionId) dirs.add(parts[1])
  }
  return [...dirs]
}

test('settings normalize session selection, per-session paths and autoReplace', () => {
  const settings = normalizeSettings({
    scopes: { sessions: { mode: 'selected', selectedSessionIds: ['s1', '../evil', 's1', 42, 's2'] } },
    sessionPaths: {
      'PC|alice': {
        s1: 'D:\\work\\demo',
        '../bad': 'C:\\x',
        s2: 42,
        s3: 'C:\\Users\\alice\\demo\\',
      },
      'PC2|bob': { s1: 'relative/path' },
      'bad-key': { s1: 'C:\\x' },
    },
    autoReplaceUserFolder: true,
  })
  assert.equal(settings.scopes.sessions.mode, 'selected')
  assert.deepEqual(settings.scopes.sessions.selectedSessionIds, ['s1', 's2'])
  assert.deepEqual(settings.sessionPaths, {
    'PC|alice': {
      s1: 'D:\\work\\demo',
      s3: 'C:\\Users\\alice\\demo',
    },
  })
  assert.equal(settings.autoReplaceUserFolder, true)

  // Legacy session-first mapping is converted to the device-first shape.
  const legacy = normalizeSettings({
    sessionPaths: { s1: { 'PC|alice': 'D:\\work\\demo' } },
  })
  assert.deepEqual(legacy.sessionPaths, { 'PC|alice': { s1: 'D:\\work\\demo' } })

  const fallback = normalizeSettings({ scopes: { sessions: { mode: 'bogus' } } })
  assert.equal(fallback.scopes.sessions.mode, 'all')
  assert.deepEqual(fallback.scopes.sessions.selectedSessionIds, [])

  const merged = mergeSettings(settings, {
    sessionPaths: { 'PC|carol': { s9: 'E:\\work' } },
    autoReplaceUserFolder: false,
    scopes: { sessions: { selectedSessionIds: ['s9'] } },
  })
  assert.deepEqual(merged.sessionPaths, { 'PC|carol': { s9: 'E:\\work' } })
  assert.deepEqual(merged.scopes.sessions.selectedSessionIds, ['s9'])
  assert.equal(merged.autoReplaceUserFolder, false)

  assert.equal(normalizeSessionId('session-a_1.x'), 'session-a_1.x')
  assert.equal(normalizeSessionId('../x'), '')
  assert.deepEqual(normalizeSelectedSessionIds(['a', 'a', 'b', '']), ['a', 'b'])
  assert.equal(sessionPathKeyOf('PC', 'alice'), 'PC|alice')
  assert.equal(sessionPathKeyOf('PC|X', 'alice'), '')
  assert.equal(sessionPathKeyOf('', 'alice'), '')
})

test('path suggestion prefers per-session mapping, then legacy mapping, then user folder', () => {
  const settings = {
    sessionPaths: { 'PC|alice': { s1: 'D:\\work\\demo' } },
    sessionPathMappings: { 'C:\\Users\\old': 'E:\\users\\old' },
  }
  assert.deepEqual(
    suggestSessionCwd('s1', 'C:\\Users\\old\\p', { settings, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    { cwd: 'D:\\work\\demo', source: 'session-path', replaced: true },
  )
  assert.deepEqual(
    suggestSessionCwd('s2', 'C:\\Users\\old\\p', { settings, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    { cwd: 'E:\\users\\old\\p', source: 'legacy-mapping', replaced: true },
  )
  assert.deepEqual(
    suggestSessionCwd('s2', 'C:\\Users\\old\\p', { settings: {}, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    { cwd: 'C:\\Users\\new\\p', source: 'current-user', replaced: true },
  )
  assert.deepEqual(
    suggestSessionCwd('s2', 'D:\\work\\x', { settings: {}, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    { cwd: 'D:\\work\\x', source: 'none', replaced: false },
  )

  assert.equal(
    chooseRestoreCwd('s1', 'C:\\Users\\old\\p', { settings, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    'D:\\work\\demo',
  )
  assert.equal(
    chooseRestoreCwd('s2', 'C:\\Users\\old\\p', { settings, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    'E:\\users\\old\\p',
  )
  assert.equal(
    chooseRestoreCwd('s2', 'C:\\Users\\old\\p', { settings: {}, deviceName: 'PC', osUser: 'alice', homeDir: 'C:\\Users\\new' }),
    'C:\\Users\\old\\p',
  )
  assert.equal(
    chooseRestoreCwd('s2', 'C:\\Users\\old\\p', {
      settings: {},
      deviceName: 'PC',
      osUser: 'alice',
      homeDir: 'C:\\Users\\new',
      autoReplaceUserFolder: true,
    }),
    'C:\\Users\\new\\p',
  )
  assert.equal(
    chooseRestoreCwd('s2', 'C:\\Users\\old\\p', {
      settings: {},
      deviceName: 'PC',
      osUser: 'alice',
      targetPath: 'F:\\restored',
    }),
    'F:\\restored\\p',
  )
  assert.equal(
    chooseRestoreCwd('s2', 'C:\\Users\\old\\p', {
      settings: {},
      deviceName: 'PC',
      osUser: 'alice',
      targetPath: 'F:\\restored',
      singleTarget: true,
    }),
    'F:\\restored',
  )
  assert.equal(joinPathLike('C:\\Users\\new', '\\p'), 'C:\\Users\\new\\p')
  assert.equal(userRootOf('C:\\Users\\alice\\x'), 'C:\\Users\\alice')
})

test('selected mode syncs only the checked session directories', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-selection-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const { engine, home, backup } = await newEngine(root)
  const cwdA = join(root, 'workspace-a')
  const cwdB = join(root, 'workspace-b')
  await fsp.mkdir(cwdA, { recursive: true })
  await fsp.mkdir(cwdB, { recursive: true })
  await writeSession(home, projectKey(cwdA), 'session-a', sessionBuffer(cwdA))
  await writeSession(home, projectKey(cwdA), 'session-b', sessionBuffer(cwdA))
  await writeSession(home, projectKey(cwdB), 'session-c', sessionBuffer(cwdB))
  // Quarantined duplicate copies must never be synced.
  await writeSession(home, '.dedupe-backup-20260101/proj', 'session-q', sessionBuffer(cwdA))

  const [target] = await engine.upsertTarget({ name: 'backup', path: backup })
  await engine.saveSettings({ scopes: { sessions: { mode: 'selected', selectedSessionIds: ['session-a'] } } })
  const first = await engine.sync({ targetId: target.id, scopeIds: ['sessions'] })
  assert.equal(first.summary.uploaded, 1, JSON.stringify(first.summary))
  const settings = await engine.getSettings()
  const manifestOne = await readManifest(backup, settings.deviceId, target.prefix)
  assert.deepEqual(sessionProjectDirs(manifestOne.scopes.sessions.files, 'session-a'), [projectKey(cwdA)])
  assert.equal(Object.keys(manifestOne.scopes.sessions.files).length, 1)
  assert.ok(!JSON.stringify(manifestOne).includes('session-b'))

  await engine.saveSettings({
    scopes: { sessions: { mode: 'selected', selectedSessionIds: ['session-a', 'session-b', 'session-c'] } },
  })
  await engine.sync({ targetId: target.id, scopeIds: ['sessions'] })
  const manifestAll = await readManifest(backup, settings.deviceId, target.prefix)
  assert.equal(Object.keys(manifestAll.scopes.sessions.files).length, 3)
  assert.equal(sessionProjectDirs(manifestAll.scopes.sessions.files, 'session-c')[0], projectKey(cwdB))
  assert.ok(!JSON.stringify(manifestAll).includes('session-q'))
})

test('duplicate copies of one session id are planned once and previewed as duplicates', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-dup-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const { engine, home, backup } = await newEngine(root)
  const cwdA = join(root, 'workspace-a')
  const cwdB = join(root, 'workspace-b')
  await fsp.mkdir(cwdA, { recursive: true })
  await fsp.mkdir(cwdB, { recursive: true })
  const bytes = sessionBuffer(cwdA)
  await writeSession(home, projectKey(cwdA), 'session-dup', bytes)
  await writeSession(home, projectKey(cwdB), 'session-dup', bytes)
  const [target] = await engine.upsertTarget({ name: 'backup', path: backup })

  const preview = await engine.preview({ targetId: target.id, scopeIds: ['sessions'], direction: 'push' })
  assert.equal(preview.summary.upload, 1, JSON.stringify(preview.summary))
  assert.equal(preview.sessionDuplicates.length, 1)
  assert.equal(preview.sessionDuplicates[0].sessionId, 'session-dup')
  assert.equal(preview.sessionDuplicates[0].localProjectDirs.length, 2)

  const result = await engine.sync({ targetId: target.id, scopeIds: ['sessions'], direction: 'push' })
  assert.equal(result.summary.uploaded, 1)
  const settings = await engine.getSettings()
  const manifest = await readManifest(backup, settings.deviceId, target.prefix)
  const dirs = sessionProjectDirs(manifest.scopes.sessions.files, 'session-dup')
  assert.equal(dirs.length, 1, `expected one canonical directory, got ${dirs.join(', ')}`)
})

test('append-only sessions fast-forward instead of conflicting', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-append-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const { engine, home, backup, stateRoot } = await newEngine(root)
  const cwd = join(root, 'workspace')
  await fsp.mkdir(cwd, { recursive: true })
  await writeSession(home, projectKey(cwd), 'session-1', sessionBuffer(cwd, ['one']))
  const [target] = await engine.upsertTarget({ name: 'backup', path: backup })
  await engine.sync({ targetId: target.id, scopeIds: ['sessions'], direction: 'push' })

  // Drop the base record so both sides look "changed" to the planner: only the
  // byte-prefix relation can then tell a fast-forward from a fork.
  await fsp.rm(join(stateRoot, 'state', target.id, 'base-manifest.json'), { force: true })
  await writeSession(home, projectKey(cwd), 'session-1', sessionBuffer(cwd, ['one', 'two']))
  const result = await engine.sync({ targetId: target.id, scopeIds: ['sessions'], direction: 'both' })
  assert.equal(result.summary.uploaded, 1, JSON.stringify(result.summary))
  assert.equal(result.summary.conflicts, 0, JSON.stringify(result.summary))
  const settings = await engine.getSettings()
  const manifest = await readManifest(backup, settings.deviceId, target.prefix)
  const rel = Object.keys(manifest.scopes.sessions.files)[0]
  const blob = await fsp.readFile(join(backup, target.prefix, 'blobs', manifest.scopes.sessions.files[rel].sha256.slice(0, 2), manifest.scopes.sessions.files[rel].sha256.slice(2, 4), manifest.scopes.sessions.files[rel].sha256))
  assert.equal(sha256(blob), sha256(sessionBuffer(cwd, ['one', 'two'])))
})

test('forked appends stay a conflict and keep both copies', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-fork-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  const cwdA = join(root, 'a', 'workspace')
  await fsp.mkdir(cwdA, { recursive: true })
  await writeSession(a.home, projectKey(cwdA), 'session-1', sessionBuffer(cwdA, ['one']))
  const [targetA] = await a.engine.upsertTarget({ name: 'backup', path: a.backup })
  await a.engine.sync({ targetId: targetA.id, scopeIds: ['sessions'], direction: 'push' })

  const b = await newEngine(join(root, 'b'))
  const cwdB = join(root, 'b', 'workspace')
  await fsp.mkdir(cwdB, { recursive: true })
  const [targetB] = await b.engine.upsertTarget({ name: 'backup', path: a.backup })
  await b.engine.sync({ targetId: targetB.id, scopeIds: ['sessions'], direction: 'pull' })
  // B appends its own frame and pushes it.
  await writeSession(b.home, Object.keys((await fsp.readdir(join(b.home, 'sessions'))).reduce((acc, name) => ({ ...acc, [name]: true }), {}))[0], 'session-1', sessionBuffer(cwdB, ['one', 'b']))
  await b.engine.sync({ targetId: targetB.id, scopeIds: ['sessions'], direction: 'push' })

  // A appends a different frame locally; no base update on A's side.
  await fsp.rm(join(a.stateRoot, 'state', targetA.id, 'base-manifest.json'), { force: true })
  await writeSession(a.home, projectKey(cwdA), 'session-1', sessionBuffer(cwdA, ['one', 'a']))
  const result = await a.engine.sync({ targetId: targetA.id, scopeIds: ['sessions'], direction: 'both' })
  assert.equal(result.summary.conflicts, 1, JSON.stringify(result.summary))
  const dir = join(a.home, 'sessions', projectKey(cwdA), 'session-1')
  const names = await fsp.readdir(dir)
  assert.ok(names.some((name) => name.includes('.conflict-')), names.join(', '))
  assert.equal(readSessionHeader(await fsp.readFile(join(dir, 'session.v4.jsonl.zstd'))).header.cwd, cwdA)
})

test('compareSessions reports same / append / newer / divergent / one-sided rows', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-compare-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  const cwdA = join(root, 'a', 'workspace')
  await fsp.mkdir(cwdA, { recursive: true })
  const v1 = sessionBuffer(cwdA, ['one'])
  await writeSession(a.home, projectKey(cwdA), 'session-1', v1)
  const [targetA] = await a.engine.upsertTarget({ name: 'backup', path: a.backup })
  await a.engine.sync({ targetId: targetA.id, scopeIds: ['sessions'], direction: 'push' })

  const same = await a.engine.compareSessions({ targetId: targetA.id, osUser: 'alice' })
  assert.equal(same.rows.length, 1)
  assert.equal(same.rows[0].status, 'same')
  assert.equal(same.sessionPathKey, `${(await a.engine.getSettings()).deviceName}|alice`)

  const v2 = sessionBuffer(cwdA, ['one', 'two'])
  await writeSession(a.home, projectKey(cwdA), 'session-1', v2)
  const ahead = await a.engine.compareSessions({ targetId: targetA.id })
  assert.equal(ahead.rows[0].status, 'local-ahead')
  assert.equal(ahead.rows[0].appendOnly, 'local')
  assert.equal(ahead.rows[0].recommended, 'backup')

  // Push v2, then append on the backup side through a second machine.
  await a.engine.sync({ targetId: targetA.id, scopeIds: ['sessions'], direction: 'push' })
  const b = await newEngine(join(root, 'b'))
  const cwdB = join(root, 'b', 'workspace')
  await fsp.mkdir(cwdB, { recursive: true })
  const [targetB] = await b.engine.upsertTarget({ name: 'backup', path: a.backup })
  await b.engine.sync({ targetId: targetB.id, scopeIds: ['sessions'], direction: 'pull' })
  const [bProject] = (await fsp.readdir(join(b.home, 'sessions'))).filter((name) => !name.startsWith('.'))
  const bFile = join(b.home, 'sessions', bProject, 'session-1', 'session.v4.jsonl.zstd')
  const bCurrent = await fsp.readFile(bFile)
  await fsp.writeFile(bFile, Buffer.concat([
    bCurrent,
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'event', event: 'b' }) + '\n')),
  ]))
  await b.engine.sync({ targetId: targetB.id, scopeIds: ['sessions'], direction: 'push' })

  const behind = await a.engine.compareSessions({ targetId: targetA.id })
  assert.equal(behind.rows[0].status, 'backup-ahead')
  assert.equal(behind.rows[0].appendOnly, 'backup')
  assert.equal(behind.rows[0].recommended, 'local')

  // A local fork: same prefix, different tail -> divergent.
  await fsp.rm(join(a.stateRoot, 'state', targetA.id, 'base-manifest.json'), { force: true })
  await writeSession(a.home, projectKey(cwdA), 'session-1', sessionBuffer(cwdA, ['one', 'two', 'a']))
  const divergent = await a.engine.compareSessions({ targetId: targetA.id })
  assert.equal(divergent.rows[0].status, 'divergent')
  assert.equal(divergent.rows[0].recommended, 'choose')

  // One-sided sessions: local-only and backup-only.
  const cwdC = join(root, 'a', 'workspace-c')
  await fsp.mkdir(cwdC, { recursive: true })
  await writeSession(a.home, projectKey(cwdC), 'session-local', sessionBuffer(cwdC))
  await fsp.rm(join(a.home, 'sessions', projectKey(cwdA), 'session-1'), { recursive: true, force: true })
  const mixed = await a.engine.compareSessions({ targetId: targetA.id })
  const byId = new Map(mixed.rows.map((row) => [row.sessionId, row]))
  assert.equal(byId.get('session-local').status, 'local-only')
  assert.equal(byId.get('session-1').status, 'backup-only')
})

test('syncSessionsToBackup pushes a session and restoreSessionsFromBackup rebuilds it', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-restore-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  const cwdA = join(root, 'a', 'workspace')
  await fsp.mkdir(cwdA, { recursive: true })
  const bytes = sessionBuffer(cwdA, ['one', 'two'])
  await writeSession(a.home, projectKey(cwdA), 'session-1', bytes)
  const [targetA] = await a.engine.upsertTarget({ name: 'backup', path: a.backup })
  await a.engine.saveSettings({ scopes: { sessions: { mode: 'selected', selectedSessionIds: ['session-1'] } } })
  const pushed = await a.engine.syncSessions({ targetId: targetA.id, sessionIds: ['session-1'], confirm: true })
  assert.equal(pushed.sessions, 1)
  assert.equal(pushed.files, 1)
  assert.ok(pushed.uploaded >= 1)

  const b = await newEngine(join(root, 'b'))
  const cwdB = join(root, 'b', 'workspaces')
  await fsp.mkdir(cwdB, { recursive: true })
  const [targetB] = await b.engine.upsertTarget({ name: 'restore', path: a.backup })
  const backupListing = await b.engine.listBackupSessions({ targetId: targetB.id })
  assert.equal(backupListing.sessions.length, 1)
  assert.equal(backupListing.sessions[0].sessionId, 'session-1')

  await assert.rejects(
    b.engine.restoreSessions({ targetId: targetB.id, sessionIds: ['session-1'], targetPath: cwdB }),
    /确认/,
  )
  await assert.rejects(
    b.engine.restoreSessions({ targetId: targetB.id, sessionIds: ['session-1'], targetPath: 'relative/dir', confirm: true }),
    /绝对路径/,
  )

  const restored = await b.engine.restoreSessions({
    targetId: targetB.id,
    sessionIds: ['session-1'],
    targetPath: cwdB,
    confirm: true,
    osUser: 'bob',
  })
  assert.equal(restored.restored, 1)
  assert.equal(restored.restartRequired, true)
  const session = restored.sessions[0]
  // A single-session restore uses the target path verbatim.
  const expectedCwd = cwdB
  assert.equal(session.cwd, expectedCwd)
  const restoredFile = join(b.home, 'sessions', projectKey(expectedCwd), 'session-1', 'session.v4.jsonl.zstd')
  const restoredBytes = await fsp.readFile(restoredFile)
  assert.notEqual(sha256(restoredBytes), sha256(bytes), 'header cwd must be rewritten')
  assert.equal(readSessionHeader(restoredBytes).header.cwd, expectedCwd)
  const settingsB = await b.engine.getSettings()
  assert.equal(settingsB.sessionPaths[`${settingsB.deviceName}|bob`]['session-1'], expectedCwd)

  // Compare now reports the restored copy as identical.
  const compared = await b.engine.compareSessions({ targetId: targetB.id, osUser: 'bob' })
  assert.equal(compared.rows[0].status, 'same')

  // A second restore must move the existing copy into the local backup folder
  // instead of leaving two copies of the same session id behind.
  const copyCwd = join(root, 'b', 'another-workspace')
  await fsp.mkdir(copyCwd, { recursive: true })
  const duplicateDir = join(b.home, 'sessions', projectKey(copyCwd), 'session-1')
  await fsp.mkdir(duplicateDir, { recursive: true })
  await fsp.writeFile(join(duplicateDir, 'session.v4.jsonl.zstd'), sessionBuffer(copyCwd))
  const again = await b.engine.restoreSessions({
    targetId: targetB.id,
    sessionIds: ['session-1'],
    targetPath: cwdB,
    confirm: true,
    osUser: 'bob',
  })
  assert.equal(again.restored, 1)
  assert.ok(again.sessions[0].backedUp.length >= 2, JSON.stringify(again.sessions[0].backedUp))
  assert.ok(again.backupRoot)
  const ids = []
  for (const project of await fsp.readdir(join(b.home, 'sessions'))) {
    if (project.startsWith('.')) continue
    const entries = await fsp.readdir(join(b.home, 'sessions', project)).catch(() => [])
    if (entries.includes('session-1')) ids.push(project)
  }
  assert.deepEqual(ids, [projectKey(expectedCwd)])
})

test('restore honours autoReplaceUserFolder and overwrite both directions', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-replace-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await newEngine(join(root, 'a'))
  const originalCwd = 'C:\\Users\\olduser\\projects\\demo'
  const sessionPath = await writeSession(a.home, projectKey(originalCwd), 'session-old', sessionBuffer(originalCwd))
  assert.ok(sessionPath)
  const [targetA] = await a.engine.upsertTarget({ name: 'backup', path: a.backup })
  await a.engine.syncSessions({ targetId: targetA.id, sessionIds: ['session-old'], confirm: true })

  const b = await newEngine(join(root, 'b'))
  const [targetB] = await b.engine.upsertTarget({ name: 'restore', path: a.backup })

  // autoReplace off: the recorded path is kept as-is.
  const kept = await b.engine.restoreSessions({ targetId: targetB.id, sessionIds: ['session-old'], confirm: true, osUser: 'alice' })
  assert.equal(kept.sessions[0].cwd, originalCwd)

  // autoReplace on: the old user folder becomes the current one.
  const currentRoot = userRootOf(homedir()) || homedir()
  const replaced = await b.engine.restoreSessions({
    targetId: targetB.id,
    sessionIds: ['session-old'],
    confirm: true,
    osUser: 'alice',
    autoReplaceUserFolder: true,
  })
  assert.equal(replaced.sessions[0].cwd, joinPathLike(currentRoot, '\\projects\\demo'))

  // Overwrite local from backup again after a local edit.
  const localFile = join(b.home, 'sessions', projectKey(replaced.sessions[0].cwd), 'session-old', 'session.v4.jsonl.zstd')
  await fsp.writeFile(localFile, sessionBuffer(replaced.sessions[0].cwd, ['local-edit']))
  const overwritten = await b.engine.overwriteSessions({
    targetId: targetB.id,
    sessionIds: ['session-old'],
    side: 'local',
    confirm: true,
    osUser: 'alice',
  })
  assert.equal(overwritten.restored, 1)
  const finalBytes = await fsp.readFile(localFile)
  assert.notEqual(sha256(finalBytes), sha256(sessionBuffer(replaced.sessions[0].cwd, ['local-edit'])))

  // Overwrite the backup with the local copy.
  await fsp.writeFile(localFile, sessionBuffer(replaced.sessions[0].cwd, ['local-new']))
  await b.engine.overwriteSessions({
    targetId: targetB.id,
    sessionIds: ['session-old'],
    side: 'backup',
    confirm: true,
    osUser: 'alice',
  })
  const settingsB = await b.engine.getSettings()
  const manifest = await readManifest(a.backup, settingsB.deviceId, targetA.prefix)
  const rel = Object.keys(manifest.scopes.sessions.files).find((key) => key.includes('session-old'))
  const entry = manifest.scopes.sessions.files[rel]
  const blob = await fsp.readFile(join(a.backup, targetA.prefix, 'blobs', entry.sha256.slice(0, 2), entry.sha256.slice(2, 4), entry.sha256))
  assert.equal(sha256(blob), sha256(await fsp.readFile(localFile)))
})

test('listLocalSessionData groups copies and reads headers without the full file', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-localdata-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const { home } = await newEngine(root)
  const cwdA = join(root, 'a')
  const cwdB = join(root, 'b')
  await fsp.mkdir(cwdA, { recursive: true })
  await fsp.mkdir(cwdB, { recursive: true })
  await writeSession(home, projectKey(cwdA), 'session-1', sessionBuffer(cwdA, ['one']))
  await writeSession(home, projectKey(cwdB), 'session-1', sessionBuffer(cwdB, ['one', 'two']))
  const sessions = await listLocalSessionData(join(home, 'sessions'))
  const session = sessions.get('session-1')
  assert.equal(session.copies.length, 2)
  assert.deepEqual(session.copies.map((copy) => copy.cwd).sort(), [cwdA, cwdB].sort())
})
