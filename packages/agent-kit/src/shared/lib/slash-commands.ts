/**
 * 斜线命令（slash commands）：输入框里以 `/` 开头触发的命令系统。
 *
 * 形态对齐 Claude Code 的输入体验：`/` 浮出命令列表（渲染在输入框上方，见
 * Composer 的 SlashCommandPalette），↑↓ 选择、Tab 补全、Enter 执行；认不出的
 * `/xxx` 按**普通文本**发送（用户明确要求 —— 拦下正文比发错一句话更糟）。
 *
 * 注册表就是一个普通数组：内置命令在 `builtinSlashCommands`（**当前为空**），调用方
 * （ChatPanel）把它（或它的扩展）传给 Composer。**插话（steer）已不在这里** ——
 * 它改由发送钮上的「队列消息 / 插话」选择器承担（见 composer.tsx 的 `sendChooser`），
 * 不再占一个斜线命令。整套解析 / 分发 / 浮层 / 补全保留：往数组里加命令即生效。
 */
import { toast } from 'sonner'
import type { FsScaffoldInput } from '@fizz/contracts/agent-api'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

/** 命令执行时拿到的上下文：app 门面 + 会话是否在跑（可用性与行为都看它） */
export interface SlashCommandContext {
  app: AgentApp
  /** 活跃会话是否有正在跑的 run（命令的可用性与行为都可能看它） */
  running: boolean
}

export interface SlashCommand {
  /** 命令名（不含斜线）：小写字母开头的 `[a-z0-9-]`，见 parseSlashInput 的正则 */
  name: string
  /** 展示名（命令列表里的中文名） */
  displayName: string
  /** 一句话说明（命令列表与悬浮提示共用） */
  description: string
  /** 参数提示（有参数的命令给，如「要插给 agent 的话」） */
  argsHint?: string
  /**
   * 这条命令**不收参数**（如 `/init`：落点固定，多打的字没有意义）。
   *
   * 为什么需要显式声明：分发的默认判据是「没给参数就 reject 并提示 argsHint」——
   * 那对**有**参数的命令是对的（用户意图明确是在敲命令却漏了参数，提示比照发出去好）。
   * 但对无参命令它会让命令**永远执行不了**：`/init` 必然落到 reject 分支。
   * 「有没有 argsHint」不能拿来当这个判据 —— 有参命令也可能不写 argsHint。
   */
  noArgs?: boolean
  /**
   * 可用性（返回 false 的命令不进列表）：命令存在 ≠ 此刻能用，比如只对某种会话
   * 后端有意义的命令（依赖服务端注入的那种，外部 agent 的协议给不了）。
   */
  available?: (ctx: SlashCommandContext) => boolean
  /** 执行：args 是去掉 `/{name}` 之后的剩余文本（已 trim） */
  run: (ctx: SlashCommandContext, args: string) => void
}

/** 解析 `/name args…`；不是命令形状（不以 / 开头 / 名字非法）返回 null */
export function parseSlashInput(text: string): { command: string; args: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/.exec(text.trim())
  if (!match) return null
  return { command: match[1], args: (match[2] ?? '').trim() }
}

/**
 * `resolveSlashDispatch` 的裁决结果（**纯数据**：执行与提示都由调用方做）。
 */
export type SlashDispatch =
  /** 认成命令，执行它 */
  | { kind: 'run'; command: SlashCommand; args: string }
  /** 认成命令但办不了：提示用户、**不要发出去** */
  | { kind: 'reject'; message: string }
  /** 不是命令语境：按**普通文本**发送 */
  | { kind: 'text' }

