/**
 * 把 `apps/mobile/package.json` 的版本号写进 Android 的 `app/build.gradle`。
 *
 * 为什么需要这一步：Android 安装包里「应用信息」看到的是 `versionName` / `versionCode`，
 * 它们只认 `build.gradle`，**不读 package.json**。`android/` 是 `cap add android` 的
 * 生成物（已 gitignore，模板里固定是 `versionCode 1` / `versionName "1.0"`），所以每次
 * 重建平台后都会退回 1.0 —— 只改 package.json 永远不会反映到安装包的版本上。
 *
 * `versionCode` 由 semver 推出：major*1000000 + minor*1000 + patch（至少为 1）。
 * 单调递增即可，不必与 `versionName` 逐字对应。
 *
 * 挂在 `npm run sync` 的最后（`cap sync` 不会覆盖 build.gradle，但重建平台会），
 * `build:android` 里也跑一次，避免有人跳过 sync 直接打 APK。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const gradlePath = join(root, 'android', 'app', 'build.gradle')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const versionName = typeof pkg.version === 'string' ? pkg.version : ''

if (!versionName) {
  console.error('[mobile] package.json 里没有 version，跳过 Android 版本号')
  process.exit(1)
}

if (!existsSync(gradlePath)) {
  console.log('[mobile] 还没有 android/ 平台，跳过版本号写入（先跑 npm run add:android）')
  process.exit(0)
}

/** 1.2.3-beta.1 → 1,2,3（预发布后缀不参与 Android 版本码） */
const parts = versionName
  .split('.')
  .map((part) => Number.parseInt(part, 10))
  .filter((part) => Number.isFinite(part))
while (parts.length < 3) parts.push(0)
const versionCode = Math.max(1, parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2])

let gradle = readFileSync(gradlePath, 'utf8')
const before = gradle
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`)

if (gradle === before) {
  console.log(`[mobile] Android 版本已是 ${versionName} (${versionCode})`)
} else {
  writeFileSync(gradlePath, gradle)
  console.log(`[mobile] Android 版本 → ${versionName} (${versionCode})`)
}
