/**
 * 会话作用域检查：**store 里不许再出现「按活跃会话走」的隐含默认值**。
 *
 * ## 为什么需要它
 *
 * 面板支持分屏（两个标签同时可见、各跑各的会话）。但 store 里的会话级动作以前统统
 * 这样开头：
 *
 *     const conversationId = get().activeConversationId;
 *
 * 单标签时「焦点 == 视图」，看不出问题；分屏一上线，非焦点标签里发消息 / 换模型 /
 * 删消息 / 点队列全部作用到了**焦点会话**上（用户报的现象：点哪个标签两个模型 pill
 * 一起变）。这类 bug 不报错、不崩，只写错地方，测试也容易漏 —— 唯一的解法是让它在
 * 写代码时就红。
 *
 * 现在的口径：
 *
 * - 每个会话级动作收 `scope?: string | null`（`undefined` = 活跃会话，`null` = 没有
 *   会话，有值 = 那条），默认值**只在 `resolveConvId` 里解析**；
 * - 「是不是焦点」只经 `isFocus` 判断（那是全局镜像字段唯一允许存在的原因）；
 * - 视图层（`agentAppFrom`）把本标签的 id 显式传下去，靠 `useAgentApp.test.ts` 钉住。
 *
 * ## 判定口径
 *
 * 扫 `packages/agent-kit/src/shared/lib/stores/` 下的 `.ts`（不含测试），**去掉注释后**
 * 出现「**读**焦点会话」的写法（`get().activeConversationId` / `state.activeConversationId`）
 * 即违规 —— 除了下面 `ALLOW` 里那几个「本来就是操作焦点」的文件。要放行单行，在该行加
 * `// scope-ok: <理由>`。
 *
 * **写**焦点（`set({ activeConversationId })`、`activeConversationId: null` 这类）不查：
 * 切会话总得有人设它，那不是「把焦点当默认目标」。
 *
 * 另外挡两记回退（都是同一类 bug 的变种）：
 *
 * - `agent-store.ts`（全局 slice）里不许再声明 `contextNotice` / `contextCompressing` /
 *   `compressContextNow`，也不许把 `chatTarget` / `reasoningEffort` / `mcpServerIds` /
 *   `browserSettings` / `draftSettings` 搬回去 —— 它们要么是**某一条会话**的属性，
 *   要么是**草稿页**那一份，放回全局就是分屏串台（见 `slices/conversation/actions/
 *   context.ts`、`actions/targets.ts`）；
 * - 视图层（hooks / features）不许直接碰 `draftSettings`：真源在会话清单项上，读它得走
 *   `scopedSettingsOf(conversationId)`。
 *
 * ## 用法
 *   node scripts/check-conversation-scope.mjs    # 有违规退出码 1
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const storeRoot = resolve(repoRoot, 'packages/agent-kit/src/shared/lib/stores')

/** 视图层：只允许经 agentApp / scopedSettingsOf 读会话现场 */
const UI_ROOTS = [
  resolve(repoRoot, 'packages/agent-kit/src/shared/hooks'),
  resolve(repoRoot, 'packages/agent-kit/src/features'),
]

/**
 * 允许出现 `activeConversationId` 的文件（相对 `storeRoot`），每条都要说清理由。
 *
 * 判据：**它是不是在「定义焦点」或「操作焦点本身」**。仅仅「读到焦点然后拿它当默认
 * 目标」不在此列 —— 那正是本脚本要拦的东西。
 */
const ALLOW = new Map([
  [
    'slices/conversation/internals/core.ts',
    'resolveConvId / isFocus 的定义处：全仓唯一解析默认目标的地方',
  ],
  [
    'slices/conversation/actions/conversation-open.ts',
    '切会话就是在动焦点：装载、写 localStorage、判断要不要重载',
  ],
  ['slices/conversation/index.ts', 'slice 组装：初始 state 的 activeConversationId: null'],
  ['slices/conversation/types.ts', '接口声明与文档注释里的字段说明'],
  ['slices/conversation/storage.ts', 'localStorage 的 key 与读写函数'],
  ['agent-store.ts', 'AgentStore 接口声明与初始值'],
])

/** 「读焦点会话」的两种写法（写焦点不在此列，见文件头） */
const READS_FOCUS = /\b(?:get\(\)|state)\.activeConversationId\b/

