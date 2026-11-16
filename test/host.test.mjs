import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function mockRequest({ url, method = 'POST', payload = {}, remote = '127.0.0.1', host = '127.0.0.1:58770' }) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    url,
    method,
    socket: { remoteAddress: remote },
    headers: { host, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body
    },
  }
}

test('host registers routes and answers loopback JSON envelopes', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-host-'))
  const previousDsh = process.env.DSH_HOME
  const previousAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = join(root, 'home')
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  await fsp.mkdir(join(root, 'home'), { recursive: true })
  await fsp.mkdir(join(root, 'agents'), { recursive: true })
  t.after(async () => {
    if (previousDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDsh
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgents
    await fsp.rm(root, { recursive: true, force: true })
  })

  const routes = []
  const disposers = []
  const agentTools = []
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
      const scope = {
        tools: {
          register(definition) {
            agentTools.push(definition)
            return () => {}
          },
        },
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
      }
      callback(scope)
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
  t.after(() => {
    // The plugin registers an auto-sync interval; dispose it so the test
    // process can exit.
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/dsh-sync')
  assert.deepEqual(
    agentTools.map((tool) => tool.name).sort(),
    [
      'dsh_sync_custom_item_add',
      'dsh_sync_custom_item_list',
      'dsh_sync_custom_item_remove',
      'dsh_sync_custom_item_update',
    ]
  )

  const call = async (endpoint, payload) => {
    const response = mockResponse()
    await routes[0].handler(mockRequest({ url: `/dsh-sync/${endpoint}`, payload }), response)
    assert.equal(response.status, 200, response.body)
    const parsed = JSON.parse(response.body)
    assert.equal(parsed.ok, true, response.body)
    return parsed.value
  }

  const status = await call('status', {})
  assert.equal(status.version, '0.3.0')
  assert.equal(status.sidebarProgressMode, 'running')
  assert.equal(status.pendingRefreshSeconds, 600)

  const listing = await call('fs.listDirs', { path: root })
  assert.equal(listing.path, root)
  assert.ok(Array.isArray(listing.dirs))
  const inspected = await call('fs.statPath', { path: join(root, 'home') })
  assert.equal(inspected.exists, true)
  assert.equal(inspected.type, 'dir')

  // Agent tools manage custom dir/file items through the same engine settings.
  const customDir = join(root, 'custom-dir')
  await fsp.mkdir(customDir, { recursive: true })
  const addTool = agentTools.find((tool) => tool.name === 'dsh_sync_custom_item_add')
  const listTool = agentTools.find((tool) => tool.name === 'dsh_sync_custom_item_list')
  const updateTool = agentTools.find((tool) => tool.name === 'dsh_sync_custom_item_update')
  const removeTool = agentTools.find((tool) => tool.name === 'dsh_sync_custom_item_remove')

  const added = await addTool.execute({ name: 'agent-dir', type: 'dir', path: customDir }, {})
  assert.equal(added.item.name, 'agent-dir')
  assert.equal(added.item.type, 'dir')
  const listed = await listTool.execute({}, {})
  assert.equal(listed.count, 1)
  const updated = await updateTool.execute({ idOrName: 'agent-dir', name: 'agent-dir-2' }, {})
  assert.equal(updated.item.name, 'agent-dir-2')
  const removed = await removeTool.execute({ idOrName: 'agent-dir-2' }, {})
  assert.equal(removed.removed.name, 'agent-dir-2')
  const afterRemove = await listTool.execute({}, {})
  assert.equal(afterRemove.count, 0)

  const backupPath = join(root, 'backup')
  const upserted = await call('targets.upsert', { target: { name: 'backup', path: backupPath } })
  assert.equal(upserted.targets.length, 1)
  const targetId = upserted.targets[0].id

  const tested = await call('targets.test', { target: { kind: 'local', path: backupPath } })
  assert.equal(tested.ok, true)

  const estimate = await call('scopes.estimate', { targetId })
  assert.ok(Array.isArray(estimate.scopes))
  assert.ok(estimate.scopes.length >= 5)

  const preview = await call('preview', { targetId, scopeIds: ['agents-md'], direction: 'push' })
  assert.ok(preview.summary)

  // Status carries the live-run slot and auto-sync status for the sidebar/UI.
  const statusBefore = await call('status', {})
  assert.equal(statusBefore.activeRun, null)
  assert.equal(statusBefore.pendingDecision, null)
  assert.equal(statusBefore.autoSync.enabled, false)

  const decision = await call('decision.set', {
    targetId,
    scopeIds: ['agents-md'],
    direction: 'both',
    total: 3,
    localMissing: 2,
    remoteMissing: 1,
  })
  assert.equal(decision.total, 3)
  const statusPending = await call('status', {})
  assert.equal(statusPending.pendingDecision.total, 3)
  assert.equal(statusPending.pendingDecision.localMissing, 2)
  await call('decision.clear', {})
  const statusCleared = await call('status', {})
  assert.equal(statusCleared.pendingDecision, null)

  const saved = await call('settings.save', {
    patch: {
      autoSync: { enabled: true, intervalMinutes: 30 },
      sidebarProgressMode: 'always',
      pendingRefreshSeconds: 300,
      sessionPathMappings: { 'C:\\Users\\old\\': 'C:\\Users\\new\\', '': 'C:\\Users\\ignored' },
    },
  })
  assert.equal(saved.settings.autoSync.enabled, true)
  assert.equal(saved.settings.autoSync.intervalMinutes, 30)
  assert.equal(saved.settings.sidebarProgressMode, 'always')
  assert.equal(saved.settings.pendingRefreshSeconds, 300)
  assert.deepEqual(saved.settings.sessionPathMappings, { 'C:\\Users\\old': 'C:\\Users\\new' })
  const statusAfter = await call('status', {})
  assert.equal(statusAfter.autoSync.enabled, true)
  assert.equal(statusAfter.autoSync.intervalMinutes, 30)
  assert.equal(statusAfter.sidebarProgressMode, 'always')
  assert.equal(statusAfter.pendingRefreshSeconds, 300)

  const invalidMode = await call('settings.save', { patch: { sidebarProgressMode: 'bogus', pendingRefreshSeconds: -5 } })
  assert.equal(invalidMode.settings.sidebarProgressMode, 'running')
  assert.equal(invalidMode.settings.pendingRefreshSeconds, 600)

  const { runId } = await call('sync', { targetId, scopeIds: ['agents-md'], direction: 'push' })
  let run
  for (let attempt = 0; attempt < 50; attempt += 1) {
    run = await call('runs.get', { id: runId })
    if (run.state !== 'running' && run.state !== 'cancelling') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(run.state, 'succeeded', JSON.stringify(run))

  // Non-loopback callers are rejected.
  const forbidden = mockResponse()
  await routes[0].handler(
    mockRequest({ url: '/dsh-sync/status', payload: {}, remote: '192.168.1.10' }),
    forbidden,
  )
  assert.equal(forbidden.status, 403)
})
