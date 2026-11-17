/**
 * Plugin enable/disable state shared by third-party, built-in and experimental
 * plugins.
 *
 * State lives in two places:
 * - `package.json` `dsh.profile.bundles`: which bundles are loaded.
 * - `cordis.patch.yml`: literal `disabled: true/false` overrides used by the
 *   built-in toggles (and any manual row overrides).
 *
 * The backup stores one small JSON document per profile; restore rewrites the
 * bundle list and only the `disabled` fields it knows about, leaving unrelated
 * patch rows untouched.
 */

import { promises as fsp } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAsarEntry } from './paths.js'
import { atomicWrite, ensureDir } from './util.js'
import { resolvePluginsProfile } from './scopes.js'

export const PLUGIN_STATE_SCHEMA = 'dsh-sync-hub/v1/plugin-state'

/** Object key for one profile's plugin state document. */
export function pluginStateKey(profile) {
  return `plugin-states/${profile}.json`
}

function profileDirOf(dshHome, profile) {
  return join(dshHome, 'profiles', profile)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function mtimeOf(files) {
  let newest = 0
  for (const file of files) {
    try {
      const stat = await fsp.stat(file)
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // Missing file never contributes a timestamp.
    }
  }
  return newest
}

/**
 * Collect literal `disabled:` values from top-level patch rows.
 *
 * The profile patch is a YAML list; this parser only looks at the row shape the
 * built-in toggles write (`- id: x` followed by `disabled: <bool>`), which keeps
 * it dependency-free and conservative.
 */
export function parseDisabledOverrides(text) {
  const overrides = {}
  if (typeof text !== 'string' || text.length === 0) return overrides
  const lines = text.split(/\r?\n/)
  let currentId = null
  let currentIndent = 0
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const row = /^(\s*)-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(line)
    if (row) {
      currentId = row[2]
      currentIndent = row[1].length
      continue
    }
    if (currentId === null) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= currentIndent) {
      currentId = null
      continue
    }
    const disabled = /^\s+disabled\s*:\s*(true|false)\s*(?:#.*)?$/.exec(line)
    if (disabled) overrides[currentId] = disabled[1] === 'true'
  }
  return overrides
}

/** Parse top-level row ranges (line indexes) from the profile patch text. */
function parseRowRanges(text) {
  const lines = typeof text === 'string' && text.length > 0 ? text.split(/\r?\n/) : []
  const rows = []
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(lines[index])
    if (!match) continue
    if (current) current.end = index
    current = { id: match[1], start: index, end: lines.length }
    rows.push(current)
  }
  return { lines, rows }
}

/** Split the profile patch into addressable top-level rows (`{ id, text }`). */
export function splitPatchRows(text) {
  const { lines, rows } = parseRowRanges(text)
  return rows.map((row) => ({
    id: row.id,
    text: lines.slice(row.start, row.end).join('\n').replace(/\s+$/, ''),
  }))
}

/** Replace/add remote patch rows by id, leaving unrelated local rows untouched. */
export function applyPatchRows(text, remoteRows) {
  const rows = Array.isArray(remoteRows)
    ? remoteRows.filter((row) => row && typeof row.id === 'string' && row.id && typeof row.text === 'string')
    : []
  if (rows.length === 0) return text
  const { lines, rows: localRows } = parseRowRanges(text)
  const byId = new Map(rows.map((row) => [row.id, row.text.replace(/\s+$/, '')]))
  const used = new Set()
  const output = []
  let cursor = 0
  for (const row of localRows) {
    output.push(...lines.slice(cursor, row.start))
    if (byId.has(row.id)) {
      output.push(...byId.get(row.id).split('\n'))
      used.add(row.id)
    } else {
      output.push(...lines.slice(row.start, row.end))
    }
    cursor = row.end
  }
  output.push(...lines.slice(cursor))
  for (const row of rows) {
    if (!used.has(row.id)) output.push(...row.text.replace(/\s+$/, '').split('\n'))
  }
  return output.join('\n')
}

/** Read a file that may live inside the packaged app.asar archive. */
function readMaybeAsar(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    const buffer = readAsarEntry(file)
    return buffer ? buffer.toString('utf8') : null
  }
}

