/**
 * 用仓库根的 `build/icon.png` 生成**桌面端各平台打包用的图标**，产物**入库**：
 *
 * - `build/icons/<尺寸>x<尺寸>.png` —— electron-builder 的 Linux 图标集（512 那份同时是
 *   `apps/web` / `apps/mobile` 的 PWA / 主屏图标源，见 `public/icon-*.png`）
 *   （`apps/desktop/package.json` 的 `linux.icon`）。文件名必须带尺寸，缺了会退回
 *   Electron 默认图标（构建日志里的 `default Electron icon is used`）。
 * - `build/icon.ico` —— Windows（`win.icon`）。多尺寸 ico，含 256 的 PNG 帧。
 * - `apps/desktop/resources/{app-icon.png,tray-icon.png,tray-icon.ico}` —— 主进程运行时读的
 *   窗口图标 / 托盘图标（见 `src/main/index.ts`）。这个目录原来是空的，打包时随包的
 *   `resources` 里什么都没有：Linux / dev 下窗口没有图标、托盘建不出来
 *   （`trayImage()` 读到空图就直接放弃托盘，连带「关闭 = 收起到托盘」失效）。
 *
 * ## 为什么单独有这么个脚本
 *
 * CI 上**不需要** ImageMagick：上面这些产物全部入库，构建只读文件。只有**换 logo** 时
 * 才跑一次 `npm run icons --workspace @fizz/desktop` —— 与 mobile 的
 * `generate-icons.mjs` 同一套分工（生成一次入库，构建纯读），别把它挂进 `dist:*`。
 *
 * ## Linux 图标为什么要这么多档
 *
 * AppImage 的桌面集成会按尺寸挑最合适的一张，也常拿 512 去缩放；只给 256 的话在
 * HiDPI 桌面（托盘 / 任务栏）上会糊。16 是标题栏 / 小托盘那一档的保底。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const buildDir = join(root, 'build')
const source = join(buildDir, 'icon.png')
const outDir = join(buildDir, 'icons')

/** Linux 图标集：pango / KDE / GNOME 的常规档位，512 供 AppImage 缩放 */
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]
/** Windows ico 里要塞的档位（16 与 256 是任务栏 / 文件管理器都必带的两头） */
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

function magick(...args) {
  execFileSync('magick', args, { stdio: 'inherit' })
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const size of LINUX_SIZES) {
  // `-extent` 兜一次正方形：源图哪怕不是正方的也裁成居中正方形，Linux 图标不接受非正方
  magick(
    source,
    '-background',
    'none',
    '-resize',
    `${size}x${size}`,
    '-gravity',
    'center',
    '-extent',
    `${size}x${size}`,
    '-strip',
    join(outDir, `${size}x${size}.png`)
  )
}

// ico 从已经切好的那批拼：比直接从 1645px 原图缩，体积小得多、也不会有 256 那一档的锯齿
magick(...ICO_SIZES.map((size) => join(outDir, `${size}x${size}.png`)), '-strip', join(buildDir, 'icon.ico'))

/*
 * 窗口图标 / 托盘图标（主进程按 `resources/<name>` 读，见 `src/main/index.ts` 的
 * `windowIconOption` / `trayImage` / `readIconDataUrl`）。
 *
 * 这三个文件名是**运行时契约**，别看它们没被任何代码 import 就删。
 * `app-icon.png` 用 256：它同时是「关于」弹窗里的图标（读成 data URL）。托盘 ico 只要
 * 16/32 两档 —— 托盘槽位最高也就 32px，把 256 塞进去白占体积。
 */
const resourcesDir = join(root, 'apps', 'desktop', 'resources')
magick(
  join(outDir, '256x256.png'),
  '-strip',
  '-define',
  'png:compression-level=9',
  join(resourcesDir, 'app-icon.png')
)
magick(
  join(outDir, '32x32.png'),
  '-strip',
  '-define',
  'png:compression-level=9',
  join(resourcesDir, 'tray-icon.png')
)
magick(join(outDir, '32x32.png'), '-define', 'icon:auto-resize=32,16', join(resourcesDir, 'tray-icon.ico'))

console.log('[desktop] 图标已生成：build/icons/*.png、build/icon.ico、resources/{app-icon.png,tray-icon.*}')
