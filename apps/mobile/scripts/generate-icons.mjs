/**
 * 用 `apps/mobile/assets/logo.png` 生成安卓的**启动图标**与**启动屏**，写到
 * `apps/mobile/assets/android/`（这份产物是**入库**的）。
 *
 * ## 为什么分「生成」和「复制」两步
 *
 * `android/` 整个目录是 `cap add android` 的生成物、已 gitignore —— 换台机器就没了，
 * 所以图标不能在那边维护。做法是：
 * - 这里（`npm run icons`）只在**换 logo 时**跑一次，产物落进 `assets/android/` 并提交；
 * - 构建时走 `scripts/copy-assets.mjs`（纯 `fs` 复制），把 `assets/android/` 铺回
 *   `android/app/src/main/res/` —— 不依赖任何图像库，CI / 别人的机器都能跑。
 *
 * 也就是说：**日常构建不需要 ImageMagick**，只有重新生成图标才需要 `magick` 在 PATH 里
 * （ImageMagick 7）。
 *
 * ## 尺寸口径（对齐 Capacitor 模板）
 *
 * - 传统图标 `mipmap-*dpi/ic_launcher.png`：48 / 72 / 96 / 144 / 192
 * - 圆形图标 `ic_launcher_round.png`：同上，边缘按正圆裁掉
 * - 自适应前景 `ic_launcher_foreground.png`：108 / 162 / 216 / 324 / 432（logo 占 70%，
 *   圆盘略大于启动器的可见区 72/108，遮罩边缘裁掉的是圆盘本身、鱼身完好）
 * - 启动屏 logo `drawable-xxxhdpi/fizz_splash_logo.png`：正方形，边长 `SPLASH_LOGO_DP`
 *   （dp）。启动屏本身是「纯色底 + 居中 logo」的 layer-list
 *   （`drawable/fizz_splash_window.xml`），不再按屏幕比例画整屏位图 —— 原因见
 *   `scripts/splash-brand.mjs` 与下面的启动屏段落。
 *
 * ## 两种底色，别搞混
 *
 * - **图标**：`ICON_BACKGROUND` = logo 圆盘边缘的青色。logo 是一张**圆形贴图**
 *   （圆盘直径 ≈ 画布 95%，四角透明），而安卓的启动图标永远得要一层底 ——
 *   自适应图标的 background 层是必需的，传统图标也会被启动器当方块画。
 *   以前这层用的是暗色 `#171717`，结果就是「青色圆盘浮在一块黑方块上」，
 *   在圆角 / 圆形遮罩下特别明显（用户报的「icon 有个黑色背景」）。
 *   换成圆盘自己的青后，两者连成一片，遮罩再裁也看不出接缝。
 * - **启动屏**：亮 / 暗两份，各取 `ui-tokens` 里对应主题的 `--background`
 *   （`oklch(1 0 0)` / `oklch(0.145 0 0)`），与状态栏那条、App 外壳底色是同一个颜色，
 *   冷启动时看不出拼缝。亮色那份写 `values/`、暗色那份写 `values-night/`，跟系统的
 *   夜间模式走（页面首屏没手动改过主题时也跟系统走，两边对齐；只烘暗色一份时，
 *   亮色设备冷启动就是「先黑屏、再白 splash」，用户报过）。
 *   ⚠️ **不要**用 `--sidebar`（`#171717`）：那是 web / desktop 的外壳色，比 `--background`
 *   亮一档。手机壳的顶栏 / 底栏 / 主区全是 `--background`，用侧栏色冷启动时状态栏那条
 *   会「先灰后黑」地闪一下（用户报过）。
 *   ⚠️ 这里**不要**跟着图标改成青色：启动屏之后接的是 App 界面，
 *   中间闪一块亮青比底色更显眼。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SPLASH_BACKGROUND_DARK,
  SPLASH_BACKGROUND_LIGHT,
  SPLASH_LOGO_DP
} from './splash-brand.mjs'

const root = join(import.meta.dirname, '..')
const source = join(root, 'assets', 'logo.png')
const outDir = join(root, 'assets', 'android')

/**
 * 图标底色 = `assets/logo.png` 圆盘边缘的青色（在 r≈232 的圈上取 16 个点求平均）。
 * 不是拍脑袋定的：圆盘本身是一圈从顶部的 `#69F3E3` 到底部的 `#04ADB2` 的渐变，
 * 取平均是为了让方图的四个角和圆盘边缘都差得不多。
 */
