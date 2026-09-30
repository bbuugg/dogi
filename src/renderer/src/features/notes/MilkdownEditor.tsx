import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import { imageBlockSchema } from '@milkdown/kit/component/image-block'
// 链接用 link-tooltip 那一份命令（Crepe 工具条的「链接」按钮也是它）：弹浮层让人填地址，
// 和 Typora 的 Ctrl+K 一致。preset/commonmark 里同名的那个是「直接给标记套 attrs」，空选区时会抛错。
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip'
import { commandsCtx, KeymapReady, keymapCtx, type CmdKey } from '@milkdown/kit/core'
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  addBlockTypeCommand,
  codeBlockSchema,
  createCodeBlockCommand,
  headingSchema,
  inlineCodeKeymap,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/kit/preset/commonmark'
import { insertTableCommand, strikethroughKeymap } from '@milkdown/kit/preset/gfm'
import type { Command } from '@milkdown/kit/prose/state'
import { replaceAll } from '@milkdown/kit/utils'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import '@milkdown/crepe/theme/common/style.css'
import './MilkdownEditor.css'

interface MilkdownEditorProps {
  /** Markdown 正文。外部传入新值（切文件）时会整体替换编辑器内容 */
  value?: string
  onChange?: (markdown: string) => void
}

/**
 * Crepe 的中文文案。
 *
 * Crepe 用 `defaultsDeep` 深合并配置，所以这里只写要改的字段，图标与其余
 * 默认值全部沿用官方（不会因为只给 label 就把 icon 弄丢）。
 * 功能集直接用官方默认（工具栏 / 块手柄 / 斜杠菜单 / 代码块 / 表格 / 图片 /
 * 占位符 / 链接浮层 / 公式），TopBar 与 AI 两个 feature 官方默认关着，保持关闭。
 */
const FEATURE_CONFIGS = {
  /*
   * 关掉 Crepe 默认的「虚拟光标」（prosemirror-virtual-cursor）。
   *
   * 它是为「光标落在非 inclusive 标记的哪一侧」画的一条提示光标，本身不跟原生光标
   * 同源：坐标是用 `getBoundingClientRect()` 算的**视口**差值，却被当成滚动内容里的
   * `top` 用（见 prosemirror-virtual-cursor 的 `updateCursor`）。编辑区不滚动时两者
   * 恰好重合，一滚动虚拟光标就整体上移一个 scrollTop —— 屏幕上出现两个插入光标，
   * 上面那个是它，下面跟着文字走的原生光标才是对的。
   *
   * 我们的编辑区正是滚动容器（见 MilkdownEditor.css），所以这里直接关掉它，
   * 只留原生光标（Typora 也没有这条提示尾巴）。drop 指示线（拖拽块时的落点线）
   * 是同一个 feature 的另一半，不受影响。
   */
  [Crepe.Feature.Cursor]: {
    virtual: false
  },
  [Crepe.Feature.Placeholder]: {
    text: '输入正文，或用 / 唤起命令…',
    mode: 'block' as const
  },
  /** 选中文字时浮出的工具条 */
  [Crepe.Feature.Toolbar]: {
    boldLabel: '加粗',
    italicLabel: '斜体',
    strikethroughLabel: '删除线',
    codeLabel: '行内代码',
    linkLabel: '链接',
    latexLabel: '公式',
    aiLabel: 'AI'
  },
  /** 块左侧的拖拽手柄 + `/` 斜杠菜单 */
  [Crepe.Feature.BlockEdit]: {
    textGroup: {
      label: '文本',
      text: { label: '正文' },
      h1: { label: '标题 1' },
      h2: { label: '标题 2' },
      h3: { label: '标题 3' },
      h4: { label: '标题 4' },
      h5: { label: '标题 5' },
      h6: { label: '标题 6' },
      quote: { label: '引用' },
      divider: { label: '分割线' }
    },
    listGroup: {
      label: '列表',
      bulletList: { label: '无序列表' },
      orderedList: { label: '有序列表' },
      taskList: { label: '任务列表' }
    },
    advancedGroup: {
      label: '高级',
      image: { label: '图片' },
      codeBlock: { label: '代码块' },
      table: { label: '表格' },
      math: { label: '公式' }
    }
  }
}

