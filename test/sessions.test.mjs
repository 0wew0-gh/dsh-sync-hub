import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  dedupeSessions,
  listSessionGroups,
  projectKey,
  readSessionHeader,
  relocateSessionGroup,
  relocateUserGroups,
  rewriteSessionCwd,
  userRootOf,
} from '../lib/core/sessions.js'

function sessionBuffer(cwd, extra = '{"type":"event"}\n') {
  const header = { type: 'session', version: 4, id: 'session-test', createdAt: 1700000000000, cwd }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')),
    zstdCompressSync(Buffer.from(extra)),
  ])
}

test('projectKey matches the DSH session directory encoding', () => {
  assert.equal(projectKey('D:\\object\\agents\\sync'), '--D-object-agents-sync--')
  assert.equal(projectKey('C:\\Users\\wangyi\\.agents'), '--C-Users-wangyi-.agents--')
  assert.equal(projectKey('D:\\object\\C#\\Gas Calibration'), '--D-object-C~0023-Gas~0020Calibration--')
})

test('rewriteSessionCwd replaces only the header frame', () => {
  const original = sessionBuffer('C:\\old\\workspace')
  const rewritten = rewriteSessionCwd(original, 'D:\\new\\workspace')
  assert.equal(readSessionHeader(rewritten).header.cwd, 'D:\\new\\workspace')
  // Every byte after the first frame is preserved.
  const frameBytes = readSessionHeader(original).frameBytes
  assert.deepEqual(
    rewritten.subarray(rewritten.length - (original.length - frameBytes)),
    original.subarray(frameBytes)
  )
})

test('listSessionGroups reports cwd existence and relocate moves the group', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-store-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const sessionsDir = join(root, 'sessions')
  const oldCwd = join(root, 'old-workspace')
  const newCwd = join(root, 'new-workspace')
  await fsp.mkdir(oldCwd, { recursive: true })
  await fsp.mkdir(newCwd, { recursive: true })

  const oldDir = join(sessionsDir, projectKey(oldCwd), 'session-test')
  await fsp.mkdir(oldDir, { recursive: true })
  await fsp.writeFile(join(oldDir, 'session.v4.jsonl.zstd'), sessionBuffer(oldCwd))

  const before = await listSessionGroups(sessionsDir)
  assert.equal(before.groups.length, 1)
  assert.equal(before.groups[0].cwd, oldCwd)
  assert.equal(before.groups[0].exists, true)
  assert.equal(before.groups[0].sessions.length, 1)

  const result = await relocateSessionGroup({ sessionsDir, dirName: before.groups[0].dirName, newCwd, confirm: true })
  assert.equal(result.moved, 1)
  assert.equal(result.dirName, projectKey(newCwd))
  await assert.rejects(fsp.access(oldDir))
  const movedFile = join(sessionsDir, projectKey(newCwd), 'session-test', 'session.v4.jsonl.zstd')
  const header = readSessionHeader(await fsp.readFile(movedFile))
  assert.equal(header.header.cwd, newCwd)

  const after = await listSessionGroups(sessionsDir)
  assert.equal(after.groups.length, 1)
  assert.equal(after.groups[0].cwd, newCwd)
  assert.equal(after.groups[0].exists, true)
})

test('listSessionGroups flags a missing workspace directory', async (t) => {  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-missing-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const sessionsDir = join(root, 'sessions')
  const missingCwd = join(root, 'not-restored-workspace')
  const dir = join(sessionsDir, projectKey(missingCwd), 'session-missing')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBuffer(missingCwd))

  const result = await listSessionGroups(sessionsDir)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].cwd, missingCwd)
  assert.equal(result.groups[0].exists, false)
})

test('userRootOf extracts a Windows user root', () => {
  assert.equal(userRootOf('C:\\Users\\alice\\Downloads'), 'C:\\Users\\alice')
  assert.equal(userRootOf('D:\\Users\\bob'), 'D:\\Users\\bob')
  assert.equal(userRootOf('D:\\projects\\demo'), '')
})

