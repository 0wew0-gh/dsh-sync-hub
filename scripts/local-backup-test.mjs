#!/usr/bin/env node
/**
 * Local backup test.
 *
 * Builds a synthetic DSH home inside `test-backups/`, backs it up to another
 * folder in the same directory, then verifies:
 *   1. first run uploads everything (minus hard excludes),
 *   2. second run is a pure no-op ("same content is not overwritten"),
 *   3. restoring into an empty home reproduces byte-identical files.
 *
 * Run: node scripts/local-backup-test.mjs
 */

import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { SyncEngine } from '../lib/core/engine.js'

const root = resolve(process.cwd(), 'test-backups')
const workspace = join(root, 'local-run')

async function writeFile(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function makeFixture(home, agentsHome) {
  await writeFile(join(home, 'AGENTS.md'), '# 全局规则（测试夹具）\n\n- 使用简体中文\n- 不要泄露凭据\n')
  await writeFile(
    join(home, 'profiles', 'web', 'package.json'),
    JSON.stringify({ name: 'profile-web-fixture', dependencies: { 'fixture-plugin': '1.0.0' } }, null, 2),
  )
  await writeFile(
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    '- id: fixture-plugin\n  config:\n    enabled: true\n',
  )
  await writeFile(join(home, 'plugins', 'fixture-plugin', 'index.js'), 'export function apply() {}\n')
  await writeFile(
    join(agentsHome, 'skills', 'fixture-skill', 'SKILL.md'),
    '# fixture-skill\n\n演示用技能，仅存在于测试夹具中。\n',
  )
  await writeFile(join(agentsHome, '.skill-lock.json'), '{"version":3}\n')
  const frames = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"session","version":4,"id":"fixture"}\n')),
    zstdCompressSync(Buffer.from('{"type":"user/message","seq":1,"data":{"text":"hello"}}\n')),
  ])
  await writeFile(join(home, 'sessions', '--D-demo-project--', 'session-fixture', 'session.v4.jsonl.zstd'), frames)
  // 必须被排除的内容
  await writeFile(join(home, '.credentials.yaml'), 'token: never-sync\n')
  await writeFile(join(home, 'profiles', 'web', 'node_modules', 'fixture-plugin', 'index.js'), 'nope\n')
  await writeFile(join(home, 'temp', 'debug.log'), 'nope\n')
  await writeFile(join(home, 'plugins', 'fixture-plugin', 'build.log'), 'nope\n')
}

async function listFiles(dir) {
  const out = []
  async function walk(abs, rel) {
    let items
    try {
      items = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) await walk(join(abs, item.name), childRel)
      else if (item.isFile()) out.push(childRel)
    }
  }
  await walk(dir, '')
  return out.sort()
}

async function hashTree(roots) {
  const result = new Map()
  for (const [label, base] of Object.entries(roots)) {
    for (const rel of await listFiles(base)) {
      result.set(`${label}:${rel}`, sha256(await fsp.readFile(join(base, rel))))
    }
  }
  return result
}
function printSummary(title, summary) {
  console.log(`\n${title}`)
  console.log(`  相同跳过: ${summary.identical}`)
  console.log(`  计划上传: ${summary.upload}（实际传输 ${summary.uploaded} 个内容块）`)
  console.log(`  计划下载: ${summary.download}（实际写入 ${summary.downloaded} 个文件）`)
  console.log(`  冲突: ${summary.conflict}（保留双方 ${summary.conflicts} 个）`)
  console.log(`  跳过: ${summary.skip}`)
  console.log(`  字节: 上传 ${summary.bytesUploaded} / 下载 ${summary.bytesDownloaded}`)
}