/**
 * 这条输入该不该当命令执行。**纯函数**（不碰 app、不发消息），所以能单测。
 *
 * ## `/` 开头 ≠ 命令：认不出的全部按普通文本发送
 *
 * 这个方向上用户报过两次：
 *
 * 1. 发以 `/` 开头的正文（路径 `/usr/local/bin`、正则、带 `/` 的说明），被整条吞掉
 *    回「未知命令」。根子是早先的判据写成「**以 `/` 开头就是命令**」；后来收成
 *    「`/名字` 形状成立」（名字 = `[a-z][a-z0-9-]*`），路径、正则写法、连续斜杠
 *    这些**天然不可能**匹配，直接走 text。
 *
 * 2. 形状对但名字不在表里（`/stre` 敲错、或用户根本没想敲命令的单词 `/done`），
 *    最初也拦下提示「未知命令」——但「发不出去」比「agent 收到一句带斜杠的话」
 *    更糟（用户明确要求改成照发）：命令表会不断扩充，拦下的那一刻用户只看到
 *    一句报错、写的正文没了。所以**名字认不出的一律按正文发送**。
 *
 * 仍然拦下的只剩两种「命令是真的」情况：缺参数（提示 argsHint）、命令存在但
 * 当前会话不可用 ——这两种用户意图明确就是在敲命令，把命令原文发给 agent 才是害他。
 */
export function resolveSlashDispatch(text: string, commands: SlashCommand[]): SlashDispatch {
  const parsed = parseSlashInput(text)
  if (!parsed) return { kind: 'text' }
  const command = commands.find((c) => c.name === parsed.command)
  // 名字不在表里 = 不是命令（哪怕形状像）：按普通文本发送，别拦（见上方文档第 2 条）
  if (!command) return { kind: 'text' }
  // ⚠️ 这里**刻意不看** `command.available`：它要 ctx，纯函数拿不到。
  // 可用性归 resolveSlashDispatchFor 的 isAvailable 管；本函数只回答「形状 / 名字 /
  // 参数」三件事。想在无 ctx 的场景（单测、纯静态分析）判可用性，调用方自己
  // 先 filter 好再传进来即可。
  if (!parsed.args) {
    // 无参命令（`/init`）直接进 run：它压根不需要参数，走 reject 就永远执行不了。
    // ⚠️ 这条**不能**反过来放宽成「有 argsHint 就拦、没就放行」—— 命令名认不出时
    // 上一步已经归 text 了，能走到这里的都是表里的命令，缺参数对它们就是漏了。
    if (command.noArgs) return { kind: 'run', command, args: '' }
    return { kind: 'reject', message: `/${command.name} ${command.argsHint ?? '需要参数'}` }
  }
  return { kind: 'run', command, args: parsed.args }
}

/**
 * `resolveSlashDispatch` 的**带上下文**版本：`isAvailable` 由调用方按 ctx 现算
 * （`available` 的签名要 ctx，纯函数拿不到）。
 *
 * ChatPanel 走这个：它那边 `slashContext` 是现成的。
 */
export function resolveSlashDispatchFor(
  text: string,
  commands: SlashCommand[],
  isAvailable: (c: SlashCommand) => boolean
): SlashDispatch {
  const outcome = resolveSlashDispatch(text, commands)
  // 「run」还要再过一道可用性：命令存在 ≠ 此刻能用（steer 在 ACP 会话上就用不了）
  if (outcome.kind !== 'run') return outcome
  if (!isAvailable(outcome.command)) {
    return { kind: 'reject', message: `/${outcome.command.name} 在当前会话不可用` }
  }
  return outcome
}

