/**
 * DSH host half of the sync plugin.
 *
 * Registers a same-origin API at `/dsh-sync/*` (loopback only) and, when the
 * Connection service is available, the same endpoints over its authenticated
 * RPC channel. All filesystem work happens in `./core/engine.js`.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { SyncEngine } from './core/engine.js'
import { SyncError } from './core/errors.js'
import { AutoSyncScheduler, autoSyncStatus } from './core/auto-sync.js'
import { resolveAgentsHome, resolveDshHome } from './core/paths.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

export const name = 'dsh-sync-hub'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-sync'
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK_ADDRESSES.has(remote)) return false
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
  if (!LOOPBACK_HOSTS.has(host)) return false
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  return true
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new SyncError('body-too-large', '请求体超过 1 MB 限制')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SyncError('bad-json', '请求体不是合法 JSON')
  }
}

function runView(run) {
  return {
    id: run.id,
    kind: run.kind,
    state: run.cancelRequested && run.state === 'running' ? 'cancelling' : run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    progress: run.progress,
    summary: run.result?.summary,
    result: run.result,
    error: run.error,
  }
}

/** Wrap one agent tool definition with a JSON text renderer. */
function agentTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    timeoutMs: 30_000,
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('aborted')
      return await execute(args ?? {}, exec)
    },
  }
}

/** Convert the agent-facing array form of per-device paths to the stored map. */
function devicePathsFromArray(value) {
  const map = {}
  if (!Array.isArray(value)) return map
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const device = String(entry.device ?? '').trim()
    const path = String(entry.path ?? '').trim()
    if (device && path) map[device] = path
  }
  return map
}

/**
 * Register agent tools for managing custom directory/file sync items.
 *
 * Tools are optional: hosts without the `tools` service (or headless profiles)
 * simply skip them, and the settings UI remains the primary entry point.
 */
function registerAgentTools(tools, engine, scope) {
  const defs = [
    agentTool(
      'dsh_sync_custom_item_list',
      'List the custom directories/files that dsh-sync-hub syncs, including each item id, name, type (dir/file), local path, per-device path mappings and enabled state.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const items = await engine.listCustomItems()
        return { count: items.length, items }
      }
    ),
    agentTool(
      'dsh_sync_custom_item_add',
      'Add a custom directory or single file to dsh-sync-hub. Use this when the user asks to back up an arbitrary folder or file. path must be absolute and already exist on this computer; optionally map other computers to their own paths via devicePaths. Prefer asking the user for the intended folder first.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'path'],
        properties: {
          name: { type: 'string', description: 'Display name for this sync item, e.g. 项目源码.' },
          type: { type: 'string', enum: ['dir', 'file'], description: 'dir syncs the whole folder tree; file syncs one file.' },
          path: { type: 'string', description: 'Absolute path on this computer (D:\\projects\\demo or \\\\nas\\share\\x).' },
          enabled: { type: 'boolean', description: 'Whether the item participates in sync immediately. Defaults to true.' },
          devicePaths: {
            type: 'array',
            description: 'Optional per-computer paths, keyed by the device name shown in DSH settings.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['device', 'path'],
              properties: {
                device: { type: 'string', description: 'Device name, e.g. PC-B.' },
                path: { type: 'string', description: 'Absolute path on that device.' },
              },
            },
          },
        },
      },
      async (args) => {
        const item = await engine.upsertCustomItem({
          create: true,
          name: args.name,
          type: args.type,
          path: args.path,
          enabled: args.enabled,
          devicePaths: devicePathsFromArray(args.devicePaths),
        })
        return { item, items: await engine.listCustomItems() }
      }
    ),
    agentTool(
      'dsh_sync_custom_item_update',
      'Update an existing custom sync item identified by id or name (case-insensitive): rename it, change dir/file type, change its local path or per-device paths, or enable/disable it.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['idOrName'],
        properties: {
          idOrName: { type: 'string', description: 'Existing item id or its current display name.' },
          name: { type: 'string', description: 'New display name.' },
          type: { type: 'string', enum: ['dir', 'file'] },
          path: { type: 'string', description: 'New absolute path on this computer.' },
          enabled: { type: 'boolean' },
          devicePaths: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['device', 'path'],
              properties: {
                device: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
        },
      },
      async (args) => {
        const items = await engine.listCustomItems()
        const lookup = String(args.idOrName ?? '').trim().toLowerCase()
        const existing = items.find((item) => item.id.toLowerCase() === lookup)
          ?? items.find((item) => item.name.toLowerCase() === lookup)
        if (!existing) throw new SyncError('custom-item-not-found', `找不到自定义同步项: ${args.idOrName}`)
        const item = await engine.upsertCustomItem({
          id: existing.id,
          name: args.name,
          type: args.type,
          path: args.path,
          enabled: args.enabled,
          devicePaths: args.devicePaths !== undefined ? devicePathsFromArray(args.devicePaths) : existing.devicePaths,
        })
        return { item, items: await engine.listCustomItems() }
      }
    ),
    agentTool(
      'dsh_sync_custom_item_remove',
      'Remove a custom directory/file sync item by id or name. Only the sync configuration is removed; already backed-up data and the local files stay untouched. Confirm with the user before calling this.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['idOrName'],
        properties: {
          idOrName: { type: 'string', description: 'Existing item id or display name.' },
        },
      },
      async (args) => {
        const removed = await engine.removeCustomItem(args.idOrName)
        return { removed, items: await engine.listCustomItems() }
      }
    ),
  ]

  for (const def of defs) {
    if (scope && typeof scope.effect === 'function') {
      scope.effect(() => tools.register(def), `dsh-sync-hub: tool ${def.name}`)
    } else {
      tools.register(def)
    }
  }
}

