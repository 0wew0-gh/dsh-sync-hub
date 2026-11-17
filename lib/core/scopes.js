/**
 * Scope declarations: what to sync, where it lives and how conflicts resolve.
 *
 * A scope is intentionally declarative. `scopeSources()` maps a scope id to a
 * list of file/directory sources relative to the DSH home and agents home; the
 * scanner turns those into manifest entries.
 */

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'

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
  // Pet installers stage resources in `<name>.install-<random>` siblings until
  // the install finishes; a failed or interrupted install leaves them behind.
  '**/*.install-*',
  '**/.plugin-manager/logs/**',
  '**/*.log',
  '**/*.tmp',
  '**/*.bak',
  '**/*.bak-*',
  '**/*.migrated.bak',
  '**/session_projcache*',
  // Duplicate-session quarantine created by the sessions tab. Those copies must
  // never travel to the backup (they are exactly the duplicate ids we avoid).
  '**/.dedupe-backup-*/**',
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
    // Config files carry user toggles (plugin enable/disable, feature switches).
    // A stale copy from another device must not silently re-enable them, so a
    // both-sides change keeps the local copy and uploads it instead of using mtime.
    policy: 'local',
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
    id: 'memes',
    name: '表情包',
    description: '$DSH_HOME/meme-packs 与 dsh-expression.json（表情包图库与选择配置）',
    enabledByDefault: true,
    policy: 'keep-both',
  },
  {
    id: 'skins',
    name: '外观皮肤',
    description: '$DSH_HOME/skins、skin-center 与 skin-center-active.json（皮肤、壁纸与当前外观）',
    enabledByDefault: true,
    policy: 'keep-both',
  },
  {
    id: 'pets',
    name: '宠物外观',
    description: '$DSH_HOME/pets 与 pet.json（宠物资源与亲密度状态，体积较大）',
    enabledByDefault: true,
    policy: 'keep-both',
  },
  {
    id: 'plugins',
    name: '插件',
    description: '所选插件的安装包（profiles/<profile>/node_modules 下的插件目录）',
    enabledByDefault: true,
    policy: 'keep-both',
    /**
     * `mode: 'selected'` syncs only the plugin packages listed in
     * `selectedPlugins`; `settingsPlugins` records which plugins also opt into
     * plugin-settings syncing in the UI.
     */
    defaults: { mode: 'selected', selectedPlugins: [], settingsPlugins: [], profile: '' },
  },
  {
    id: 'sessions',
    name: '会话数据',
    description: '$DSH_HOME/sessions（不解析内容，按字节同步；可只同步选中的会话）',
    enabledByDefault: true,
    policy: 'keep-both',
    /**
     * `mode: 'all'` keeps the historical behaviour (every session directory is
     * synced). `mode: 'selected'` only syncs the ids listed in
     * `selectedSessionIds`; a new session is therefore never added silently.
     */
    defaults: { mode: 'all', selectedSessionIds: [] },
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

/** Resolve which profile's plugins are in scope (configured, active, or first). */
export async function resolvePluginsProfile(dshHome, configured) {
  const names = await listProfileNames(dshHome)
  const wanted = typeof configured === 'string' ? configured.trim() : ''
  if (wanted && names.includes(wanted)) return wanted
  const active = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  if (active && names.includes(active)) return active
  const activeDir = typeof process.env.DSH_PROFILE_DIR === 'string' ? basename(process.env.DSH_PROFILE_DIR.trim()) : ''
  if (activeDir && names.includes(activeDir)) return activeDir
  // A host without profile env vars still syncs the desktop plugins by default;
  // profile-name ordering is alphabetical (`cc-tui` would win otherwise).
  for (const preferred of ['desktop', 'web']) {
    if (names.includes(preferred)) return preferred
  }
  return names[0] ?? (active || 'web')
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
    case 'plugins': {
      const profile = await resolvePluginsProfile(dshHome, scopeSettings.profile)
      const selected = Array.isArray(scopeSettings.selectedPlugins)
        ? scopeSettings.selectedPlugins.filter((name) => typeof name === 'string' && name)
        : []
      return selected.map((name) => ({
        kind: 'dir',
        abs: join(dshHome, 'profiles', profile, 'node_modules', name),
        relPrefix: `plugins/${profile}/packages/${name}`,
      }))
    }
    case 'skills':
      return [
        { kind: 'dir', abs: join(agentsHome, 'skills'), relPrefix: 'skills' },
        { kind: 'file', abs: join(agentsHome, '.skill-lock.json'), rel: '.skill-lock.json' },
      ]
    case 'memes':
      return [
        { kind: 'dir', abs: join(dshHome, 'meme-packs'), relPrefix: 'meme-packs' },
        { kind: 'file', abs: join(dshHome, 'dsh-expression.json'), rel: 'dsh-expression.json' },
      ]
    case 'skins':
      return [
        { kind: 'dir', abs: join(dshHome, 'skins'), relPrefix: 'skins' },
        { kind: 'dir', abs: join(dshHome, 'skin-center'), relPrefix: 'skin-center' },
        { kind: 'file', abs: join(dshHome, 'skin-center-active.json'), rel: 'skin-center-active.json' },
      ]
    case 'pets':
      return [
        { kind: 'dir', abs: join(dshHome, 'pets'), relPrefix: 'pets' },
        { kind: 'file', abs: join(dshHome, 'pet.json'), rel: 'pet.json' },
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
    if (scope.defaults) Object.assign(result[scope.id], structuredClone(scope.defaults))
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
  if (scopeId === 'plugins') {
    const prefix = 'plugins/'
    if (!rel.startsWith(prefix)) throw new Error(`plugins scope path mismatch: ${rel}`)
    const rest = rel.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash < 0) throw new Error(`plugins scope path mismatch: ${rel}`)
    const profile = rest.slice(0, slash)
    const packages = rest.slice(slash + 1)
    if (!packages.startsWith('packages/')) throw new Error(`plugins scope path mismatch: ${rel}`)
    const tail = packages.slice('packages/'.length)
    const selected = Array.isArray(context.settings?.scopes?.plugins?.selectedPlugins)
      ? context.settings.scopes.plugins.selectedPlugins
      : []
    let name = selected.find((candidate) => tail === candidate || tail.startsWith(candidate + '/'))
    if (!name) {
      // A restore may carry a package that is no longer in the local selection;
      // derive the npm name from the path instead of rejecting the manifest key.
      const parts = tail.split('/')
      name = tail.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    }
    if (!name) throw new Error(`plugins scope path mismatch: ${rel}`)
    const relative = tail.slice(name.length).replace(/^\//, '')
    return join(dshHome, 'profiles', profile, 'node_modules', name, relative)
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

