import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SyncEngine } from '../lib/core/engine.js'

async function writeFile(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

async function makeEngine(root, name) {
  const engine = new SyncEngine({
    dshHome: join(root, `${name}-home`),
    agentsHome: join(root, `${name}-agents`),
    stateRoot: join(root, `${name}-state`),
  })
  return await engine.init()
}

test('custom directory and file items sync by name and honor per-device paths', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-custom-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const projectDir = join(root, 'work', 'project-a')
  await writeFile(join(projectDir, 'README.md'), '# project\n')
  await writeFile(join(projectDir, 'src', 'main.js'), 'console.log(1)\n')
  await writeFile(join(projectDir, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
  const singleFile = join(root, 'notes.txt')
  await writeFile(singleFile, 'hello custom file\n')

  const engineA = await makeEngine(root, 'a')
  await engineA.saveSettings({
    deviceName: 'PC-A',
    customItems: [
      { id: 'c_dir', name: '项目目录', type: 'dir', path: projectDir },
      { id: 'c_file', name: '备注文件', type: 'file', path: singleFile },
    ],
  })
  const backup = join(root, 'backup')
  const targetId = (await engineA.upsertTarget({ name: 'backup', path: backup }))[0].id
  const first = await engineA.sync({ targetId })
  assert.ok(first.summary.uploaded >= 3, JSON.stringify(first.summary))

  const settingsForManifest = await engineA.getSettings()
  const manifestText = await fsp.readFile(
    join(backup, settingsForManifest.targets[0].prefix, 'manifests', settingsForManifest.deviceId + '.json'),
    'utf8',
  )
  assert.ok(manifestText.includes('custom/c_dir/README.md'))
  assert.ok(manifestText.includes('custom/c_dir/src/main.js'))
  assert.ok(manifestText.includes('custom/c_file/file'))
  assert.ok(!manifestText.includes('node_modules'))

  // Device B uses the same item definitions but its own directories.
  const projectDirB = join(root, 'work', 'project-b')
  const singleFileB = join(root, 'notes-b.txt')
  const engineB = await makeEngine(root, 'b')
  const settingsA = await engineA.getSettings()
  await engineB.saveSettings({
    deviceName: 'PC-B',
    customItems: [
      { ...settingsA.customItems[0], path: projectDir, devicePaths: { 'PC-B': projectDirB } },
      { ...settingsA.customItems[1], path: singleFile, devicePaths: { 'PC-B': singleFileB } },
    ],
  })
  const bTargetId = (await engineB.upsertTarget({ name: 'restore', path: backup }))[0].id
  await engineB.sync({ targetId: bTargetId, direction: 'pull' })

  assert.equal(await fsp.readFile(join(projectDirB, 'README.md'), 'utf8'), '# project\n')
  assert.equal(await fsp.readFile(join(projectDirB, 'src', 'main.js'), 'utf8'), 'console.log(1)\n')
  assert.equal(await fsp.readFile(singleFileB, 'utf8'), 'hello custom file\n')
})

test('a target resolves its directory per device', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-target-device-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const backupA = join(root, 'backup-a')
  const backupB = join(root, 'backup-b')

  const engineA = await makeEngine(root, 'a')
  await writeFile(join(engineA.dshHome, 'AGENTS.md'), '# rules\n')
  await engineA.saveSettings({ deviceName: 'PC-A' })
  const targets = await engineA.upsertTarget({
    name: 'shared config',
    path: backupA,
    devicePaths: { 'PC-B': backupB },
  })
  const targetId = targets[0].id
  await engineA.sync({ targetId })

  // Simulate the shared repository being available at B's own directory.
  await fsp.cp(backupA, backupB, { recursive: true })

  const engineB = await makeEngine(root, 'b')
  const settingsA = await engineA.getSettings()
  await engineB.saveSettings({ deviceName: 'PC-B', targets: settingsA.targets })
  const bTargetId = (await engineB.listTargets())[0].id
  await engineB.sync({ targetId: bTargetId, direction: 'pull' })

  assert.equal(await fsp.readFile(join(engineB.dshHome, 'AGENTS.md'), 'utf8'), '# rules\n')
  assert.equal((await engineB.listTargets())[0].effectivePath, backupB)
})

test('custom item CRUD validates paths, types and duplicate names', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'dsh-sync-custom-crud-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const engine = await makeEngine(root, 'a')
  const dirA = join(root, 'dir-a')
  const dirB = join(root, 'dir-b')
  await fsp.mkdir(dirA, { recursive: true })
  await fsp.mkdir(dirB, { recursive: true })

  const added = await engine.upsertCustomItem({ name: '源码', type: 'dir', path: dirA })
  assert.equal(added.name, '源码')
  assert.equal(added.path, dirA)
  assert.ok(added.id)

  const updated = await engine.upsertCustomItem({ id: added.id, name: '源码2', enabled: false })
  assert.equal(updated.name, '源码2')
  assert.equal(updated.enabled, false)
  assert.equal(updated.path, dirA)

  await assert.rejects(
    engine.upsertCustomItem({ create: true, name: '源码2', type: 'dir', path: dirB }),
    /同名/
  )
  await assert.rejects(
    engine.upsertCustomItem({ name: '不存在', type: 'dir', path: join(root, 'missing') }),
    /不存在/
  )
  await assert.rejects(
    engine.upsertCustomItem({ name: '类型不符', type: 'file', path: dirB }),
    /不是文件/
  )

  const removed = await engine.removeCustomItem('源码2')
  assert.equal(removed.id, added.id)
  assert.equal((await engine.listCustomItems()).length, 0)
  await assert.rejects(engine.removeCustomItem('源码2'), /找不到/)
})
