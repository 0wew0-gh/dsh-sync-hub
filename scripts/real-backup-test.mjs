#!/usr/bin/env node
/**
 * Real-data local backup test (read-only on the real DSH home).
 *
 * Backs up a selected subset of the real environment into
 * `test-backups/real-backup/`; never writes to the real DSH home. The first
 * run uploads, the second run must report every file as identical.
 *
 * Usage:
 *   node scripts/real-backup-test.mjs            # config + skills
 *   node scripts/real-backup-test.mjs --sessions # also sessions (large)
 */

import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import { SyncEngine } from '../lib/core/engine.js'
import { resolveAgentsHome, resolveDshHome } from '../lib/core/paths.js'

const args = new Set(process.argv.slice(2))
const includeSessions = args.has('--sessions')

const workspace = resolve(process.cwd(), 'test-backups', 'real-run')
const stateRoot = join(workspace, 'state')
const backupStore = join(workspace, 'backup-store')

const dshHome = resolveDshHome()
const agentsHome = resolveAgentsHome()

function printSummary(title, summary) {
  console.log(`\n${title}`)
  console.log(`  相同跳过: ${summary.identical}`)
  console.log(`  上传: ${summary.upload}（实际 ${summary.uploaded}）`)
  console.log(`  下载: ${summary.download}（实际 ${summary.downloaded}）`)
  console.log(`  冲突: ${summary.conflict}`)
  console.log(`  字节: 上传 ${summary.bytesUploaded}`)
}

async function main() {
  console.log(`DSH_HOME: ${dshHome}`)
  console.log(`AGENTS_HOME: ${agentsHome}`)
  console.log(`备份目标: ${backupStore}`)

  const engine = await new SyncEngine({ dshHome, agentsHome, stateRoot }).init()
  const settings = await engine.getSettings()
  settings.deviceName = 'backup-test-pc'
  settings.scopes['plugin-settings'].profiles = ['web']
  settings.scopes.sessions.enabled = includeSessions
  settings.scopes.attachments.enabled = false
  settings.scopes.storages.enabled = false
  await engine.saveSettings(settings)

  const targets = await engine.upsertTarget({ name: '真实数据本地备份（测试）', path: backupStore })
  const targetId = targets[0].id

  const estimate = await engine.estimateScopes({ targetId })
  console.log('\n预估同步项:')
  for (const row of estimate.scopes) {
    if (!row.enabled) continue
    console.log(`  ${row.id}: ${row.files} 个文件 / ${row.bytes} 字节`)
  }

  const first = await engine.sync({ targetId, direction: 'push' })
  printSummary('第一次同步（备份真实数据到本地目录）', first.summary)

  const second = await engine.sync({ targetId, direction: 'push' })
  printSummary('第二次同步（应全部相同跳过）', second.summary)
  if (second.summary.uploaded !== 0) {
    throw new Error(`第二次同步仍上传了 ${second.summary.uploaded} 个内容块，说明“相同内容不覆盖”未生效`)
  }

  console.log('\n[通过] 真实数据本地备份成功，重复同步未产生任何上传')
  console.log(`备份仓库: ${backupStore}`)
}

main().catch((error) => {
  console.error('\n[失败]', error)
  process.exitCode = 1
})
