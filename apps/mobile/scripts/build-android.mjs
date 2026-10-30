/**
 * 跨平台跑 Android **release** 构建（`./gradlew assembleRelease`）。
 *
 * 为什么不用 `cap build android`：
 *  - 它默认打 AAB，且会在 Gradle 之后再调一次 `apksigner`/`jarsigner`，
 *    没传 `--keystorepath` 直接报错；签名参数和 build.gradle 里的 `signingConfigs` 是两套。
 *  - 我们的固定签名在 `app/build.gradle`（见 configure-android-signing.mjs），
 *    直接用 Gradle 的 release 任务即可，产物是已签名的 `app-release.apk`。
 *
 * Windows 用 `gradlew.bat`，其余平台用 `./gradlew`，避免 npm script 里写平台判断。
 * 签名环境变量缺失时 configure 脚本会让 release 退回 debug 签名（见那边的注释）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const androidDir = join(root, 'android')
const wrapper = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')

if (!existsSync(wrapper)) {
  console.error('[mobile] 找不到 android/gradlew，先跑 npm run add:android')
  process.exit(1)
}

const result = spawnSync(wrapper, ['assembleRelease'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

if (result.error) {
  console.error('[mobile] 启动 gradle 失败：', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
