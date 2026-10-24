/**
 * 把**入库**的 `apps/mobile/assets/android/`（启动图标 + 启动屏）铺回
 * `android/app/src/main/res/`，并给启动主题补一行 Android 12+ 的系统启动屏底色。
 *
 * 为什么需要这一步：`android/` 是 `cap add android` 的生成物（已 gitignore），
 * 换机器 / 重新 add 时图标会退回 Capacitor 的默认图。所以真正的源头放在
 * `assets/android/`（由 `scripts/generate-icons.mjs` 生成、随仓库提交），
 * 每次 `npm run sync` 再复制进去 —— 纯 `fs` 操作，不依赖 ImageMagick / sharp，
 * 任何机器都能跑。
 *
 * 注意 `cap sync` 本身**不碰** `res/`，所以这个脚本挂在 `sync` 的最后一步；
 * 顺序无所谓，但必须在打 APK 之前。
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const from = join(root, 'assets', 'android')
const resDir = join(root, 'android', 'app', 'src', 'main', 'res')

if (!existsSync(resDir)) {
  console.log('[mobile] 还没有 android/ 平台，跳过图标复制（先跑 npm run add:android）')
  process.exit(0)
}

cpSync(from, resDir, { recursive: true, force: true })

/*
 * 清掉旧版的「整屏 splash.png」（现在是固定 dp 的 logo + layer-list，见 generate-icons）。
 * `cpSync` 只增不减：不主动删除，那批图会一直留在 `res/drawable*` 里白占 APK 体积，
 * 还会误导下一个人（“为什么改了 splash.png 屏幕没变”）。
 */
for (const entry of readdirSync(resDir)) {
  if (!entry.startsWith('drawable')) continue
  rmSync(join(resDir, entry, 'splash.png'), { force: true })
}

/**
 * 启动主题：整块换成我们自己的版本。
 *
 * `cap add android` 的模板只给了一句 `android:background=@drawable/splash`（一张按档位画的
 * 整屏位图），其余全用 AppCompat 的默认值。冷启动那几个可见的毛病都出在这里：
 *
 * - **logo 高度跳动**：整屏位图会被 `android:background` 拉满窗口，而 drawable 档位几乎
 *   不可能与真实屏幕同比例 —— logo 被纵向拉长，切到页面首屏（正圆、固定 dp）就跳一下。
 *   换成 layer-list（`fizz_splash_window`）：纯色底 + 按固有尺寸居中的 logo。
 * - **状态栏一条灰**：`Theme.AppCompat.DayNight` 的 `colorPrimaryDark` 在暗色下是 #303030，
 *   edge-to-edge 生效之前状态栏用的就是它。钉成同一个底色就没了。
 * - **系统启动屏那个青色方块**：Android 12+ 的图标位是固定尺寸容器、不认我们的 dp，
 *   给一张全透明形状把它占住（`fizz_splash_icon_empty`），那几帧只剩底色，由页面首屏的
 *   logo 接管。
 * - **亮色设备冷启动先黑一下**：底色以前只烘了暗色一份。现在 `fizz_splash_background`
 *   与 `fizz_splash_light_bars` 都是**按夜间模式分档的资源**（`values/` 亮、`values-night/`
 *   暗，见 `generate-icons.mjs`），主题里只写引用，别在这里写死颜色或 true/false。
 *
 * 整块替换而不是逐条 `includes` 判断后插入：这个主题的每一行都由我们决定，逐条 patch
 * 会在改主意时留下旧项（比如旧的 `@drawable/splash`）。
 */
const stylesPath = join(resDir, 'values', 'styles.xml')
const styles = readFileSync(stylesPath, 'utf8')
const LAUNCH_THEME = `    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/fizz_splash_window</item>
        <item name="android:windowBackground">@drawable/fizz_splash_window</item>
        <item name="android:statusBarColor">@color/fizz_splash_background</item>
        <item name="android:navigationBarColor">@color/fizz_splash_background</item>
        <item name="android:windowLightStatusBar">@bool/fizz_splash_light_bars</item>
        <item name="android:windowLightNavigationBar">@bool/fizz_splash_light_bars</item>
        <item name="android:windowSplashScreenBackground">@color/fizz_splash_background</item>
        <item name="android:windowSplashScreenAnimatedIcon">@drawable/fizz_splash_icon_empty</item>
        <item name="android:windowSplashScreenIconBackgroundColor">@color/fizz_splash_background</item>
    </style>`
const next = styles.replace(
  / *<style name="AppTheme\.NoActionBarLaunch"[\s\S]*?<\/style>/,
  LAUNCH_THEME
)
if (next !== styles) {
  writeFileSync(stylesPath, next, 'utf8')
  console.log('[mobile] 启动主题已重写（纯色底 + 固定 dp 的 logo、状态栏同色、系统图标占位）')
}

console.log('[mobile] 图标与启动屏已复制进 android/app/src/main/res/')
