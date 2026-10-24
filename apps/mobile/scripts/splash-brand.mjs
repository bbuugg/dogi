/**
 * 启动屏的**共享口径**：原生（`generate-icons.mjs` / `copy-assets.mjs`）与页面首屏
 * （`index.html` 的 `#boot-splash`）必须同尺寸、同底色。
 *
 * ## 为什么是固定 dp，而不是「短边的 32%」
 *
 * 页面侧 `vmin` 能按比例算，安卓的 drawable 不能（`<bitmap>` 只认固有尺寸）。以前两边
 * 各算各的 —— 原生是一张按档位画好的整屏 PNG，被 `android:background` **拉满窗口**，
 * 而 drawable 档位几乎不可能与真实屏幕同比例，logo 于是被纵向拉长；页面那边是正圆的
 * `32vmin`。切过去就是「图标闪烁一下、高度跳一下」。
 *
 * 现在两边都取 `SPLASH_LOGO_DP`：CSS px 与安卓 dp 是 1:1（WebView 的
 * `devicePixelRatio` 就是屏幕 density），所以原生 `128dp` 与页面 `128px` 是同一块像素。
 *
 * ⚠️ 改这里就够了：`vite.config.ts` 用 `bootSplashLogo` 插件把它烘进 HTML，
 * `generate-icons.mjs` 用它算 PNG 的像素尺寸。别在任一端再写一个字面值。
 */

/** 启动屏 logo 的边长（dp == CSS px） */
export const SPLASH_LOGO_DP = 128

/**
 * 启动屏底色：与 `ui-tokens` 的 `--background` 同值（亮 `oklch(1 0 0)` / 暗
 * `oklch(0.145 0 0)`），也就是 App 界面本身的底色 —— 启动屏和它后面那一屏必须是同一个颜色。
 *
 * ## 为什么要分亮暗两份（以前只有暗色，是个 bug）
 *
 * 原生启动屏的底色是**构建期烘死的**，而页面首屏（`index.html` 里那段内联脚本）是
 * **运行期**按「存的设置 → 系统偏好」算的。只烘一份暗色，就意味着亮色设备冷启动是
 * 「系统启动屏（纯暗色、图标位是透明占位）→ 应用窗口（暗色 + logo）→ 页面首屏（白）」，
 * 用户看到的就是「先黑屏、再白 splash」那一下闪。
 *
 * 现在原生给两份：`values/`（亮）与 `values-night/`（暗），跟系统的夜间模式走；页面侧
 * 没手动改过主题时也是跟系统走（`mode === 'system'` → `prefers-color-scheme`），两边对齐。
 *
 * ⚠️ 残余差异：用户在设置里**显式**选了与系统相反的主题时，原生那一帧仍会差一档
 * （原生读不到 WebView 的 localStorage）。要彻底消掉得把主题选择镜像到原生侧
 * （SharedPreferences），目前判断不值得 —— 首帧那几百毫秒，且是用户自己选的组合。
 *
 * ⚠️ 那个 `--` 前缀只在 `.mjs` / CSS 里能这么写：XML 注释里出现两个连续的短横线会让
 * 安卓的资源解析器直接抛 `SAXParseException`，别把这句抄进 `fizz_splash.xml`。
 * ⚠️ **不要**用 `--sidebar`（`#171717`）：那是 web / desktop 的外壳色，比 `--background`
 * 亮一档，冷启动时状态栏那条会「先灰后黑」地闪一下。
 */
export const SPLASH_BACKGROUND_LIGHT = '#ffffff'
export const SPLASH_BACKGROUND_DARK = '#0a0a0a'