/** 按输入前缀过滤命令（`/st` → steer）；`token` 含开头斜线或不含都行 */
export function filterCommands(commands: SlashCommand[], token: string): SlashCommand[] {
  const prefix = token.replace(/^\//, '').toLowerCase()
  return commands.filter((c) => c.name.startsWith(prefix))
}

/**
 * 内置斜线命令。
 *
 * 注册表就是下面这个数组：加进来浮层、补全、`resolveSlashDispatch*` 立刻认它。
 *
 * 两条命令（`/create-skill` / `/init`）的共同立场：**直接在磁盘上把文件建出来**，而不是往
 * 输入框里塞一段提示词让模型去建。理由：脚手架是确定性的动作（一个目录 + 一个 SKILL.md
 * / 一个 AGENTS.md），走模型要多烧一轮、还可能建到别的地方去；用户敲这个命令时想要的是
 * 文件此刻就在那儿。
 *
 * 落盘统一经服务端的 `/api/workspaces/:id/scaffold`（`lib/server/scaffold.ts`）——
 * 那里 `mkdir` 中间目录、且**已存在一律 409 绝不覆盖**（覆盖是破坏性的，该由用户在
 * 编辑器里明确做）。所以本文件里没有 fs / fetch，只有「调 store + 出提示」。
 */
export function builtinSlashCommands(ctx: SlashCommandContext): SlashCommand[] {
  /**
   * 「这个工作区能不能落文件」：**只有一条判据 —— `activeWorkspace.path` 要在**。
   *
   * 内置「任务」是**虚拟工作区**（path 为空，它没有磁盘目录）；聊天页本身已经
   * `disabled: !activeWorkspace`，所以「连没连线」不必在这里再判一遍（真没连上的话
   * 这条路会走到 store 的 `getApi()` 返回 null，得到一句「未连接」—— 那是对的提示）。
   *
   * 顺带记一条同源的教训（文件面板 `canReveal/canDownload` 踩过）：**只看「有没有这个
   * 方法」会漏判平台**。这里反过来 —— 只看 `path` 就够，因为落点是服务端按工作区登记的
   * 路径算的，前端无从也无需预判。
   */
  const needsWorkspace = (c: SlashCommandContext): boolean => !!c.app.activeWorkspace?.path

  return [
    {
      // 命名照「动词-名词」：`/create-skill` 说的是「建一个技能」。早先叫 `/skill`，
      // 那个读起来像「管理技能」而不是「创建」—— 这条命令只建、不列也不改。
      name: 'create-skill',
      displayName: '创建技能',
      description: '在项目里新建一个技能（.fizz/skills/<名字>/SKILL.md），下一轮对话生效',
      argsHint: '<名字> [一句说明]',
      available: needsWorkspace,
      run: (c, args) => {
        // args 的形态是 `<名字> [一句说明]` —— 按**第一个空格**切，名字后面全部当描述。
        // 不切的话整句都会变成目录名（而目录名只允许 ASCII 小写），用户补个中文说明就报错。
        const [rawName, ...rest] = args.split(/\s+/)
        const description = rest.join(' ').trim()
        void createAndReport(c, { kind: 'skill', name: rawName, ...(description ? { description } : {}) })
      }
    },
    {
      // `/init` 是 AGENTS.md 生态的既有约定（Claude Code 与 opencode 的 `/init` 都是
      // 「为这个项目生成 AGENTS.md」），跟着它走的好处是从别的工具迁过来的人不用重学。
      // 显示名仍然说清它到底建了什么 —— 命令名对齐生态，描述不误导。
      name: 'init',
      displayName: '创建项目约束文档',
      description: '在项目根新建 AGENTS.md（下一轮对话会被全文注入系统提示词）',
      noArgs: true,
      available: needsWorkspace,
      run: (c) => {
        void createAndReport(c, { kind: 'agents' })
      }
    }
  ]
}

/**
 * 调脚手架并出提示。
 *
 * 两条通道分开走：**失败进 `app.setError`**（全局错误条，与 `resolveSlashDispatch`
 * 的 reject 分支同一个出口，用户习惯在顶部看到命令没成），**成功进 sonner toast**
 * —— 建文件不是「错误条」该承载的事，而落点（绝对路径 + 生效时机）是要一眼看到、
 * 随时能划走的信息，挂在错误条上反而不像正常反馈。
 *
 * 成败的判据是 `typeof result === 'string'`：store 那层约定「字符串 = 人话错误、
 * 对象 = 成功」（与 `writeWorkspaceFile` 同款）。
 */
async function createAndReport(c: SlashCommandContext, input: FsScaffoldInput): Promise<void> {
  const workspace = c.app.activeWorkspace
  if (!workspace) {
    c.app.setError('先选一个有磁盘目录的项目（内置「任务」没有目录，落不了文件）')
    return
  }
  let result: Awaited<ReturnType<typeof c.app.scaffoldWorkspaceFile>>
  try {
    result = await c.app.scaffoldWorkspaceFile(workspace.id, input)
  } catch (err) {
    // store 那层已经兜过一层，但它是 `errorMessage` 的薄封装，这里再兜一次是为了
    // 「同步抛出」的情况（未连接的 getApi 路径）——那会让整个命令崩掉且不留痕迹。
    c.app.setError(err instanceof Error ? err.message : String(err))
    return
  }
  if (typeof result === 'string') {
    c.app.setError(result)
    return
  }
  toast.success(`已创建 ${result.path}`, {
    description: `${result.abs}\n${result.note}`,
    duration: 6000
  })
}
