import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoSyncScheduler, autoSyncStatus, autoSyncIntervalMs } from '../lib/core/auto-sync.js'

function settingsWith({ enabled, intervalMinutes = 60, targets = [{ id: 't1', name: 'A', enabled: true }] }) {
  return {
    autoSync: { enabled, intervalMinutes },
    targets,
    direction: 'both',
  }
}

function createEnvironment({ settings, nowMs = 1_000_000, busy = false }) {
  const clock = { now: nowMs }
  const state = { value: null }
  const calls = []
  const engine = {
    async getSettings() {
      return settings
    },
    async sync(options) {
      calls.push(options)
      return { summary: { uploaded: 1 } }
    },
  }
  const store = {
    async loadAutoSyncState() {
      return state.value
    },
    async saveAutoSyncState(next) {
      state.value = next
      return next
    },
  }
  const scheduler = new AutoSyncScheduler({
    engine,
    store,
    now: () => clock.now,
    isBusy: () => busy,
  })
  return { scheduler, clock, state, calls }
}

test('disabled auto sync never runs', async () => {
  const env = createEnvironment({ settings: settingsWith({ enabled: false }) })
  const result = await env.scheduler.tick()
  assert.equal(result.run, false)
  assert.equal(result.reason, 'disabled')
  assert.equal(env.calls.length, 0)
})

test('first tick only records a baseline instead of running immediately', async () => {
  const env = createEnvironment({ settings: settingsWith({ enabled: true }) })
  const result = await env.scheduler.tick()
  assert.equal(result.run, false)
  assert.equal(result.reason, 'baseline')
  assert.ok(env.state.value.baselineAt)
  assert.equal(env.calls.length, 0)
})

test('runs after the interval elapses and persists lastRunAt', async () => {
  const env = createEnvironment({ settings: settingsWith({ enabled: true, intervalMinutes: 15 }) })
  await env.scheduler.tick()
  assert.equal(env.calls.length, 0)

  env.clock.now += 15 * 60_000 - 1
  assert.equal((await env.scheduler.tick()).reason, 'not-due')

  env.clock.now += 1
  const result = await env.scheduler.tick()
  assert.equal(result.run, true)
  assert.equal(env.calls.length, 1)
  assert.equal(env.calls[0].targetId, 't1')
  assert.equal(env.calls[0].direction, 'both')
  assert.ok(env.state.value.lastRunAt)
  assert.equal(env.state.value.lastResults[0].ok, true)
})

test('skips while another run is active', async () => {
  const settings = settingsWith({ enabled: true, intervalMinutes: 15 })
  const env = createEnvironment({ settings, busy: true })
  await env.scheduler.tick()
  env.clock.now += 15 * 60_000
  const result = await env.scheduler.tick()
  assert.equal(result.run, false)
  assert.equal(result.reason, 'busy')
  assert.equal(env.calls.length, 0)
})

test('syncs every enabled target sequentially and records failures', async () => {
  const settings = settingsWith({
    enabled: true,
    intervalMinutes: 15,
    targets: [
      { id: 't1', name: 'A', enabled: true },
      { id: 't2', name: 'B', enabled: false },
      { id: 't3', name: 'C', enabled: true },
    ],
  })
  const env = createEnvironment({ settings })
  await env.scheduler.tick()
  env.clock.now += 15 * 60_000
  const original = env.scheduler.engine.sync
  env.scheduler.engine.sync = async (options) => {
    if (options.targetId === 't3') throw Object.assign(new Error('boom'), { code: 'x' })
    return original(options)
  }
  const result = await env.scheduler.tick()
  assert.equal(result.run, true)
  // The failing target never reaches the wrapped fake, so only t1 is recorded.
  assert.deepEqual(env.calls.map((call) => call.targetId), ['t1'])
  const results = env.state.value.lastResults
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, true)
  assert.equal(results[1].ok, false)
  assert.equal(results[1].error.message, 'boom')
})

test('status exposes normalized interval and next time', () => {
  assert.equal(autoSyncIntervalMs({ autoSync: { intervalMinutes: 1 } }), 15 * 60_000)
  assert.equal(autoSyncIntervalMs({ autoSync: { intervalMinutes: 9999 } }), 1440 * 60_000)
  const status = autoSyncStatus(
    { autoSync: { enabled: true, intervalMinutes: 60 } },
    { lastRunAt: '2026-01-01T00:00:00.000Z' },
    Date.parse('2026-01-01T00:30:00.000Z')
  )
  assert.equal(status.enabled, true)
  assert.equal(status.intervalMinutes, 60)
  assert.equal(status.nextAt, '2026-01-01T01:00:00.000Z')
})

test('runNow ignores the interval, but respects disabled and busy', async () => {
  const disabled = createEnvironment({ settings: settingsWith({ enabled: false }) })
  assert.equal((await disabled.scheduler.runNow()).reason, 'disabled')

  const busy = createEnvironment({ settings: settingsWith({ enabled: true }), busy: true })
  assert.equal((await busy.scheduler.runNow()).reason, 'busy')

  const ready = createEnvironment({ settings: settingsWith({ enabled: true }) })
  const result = await ready.scheduler.runNow()
  assert.equal(result.run, true)
  assert.equal(ready.calls.length, 1)
  assert.ok(ready.state.value.lastRunAt)
})