async function main() {
  await fsp.rm(workspace, { recursive: true, force: true })
  const home = join(workspace, 'home')
  const agentsHome = join(workspace, 'agents-home')
  const stateRoot = join(workspace, 'state')
  const backupStore = join(workspace, 'backup-store')
  const restoreHome = join(workspace, 'restore-home')
  const restoreAgents = join(workspace, 'restore-agents')
  await makeFixture(home, agentsHome)

  const engine = await new SyncEngine({ dshHome: home, agentsHome, stateRoot }).init()
  const targetId = (await engine.upsertTarget({ name: '本地备份（测试）', path: backupStore }))[0].id

  console.log(`测试目录: ${workspace}`)
  console.log(`备份目标: ${backupStore}`)

  const settings = await engine.getSettings()
  settings.deviceName = 'test-pc'
  await engine.saveSettings(settings)

  const first = await engine.sync({ targetId, direction: 'push' })
  printSummary('第一次同步（应全部上传）', first.summary)
  if (first.summary.uploaded < 7) throw new Error('第一次同步上传数量不足')

  const mtimes = new Map()
  for (const rel of ['AGENTS.md', 'profiles/web/package.json', 'sessions/--D-demo-project--/session-fixture/session.v4.jsonl.zstd']) {
    mtimes.set(join(home, rel), (await fsp.stat(join(home, rel))).mtimeMs)
  }

  const second = await engine.sync({ targetId, direction: 'push' })
  printSummary('第二次同步（应全部相同跳过）', second.summary)
  if (second.summary.uploaded !== 0 || second.summary.identical < 7) {
    throw new Error('第二次同步没有做到“相同内容不覆盖”')
  }
  for (const [file, mtime] of mtimes) {
    if ((await fsp.stat(file)).mtimeMs !== mtime) throw new Error(`mtime 被改动: ${file}`)
  }

  const restoreEngine = await new SyncEngine({
    dshHome: restoreHome,
    agentsHome: restoreAgents,
    stateRoot: join(workspace, 'restore-state'),
  }).init()
  const restoreTargetId = (await restoreEngine.upsertTarget({ name: '恢复（测试）', path: backupStore }))[0].id
  const restored = await restoreEngine.sync({ targetId: restoreTargetId, direction: 'pull' })
  printSummary('恢复到全新目录（应全部下载）', restored.summary)

  const expected = [
    [join(home, 'AGENTS.md'), join(restoreHome, 'AGENTS.md')],
    [join(home, 'profiles', 'web', 'package.json'), join(restoreHome, 'profiles', 'web', 'package.json')],
    [join(home, 'profiles', 'web', 'cordis.patch.yml'), join(restoreHome, 'profiles', 'web', 'cordis.patch.yml')],
    [join(home, 'plugins', 'fixture-plugin', 'index.js'), join(restoreHome, 'plugins', 'fixture-plugin', 'index.js')],
    [join(home, 'sessions', '--D-demo-project--', 'session-fixture', 'session.v4.jsonl.zstd'), join(restoreHome, 'sessions', '--D-demo-project--', 'session-fixture', 'session.v4.jsonl.zstd')],
    [join(agentsHome, 'skills', 'fixture-skill', 'SKILL.md'), join(restoreAgents, 'skills', 'fixture-skill', 'SKILL.md')],
    [join(agentsHome, '.skill-lock.json'), join(restoreAgents, '.skill-lock.json')],
  ]
  for (const [source, destination] of expected) {
    const sourceHash = sha256(await fsp.readFile(source))
    const restoreHash = sha256(await fsp.readFile(destination))
    if (sourceHash !== restoreHash) throw new Error(`恢复内容不一致: ${destination}`)
  }

  const restoreFiles = [
    ...(await listFiles(restoreHome)).map((rel) => `home:${rel}`),
    ...(await listFiles(restoreAgents)).map((rel) => `agents:${rel}`),
  ]
  for (const forbidden of ['.credentials.yaml', 'node_modules', 'temp/', 'build.log']) {
    if (restoreFiles.some((rel) => rel.includes(forbidden))) {
      throw new Error(`排除项泄漏进了备份/恢复: ${forbidden}`)
    }
  }
  console.log(`\n恢复文件清单（${restoreFiles.length} 个，已排除凭据/依赖/日志）:`)
  for (const rel of restoreFiles) console.log(`  ${rel}`)

  console.log('\n[通过] 本地备份 / 相同内容不覆盖 / 恢复校验 全部成功')
  const repoFiles = await listFiles(backupStore)
  console.log(`备份仓库内对象: ${repoFiles.length} 个（${backupStore}）`)
}

main().catch((error) => {
  console.error('\n[失败]', error)
  process.exitCode = 1
})