/**
 * 把「执行某个已注册命令」包成 keymap 需要的 `Command`。
 * 命令管理器自己会读当前 view 的状态，所以这里不转发 state / dispatch / view
 * （Milkdown 官方 keymap 也是这个写法）。
 */
function call<T>(ctx: Ctx, command: CmdKey<T>, payload?: T): Command {
  return () => ctx.get(commandsCtx).call(command, payload)
}

/**
 * 按当前块的标题级别上下移动一级（Typora 的 Ctrl+= / Ctrl+-）。
 * 非标题一律按 0 级算：提升会变成「标题 1」；已经是正文还要降低就无从可降，
 * 返回 false 把按键让给后续处理。
 */
function stepHeading(ctx: Ctx, delta: number): Command {
  const commands = ctx.get(commandsCtx)
  const headingType = headingSchema.type(ctx)
  return (state, dispatch, view) => {
    const parent = state.selection.$from.parent
    const current = parent.type === headingType ? Number(parent.attrs.level) : 0
    const next = current + delta
    if (next < 1 && current < 1) return false
    return commands.get(wrapInHeadingCommand.key)(Math.min(next, 6))(state, dispatch, view)
  }
}

/**
 * Typora 风格键位 → 命令。
 *
 * 只登记「Milkdown 默认没有 / 默认不一样」的键位；加粗（Mod-b）、斜体（Mod-i）、
 * 撤销（Mod-z）、重做（Mod-y）、列表缩进（Tab / Shift-Tab）、软换行（Shift-Enter）
 * 沿用 Milkdown 内置键位，本身就与 Typora 一致。
 *
 * 删除线与行内代码不走这里：官方把它们的键位写在 preset 的 keymap 槽位里，而 Crepe
 * 工具条上的快捷键提示正是从这个槽位读的（`resolveKeymapShortcut`），所以改槽位才能
 * 让提示和实际绑定一起变（见 `TYPORA_KEYMAP_REBIND`）。
 *
 * 键名与 `@shared/shortcuts` 的 `EDITOR_SHORTCUTS` 一一对应 —— 那份是给「?」帮助浮层
 * 和设置页看的展示清单，两边改动要一起改。
 */
const TYPORA_KEYMAP: Array<{ key: string; onRun: (ctx: Ctx) => Command }> = [
  // 行内格式
  { key: 'Mod-k', onRun: (ctx) => call(ctx, toggleLinkCommand.key) },
  // 段落与块
  ...Array.from({ length: 6 }, (_, level) => ({
    key: `Mod-${level + 1}`,
    onRun: (ctx: Ctx) => call(ctx, wrapInHeadingCommand.key, level + 1)
  })),
  { key: 'Mod-0', onRun: (ctx) => call(ctx, wrapInHeadingCommand.key, 0) },
  { key: 'Mod-=', onRun: (ctx) => stepHeading(ctx, 1) },
  { key: 'Mod--', onRun: (ctx) => stepHeading(ctx, -1) },
  { key: 'Mod-Shift-q', onRun: (ctx) => call(ctx, wrapInBlockquoteCommand.key) },
  { key: 'Mod-Shift-k', onRun: (ctx) => call(ctx, createCodeBlockCommand.key) },
  // 列表与表格
  { key: 'Mod-Shift-]', onRun: (ctx) => call(ctx, wrapInBulletListCommand.key) },
  { key: 'Mod-Shift-[', onRun: (ctx) => call(ctx, wrapInOrderedListCommand.key) },
  { key: 'Mod-t', onRun: (ctx) => call(ctx, insertTableCommand.key) },
  {
    key: 'Mod-Shift-i',
    onRun: (ctx) => call(ctx, addBlockTypeCommand.key, { nodeType: imageBlockSchema.type(ctx) })
  },
  {
    // 数学块就是「语言为 LaTeX 的代码块」（与 `/` 斜杠菜单里那一项同一个做法）
    key: 'Mod-Shift-m',
    onRun: (ctx) =>
      call(ctx, addBlockTypeCommand.key, {
        nodeType: codeBlockSchema.type(ctx),
        attrs: { language: 'LaTeX' }
      })
  }
]

