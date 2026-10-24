/**
 * xterm 主题：把 CSS 变量现读成 xterm 认得的颜色。
 *
 * 从 `TerminalPanel` 里拆出来只是因为它跟组件生命周期毫无关系（纯函数 + 两张常量表），
 * 留在 2500 行的组件文件里只会让「终端到底怎么上色」更难找。
 */
import type { ITheme } from '@xterm/xterm'
import { toHex } from '@fizz/agent-kit/shared/hooks/useColorTheme'

/**
 * 读一个 CSS 变量并换算成 xterm 认得的颜色。
 *
 * ⚠️ **必须换算，不能把变量原值直接喂给 xterm**：本项目主题变量是 `oklch(...)`
 * （`packages/ui-tokens/src/themes.css`），xterm 自带的颜色解析只认 hex / `rgb()` /
 * `hsl()` / 具名色 —— 喂 `oklch()` 进去**不报错**，它内部解析失败后静默退回默认值
 * （背景 `#000000`、前景 `#ffffff`），于是「亮色主题下终端仍是黑底」。这正是
 * 「终端背景不跟主题」的根因。换算交给 canvas（`toHex`），色彩管理由浏览器做。
 *
 * `over` 是半透明时的合成底色：主题配了背景图 / 视频时 `--background` 是半透明的，
 * 而**前景 / 强调色 / 光标**这类颜色必须实心，先叠到该明暗档的基准色上。
 * （终端背景反过来是**全透明**，见 `buildTheme()` 里那段 —— 两件事别混。）
 *
 * ⚠️ `--primary-soft` / `--primary-strong` 是 `color-mix(...)`：`getPropertyValue` 拿到的是
 * **未计算的 token 序列**，`toHex` 的 canvas 解析不了它（解析失败会静默保留上一个 fillStyle，
 * 结果就是选区色等于底色、看不见）。这类值先挂一个隐藏探针，让浏览器算成具体色再读。
 */
function readVar(name: string, fallback: string, over: string, el: Element): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim()
  if (!value) return fallback
  if (!value.includes('color-mix(') && !value.includes('var(')) return toHex(value, over)
  const probe = document.createElement('span')
  probe.style.cssText = 'display:none'
  probe.style.color = value
  el.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return computed ? toHex(computed, over) : fallback
}

/**
 * 主题色全部来自 CSS 变量：亮 / 暗切换后重读一次即可。
 *
 * 从**终端容器**读而不是 `<html>`：变量是继承的，读容器拿到的是它实际会用的那套值 ——
 * 万一某个宿主（弹层 / 独立工作台）在局部改写了 `--background`，这里也跟得上。
 */
export function buildTheme(el: Element = document.documentElement): ITheme {
  const dark = document.documentElement.classList.contains('dark')
  /** 半透明 `--background` 的合成底色（与 themes.css 里各主题的基准底一致） */
  const base = dark ? '#0a0a0a' : '#ffffff'
  /**
   * 终端**不自己画底**：背景给全透明，透出**宿主容器**那层底 —— 侧栏里是 `SidePanel`
   * 的 `bg-surface-1`（0.86），整页终端是画布那层 `bg-background`（0.72）；没配背景
   * 媒体时两者都是不透明的主题底色，终端看起来和以前一模一样。
   * `TerminalPanel` 自己也是 `bg-transparent`，别在那儿再补一层（见那边的注释）。
   *
   * ⚠️ 必须配合 `allowTransparency: true`（见 TerminalPanel 的 `new Terminal`）：
   * 那个选项默认 `false`，xterm 会把 alpha 当不透明处理，给 `rgba(…, 0)` 也照样一块死色。
   *
   * ⚠️ 也别改成「半透明的 `--background`」：终端这层 0.72 叠在宿主那层（0.72 / 0.86）上
   * 就是 0.92 / 0.96，背景图只剩 4~8% 可见 —— 等于没透，还多一次合成。
   */
  const background = 'rgba(0, 0, 0, 0)'
  /** 不透明的主题底色：`cursorAccent`（光标里的字）这类「必须实心」的地方用它 */
  const solidBackground = readVar('--background', base, base, el)
  const foreground = readVar('--foreground', dark ? '#e5e7eb' : '#252525', solidBackground, el)
  /** 强调色也跟随主题：光标 / 选区 / 蓝青 ANSI 都取自它，终端才不只是「换了个 ANSI 调色板」 */
  const primary = readVar('--primary', foreground, solidBackground, el)
  const primaryStrong = readVar('--primary-strong', primary, solidBackground, el)
  const primarySoft = readVar('--primary-soft', primary, solidBackground, el)
  return {
    background,
    foreground,
    cursor: primary,
    // 光标里的字：背景透明了，这里不能跟着透 —— 否则光标块里的字符直接消失
    cursorAccent: solidBackground,
    // 选区用 `--primary-line`（45% 强调色）：`--primary-soft` 只有 13%，选中后几乎看不出范围
    selectionBackground: readVar('--primary-line', primarySoft, solidBackground, el),
    /**
     * ⚠️ overview ruler 的边框色**不跟随主题**：xterm 内部把它硬编码成 `#ffffff`
     * （`overviewRulerBorder` 缺省值就是白色，与 background / foreground 无关），
     * 并在视口右缘（滚动条位置）无条件画一条 1px 纯白竖线 —— 就是那条「终端右侧白线」。
     *
     * styles.css 里那条 `.xterm-decoration-overview-ruler { display: none }` 是同一目的的
     * 第一道防线（整个 canvas 一起藏掉）；这里把颜色设成全透明是第二道：不依赖选择器能否
     * 命中 canvas、也不依赖层叠顺序，直接从根上保证那条线画成透明。
     */
    overviewRulerBorder: 'rgba(0, 0, 0, 0)',
    // ANSI 十六色按主题分开给：xterm 默认调色板按深底设计，亮底下
    // white / brightWhite / 黄系会直接糊进背景（实测亮色下部分文本看不清）
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
    // 蓝 / 青跟随主题强调色；其余 ANSI 保留 VS Code 口径 —— 红绿黄是语义色，不能跟着主题漂
    blue: primary,
    brightBlue: primaryStrong,
    cyan: primary,
    brightCyan: primaryStrong
  }
}

/** 暗色 ANSI（VS Code Dark+ 终端同款） */
const ANSI_DARK = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
} satisfies Partial<ITheme>

/**
 * 亮色 ANSI（VS Code Light+ 终端同款，brights 略调）。
 * 注意 white / brightWhite 反常地给了深灰：ConPTY 下 shell 常用它们画「普通强调文本」，
 * 若照字面给白色，亮底下就是一片看不见 —— 这两个语义在亮色主题必须落到可读的灰。
 */
const ANSI_LIGHT = {
  black: '#000000',
  red: '#cd3131',
  green: '#008000',
  yellow: '#949600',
  blue: '#0451a5',
  magenta: '#a626a4',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#e04040',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0f62d8',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#3b3b3b'
} satisfies Partial<ITheme>