export function apply(ctx) {
  const dshHome = resolveDshHome()
  const agentsHome = resolveAgentsHome()
  const engine = new SyncEngine({
    dshHome,
    agentsHome,
    stateRoot: join(dshHome, 'dsh-sync-hub'),
  })

  // Agent-facing tools for custom directory/file items. The service is optional
  // so the plugin still loads in deployments without a tool registry.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scope) => registerAgentTools(scope.tools, engine, scope))
    } else {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      if (tools && typeof tools.register === 'function') registerAgentTools(tools, engine)
    }
  } catch (toolError) {
    ctx.logger?.warn?.('[dsh-sync-hub] agent tools unavailable', toolError)
  }

  /** In-memory run registry; long operations return a runId for polling. */
  const runs = new Map()

  /**
   * One pending deletion decision shared by the settings panel and the sidebar
   * widget. It lives on the host so both surfaces can render the same conflict
   * card without the settings page being open.
   */
  let pendingDecision = null

  const isBusy = () => [...runs.values()].some(
    (run) => run.state === 'running' || run.state === 'cancelling',
  )

  const startRun = (kind, task) => {
    const id = randomUUID()
    const run = { id, kind, state: 'running', startedAt: new Date().toISOString(), cancelRequested: false }
    runs.set(id, run)
    const promise = Promise.resolve()
      .then(() => task(
        (progress) => { run.progress = progress },
        () => run.cancelRequested === true,
      ))
      .then((result) => {
        run.state = 'succeeded'
        run.result = result
        run.finishedAt = new Date().toISOString()
        return result
      })
      .catch((error) => {
        run.state = error?.code === 'cancelled' ? 'cancelled' : 'failed'
        run.error = { code: error?.code ?? 'error', message: String(error?.message ?? error) }
        run.finishedAt = new Date().toISOString()
        throw error
      })
    run.promise = promise
    // Manual runs are polled through runs.get; keep their rejection handled.
    promise.catch(() => {})
    return id
  }

  /**
   * Scheduled sync. Auto runs are registered in the same run registry as manual
   * ones, so the settings page and the sidebar progress widget show them too.
   */
  const autoSync = new AutoSyncScheduler({
    engine,
    store: engine.store,
    isBusy,
    runSync: async (options) => {
      const id = startRun('auto-sync', (onProgress, isCancelled) => engine.sync({
        ...options,
        onProgress,
        isCancelled,
      }))
      return await runs.get(id).promise
    },
    onEvent: (event) => ctx.logger?.info?.('[dsh-sync-hub] auto sync finished', event.results),
  })

  const handlers = {
    status: async () => {
      const base = await engine.status()
      const settings = await engine.getSettings()
      const autoState = await engine.store.loadAutoSyncState()
      const active = [...runs.values()].find(
        (run) => run.state === 'running' || run.state === 'cancelling',
      )
      return {
        version: pkg.version,
        ...base,
        activeRun: active ? runView(active) : null,
        pendingDecision,
        autoSync: autoSyncStatus(settings, autoState),
      }
    },

    'settings.get': async () => ({ settings: await engine.getSettings() }),

    'settings.save': async (payload) => ({ settings: await engine.saveSettings(payload?.patch ?? payload ?? {}) }),

    'scopes.estimate': async (payload) => await engine.estimateScopes({ targetId: payload?.targetId }),

    'targets.list': async () => ({ targets: await engine.listTargets() }),

    'targets.upsert': async (payload) => ({ targets: await engine.upsertTarget(payload?.target ?? payload) }),

    'targets.remove': async (payload) => ({ targets: await engine.removeTarget(payload?.id) }),

    'targets.test': async (payload) => await engine.testTarget(payload?.target ?? payload),

    preview: async (payload) => await engine.preview({
      targetId: payload?.targetId,
      scopeIds: payload?.scopeIds,
      direction: payload?.direction,
      deleteChoice: payload?.deleteChoice,
    }),

    sync: async (payload) => {
      if (isBusy()) throw new SyncError('busy', '已有同步任务在运行，请等待完成或取消后再开始新的同步')
      pendingDecision = null
      const runId = startRun('sync', (onProgress) => engine.sync({
        targetId: payload?.targetId,
        scopeIds: payload?.scopeIds,
        direction: payload?.direction,
        deleteChoice: payload?.deleteChoice,
        onProgress,
        isCancelled: () => runs.get(runId)?.cancelRequested === true,
      }))
      return { runId }
    },

    /** Register a deletion decision so both UI surfaces can render it. */
    'decision.set': async (payload) => {
      const targetId = typeof payload?.targetId === 'string' ? payload.targetId : ''
      if (!targetId) throw new SyncError('bad-target', '缺少同步目标')
      const settings = await engine.getSettings()
      const target = settings.targets.find((item) => item.id === targetId)
      if (!target) throw new SyncError('target-not-found', `找不到同步目标: ${targetId}`)
      pendingDecision = {
        id: randomUUID(),
        targetId,
        targetName: target.name,
        scopeIds: Array.isArray(payload?.scopeIds) ? payload.scopeIds : [],
        direction: payload?.direction === 'push' || payload?.direction === 'pull' ? payload.direction : 'both',
        total: Math.max(0, Number(payload?.total) || 0),
        localMissing: Math.max(0, Number(payload?.localMissing) || 0),
        remoteMissing: Math.max(0, Number(payload?.remoteMissing) || 0),
        createdAt: new Date().toISOString(),
      }
      return pendingDecision
    },

    'decision.clear': async () => {
      pendingDecision = null
      return { ok: true }
    },

    'runs.get': async (payload) => {
      const run = runs.get(payload?.id)
      if (!run) throw new SyncError('run-not-found', `找不到运行记录: ${payload?.id}`)
      return runView(run)
    },

    'runs.cancel': async (payload) => {
      const run = runs.get(payload?.id)
      if (!run) throw new SyncError('run-not-found', `找不到运行记录: ${payload?.id}`)
      if (run.state !== 'running') return { ok: false, state: run.state }
      run.cancelRequested = true
      return { ok: true, state: 'cancelling' }
    },

    /**
     * Trigger one scheduled pass now (ignores the interval, keeps the busy
     * guard). Runs in the background so the HTTP call returns immediately; the
     * UI watches `status.activeRun` and the auto-sync state afterwards.
     */
    'autoSync.runNow': async () => {
      if (isBusy()) return { run: false, reason: 'busy' }
      const settings = await engine.getSettings()
      if (settings.autoSync?.enabled !== true) return { run: false, reason: 'disabled' }
      if (!settings.targets.some((target) => target.enabled !== false)) {
        return { run: false, reason: 'no-targets' }
      }
      const promise = autoSync.runNow()
      promise.catch(() => {})
      return { run: true, started: true }
    },

    'snapshots.list': async (payload) => await engine.listSnapshots({ targetId: payload?.targetId }),

    /**
     * Read-only directory listing for the path picker. Loopback-only, like all
     * endpoints; it never writes anything.
     */
    'fs.listDirs': async (payload) => {
      const raw = typeof payload?.path === 'string' ? payload.path.trim() : ''
      const directory = raw ? resolve(raw) : homedir()
      let stat
      try {
        stat = await fsp.stat(directory)
      } catch (error) {
        throw new SyncError('fs-not-found', `目录不存在: ${directory}`)
      }
      if (!stat.isDirectory()) throw new SyncError('fs-not-directory', `不是目录: ${directory}`)
      const entries = await fsp.readdir(directory, { withFileTypes: true })
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'))
      return {
        path: directory,
        parent: dirname(directory) === directory ? '' : dirname(directory),
        dirs: dirs.map((name) => ({ name, path: join(directory, name) })),
      }
    },

    /** Inspect a path so the form can tell a file from a directory. */
    'fs.statPath': async (payload) => {
      const raw = typeof payload?.path === 'string' ? payload.path.trim() : ''
      if (!raw) throw new SyncError('bad-path', '路径不能为空')
      const target = resolve(raw)
      try {
        const stat = await fsp.stat(target)
        return {
          path: target,
          exists: true,
          type: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
          size: stat.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT') return { path: target, exists: false, type: 'missing', size: 0 }
        throw error
      }
    },

    'cache.clearProjections': async () => {
      const { promises: fsp } = await import('node:fs')
      const dir = join(dshHome, 'storages', 'session_projcache')
      await fsp.rm(dir, { recursive: true, force: true })
      return { ok: true, cleared: dir }
    },

    /**
     * Read-only diagnostics for the client module graph.
     *
     * Answers "is my browser bundle actually in the boot graph?" without
     * opening devtools. `clientModules` is a host service; it is read lazily
     * because it is optional (TUI/headless profiles do not mount it).
     */
    diagnostics: async () => {
      const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
      let graph = null
      let graphError = null
      try {
        graph = clientModules?.graph?.() ?? null
      } catch (error) {
        graphError = String(error?.message ?? error)
      }
      const rows = Array.isArray(graph?.entries) ? graph.entries : []
      return {
        clientModules: Boolean(clientModules),
        graphError,
        graphRev: graph?.rev ?? null,
        graphSize: rows.length,
        rows: rows.filter((row) => /sync|pilot|cloud/.test(String(row.id))),
        ourClientPath: typeof clientModules?.clientPath === 'function'
          ? (clientModules.clientPath('dsh-sync-hub') ?? null)
          : null,
      }
    },
  }

  const dispatch = async (endpoint, payload) => {
    const handler = handlers[endpoint]
    if (!handler) throw new SyncError('unknown-endpoint', `未知接口: ${endpoint}`)
    return await handler(payload ?? {})
  }

  const routeHandler = async (req, res) => {
    try {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, code: 'forbidden', message: 'dsh-sync-hub: loopback request required' })
        return
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/'
      if (!rawPath.startsWith(`${ROUTE_PREFIX}/`)) {
        sendJson(res, 404, { ok: false, code: 'not-found', message: 'no such endpoint' })
        return
      }
      const endpoint = decodeURIComponent(rawPath.slice(ROUTE_PREFIX.length + 1))
      if (req.method === 'GET') {
        const value = await dispatch(endpoint, {})
        sendJson(res, 200, { ok: true, value })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' })
        return
      }
      const payload = await readBody(req)
      const value = await dispatch(endpoint, payload)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const status = error?.code === 'body-too-large' ? 413 : 400
      sendJson(res, status, {
        ok: false,
        code: error?.code ?? 'error',
        message: String(error?.message ?? error),
      })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler }),
    'dsh-sync-hub: web routes',
  )

  // Prefer the Connection RPC channel when the host exposes it; the browser
  // half already falls back to fetch if this is unavailable.
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (connection?.rpc?.handle) {
    ctx.effect(
      () => connection.rpc.handle(ROUTE_PREFIX, async (endpoint, payload) => {
        try {
          return { ok: true, value: await dispatch(endpoint, payload ?? {}) }
        } catch (error) {
          return { ok: false, error: { code: error?.code ?? 'error', message: String(error?.message ?? error) } }
        }
      }),
      'dsh-sync-hub: rpc channel',
    )
  }

  // Scheduled sync: a 60s tick decides whether the configured interval elapsed.
  ctx.effect(() => {
    let disposed = false
    let ticking = false
    const tick = async () => {
      if (disposed || ticking) return
      ticking = true
      try {
        const outcome = await autoSync.tick()
        if (outcome.run) ctx.logger?.info?.('[dsh-sync-hub] auto sync ran', outcome.results)
      } catch (error) {
        ctx.logger?.warn?.('[dsh-sync-hub] auto sync failed', error)
      } finally {
        ticking = false
      }
    }
    const timer = setInterval(tick, 60_000)
    // First check shortly after boot so enabling auto sync does not wait a full minute.
    const warmup = setTimeout(tick, 10_000)
    return () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(warmup)
    }
  }, 'dsh-sync-hub: auto sync timer')

  ctx.effect(() => () => {
    runs.clear()
  }, 'dsh-sync-hub: runs')
}
