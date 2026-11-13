import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client bundle follows the DSH module-loader contract', async () => {
  const source = await fsp.readFile(join(root, 'lib', 'client.js'), 'utf8')
  const expectedId = pkg.name
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, new RegExp(`id:\\s*['"]${expectedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`))
  assert.match(source, /factory:\s*\(require\)\s*=>/)
  assert.match(source, /require\('react'\)/)
  assert.match(source, /inject:\s*\['slots',\s*'locale'\]/)
  assert.match(source, /settings\.plugins\.tab/)
  assert.match(source, /settings\.section/)
  assert.match(source, /sidebar\.footer\.action/)
  assert.match(source, /sidebar\.right\.pane\.tab/)
  assert.match(source, /sidebarRightTabs/)
  assert.match(source, /speedBytesPerSec/)
  assert.match(source, /autoSync/)
  assert.match(source, /sidebar\.inject|sidebar\.register|sidebar\.footer\.action/)
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.inject.length, 0, 'dsh.client.inject must list package names only')
})

test('plugin display metadata is valid for the DSH plugin inventory', async () => {
  // The inventory reads description/title from exported locale/*.json meta and
  // the icon from a manifest-relative file no larger than 256 KiB.
  assert.equal(pkg.icon, './assets/icon.svg')
  const iconStat = await fsp.stat(join(root, pkg.icon))
  assert.ok(iconStat.size <= 256 * 1024, 'icon exceeds the 256 KiB DSH limit')
  for (const language of ['en', 'zh', 'zh-cn']) {
    const exported = pkg.exports[`./locale/${language}.json`]
    assert.equal(exported, `./locale/${language}.json`, `locale/${language}.json must be exported`)
    const meta = JSON.parse(await fsp.readFile(join(root, exported), 'utf8'))
    assert.equal(typeof meta.meta?.title, 'string')
    assert.ok(meta.meta.title.length > 0)
    assert.equal(typeof meta.meta?.description, 'string')
  }
  const english = JSON.parse(await fsp.readFile(join(root, 'locale', 'en.json'), 'utf8'))
  const chinese = JSON.parse(await fsp.readFile(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(english.meta.title, 'Data Sync')
  assert.equal(chinese.meta.title, '数据同步')
})
