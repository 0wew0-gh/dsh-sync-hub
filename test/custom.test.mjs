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

  const manifestText = await fsp.readFile(
    join(backup, 'dsh-sync', 'v1', 'manifests', (await engineA.getSettings()).deviceId + '.json'),
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
