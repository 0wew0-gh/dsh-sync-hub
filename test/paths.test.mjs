import test from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { resolveDshVersion, resolveInside } from '../lib/core/paths.js'

test('resolveInside allows a filesystem root as the target directory', () => {
  const root = process.platform === 'win32' ? 'C:\\' : '/'
  const inside = resolveInside(root, 'dsh-sync-v0.4.4')
  assert.equal(inside, join(root, 'dsh-sync-v0.4.4'))

  assert.throws(() => resolveInside(join(root, 'backup'), '..' + sep + 'escape'))
})

test('resolveDshVersion reads the installed dsh package, including inside app.asar', { skip: !process.env.DSH_INSTALL_DIR }, () => {
  const version = resolveDshVersion()
  assert.notEqual(version, 'unknown')
  assert.match(version, /^\d+\.\d+/)
})
