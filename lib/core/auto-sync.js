/**
 * Scheduled (automatic) sync.
 *
 * The scheduler is deliberately separate from the timer: `tick()` is a pure
 * decision plus one sequential run over enabled targets, so it can be tested
 * with a fake clock and a fake engine. The host calls `tick()` on an interval.
 */

import { SyncError } from './errors.js'

export const MIN_AUTO_SYNC_MINUTES = 15
export const MAX_AUTO_SYNC_MINUTES = 1440

/** Normalized interval in milliseconds (15 min .. 24 h). */
export function autoSyncIntervalMs(settings) {
  const raw = Number(settings?.autoSync?.intervalMinutes)
  const minutes = Number.isFinite(raw) ? raw : 60
  return Math.min(MAX_AUTO_SYNC_MINUTES, Math.max(MIN_AUTO_SYNC_MINUTES, minutes)) * 60_000
}

/** Public status for the settings UI. */
export function autoSyncStatus(settings, state, now = Date.now()) {
  const enabled = settings?.autoSync?.enabled === true
  const intervalMs = autoSyncIntervalMs(settings)
  const anchorIso = state?.lastRunAt ?? state?.baselineAt ?? null
  const anchor = anchorIso ? Date.parse(anchorIso) : Number.NaN
  return {
    enabled,
    intervalMinutes: intervalMs / 60_000,
    lastRunAt: state?.lastRunAt ?? null,
    nextAt: enabled && Number.isFinite(anchor) ? new Date(anchor + intervalMs).toISOString() : null,
    lastResults: Array.isArray(state?.lastResults) ? state.lastResults : [],
  }
}

/**
 * Decide whether a sync is due and, if so, run it for every enabled target.
 *
 * Behaviour:
 * - disabled -> no run;
 * - enabled but no baseline yet -> record `baselineAt` and wait one interval
 *   (enabling auto sync never triggers an immediate surprise sync);
 * - due but a manual/other run is active -> skip (`busy`);
 * - due -> sequential sync of enabled targets, then persist `lastRunAt`.
 */
export class AutoSyncScheduler {
  constructor({ engine, store, now = () => Date.now(), isBusy = () => false, onEvent = () => {}, runSync = null }) {
    this.engine = engine
    this.store = store
    this.now = now
    this.isBusy = isBusy
    this.onEvent = onEvent
    this.runSync = runSync
  }

  /** One sync of one target; the host replaces this to expose a run for progress UI. */
  async syncTarget(options) {
    if (typeof this.runSync === 'function') return await this.runSync(options)
    return await this.engine.sync(options)
  }

  async tick() {
    const settings = await this.engine.getSettings()
    const state = (await this.store.loadAutoSyncState()) ?? {}
    const nowMs = this.now()
    const status = autoSyncStatus(settings, state, nowMs)

    if (settings.autoSync?.enabled !== true) {
      return { run: false, reason: 'disabled', status }
    }

    const anchorIso = state.lastRunAt ?? state.baselineAt
    if (!anchorIso) {
      state.baselineAt = new Date(nowMs).toISOString()
      await this.store.saveAutoSyncState(state)
      return { run: false, reason: 'baseline', status: autoSyncStatus(settings, state, nowMs) }
    }

    if (nowMs - Date.parse(anchorIso) < autoSyncIntervalMs(settings)) {
      return { run: false, reason: 'not-due', status }
    }
    if (this.isBusy()) {
      return { run: false, reason: 'busy', status }
    }

    const targets = settings.targets.filter((target) => target.enabled !== false)
    if (targets.length === 0) {
      state.lastRunAt = new Date(nowMs).toISOString()
      await this.store.saveAutoSyncState(state)
      return { run: false, reason: 'no-targets', status: autoSyncStatus(settings, state, nowMs) }
    }

    return await this.runTargets(settings, state, targets, nowMs)
  }

  /**
   * Run one scheduled pass immediately (UI "run now"). The interval and
   * baseline are ignored, but the busy guard still applies.
   */
  async runNow() {
    const settings = await this.engine.getSettings()
    if (settings.autoSync?.enabled !== true) {
      return { run: false, reason: 'disabled', status: autoSyncStatus(settings, null, this.now()) }
    }
    if (this.isBusy()) {
      return { run: false, reason: 'busy', status: autoSyncStatus(settings, await this.store.loadAutoSyncState(), this.now()) }
    }
    const state = (await this.store.loadAutoSyncState()) ?? {}
    const targets = settings.targets.filter((target) => target.enabled !== false)
    if (targets.length === 0) {
      return { run: false, reason: 'no-targets', status: autoSyncStatus(settings, state, this.now()) }
    }
    return await this.runTargets(settings, state, targets, this.now())
  }

  async runTargets(settings, state, targets, nowMs) {
    const results = []
    for (const target of targets) {
      try {
        const options = { targetId: target.id, direction: settings.direction }
        // Unattended runs cannot answer an interactive deletion prompt: skip
        // deletions instead of guessing.
        if (settings.deleteMode === 'ask') options.deleteChoice = 'ignore'
        const result = await this.syncTarget(options)
        results.push({ targetId: target.id, name: target.name, ok: true, summary: result.summary })
      } catch (error) {
        results.push({
          targetId: target.id,
          name: target.name,
          ok: false,
          error: {
            code: error?.code ?? 'error',
            message: String(error?.message ?? error),
          },
        })
      }
    }

    state.lastRunAt = new Date(this.now()).toISOString()
    state.lastResults = results
    await this.store.saveAutoSyncState(state)
    const outcome = { run: true, results, status: autoSyncStatus(settings, state, this.now()) }
    try {
      this.onEvent({ type: 'auto-sync', ...outcome })
    } catch {
      // Listener failures must not break the schedule.
    }
    return outcome
  }
}
