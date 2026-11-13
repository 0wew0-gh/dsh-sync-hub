/**
 * Scope declarations: what to sync, where it lives and how conflicts resolve.
 *
 * A scope is intentionally declarative. `scopeSources()` maps a scope id to a
 * list of file/directory sources relative to the DSH home and agents home; the
 * scanner turns those into manifest entries.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** Profile files that together describe plugin settings for one profile. */
export const PROFILE_CONFIG_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'pnpm-lock.yaml',
  'compatibility.json',
]

/** Files with machine-specific or secret content that must never be synced. */
export const HARD_EXCLUDES = [
  '**/.credentials*',
  '**/credentials.json',
  '**/node_modules/**',
  '**/.pnpm-store/**',
  '**/dsh-runtimes/**',
  '**/temp/**',
  '**/cache/**',
  '**/skin-center/**/.cache/**',
  '**/.plugin-manager/logs/**',
  '**/*.log',
  '**/*.tmp',
  '**/*.bak',
  '**/*.bak-*',
  '**/*.migrated.bak',
  '**/session_projcache*',
  '**/*.lock',
  '**/.git/**',
]

/** Directory names pruned during walks (fast path for the big ignored trees). */
export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.pnpm-store',
  'dsh-runtimes',
  'temp',
  'cache',
  '.cache',
  '.git',
  'logs',
  '.plugin-manager',
])

/** Default scopes. `policy` is the conflict strategy used by the planner. */
export const SCOPES = [
  {
    id: 'agents-md',
    name: '全局 AGENTS.md',
    description: '$DSH_HOME/AGENTS.md（用户全局指令）',
    enabledByDefault: true,
    policy: 'newer',
  },
  {
    id: 'plugin-settings',
    name: '插件设置',
    description: '各 profile 的 package.json / cordis.patch.yml / pnpm 配置',
    enabledByDefault: true,
    policy: 'newer',
    profiles: ['web'],
  },
  {
    id: 'plugin-files',
    name: '插件文件',
    description: '$DSH_HOME/plugins 与 .agent-presets（本地插件源码、自定义预设）',
    enabledByDefault: true,
    policy: 'keep-both',
  },
  {
    id: 'skills',
    name: '全局 Skills',
    description: '~/.agents/skills 与 .skill-lock.json',
    enabledByDefault: true,
    policy: 'newer',
  },
  {
    id: 'sessions',
    name: '会话数据',
    description: '$DSH_HOME/sessions（不解析内容，按字节同步）',
    enabledByDefault: true,
    policy: 'keep-both',
  },
  {
    id: 'attachments',
    name: '会话附件',
    description: '$DSH_HOME/attachments（内容寻址、不可变）',
    enabledByDefault: false,
    policy: 'newer',
  },
  {
    id: 'storages',
    name: '工作区与统计',
    description: '$DSH_HOME/storages（含绝对路径，默认关闭）',
    enabledByDefault: false,
    policy: 'newer',
  },
]

const SCOPE_BY_ID = new Map(SCOPES.map((scope) => [scope.id, scope]))

/** Look up a scope declaration by id. */
export function getScope(id) {
  return SCOPE_BY_ID.get(id)
}

/** Directory entries inside `$DSH_HOME/profiles` that look like profiles. */
export async function listProfileNames(dshHome) {
  const root = join(dshHome, 'profiles')
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    try {
      await fsp.access(join(root, entry.name, 'package.json'))
      names.push(entry.name)
    } catch {
      // Not a profile directory; ignore.
    }
  }
  return names.sort()
}

/**
 * Map a scope to concrete sources.
 *
 * Returns entries of shape `{ kind: 'file', abs, rel }` or
 * `{ kind: 'dir', abs, relPrefix }`. Missing roots are skipped silently so a
 * fresh machine can sync a partial environment.
 */
