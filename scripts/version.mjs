#!/usr/bin/env node
/**
 * 统一改版本号。
 *
 *   npm run version:set -- v0.1.3
 *   npm run version:set -- 0.1.3
 *
 * 改这些地方：
 *   · 根 package.json
 *   · 所有 apps/<name>/package.json
 *   · package-lock.json 里对应的 version 字段（根 + 各 workspace 条目）
 *   · apps/server 里三处硬编码的版本号（app.ts 的 VERSION、
 *     /api/health 与 state-ws 的 `version`）—— 它们不读 package.json，
 *     漏掉会出现「装的包是新版、接口自报旧版」。
 *
 * 不碰 packages/*：它们是内部包、依赖关系用 `*`，版本号不参与发布。
 * 不碰 apps/mobile/android/**：那是 cap sync 的生成物（已 ignore）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(`\n[version] ${message}\n`)
  process.exit(1)
}

const raw = process.argv[2]?.trim()
if (!raw) {
  fail('缺少 tag 号。用法：npm run version:set -- v0.1.3（也接受不带 v 的 0.1.3）')
}

const version = raw.replace(/^v/i, '')
if (!SEMVER.test(version)) {
  fail(`不是合法的版本号：${raw}。示例：v0.1.3 / 1.2.0 / 1.2.0-beta.1`)
}

const changed = []
const unchanged = []

/** 读 JSON 时保留原文件的缩进与结尾换行（这两个文件都是 2 空格 + 末尾换行）。 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function setVersion(file, holder, label) {
  if (!holder || typeof holder.version !== 'string') return
  if (holder.version === version) {
    unchanged.push(label)
    return
  }
  const from = holder.version
  holder.version = version
  changed.push(`${label}: ${from} -> ${version}`)
}

// ---- package.json（根 + apps/*）--------------------------------------------
const rootPkgFile = join(ROOT, 'package.json')
const rootPkg = readJson(rootPkgFile)
setVersion(rootPkgFile, rootPkg, 'package.json')
writeJson(rootPkgFile, rootPkg)

const appsDir = join(ROOT, 'apps')
const appNames = readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(appsDir, name, 'package.json'))
      return true
    } catch {
      return false
    }
  })
  .sort()

for (const name of appNames) {
  const file = join(appsDir, name, 'package.json')
  const pkg = readJson(file)
  setVersion(file, pkg, `apps/${name}/package.json`)
  writeJson(file, pkg)
}

// ---- package-lock.json -----------------------------------------------------
const lockFile = join(ROOT, 'package-lock.json')
const lock = readJson(lockFile)
if (lock.packages) {
  setVersion(lockFile, lock.packages[''], 'package-lock.json (root)')
  if (typeof lock.version === 'string' && lock.version !== version) {
    changed.push(`package-lock.json (lock.version): ${lock.version} -> ${version}`)
    lock.version = version
  }
  for (const name of appNames) {
    const key = `apps/${name}`
    if (lock.packages[key]) setVersion(lockFile, lock.packages[key], `package-lock.json (${key})`)
  }
  writeJson(lockFile, lock)
}

// ---- apps/server 里硬编码的版本号 -------------------------------------------
function replaceInFile(file, pattern, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (!pattern.test(text)) {
    console.warn(`[version] 跳过 ${label}：没匹配到版本号，请手工确认`)
    return
  }
  const next = text.replace(pattern, (_match, prefix, suffix) => `${prefix}${version}${suffix}`)
  if (next === text) {
    unchanged.push(label)
    return
  }
  writeFileSync(file, next)
  changed.push(label)
}

replaceInFile(
  join(ROOT, 'apps/server/src/app.ts'),
  /(const VERSION = ')[^']*(')/,
  'apps/server/src/app.ts (VERSION)'
)
replaceInFile(
  join(ROOT, 'apps/server/src/api/health/route.ts'),
  /(name: 'fizz-server',\s*\n\s*version: ')[^']*(')/,
  'apps/server/src/api/health/route.ts (version)'
)
replaceInFile(
  join(ROOT, 'apps/server/src/server/state-ws.ts'),
  /(name: 'fizz-server',\s*\n\s*version: ')[^']*(')/,
  'apps/server/src/server/state-ws.ts (version)'
)

// ---- 汇总 ------------------------------------------------------------------
if (changed.length > 0) {
  console.log(`[version] 已更新到 ${version}：`)
  for (const line of changed) console.log(`  · ${line}`)
} else {
  console.log(`[version] 所有位置已经是 ${version}，无需改动`)
}
if (unchanged.length > 0) {
  console.log(`[version] 已是 ${version}：${unchanged.join('、')}`)
}
