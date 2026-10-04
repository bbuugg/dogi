/**
 * 自动更新「线上可更新性」验证（纯 Node，不启 Electron、不连本机应用）。
 *
 * ## 为什么需要它
 *
 * `services/updater.ts` 那边再正确也没用 —— 只要 GitHub Release 上没挂
 * `latest.yml`，客户端 `checkForUpdates()` 就会拿到 404，并且**被静默吞掉**
 * （失败只记主机日志 `app` 作用域，界面一句提示都没有）。所以「能不能更新」
 * 这个事实只能去线上验证，本脚本用 `electron-updater` **自己的** `GitHubProvider`
 * 打真实 Release，走的就是客户端那条请求链（只把 HTTP 传输层换成 node fetch）：
 *
 *   releases.atom → releases/latest（拿 tag）→ <tag>/download/latest.yml
 *
 * ## 跑法（项目根目录）
 *
 *   node scripts/verify-updater-release.mjs          # 当前平台
 *   node scripts/verify-updater-release.mjs all      # win32 + darwin + linux 三个都查
 *   node scripts/verify-updater-release.mjs darwin
 *
 * ⚠️ 发版后跑：**绿了才说明自动更新真的可用**；`latest.yml` 没挂上去时它会明确报
 * `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`（这正是踩过的坑，见 AGENTS.md 4.26）。
 * ⚠️ 它只验证「服务器侧就绪」，不验证「客户端能装上」（那要真机装旧版跑一遍）。
 * ⚠️ macOS 的清单即使存在，也只有包**已签名**时才真能装（Squirrel.Mac 要求），
 * 本仓库 CI 默认不签名 —— 所以 mac 这条绿了只代表「清单在」，不代表「能装」。
 * ⚠️ electron-updater 用的是它**自己嵌套的那份** `builder-util-runtime`（9.7.0）：
 * HttpError 必须从那里面取，否则 `e instanceof HttpError` 判定不成立，
 * 404 不会被翻译成 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`（本脚本要的正是那个错误码）。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const { GitHubProvider } = require(
  join(root, 'node_modules/electron-updater/out/providers/GitHubProvider.js')
)
const { HttpError } = createRequire(join(root, 'node_modules/electron-updater/package.json'))(
  'builder-util-runtime'
)

/** 读 package.json 的 build.publish[0]，保证探针查的就是应用真会去查的那个仓库 */
function readPublishConfig() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const publish = pkg.build?.publish?.[0]
  assert.equal(publish?.provider, 'github', 'build.publish[0] 必须是 github provider')
  assert.ok(publish.owner && publish.repo, 'build.publish[0] 必须配齐 owner / repo')
  return { owner: publish.owner, repo: publish.repo, version: pkg.version }
}

/** 各平台的清单文件名（由 updater 的默认 channel 决定，见 Provider.getDefaultChannelName） */
const CHANNEL_FILE = {
  win32: 'latest.yml',
  darwin: 'latest-mac.yml',
  linux: 'latest-linux.yml'
}

/** 只替代传输层：走真实的 URL 拼装 / 重定向跟随 / 404 → HttpError 语义 */
const executor = {
  request: async (options) => {
    const proto = (options.protocol || 'https:').replace(/:$/, '')
    const port = options.port ? `:${options.port}` : ''
    const url = `${proto}://${options.hostname}${port}${options.path}`
    const res = await fetch(url, { headers: options.headers || {}, redirect: 'follow' })
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${url}`)
    return await res.text()
  }
}

/** 打一个平台的真实清单请求；成功返回 { version, files } */
async function checkPlatform(platform, { owner, repo, version }) {
  const provider = new GitHubProvider(
    { provider: 'github', owner, repo },
    {
      channel: null,
      allowPrerelease: false,
      fullChangelog: false,
      requestHeaders: null,
      currentVersion: { raw: version, format: () => version }
    },
    { isUseMultipleRangeRequest: false, platform, executor }
  )
  // 注意：这里断言的是「清单能取到且结构完整」，与当前版本是否最新无关
  // （本地版本 == 线上版本时也必须能取到，否则「已是最新」也判不出来）
  const info = await provider.getLatestVersion()
  assert.ok(info.version, '清单里必须有 version')
  assert.ok(Array.isArray(info.files) && info.files.length > 0, '清单里必须有 files')
  for (const file of info.files) {
    assert.ok(file.url && file.sha512, `清单条目 ${file.url} 必须带 url 与 sha512`)
  }
  return info
}

/** 清单里列的安装包必须真能下载（HEAD 200）—— 清单与资产对不上时更新会下载失败 */
async function checkAssetsReachable(files) {
  for (const file of files) {
    const res = await fetch(file.url, { method: 'HEAD', redirect: 'follow' })
    assert.equal(res.status, 200, `${file.url} 应该可下载，实际 HTTP ${res.status}`)
  }
}

const args = process.argv.slice(2)
const platforms =
  args.length === 0
    ? [process.platform]
    : args[0] === 'all'
      ? ['win32', 'darwin', 'linux']
      : args

const config = readPublishConfig()
console.log(`仓库      : ${config.owner}/${config.repo}`)
console.log(`本地版本  : ${config.version}`)
console.log(`检查平台  : ${platforms.join(', ')}\n`)

let failed = 0
for (const platform of platforms) {
  const channelFile = CHANNEL_FILE[platform]
  if (!channelFile) {
    console.log(`  跳过  ${platform}（不认识的平台）`)
    continue
  }
  try {
    const info = await checkPlatform(platform, config)
    await checkAssetsReachable(info.files)
    const state = info.version === config.version ? '与本地同版' : `线上最新 ${info.version}`
    console.log(`  ok    ${platform}  ${channelFile}  （${state}，${info.files.length} 个文件）`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${platform}  ${channelFile}`)
    console.error(`        ${err.code ?? ''} ${String(err.message).split('\n')[0]}`)
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} 个平台取不到更新清单 —— 自动更新在这些平台上不可用。\n` +
      '先确认 .github/workflows/build.yml 的 Publish Release 步骤里\n' +
      '`files:` 是否包含 release/latest*.yml 与 release/*.blockmap（见 AGENTS.md 4.26）。'
  )
  process.exit(1)
}
console.log('\n全部通过：Release 侧已具备自动更新所需的清单与资产。')
