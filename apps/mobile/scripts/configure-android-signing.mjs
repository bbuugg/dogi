/**
 * 给 `cap add android` 生成的 `android/app/build.gradle` 注入 **release 签名配置**。
 *
 * ## 为什么必须有这一步
 *
 * `android/` 是生成物（已 gitignore），`build.gradle` 模板里没有任何 `signingConfigs`，
 * 于是 `assembleRelease` 出来的是未签名包，`assembleDebug` 用的是**每台机器 / 每个
 * CI runner 现场生成**的 debug keystore —— 每次构建密钥都不同。
 *
 * 后果就是用户看到的那句「签名不一致」：新 APK 的签名和已安装版本对不上，Android 只允许
 * 先卸载再装，应用数据全丢。debug 签名从来不是「固定签名」，它只是本机第一次构建时随机生成、
 * 之后复用；换 runner / 清缓存就换一套。
 *
 * 这里把签名参数写成**从环境变量读取**，让本地与 CI 共用同一个 keystore：
 *
 *   FIZZ_ANDROID_KEYSTORE           keystore 文件路径（绝对或相对 app 模块）
 *   FIZZ_ANDROID_KEYSTORE_PASSWORD  store 密码
 *   FIZZ_ANDROID_KEY_ALIAS          key 别名
 *   FIZZ_ANDROID_KEY_PASSWORD       key 密码（不填则复用 store 密码）
 *
 * 没配 `FIZZ_ANDROID_KEYSTORE` 时退回 debug 签名，保证本地 `assembleRelease` 仍然可装，
 * 但这种包**不能覆盖安装已发布的固定签名版本**——真要分发必须配齐上面的变量。
 *
 * ## 为什么是「追加到文件末尾」而不是改写原块
 *
 * Gradle 允许同一个 `android { }` 在脚本里出现多次、对同一个 build type 多次配置会合并。
 * 追加一段独立的、带标记的配置块，`cap add` 重新生成后重跑本脚本即可还原，
 * 也不怕上游模板的字段顺序变化（逐条 `replace` 迟早会漏）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const gradlePath = join(root, 'android', 'app', 'build.gradle')

if (!existsSync(gradlePath)) {
  console.log('[mobile] 还没有 android/ 平台，跳过签名配置（先跑 npm run add:android）')
  process.exit(0)
}

const MARKER = 'fizz-android-signing'
const START = `// >>> ${MARKER}`
const END = `// <<< ${MARKER}`

const BLOCK = `${START} (由 scripts/configure-android-signing.mjs 生成，勿手改)
//
// 签名参数一律从环境变量取，本地与 CI 复用同一份 keystore：
//   FIZZ_ANDROID_KEYSTORE / FIZZ_ANDROID_KEYSTORE_PASSWORD
//   FIZZ_ANDROID_KEY_ALIAS / FIZZ_ANDROID_KEY_PASSWORD
// 未配置时退回 debug 签名（可装，但签名随机器变，不能覆盖安装固定签名版本）。
def fizzKeystorePath = System.getenv('FIZZ_ANDROID_KEYSTORE')
def fizzKeystorePass = System.getenv('FIZZ_ANDROID_KEYSTORE_PASSWORD')
def fizzKeyAlias = System.getenv('FIZZ_ANDROID_KEY_ALIAS')
def fizzKeyPass = System.getenv('FIZZ_ANDROID_KEY_PASSWORD') ?: fizzKeystorePass

android {
    signingConfigs {
        release {
            if (fizzKeystorePath) {
                storeFile file(fizzKeystorePath)
                storePassword fizzKeystorePass
                keyAlias fizzKeyAlias
                keyPassword fizzKeyPass
            }
        }
    }
    buildTypes {
        release {
            signingConfig fizzKeystorePath ? signingConfigs.release : signingConfigs.debug
        }
    }
}
${END}
`

const original = readFileSync(gradlePath, 'utf8')

// 去掉上一次注入的块（幂等），再统一追到末尾。
const stripped = original
  .replace(new RegExp(`\\n?${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n?`), '\n')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/\s+$/, '')

const next = `${stripped}\n\n${BLOCK}`

if (next === original) {
  console.log('[mobile] Android 签名配置已是最新')
} else {
  writeFileSync(gradlePath, next, 'utf8')
  console.log('[mobile] Android 签名配置已写入 app/build.gradle（环境变量缺失时退回 debug 签名）')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