const ICON_BACKGROUND = '#28D8D1'
/**
 * 自适应图标的前景占比。启动器的可见区是 108dp 画布里的 72dp（66.7%），
 * 取 70% 让**圆盘本身**稍微超出遮罩 —— 遮罩裁掉的是圆盘边缘，图标看起来
 * 就是「一整块青色圆盘 + 鱼」，不会像以前那样在圆盘外再露出一圈深色底。
 * 鱼身约占圆盘的 85%，即画布的 59.5%，仍在 66dp 安全区内。
 */
const FOREGROUND_RATIO = 0.7
/** 传统图标里 logo 的占比（留一圈底，避免边缘被裁） */
const LAUNCHER_RATIO = 0.84

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192]
]

function magick(...args) {
  execFileSync('magick', args, { stdio: 'inherit' })
}

/** 一块纯色画布上居中贴一张图，输出到 out */
function compose({
  width,
  height,
  logoSize,
  out,
  transparent = false,
  background = ICON_BACKGROUND
}) {
  magick(
    '-size',
    `${width}x${height}`,
    transparent ? 'xc:none' : `xc:${background}`,
    '(',
    source,
    '-resize',
    `${logoSize}x${logoSize}`,
    ')',
    '-gravity',
    'center',
    '-composite',
    // 体积：这张 logo 是要入库、也要进 APK 的。不透明图压成调色板 PNG（底色是纯色，
    // 体积能小一个数量级）；透明图不能减色（渐变会出色带），只开最高压缩。
    ...(transparent ? [] : ['-colors', '256']),
    '-strip',
    '-define',
    'png:compression-level=9',
    out
  )
}

/** 把方块图裁成正圆（启动器的 round 图标） */
function roundify(file, size) {
  magick(
    file,
    '(',
    '-size',
    `${size}x${size}`,
    'xc:black',
    '-fill',
    'white',
    '-draw',
    `circle ${size / 2},${size / 2} ${size / 2},0`,
    ')',
    '-alpha',
    'off',
    '-compose',
    'CopyOpacity',
    '-composite',
    file
  )
}

rmSync(outDir, { recursive: true, force: true })

// ---- 传统 / 自适应图标 -----------------------------------------------------
for (const [density, size] of DENSITIES) {
  const dir = join(outDir, `mipmap-${density}`)
  mkdirSync(dir, { recursive: true })

  const launcher = join(dir, 'ic_launcher.png')
  compose({
    width: size,
    height: size,
    logoSize: Math.round(size * LAUNCHER_RATIO),
    out: launcher
  })

  const round = join(dir, 'ic_launcher_round.png')
  compose({
    width: size,
    height: size,
    logoSize: Math.round(size * LAUNCHER_RATIO),
    out: round
  })
  roundify(round, size)

  // 自适应图标的前景层：1 单位 = 108dp，前景按 density 的 2.25 倍算
  const foregroundSize = Math.round(size * 2.25)
  compose({
    width: foregroundSize,
    height: foregroundSize,
    logoSize: Math.round(foregroundSize * FOREGROUND_RATIO),
    out: join(dir, 'ic_launcher_foreground.png'),
    transparent: true
  })
}

// ---- 启动屏 ---------------------------------------------------------------
/*
 * 原生启动屏 = 纯色底 + 一张固定 dp 的 logo（`fizz_splash_window.xml` 的 layer-list）。
 *
 * ⚠️ 别再回到「按屏幕比例画好的整屏位图」：`android:background` 会把位图**拉满窗口**，
 * 而 drawable 的尺寸档位几乎不可能与真实屏幕同比例 —— logo 会被纵向拉长，
 * 原生 → 页面交接时「高度跳一下」（用户报过「图标闪一下」）。现在 logo 只生成一份，
 * 边长 `SPLASH_LOGO_DP`，页面首屏用同一个值（见 `scripts/splash-brand.mjs`）。
 *
 * 放 xxxhdpi（4x）：128dp 需要 512px，正好是这套资源里最高的一档，其余密度由系统缩放。
 */