/**
 * 把 `TYPORA_KEYMAP` 注册进编辑器的 keymap。
 *
 * 官方键位是在 `KeymapReady` 之后由 `keymapCtx.build()` 一次性组装的，所以这里也等同一个
 * 计时器（`$shortcut` 就是这么干的），条目才赶得上被 build 进去。priority 给 100（默认 50）
 * 是为了万一将来官方绑了同一个键：优先级高的先跑，返回 true 就覆盖掉官方行为。
 */
const typoraKeymapPlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(KeymapReady)
  const keymap = ctx.get(keymapCtx)
  const disposers = TYPORA_KEYMAP.map(({ key, onRun }) => keymap.add({ key, priority: 100, onRun }))
  return () => disposers.forEach((dispose) => dispose())
}

/**
 * 编辑器内层：建一个 Crepe 实例并管好值与外部的双向同步。
 * 必须在 MilkdownProvider 内部（`useEditor` / `Milkdown` 都依赖它的 context）。
 */
function CrepeEditor({ value = '', onChange }: MilkdownEditorProps) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  /**
   * 编辑器当前内容（编辑器自己归一化后的 Markdown）。
   * 初值是首次传入的内容 —— Crepe 已经用 `defaultValue` 灌进去了，
   * 所以首次的 value effect 应当直接跳过。
   */
  const currentRef = useRef<string | null>(value)

  const { get } = useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: value,
      featureConfigs: FEATURE_CONFIGS
    })
    // 删除线与行内代码：官方把键位写在 preset 的 keymap 槽位里，而 Crepe 工具条的快捷键
    // 提示也读这份槽位（`resolveKeymapShortcut` 只取第一条），所以改这里才能让「实际绑定」
    // 和「工具条上的提示」一起变成 Typora 的键位。
    crepe.editor.config((ctx) => {
      ctx.update(strikethroughKeymap.key, () => ({
        ToggleStrikethrough: { shortcuts: 'Alt-Shift-5' }
      }))
      ctx.update(inlineCodeKeymap.key, () => ({
        ToggleInlineCode: { shortcuts: 'Mod-Shift-`' }
      }))
    })
    // 追加 Typora 风格键位（在 create 之前 use，官方插件同样在这一步注册）
    crepe.editor.use(typoraKeymapPlugin)

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (markdown === prevMarkdown) return
        // 先记下编辑器当前内容，再把 Markdown 送出去：父组件把同一份内容回传
        // 时下面的 effect 就能识别出「编辑器已经就是这个内容」，
        // 不会多跑一次 replaceAll（那会重置光标，还会把斜杠菜单/块菜单关掉）。
        currentRef.current = markdown
        onChangeRef.current?.(markdown)
      })
    })

    return crepe
  }, [])

  useEffect(() => {
    // 外部值变更（切文件 / 重新读盘）：整体替换文档内容
    if (currentRef.current === value) return
    currentRef.current = value
    const editor = get()
    if (!editor) return
    editor.action(replaceAll(value))
  }, [value, get])

  return <Milkdown />
}

/**
 * 笔记正文编辑器：`@milkdown/crepe`（Milkdown 官方的一站式所见即所得编辑器）。
 *
 * Crepe 一次带齐工具栏、块手柄、斜杠菜单、代码块（CodeMirror）、表格、图片、
 * 链接浮层与公式，不用自己拼插件、也不用自己画工具条。
 *
 * ⚠️ 外层宿主的样式不能照搬网页端那套「`min-height: 400px` + 整页滚动」：
 * 笔记页是面板里的固定高度区域，必须让整条高度链撑满、滚动落在编辑区自己身上，
 * 否则长笔记会把内容顶出面板被裁掉（见 MilkdownEditor.css）。
 */
export function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <div className="notes-milkdown">
        <CrepeEditor {...props} />
      </div>
    </MilkdownProvider>
  )
}