export async function scopeSources(scopeId, context) {
  const { dshHome, agentsHome, settings } = context
  const scopeSettings = settings?.scopes?.[scopeId] ?? {}
  switch (scopeId) {
    case 'agents-md':
      return [
        {
          kind: 'file',
          abs: join(dshHome, 'AGENTS.md'),
          rel: 'AGENTS.md',
        },
      ]
    case 'plugin-settings': {
      const wanted = Array.isArray(scopeSettings.profiles) && scopeSettings.profiles.length > 0
        ? scopeSettings.profiles
        : (getScope(scopeId)?.profiles ?? ['web'])
      const available = await listProfileNames(dshHome)
      const profiles = available.filter((name) => wanted.includes(name))
      const sources = []
      for (const profile of profiles) {
        for (const file of PROFILE_CONFIG_FILES) {
          sources.push({
            kind: 'file',
            abs: join(dshHome, 'profiles', profile, file),
            rel: `profiles/${profile}/${file}`,
          })
        }
      }
      return sources
    }
    case 'plugin-files':
      return [
        { kind: 'dir', abs: join(dshHome, 'plugins'), relPrefix: 'plugins' },
        { kind: 'dir', abs: join(dshHome, '.agent-presets'), relPrefix: '.agent-presets' },
      ]
    case 'skills':
      return [
        { kind: 'dir', abs: join(agentsHome, 'skills'), relPrefix: 'skills' },
        { kind: 'file', abs: join(agentsHome, '.skill-lock.json'), rel: '.skill-lock.json' },
      ]
    case 'sessions':
      return [{ kind: 'dir', abs: join(dshHome, 'sessions'), relPrefix: 'sessions' }]
    case 'attachments':
      return [{ kind: 'dir', abs: join(dshHome, 'attachments'), relPrefix: 'attachments' }]
    case 'storages':
      return [
        { kind: 'file', abs: join(dshHome, 'storages', 'workspace.json'), rel: 'storages/workspace.json' },
      ]
    default:
      throw new Error(`unknown scope: ${scopeId}`)
  }
}

/** Build the default per-scope settings map. */
export function defaultScopeSettings() {
  const result = {}
  for (const scope of SCOPES) {
    result[scope.id] = { enabled: scope.enabledByDefault }
    if (scope.profiles) result[scope.id].profiles = [...scope.profiles]
  }
  return result
}

/**
 * Absolute path for a manifest key.
 *
 * Manifest keys are relative to either the DSH home or the agents home; skills
 * live under the agents home, everything else under the DSH home. Custom items
 * live outside those roots, so they resolve against the item's per-device path.
 * Callers must validate the key with `assertSafeRel` first (the engine does).
 */
export function absPathForRel(scopeId, rel, context) {
  const { dshHome, agentsHome } = context
  if (isCustomScope(scopeId)) {
    const item = findCustomItem(scopeId, context.customItems)
    if (!item) throw new Error(`unknown custom scope: ${scopeId}`)
    const base = customItemPath(item, context.deviceName)
    const prefix = `custom/${item.id}/`
    if (!rel.startsWith(prefix)) throw new Error(`custom scope path mismatch: ${rel}`)
    // A file item maps the whole item to its configured path; a directory item
    // keeps the relative path below its root.
    if (item.type === 'file') return base
    return join(base, rel.slice(prefix.length))
  }
  const root = scopeId === 'skills' ? agentsHome : dshHome
  return join(root, rel)
}

export const CUSTOM_SCOPE_PREFIX = 'custom:'

/** Scope id for one custom directory/file item. */
export function customScopeId(itemId) {
  return `${CUSTOM_SCOPE_PREFIX}${itemId}`
}

/** True for ids created by custom directory/file items. */
export function isCustomScope(scopeId) {
  return typeof scopeId === 'string' && scopeId.startsWith(CUSTOM_SCOPE_PREFIX)
}

/** The item id inside a custom scope id. */
export function customItemIdOf(scopeId) {
  return isCustomScope(scopeId) ? scopeId.slice(CUSTOM_SCOPE_PREFIX.length) : ''
}

/** Find a custom item by scope id. */
export function findCustomItem(scopeId, customItems) {
  const id = customItemIdOf(scopeId)
  return (Array.isArray(customItems) ? customItems : []).find((item) => item.id === id)
}

/** Directory/file path an item uses on one device. */
export function customItemPath(item, deviceName) {
  if (!item) return ''
  const mapped = item.devicePaths && deviceName ? item.devicePaths[deviceName] : ''
  return mapped || item.path || ''
}

/** Enabled custom items that should take part in a sync. */
export function enabledCustomItems(settings) {
  return (Array.isArray(settings?.customItems) ? settings.customItems : [])
    .filter((item) => item.enabled !== false && customItemPath(item, settings?.deviceName))
}

