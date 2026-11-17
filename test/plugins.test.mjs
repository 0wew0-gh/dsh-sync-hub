import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { absPathForRel, defaultScopeSettings, scopeSources } from '../lib/core/scopes.js'
import { scanScope } from '../lib/core/scan.js'
import { SyncEngine } from '../lib/core/engine.js'
import { applyPluginState, parseDisabledOverrides, readBuiltinCapabilities, readPluginState } from '../lib/core/plugin-state.js'

async function writeFile(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

test('plugins scope maps selected profile packages and restores their paths', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-plugins-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  await writeFile(join(profileDir, 'package.json'), '{"dependencies":{"demo-plugin":"1.2.3"}}\n')
  await writeFile(join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin","version":"1.2.3"}\n')
  await writeFile(join(profileDir, 'node_modules', 'demo-plugin', 'index.js'), 'export const demo = true\n')

  const settings = defaultScopeSettings()
  settings.plugins.selectedPlugins = ['demo-plugin']
  settings.plugins.profile = 'desktop'
  const context = { dshHome, agentsHome, settings: { scopes: settings } }

  const sources = await scopeSources('plugins', context)
  assert.deepEqual(sources, [{
    kind: 'dir',
    abs: join(profileDir, 'node_modules', 'demo-plugin'),
    relPrefix: 'plugins/desktop/packages/demo-plugin',
  }])

  const rel = 'plugins/desktop/packages/demo-plugin/index.js'
  assert.equal(absPathForRel('plugins', rel, context), join(profileDir, 'node_modules', 'demo-plugin', 'index.js'))

  const entries = await scanScope('plugins', context)
  assert.ok(entries.has(rel))
})

test('plugins scope uploads the selected package and records its backup version', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-plugins-sync-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  const backup = join(root, 'backup')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  await writeFile(join(profileDir, 'package.json'), '{"dependencies":{"demo-plugin":"1.2.3"}}\n')
  await writeFile(join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), '{"name":"demo-plugin","version":"1.2.3"}\n')
  await writeFile(join(profileDir, 'node_modules', 'demo-plugin', 'index.js'), 'export const demo = true\n')

  const engine = await new SyncEngine({ dshHome, agentsHome, stateRoot: join(root, 'state') }).init()
  await engine.saveSettings({ scopes: { plugins: { selectedPlugins: ['demo-plugin'], profile: 'desktop' } } })
  const [target] = await engine.upsertTarget({ name: 'backup', path: backup })
  const result = await engine.sync({ targetId: target.id, scopeIds: ['plugins'], direction: 'push' })
  assert.equal(result.summary.uploaded, 2, JSON.stringify(result.summary))

  const settings = await engine.getSettings()
  const manifest = JSON.parse(await fsp.readFile(join(backup, target.prefix, 'manifests', settings.deviceId + '.json'), 'utf8'))
  assert.ok(manifest.scopes.plugins.files['plugins/desktop/packages/demo-plugin/index.js'])
  assert.ok(manifest.scopes.plugins.files['plugins/desktop/packages/demo-plugin/package.json'])

  const listed = await engine.listPlugins({ targetId: target.id })
  assert.equal(listed.builtins.length, 4)
  assert.deepEqual(listed.builtins.map((item) => item.name), ['子智能体', '网页搜索与获取', 'Agent 循环', '终端'])
  assert.ok(Array.isArray(listed.experimental))
  const row = listed.rows.find((item) => item.name === 'demo-plugin')
  assert.equal(row.selected, true)
  assert.equal(row.backupVersion, '1.2.3')

  const stateFile = join(backup, target.prefix, 'plugin-states', 'desktop.json')
  const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.equal(saved.schema, 'dsh-sync-hub/v1/plugin-state')
  assert.ok(Array.isArray(saved.bundles))
})

test('built-in capability rows come from bundles and honour profile overrides', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-builtins-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const installDir = join(root, 'dsh-install', 'node_modules', '@deepseek-ai', 'dsh')
  const bundleDir = join(root, 'dsh-install', 'node_modules', '@deepseek-ai', 'dsh-base')
  await writeFile(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: subagent',
    "      name: '@deepseek-ai/dsh-subagent'",
    '    - id: web-search-deepseek',
    "      name: '@deepseek-ai/dsh-web-search-deepseek'",
    '    - id: unrelated-plugin',
    "      name: '@deepseek-ai/dsh-other'",
    '',
  ].join('\n'))
  // web-app is applied after base: its override must win over the base default.
  await writeFile(join(root, 'dsh-install', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'), [
    '- id: web-search-deepseek',
    '  disabled: true',
    '',
  ].join('\n'))
  await writeFile(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: subagent\n  disabled: true\n')

  const previous = process.env.DSH_INSTALL_DIR
  process.env.DSH_INSTALL_DIR = installDir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = previous
  })

  const rows = await readBuiltinCapabilities(dshHome, 'desktop')
  assert.deepEqual(rows.map((row) => row.id), ['subagent', 'web-search-deepseek'])
  assert.equal(rows.find((row) => row.id === 'subagent').enabled, false)
  assert.equal(rows.find((row) => row.id === 'web-search-deepseek').enabled, false)
})

