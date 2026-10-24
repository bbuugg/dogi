/**
 * Tailwind v4 走 PostCSS 插件（`@tailwindcss/postcss`）接入 Next。
 *
 * 与 Vite 模板的 `@tailwindcss/vite` 是同一套引擎、不同接入口；样式写法完全一样
 * （`globals.css` 里 `@import 'tailwindcss'` + `@theme`）。
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {}
  }
}

export default config
