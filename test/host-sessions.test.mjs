import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../lib/index.js'

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(data) {
      this.body = data ? data.toString('utf8') : ''
    },
  }
}

function mockRequest({ url, method = 'POST', payload = {} }) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    url,
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:58770', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body
    },
  }
}

function sessionBuffer(cwd, events = ['one']) {
  const header = { type: 'session', version: 4, id: 'session-test', createdAt: 1700000000000, cwd }
  const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))]
  for (const event of events) {
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify({ type: 'event', event }) + '\n')))
  }
  return Buffer.concat(frames)
}

async function writeSession(home, projectDir, sessionId, buffer) {
  const dir = join(home, 'sessions', projectDir, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), buffer)
}

test('host exposes session selection, per-session paths and transfer endpoints', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-host-sessions-'))
  const previousDsh = process.env.DSH_HOME
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = join(root, 'home')
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  await fsp.mkdir(join(root, 'home'), { recursive: true })
  await fsp.mkdir(join(root, 'agents'), { recursive: true })
  const workspace = join(root, 'workspace')
  await fsp.mkdir(workspace, { recursive: true })
  await writeSession(join(root, 'home'), '--D-demo--', 'session-1', sessionBuffer(workspace))

  const routes = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get(name) {
      return name === 'webServer' ? ctx.webServer : undefined
    },
    inject(_deps, callback) {
      callback({
        tools: { register() { return () => {} } },
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
          return () => {}
        },
        get() {
          return undefined
        },
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
      })
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx)
  t.after(async () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
    if (previousDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDsh
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgents
    await fsp.rm(root, { recursive: true, force: true })
  })

  const call = async (endpoint, payload) => {
    const response = mockResponse()
    await routes[0].handler(mockRequest({ url: `/dsh-sync/${endpoint}`, payload }), response)
    const parsed = JSON.parse(response.body)
    return { status: response.status, ...parsed }
  }
  const ok = async (endpoint, payload) => {
    const value = await call(endpoint, payload)
    assert.equal(value.status, 200, JSON.stringify(value))
    assert.equal(value.ok, true, JSON.stringify(value))
    return value.value
  }

  const status = await ok('status', {})
  assert.equal(typeof status.osUser, 'string')
  assert.equal(typeof status.sessionPathKey, 'string')
  assert.ok(status.sessionPathKey.includes('|'), status.sessionPathKey)

  const listed = await ok('sessions.list', {})
  assert.equal(listed.groups.length, 1)
  assert.equal(listed.selection.mode, 'all')
  assert.equal(listed.selection.totalCount, 1)
  assert.equal(listed.selection.selectedCount, 1)
  assert.equal(listed.groups[0].sessions[0].selected, true)
  assert.equal(typeof listed.groups[0].suggestedCwd, 'string')

  const saved = await ok('settings.save', {
    patch: {
      scopes: { sessions: { mode: 'selected', selectedSessionIds: ['session-1', '../bad'] } },
      sessionPaths: {
        [`${status.deviceName}|${status.osUser}`]: { 'session-1': 'D:\\work\\demo', 'session-2': 'relative' },
      },
      autoReplaceUserFolder: true,
    },
  })
  assert.equal(saved.settings.scopes.sessions.mode, 'selected')
  assert.deepEqual(saved.settings.scopes.sessions.selectedSessionIds, ['session-1'])
  assert.deepEqual(saved.settings.sessionPaths, {
    [`${status.deviceName}|${status.osUser}`]: { 'session-1': 'D:\\work\\demo' },
  })
  assert.equal(saved.settings.autoReplaceUserFolder, true)

  const selectedList = await ok('sessions.list', {})
  assert.equal(selectedList.selection.mode, 'selected')
  assert.equal(selectedList.selection.unselectedCount, 0)
  assert.equal(selectedList.groups[0].sessions[0].mappedPath, 'D:\\work\\demo')
  assert.equal(selectedList.groups[0].sessions[0].selected, true)

  const backupPath = join(root, 'backup')
  const target = await ok('targets.upsert', { target: { name: 'backup', path: backupPath } })
  const targetId = target.targets[0].id

  // In selected mode without the id selected, an explicit push is rejected.
  await ok('settings.save', { patch: { scopes: { sessions: { selectedSessionIds: [] } } } })
  const notSelected = await call('sessions.sync', { targetId, sessionIds: ['session-1'], confirm: true })
  assert.equal(notSelected.ok, false)
  assert.equal(notSelected.code, 'session-not-selected')

  await ok('settings.save', { patch: { scopes: { sessions: { mode: 'all', selectedSessionIds: [] } } } })
  const pushed = await ok('sessions.sync', { targetId, sessionIds: ['session-1'], confirm: true })
  assert.equal(pushed.sessions, 1)
  assert.ok(pushed.uploaded >= 1)

  const compared = await ok('sessions.compare', { targetId })
  assert.equal(compared.rows.length, 1)
  assert.equal(compared.rows[0].status, 'same')
  assert.equal(compared.rows[0].selected, true)

  const backupListing = await ok('sessions.backup.list', { targetId })
  assert.equal(backupListing.sessions.length, 1)
  assert.equal(backupListing.sessions[0].sessionId, 'session-1')

  const badRestore = await call('sessions.restore', { targetId, sessionIds: ['session-1'], targetPath: workspace })
  assert.equal(badRestore.ok, false)
  assert.equal(badRestore.code, 'need-confirm')
  const relativeRestore = await call('sessions.restore', {
    targetId,
    sessionIds: ['session-1'],
    targetPath: 'relative-dir',
    confirm: true,
  })
  assert.equal(relativeRestore.ok, false)
  assert.equal(relativeRestore.code, 'bad-target')

  const restoredCwd = join(root, 'restored-workspace')
  const restored = await ok('sessions.restore', {
    targetId,
    sessionIds: ['session-1'],
    targetPath: restoredCwd,
    confirm: true,
  })
  assert.equal(restored.restored, 1)
  assert.equal(restored.restartRequired, true)
  assert.equal(restored.sessions[0].cwd, restoredCwd)

  const badOverwrite = await call('sessions.overwrite', { targetId, sessionIds: ['session-1'], side: 'backup' })
  assert.equal(badOverwrite.ok, false)
  assert.equal(badOverwrite.code, 'need-confirm')
  const overwritten = await ok('sessions.overwrite', {
    targetId,
    sessionIds: ['session-1'],
    side: 'backup',
    confirm: true,
  })
  assert.equal(overwritten.sessions, 1)

  // Unknown target must fail cleanly.
  const missingTarget = await call('sessions.compare', { targetId: 'missing' })
  assert.equal(missingTarget.ok, false)
  assert.equal(missingTarget.code, 'target-not-found')
})