/** Candidate DSH install directories (packaged app.asar or a normal npm tree). */
function dshInstallDirs() {
  const dirs = []
  if (process.env.DSH_INSTALL_DIR) dirs.push(process.env.DSH_INSTALL_DIR)
  if (process.env.DSH_NODE_EXECUTABLE) {
    dirs.push(join(dirname(process.env.DSH_NODE_EXECUTABLE), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  const localAppData = process.env.LOCALAPPDATA
    || (process.env.APPDATA ? join(process.env.APPDATA, '..', 'Local') : '')
  if (localAppData) dirs.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
  return [...new Set(dirs)]
}

/** Parse flat bundle-patch rows (id / name / literal disabled). */
function parseBundleRows(text, source) {
  const rows = []
  if (typeof text !== 'string') return rows
  const lines = text.split(/\r?\n/)
  let current = null
  for (const line of lines) {
    const row = /^(\s*)-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(line)
    if (row) {
      current = { id: row[2], indent: row[1].length, name: '', disabled: false, source }
      rows.push(current)
      continue
    }
    if (!current) continue
    if (line.trim() && /^\s*/.test(line)) {
      const indent = /^(\s*)/.exec(line)[1].length
      if (indent <= current.indent && !/^\s*#/.test(line)) {
        current = null
        continue
      }
    }
    const name = /^\s+name\s*:\s*['"]?([^'"#\s]+)['"]?/.exec(line)
    if (name && !current.name) current.name = name[1]
    const disabled = /^\s+disabled\s*:\s*(true|false)\b/.exec(line)
    if (disabled) current.disabled = disabled[1] === 'true'
  }
  return rows
}

const BUILTIN_CAPABILITY_PATTERN = /subagent|web[-_ ]?search|web[-_ ]?fetch|websearch|webfetch|tool-web/i

/**
 * Read built-in capability plugin rows (subagents, web search, web fetch) from
 * the DSH bundles and fold in the profile's `disabled` overrides.
 */
export async function readBuiltinCapabilities(dshHome, profile) {
  const found = new Map()
  for (const installDir of dshInstallDirs()) {
    const parent = dirname(installDir)
    for (const pkg of ['dsh-base', 'dsh-web-app']) {
      const text = readMaybeAsar(join(parent, pkg, 'cordis.patch.yml'))
      if (!text) continue
      for (const row of parseBundleRows(text, pkg)) {
        if (!BUILTIN_CAPABILITY_PATTERN.test(row.id) && !BUILTIN_CAPABILITY_PATTERN.test(row.name)) continue
        const previous = found.get(row.id)
        if (!previous) {
          found.set(row.id, {
            id: row.id,
            name: row.name || row.id,
            enabled: !row.disabled,
            source: row.source,
          })
        } else {
          // Later bundle layers (web-app after base) override earlier rows; the
          // profile patch is applied after this loop.
          if (row.name) previous.name = row.name
          previous.enabled = !row.disabled
          previous.source = row.source
        }
      }
    }
    if (found.size > 0) break
  }
  let overrides = {}
  try {
    const text = await fsp.readFile(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
    overrides = parseDisabledOverrides(text)
  } catch {
    overrides = {}
  }
  const rows = [...found.values()].map((row) => ({
    ...row,
    enabled: Object.prototype.hasOwnProperty.call(overrides, row.id) ? !overrides[row.id] : row.enabled,
  }))
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}

/** Read the current state for one profile. */
export async function readPluginState(dshHome, profile) {
  const dir = profileDirOf(dshHome, profile)
  const packageFile = join(dir, 'package.json')
  const patchFile = join(dir, 'cordis.patch.yml')
  const pkg = await readJson(packageFile, {})
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.slice() : []
  let patchText = ''
  try {
    patchText = await fsp.readFile(patchFile, 'utf8')
  } catch {
    patchText = ''
  }
  const updatedAtMs = await mtimeOf([packageFile, patchFile])
  return {
    schema: PLUGIN_STATE_SCHEMA,
    profile,
    bundles,
    disabled: parseDisabledOverrides(patchText),
    // Full top-level rows carry built-in capability configs (subagents, web
    // search/fetch) and experimental plugin configs, not just enable flags.
    rows: splitPatchRows(patchText),
    updatedAt: new Date(updatedAtMs || Date.now()).toISOString(),
  }
}

/**
 * Rewrite one top-level row's literal `disabled` field, appending the field or
 * the whole row when needed. Returns null when the patch has no such row.
 */
function applyDisabledToPatch(text, id, disabled) {
  const lines = text.length > 0 ? text.split(/\r?\n/) : []
  let start = -1
  let end = lines.length
  let indent = 0
  for (let index = 0; index < lines.length; index += 1) {
    const row = /^(\s*)-\s+id\s*:\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(lines[index])
    if (row && row[2] === id) {
      start = index
      indent = row[1].length
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (/^\s*-\s+/.test(lines[cursor]) || (/^\S/.test(lines[cursor]) && lines[cursor].trim() !== '')) {
          end = cursor
          break
        }
      }
      break
    }
  }
  if (start < 0) {
    const prefix = lines.length > 0 && lines[lines.length - 1] === '' ? '' : '\n'
    return `${text}${prefix}- id: ${id}\n  disabled: ${disabled ? 'true' : 'false'}\n`
  }
  const fieldIndent = ' '.repeat(indent + 2)
  const fieldPattern = new RegExp(`^${fieldIndent}disabled\\s*:\\s*(true|false)(\\s*(?:#.*)?)$`)
  for (let index = start + 1; index < end; index += 1) {
    if (fieldPattern.test(lines[index])) {
      lines[index] = `${fieldIndent}disabled: ${disabled ? 'true' : 'false'}`
      return lines.join('\n')
    }
  }
  lines.splice(start + 1, 0, `${fieldIndent}disabled: ${disabled ? 'true' : 'false'}`)
  return lines.join('\n')
}

/** Apply a remote state document to one local profile. */
export async function applyPluginState(dshHome, profile, state, { applyBundles = true } = {}) {
  if (!state || typeof state !== 'object') return { applied: false }
  const dir = profileDirOf(dshHome, profile)
  const packageFile = join(dir, 'package.json')
  const patchFile = join(dir, 'cordis.patch.yml')
  let changed = false
  if (applyBundles && Array.isArray(state.bundles)) {
    const pkg = await readJson(packageFile, null)
    if (pkg) {
      pkg.dsh ??= {}
      pkg.dsh.profile ??= {}
      const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
      // Bundles whose package is not installed locally are skipped; adding them
      // would make the next startup fail to resolve the plugin.
      const nextBundles = [...new Set(state.bundles.filter((name) => (
        typeof name === 'string'
        && name
        && (Object.prototype.hasOwnProperty.call(dependencies, name)
          || name === '@deepseek-ai/dsh-base'
          || name === '@deepseek-ai/dsh-web-app')
      )))]
      const currentBundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
      const sameBundles = currentBundles.length === nextBundles.length
        && currentBundles.every((name, index) => name === nextBundles[index])
      if (!sameBundles) {
        pkg.dsh.profile.bundles = nextBundles
        await atomicWrite(packageFile, JSON.stringify(pkg, null, 2) + '\n', 0o644)
        changed = true
      }
    }
  }
  const disabled = state.disabled && typeof state.disabled === 'object' ? state.disabled : {}
  const hasRows = Array.isArray(state.rows) && state.rows.length > 0
  if (hasRows) {
    let text = ''
    try {
      text = await fsp.readFile(patchFile, 'utf8')
    } catch {
      text = ''
    }
    const remoteRows = state.rows
      .filter((row) => row && typeof row.id === 'string' && row.id && typeof row.text === 'string')
      .map((row) => ({ id: row.id, text: row.text.replace(/\s+$/, '') }))
    const localRows = splitPatchRows(text)
    const sameRows = localRows.length === remoteRows.length
      && localRows.every((row, index) => row.id === remoteRows[index].id && row.text === remoteRows[index].text)
    if (!sameRows) {
      const next = applyPatchRows(text, remoteRows)
      if (next !== text) {
        await ensureDir(dir)
        await atomicWrite(patchFile, next, 0o644)
        changed = true
      }
    }
  } else if (Object.keys(disabled).length > 0) {
    let text = ''
    try {
      text = await fsp.readFile(patchFile, 'utf8')
    } catch {
      text = ''
    }
    let next = text
    for (const [id, value] of Object.entries(disabled)) {
      if (typeof id === 'string' && id && typeof value === 'boolean') next = applyDisabledToPatch(next, id, value)
    }
    if (next !== text) {
      await ensureDir(dir)
      await atomicWrite(patchFile, next, 0o644)
      changed = true
    }
  }
  return { applied: changed }
}

/** Reset timestamps helper used by callers that want a fresh local state. */
export function normalizePluginState(state, profile) {
  const bundles = Array.isArray(state?.bundles)
    ? [...new Set(state.bundles.filter((name) => typeof name === 'string' && name))]
    : []
  const disabled = {}
  if (state?.disabled && typeof state.disabled === 'object') {
    for (const [id, value] of Object.entries(state.disabled)) {
      if (typeof id === 'string' && id && typeof value === 'boolean') disabled[id] = value
    }
  }
  return { ...state, schema: PLUGIN_STATE_SCHEMA, profile, bundles, disabled }
}