const logoDir = join(outDir, 'drawable-xxxhdpi')
mkdirSync(logoDir, { recursive: true })
compose({
  width: SPLASH_LOGO_DP * 4,
  height: SPLASH_LOGO_DP * 4,
  logoSize: SPLASH_LOGO_DP * 4,
  transparent: true,
  out: join(logoDir, 'fizz_splash_logo.png')
})

const drawableDir = join(outDir, 'drawable')
mkdirSync(drawableDir, { recursive: true })
writeFileSync(
  join(drawableDir, 'fizz_splash_window.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- 冷启动窗口：纯色底 + 居中 logo。logo 按固有尺寸画（不 fill），屏幕比例怎么变都不会拉长 -->
    <item android:drawable="@color/fizz_splash_background" />
    <item>
        <bitmap android:gravity="center" android:src="@drawable/fizz_splash_logo" />
    </item>
</layer-list>
`,
  'utf8'
)
writeFileSync(
  join(drawableDir, 'fizz_splash_icon_empty.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!--
  Android 12+ 系统启动屏的图标位：拿一张全透明的形状把它占住。
  系统那层图标是固定尺寸的容器、不认我们的 dp，留着应用图标就会
  「青色方块 → 圆形 logo」地跳一下；让它透明，那几帧就只剩底色，
  视觉上直接由页面首屏的 logo 接管。
-->
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <size android:width="1dp" android:height="1dp" />
    <solid android:color="@android:color/transparent" />
</shape>
`,
  'utf8'
)

// ---- 颜色资源 -------------------------------------------------------------
/*
 * 启动屏底色写两份：`values/` 亮、`values-night/` 暗，由系统夜间模式选。
 *
 * `fizz_splash_light_bars` 是同一件事的另一半：状态栏 / 手势条底色跟着启动屏走，
 * 所以亮色启动屏上系统图标必须是深色（`windowLightStatusBar` 为 true），
 * 否则白底上挂一排白图标 = 看不见。`copy-assets.mjs` 把它挂到启动主题上。
 *
 * ⚠️ 两份文件的**键必须完全一致**（color + bool），少一个就会在夜间模式下取不到、
 * 退回默认值（= 白底亮图标那套），表现为「暗色设备启动屏还是白的」。
 */
function splashValues(background, lightBars) {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 启动屏底色 = 对应主题的 App 底色（见 scripts/splash-brand.mjs）。
         Android 12+ 的系统启动屏与冷启动窗口背景都用它。
         注意：注释里不能出现两个连续的短横线，安卓的资源解析器会直接抛 SAXParseException。 -->
    <color name="fizz_splash_background">${background}</color>
    <!-- 状态栏 / 手势条上的系统图标要不要用深色（亮色底要，暗色底不要） -->
    <bool name="fizz_splash_light_bars">${lightBars}</bool>
</resources>
`
}

mkdirSync(join(outDir, 'values'), { recursive: true })
writeFileSync(join(outDir, 'values', 'fizz_splash.xml'), splashValues(SPLASH_BACKGROUND_LIGHT, 'true'), 'utf8')
mkdirSync(join(outDir, 'values-night'), { recursive: true })
writeFileSync(
  join(outDir, 'values-night', 'fizz_splash.xml'),
  splashValues(SPLASH_BACKGROUND_DARK, 'false'),
  'utf8'
)

writeFileSync(
  join(outDir, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 自适应图标的背景层：取 logo 圆盘边缘的青，与前景的圆盘连成一片
         （不要改回暗色，那会让图标看起来浮在一块黑底上）。见 scripts/generate-icons.mjs -->
    <color name="ic_launcher_background">${ICON_BACKGROUND}</color>
</resources>
`,
  'utf8'
)

console.log('[mobile] 图标与启动屏已生成到 assets/android/')