/** 全局 slice 里不许再出现的字段：它们是每会话的（搬回来 = 分屏串台） */
const GLOBAL_BANNED = [
  ['contextNotice', '上下文压缩提示是每会话的：slices/conversation/actions/context.ts'],
  ['contextCompressing', '压缩进行中是每会话的：slices/conversation/actions/context.ts'],
  ['compressContextNow', '压缩动作要带会话：slices/conversation/actions/context.ts'],
  [
    'chatTarget',
    '会话的模型在清单项上、草稿在 draftSettings 里：slices/conversation/actions/targets.ts',
  ],
  [
    'reasoningEffort',
    '思考强度是每会话的：slices/conversation/actions/targets.ts',
  ],
  [
    'mcpServerIds',
    'MCP 选择是每会话的：slices/conversation/actions/targets.ts',
  ],
  [
    'browserSettings',
    '浏览器偏好是每会话的：slices/conversation/actions/targets.ts',
  ],
  [
    'draftSettings',
    '草稿现场属于 ConversationSlice（视图层走 scopedSettingsOf），不是全局 slice 的字段',
  ],
]

/** 去掉行内注释与单行块注释，免得文档里的字段名被当成代码 */
function codeOf(line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
    return ''
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
}

function walk(dir, out = [], exts = ['.ts']) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(full, out, exts)
    else if (
      exts.some((ext) => entry.name.endsWith(ext)) &&
      !entry.name.includes('.test.')
    )
      out.push(full)
  }
  return out
}

const problems = []

for (const file of walk(storeRoot)) {
  const rel = relative(storeRoot, file).split('\\').join('/')
  const allowReason = ALLOW.get(rel)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)

  lines.forEach((line, index) => {
    const code = codeOf(line)
    if (!code) return
    const at = `${rel}:${index + 1}`

    if (!allowReason && READS_FOCUS.test(code)) {
      if (code.includes('scope-ok')) return
      problems.push({
        at,
        text: line.trim(),
        hint:
          '会话级动作请收 `scope?: string | null` 并用 `resolveConvId(scope)` 取 id；' +
          '只判断焦点用 `isFocus(id)`。确实是操作焦点本身，就把文件加进脚本的 ALLOW。',
      })
    }

    // 全局 slice 只额外查「搬回去」的那几个字段
    if (rel !== 'agent-store.ts') return
    for (const [field, why] of GLOBAL_BANNED) {
      if (new RegExp(`^\\s*${field}\\s*[:(?]`).test(code)) {
        problems.push({
          at,
          text: line.trim(),
          hint: `\`${field}\` 不能放回全局：${why}`,
        })
      }
    }
  })
}

/**
 * 视图层不许直接碰 `draftSettings`。
 *
 * 它是**草稿页**那一份（还没有会话时的待定选择），谁在 UI 里读它，等于又在拿「一份共享
 * 的现场」当当前会话用 —— 分屏时另一个标签就会跟着变。要读会话的现场，走
 * `app.chatTarget`（内部已经是 `scopedSettingsOf(本视图 id)`）。
 */
for (const root of UI_ROOTS) {
  if (!existsSync(root)) continue
  for (const file of walk(root, [], ['.ts', '.tsx'])) {
    const rel = relative(repoRoot, file).split('\\').join('/')
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const code = codeOf(line)
        if (!code || code.includes('scope-ok')) return
        if (!/\bdraftSettings\b/.test(code)) return
        problems.push({
          at: `${rel}:${index + 1}`,
          text: line.trim(),
          hint:
            '草稿现场是 store 内部的：视图层读 `app.chatTarget` 等（里面就是 ' +
            '`scopedSettingsOf(conversationId)`），别直接读 draftSettings。',
        })
      })
  }
}

if (problems.length === 0) {
  console.log(
    '✓ 会话作用域：store 里没有按活跃会话走的动作，视图层也没有直接读共享现场',
  )
  process.exit(0)
}

console.error(`✗ 会话作用域：${problems.length} 处按活跃会话走（分屏时会作用到焦点会话）\n`)
for (const p of problems) {
  console.error(`  ${p.at}`)
  console.error(`    ${p.text}`)
  console.error(`    → ${p.hint}\n`)
}
process.exit(1)
