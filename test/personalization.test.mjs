/**
 * Personalization scopes: meme packs, skins and pets.
 *
 * These scopes cover large user-owned asset trees plus the small state files
 * that remember the current selection, so the tests pin down three things:
 * which sources each scope maps to, which state files travel with them, and
 * which cache/staging paths must never be copied.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanScope } from '../lib/core/scan.js'
import { buildScopeManifest } from '../lib/core/manifest.js'
import { SCOPES, defaultScopeSettings, getScope, scopeSources } from '../lib/core/scopes.js'
import { normalizeSettings } from '../lib/core/state.js'

async function writeFile(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

/** Build a home directory with one asset of each personalization kind. */
async function makeHome(root) {
  const home = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  // Meme packs plus the selection baseline.
  await writeFile(join(home, 'meme-packs', 'whale-girl-emoji', 'happy', 'deyi.webp'), 'meme')
  await writeFile(join(home, 'dsh-expression.json'), '{"bundledBaseline":{"version":"0.1.76"}}\n')
  // Skins, the wallpaper store and the active-skin record.
  await writeFile(join(home, 'skins', 'pink-sakura', 'skin.json'), '{"id":"pink-sakura"}\n')
  await writeFile(join(home, 'skins', 'pink-sakura', 'assets', 'bg.webp'), 'bg')
  await writeFile(join(home, 'skins', 'pink-sakura', 'hooks.mjs'), 'export const hooks = {}\n')
  await writeFile(join(home, 'skin-center', 'wallpapers', 'sakura.webp'), 'wallpaper')
  await writeFile(join(home, 'skin-center', 'wallpapers', '.cache', 'we-tokens.json'), '{}')
  await writeFile(join(home, 'skin-center-active.json'), '{"active":"pink-sakura"}\n')
  // Pets, their state, and the staging sibling an interrupted install leaves.
  await writeFile(join(home, 'pets', 'miku', 'pet.json'), '{"id":"miku"}\n')
  await writeFile(join(home, 'pets', 'miku', 'thumb', 'idle', '0.webp'), 'frame')
  await writeFile(join(home, 'pets', 'miku', 'previews', 'idle.webp'), 'preview')
  await writeFile(join(home, 'pets', 'miku.install-abc123', 'pet.json'), '{"partial":true}\n')
  await writeFile(join(home, 'pet.json'), '{"petId":"miku"}\n')
  return { home, agentsHome }
}

const contextOf = ({ home, agentsHome }) => ({
  dshHome: home,
  agentsHome,
  settings: defaultScopeSettings(),
})

const sourceKeys = (sources) => sources.map((source) => source.rel ?? source.relPrefix).sort()

test('personalization scopes are declared and enabled by default', () => {
  const ids = SCOPES.map((scope) => scope.id)
  for (const id of ['memes', 'skins', 'pets']) {
    assert.ok(ids.includes(id), `${id} must be a declared scope`)
    // User-owned assets: a conflicting edit keeps both sides instead of picking a winner.
    assert.equal(getScope(id).policy, 'keep-both')
    assert.equal(defaultScopeSettings()[id].enabled, true)
  }
})

test('each personalization scope maps to its sources under the dsh home', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-personal-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const home = await makeHome(root)

  assert.deepEqual(sourceKeys(await scopeSources('memes', contextOf(home))), [
    'dsh-expression.json',
    'meme-packs',
  ])
  assert.deepEqual(sourceKeys(await scopeSources('skins', contextOf(home))), [
    'skin-center',
    'skin-center-active.json',
    'skins',
  ])
  assert.deepEqual(sourceKeys(await scopeSources('pets', contextOf(home))), [
    'pet.json',
    'pets',
  ])
})

test('scanning keeps assets and state files but drops caches and staging dirs', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-personal-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const home = await makeHome(root)
  const context = contextOf(home)

  const memes = await scanScope('memes', context)
  assert.equal(memes.has('dsh-expression.json'), true)
  assert.equal(memes.has('meme-packs/whale-girl-emoji/happy/deyi.webp'), true)

  const skins = await scanScope('skins', context)
  assert.equal(skins.has('skins/pink-sakura/skin.json'), true)
  assert.equal(skins.has('skins/pink-sakura/assets/bg.webp'), true)
  assert.equal(skins.has('skins/pink-sakura/hooks.mjs'), true)
  assert.equal(skins.has('skin-center/wallpapers/sakura.webp'), true)
  assert.equal(skins.has('skin-center-active.json'), true)
  assert.equal(skins.has('skin-center/wallpapers/.cache/we-tokens.json'), false)

  const pets = await scanScope('pets', context)
  assert.equal(pets.has('pet.json'), true)
  assert.equal(pets.has('pets/miku/thumb/idle/0.webp'), true)
  assert.equal(pets.has('pets/miku/previews/idle.webp'), true)
  assert.equal(pets.has('pets/miku.install-abc123/pet.json'), false)

  // Every entry carries a measured size, which the planner and the settings
  // panel both rely on.
  for (const entries of [memes, skins, pets]) {
    for (const entry of entries.values()) {
      assert.equal(entry.isDir, false)
      assert.ok(entry.size > 0, entry.rel)
    }
  }

  // The manifest is what the planner groups by scope; it must stamp the real
  // scope id (the scanner's per-entry field is only a walk-local hint).
  const manifest = await buildScopeManifest('pets', pets)
  assert.equal(manifest.files['pet.json'].scope, 'pets')
  assert.equal(manifest.files['pets/miku/thumb/idle/0.webp'].scope, 'pets')
  assert.equal(Object.keys(manifest.files).includes('pets/miku.install-abc123/pet.json'), false)
})

test('settings saved before these scopes existed pick them up on load', () => {
  const normalized = normalizeSettings({ scopes: { 'agents-md': { enabled: false } } })
  assert.equal(normalized.scopes.memes.enabled, true)
  assert.equal(normalized.scopes.skins.enabled, true)
  assert.equal(normalized.scopes.pets.enabled, true)
  // An explicit user choice is preserved.
  assert.equal(normalized.scopes['agents-md'].enabled, false)
})