test('relocateUserGroups mirrors an old user root onto a new one', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-batch-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const sessionsDir = join(root, 'sessions')
  const fromRoot = join(root, 'Users', 'old')
  const toRoot = join(root, 'Users', 'new')
  const oldDownloads = join(fromRoot, 'Downloads')
  const oldAgents = join(fromRoot, '.agents')
  await fsp.mkdir(oldDownloads, { recursive: true })
  await fsp.mkdir(oldAgents, { recursive: true })
  await fsp.mkdir(toRoot, { recursive: true })

  for (const [cwd, id] of [[oldDownloads, 'session-a'], [oldAgents, 'session-b']]) {
    const dir = join(sessionsDir, projectKey(cwd), id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBuffer(cwd))
  }

  const before = await listSessionGroups(sessionsDir)
  assert.equal(before.groups.length, 2)

  const result = await relocateUserGroups({ sessionsDir, fromPrefix: fromRoot, toPrefix: toRoot, confirm: true })
  assert.equal(result.selected, 2)
  assert.equal(result.moved, 2)
  assert.equal(result.failed.length, 0)

  const after = await listSessionGroups(sessionsDir)
  assert.equal(after.groups.length, 2)
  const cwds = after.groups.map((group) => group.cwd).sort()
  assert.deepEqual(cwds, [join(toRoot, '.agents'), join(toRoot, 'Downloads')].sort())
  for (const group of after.groups) {
    assert.equal(group.exists, true)
    const file = join(sessionsDir, group.dirName, group.sessions[0].id, 'session.v4.jsonl.zstd')
    assert.equal(readSessionHeader(await fsp.readFile(file)).header.cwd, group.cwd)
  }
})

test('relocateSessionGroup requires confirmation and never duplicates a session', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-confirm-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sessionsDir = join(root, 'sessions')
  const oldCwd = join(root, 'old')
  const newCwd = join(root, 'new')
  await fsp.mkdir(oldCwd, { recursive: true })
  await fsp.mkdir(newCwd, { recursive: true })
  const oldDir = join(sessionsDir, projectKey(oldCwd), 'session-a')
  await fsp.mkdir(oldDir, { recursive: true })
  await fsp.writeFile(join(oldDir, 'session.v4.jsonl.zstd'), sessionBuffer(oldCwd))

  await assert.rejects(
    relocateSessionGroup({ sessionsDir, dirName: projectKey(oldCwd), newCwd }),
    /请先确认/
  )
  await relocateSessionGroup({ sessionsDir, dirName: projectKey(oldCwd), newCwd, confirm: true })
  const after = await listSessionGroups(sessionsDir)
  assert.equal(after.groups.length, 1)
  assert.equal(after.groups[0].cwd, newCwd)
  assert.equal(after.duplicates.length, 0)
  await assert.rejects(fsp.access(oldDir))
})

test('dedupeSessions quarantines duplicate session ids', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-session-dedupe-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const sessionsDir = join(root, 'sessions')
  const cwdA = join(root, 'workspace-a')
  const cwdB = join(root, 'workspace-b')
  await fsp.mkdir(cwdA, { recursive: true })
  await fsp.mkdir(cwdB, { recursive: true })
  for (const cwd of [cwdA, cwdB]) {
    const dir = join(sessionsDir, projectKey(cwd), 'session-dup')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBuffer(cwd))
  }

  const before = await listSessionGroups(sessionsDir)
  assert.equal(before.duplicates.length, 1)
  const result = await dedupeSessions({ sessionsDir })
  assert.equal(result.moved, 1)
  assert.ok(result.backupRoot)
  const after = await listSessionGroups(sessionsDir)
  assert.equal(after.duplicates.length, 0)
  assert.equal(after.groups.length, 1)
})