test('backup plugin inventory lists other devices and installs their package', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-plugin-install-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const backup = join(root, 'backup')

  async function makeDevice(letter) {
    const dshHome = join(root, letter, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', 'desktop')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: letter === 'a' ? { 'demo-plugin': '1.2.3' } : {},
      dsh: { profile: { bundles: [] } },
    }, null, 2) + '\n')
    const engine = await new SyncEngine({ dshHome, agentsHome: join(root, letter, 'agents'), stateRoot: join(root, letter, 'state') }).init()
    return { engine, dshHome, profileDir }
  }

  const a = await makeDevice('a')
  const pluginDir = join(a.profileDir, 'node_modules', 'demo-plugin')
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n')
  await writeFile(join(pluginDir, 'index.js'), 'export const demo = true\n')
  const [targetA] = await a.engine.upsertTarget({ name: 'backup', path: backup })
  await a.engine.saveSettings({ scopes: { plugins: { selectedPlugins: ['demo-plugin'], profile: 'desktop' } } })
  await a.engine.sync({ targetId: targetA.id, scopeIds: ['plugins'], direction: 'push' })

  const b = await makeDevice('b')
  const [targetB] = await b.engine.upsertTarget({ name: 'backup', path: backup })
  const inventory = await b.engine.listBackupPlugins({ targetId: targetB.id })
  const row = inventory.plugins.find((item) => item.name === 'demo-plugin')
  assert.ok(row)
  assert.equal(row.own, false)
  assert.equal(row.synced, false)
  assert.equal(row.version, '1.2.3')

  const installed = await b.engine.installBackupPlugin({ targetId: targetB.id, deviceId: row.deviceId, name: 'demo-plugin' })
  assert.ok(installed.files >= 2)
  const installedPkg = JSON.parse(await fsp.readFile(join(b.profileDir, 'node_modules', 'demo-plugin', 'package.json'), 'utf8'))
  assert.equal(installedPkg.version, '1.2.3')
  const profilePkg = JSON.parse(await fsp.readFile(join(b.profileDir, 'package.json'), 'utf8'))
  assert.equal(profilePkg.dependencies['demo-plugin'], '1.2.3')
  assert.ok(profilePkg.dsh.profile.bundles.includes('demo-plugin'))
})

test('plugin state captures bundles and disabled overrides and applies them back', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-plugin-state-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const dir = join(dshHome, 'profiles', 'desktop')
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@demo/one': '1.0.0', '@deepseek-ai/dsh-experimental-auto-review': '0.1.0' },
    dsh: { profile: { bundles: ['@demo/one', '@deepseek-ai/dsh-experimental-auto-review', 'missing-bundle'] } },
  }, null, 2) + '\n')
  await writeFile(join(dir, 'cordis.patch.yml'), [
    '- id: builtin-a',
    '  disabled: false',
    '- id: builtin-b',
    '  disabled: true',
    '',
  ].join('\n'))

  assert.deepEqual(parseDisabledOverrides(await fsp.readFile(join(dir, 'cordis.patch.yml'), 'utf8')), {
    'builtin-a': false,
    'builtin-b': true,
  })

  const state = await readPluginState(dshHome, 'desktop')
  assert.deepEqual(state.bundles, ['@demo/one', '@deepseek-ai/dsh-experimental-auto-review', 'missing-bundle'])
  assert.deepEqual(state.disabled, { 'builtin-a': false, 'builtin-b': true })

  await applyPluginState(dshHome, 'desktop', {
    schema: 'dsh-sync-hub/v1/plugin-state',
    profile: 'desktop',
    bundles: ['@demo/one'],
    disabled: { 'builtin-a': true, 'builtin-c': false },
  })

  const pkg = JSON.parse(await fsp.readFile(join(dir, 'package.json'), 'utf8'))
  // Uninstalled bundles are dropped; installed ones follow the backup exactly.
  assert.deepEqual(pkg.dsh.profile.bundles, ['@demo/one'])
  const patch = await fsp.readFile(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: builtin-a\n  disabled: true/)
  assert.match(patch, /- id: builtin-c\n  disabled: false/)

  // Full rows carry built-in capability / experimental plugin configuration.
  await applyPluginState(dshHome, 'desktop', {
    schema: 'dsh-sync-hub/v1/plugin-state',
    profile: 'desktop',
    bundles: ['@demo/one'],
    rows: [
      { id: 'builtin-a', text: '- id: builtin-a\n  config:\n    enabled: true' },
      { id: 'web-search', text: '- id: web-search\n  config:\n    provider: duckduckgo' },
    ],
  })
  const merged = await fsp.readFile(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(merged, /- id: builtin-a\n  config:\n    enabled: true/)
  assert.match(merged, /- id: web-search\n  config:\n    provider: duckduckgo/)
})
