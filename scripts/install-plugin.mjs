#!/usr/bin/env node
/**
 * Install / uninstall this plugin into a DSH profile without network access.
 *
 * The official `dsh plugin --profile <name> add` path forwards to pnpm, which
 * re-resolves every existing dependency and therefore needs the registry (and
 * git) even for a `link:` package. This script does the two things pnpm would
 * do for a bundle plugin and nothing else:
 *
 *   1. link the package into `<profile>/node_modules/<name>` (junction on
 *      Windows, symlink elsewhere);
 *   2. add the dependency and the `dsh.profile.bundles` entry to
 *      `<profile>/package.json` (atomic write, backup kept).
 *
 * Usage:
 *   node scripts/install-plugin.mjs --profile web
 *   node scripts/install-plugin.mjs --profile desktop
 *   node scripts/install-plugin.mjs --profile web --uninstall
 */

import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = resolve(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'))

function parseArgs(argv) {
  const options = { profile: '', uninstall: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') options.profile = argv[index += 1] || ''
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--force') options.force = true
    else if (!arg.startsWith('-') && !options.profile) options.profile = arg
  }
  return options
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${Date.now()}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
}

async function backupFiles(profileDir, files) {
  const dir = join(DSH_HOME, 'dsh-sync-hub-install-backup', timestamp(), basename(profileDir))
  await fsp.mkdir(dir, { recursive: true })
  const copied = []
  for (const file of files) {
    const source = join(profileDir, file)
    if (!existsSync(source)) continue
    await fsp.copyFile(source, join(dir, file))
    copied.push(file)
  }
  return { dir, copied }
}

/**
 * Remove a plugin link without ever following it.
 *
 * A recursive `rm` on a Windows junction traverses the link target, which would
 * delete the user's project directory. Junctions are directories to lstat but
 * reparse points to the OS, so unlink/rmdir are the only safe removals.
 */
async function removeLinkIfPresent(linkPath) {
  let stat
  try {
    stat = await fsp.lstat(linkPath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink()) {
    try {
      await fsp.unlink(linkPath)
      return true
    } catch (error) {
      if (!['EPERM', 'EISDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  if (stat.isDirectory()) {
    try {
      await fsp.rmdir(linkPath)
      return true
    } catch (error) {
      if (error.code === 'ENOTEMPTY') {
        throw new Error(`拒绝删除非空目录（不是一个链接）: ${linkPath}`)
      }
      throw error
    }
  }
  await fsp.unlink(linkPath)
  return true
}

async function linkPackage(profileDir, pluginName) {
  const linkPath = join(profileDir, 'node_modules', pluginName)
  await fsp.mkdir(join(profileDir, 'node_modules'), { recursive: true })
  try {
    const stat = await fsp.lstat(linkPath)
    if (stat.isSymbolicLink()) {
      const current = await fsp.readlink(linkPath)
      if (resolve(current) === projectRoot) return linkPath
    }
    await removeLinkIfPresent(linkPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await fsp.symlink(projectRoot, linkPath, type)
  return linkPath
}

async function removeLink(profileDir, pluginName) {
  const linkPath = join(profileDir, 'node_modules', pluginName)
  await removeLinkIfPresent(linkPath)
  return linkPath
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pkg = await readJson(join(projectRoot, 'package.json'), null)
  if (!pkg || !pkg.name) throw new Error('当前目录不是插件包目录（缺少 package.json.name）')
  const pluginName = pkg.name

  if (!options.profile) {
    console.error('用法: node scripts/install-plugin.mjs --profile <web|desktop> [--uninstall]')
    process.exitCode = 1
    return
  }
  const profileDir = join(DSH_HOME, 'profiles', options.profile)
  if (!existsSync(profileDir)) {
    throw new Error(`profile 不存在: ${profileDir}`)
  }
  const manifestPath = join(profileDir, 'package.json')
  const manifest = await readJson(manifestPath, null)
  if (!manifest) throw new Error(`profile 缺少 package.json: ${profileDir}`)

  const { dir: backupDir, copied } = await backupFiles(profileDir, ['package.json', 'cordis.patch.yml'])
  console.log(`已备份 ${copied.join(', ')} → ${backupDir}`)

  if (options.uninstall) {
    manifest.dependencies = manifest.dependencies || {}
    delete manifest.dependencies[pluginName]
    if (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) {
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== pluginName)
    }
    await writeJsonAtomic(manifestPath, manifest)
    const removed = await removeLink(profileDir, pluginName)
    console.log(`已从 ${options.profile} 卸载 ${pluginName}`)
    console.log(`已移除链接: ${removed}`)
    console.log('请完全退出并重启 DSH 以生效。')
    return
  }

  const linkPath = await linkPackage(profileDir, pluginName)
  console.log(`已建立链接: ${linkPath} → ${projectRoot}`)

  manifest.dependencies = manifest.dependencies || {}
  manifest.dependencies[pluginName] = `link:${projectRoot.replace(/\\/g, '/')}`
  manifest.dsh = manifest.dsh || {}
  manifest.dsh.profile = manifest.dsh.profile || {}
  manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  if (!manifest.dsh.profile.bundles.includes(pluginName)) {
    manifest.dsh.profile.bundles.push(pluginName)
  }
  await writeJsonAtomic(manifestPath, manifest)
  console.log(`已写入依赖与 bundle: ${pluginName}`)
  console.log('')
  console.log(`安装完成（profile: ${options.profile}）。请完全退出并重启 DSH，然后在 设置 → 插件 → 数据同步 中配置。`)
  console.log(`卸载: node scripts/install-plugin.mjs --profile ${options.profile} --uninstall`)
}

main().catch((error) => {
  console.error('[安装失败]', error.message)
  process.exitCode = 1
})
