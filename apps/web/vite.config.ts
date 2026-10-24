import { readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * 构建开始时清掉 `assets/`（里面全部是带哈希的产物，旧哈希零引用）。
 *
 * ⚠️ emptyOutDir 必须保持 false：整目录清连 public 拷来的 monaco-editor（600+ 文件）
 * 一起删，会撞上 IDE 的批量删除保护；但**过期哈希产物也不能留** —— 渲染端每次构建
 * 都生成一套新哈希，桌面端打包还会把整个 dist 当 extraResources 收进安装包，实测
 * 残留曾累积到 46.7MB 死重（49 个旧文件）。
 */
function cleanStaleAssets(assetsDir: string): Plugin {
  return {
    name: 'clean-stale-assets',
    buildStart() {
      rmSync(assetsDir, { recursive: true, force: true })
    }
  }
}

/**
 * 把目录下的模块逐条映射成 alias。
 *
 * ⚠️ 不能写成 `'@fizz/ui/': '…/src/'` 这种「带斜杠的通配」：@rollup/plugin-alias 的
 * `matches` 只认 `importee === find` 与 `importee.startsWith(find + '/')`，**带斜杠的 find
 * 永远不命中**；而只写 `'@fizz/ui'` 又会把 `@fizz/ui/button` 匹配成 `…/index.ts/button`。
 * 两条路都不通，所以只能逐条列 —— 用目录扫描生成，新增原语不用再改配置。
 *
 * 顺序也重要：具体子路径必须排在包名本体之前（`@fizz/ui` 会匹配所有 `@fizz/ui/…`）。
 */
function moduleAliases(dir: string, prefix: string): Record<string, string> {
  const base = resolve(import.meta.dirname, dir)
  return Object.fromEntries(
    readdirSync(base)
      .filter((file) => /\.tsx?$/.test(file) && !/^index\.tsx?$/.test(file))
      .map((file) => [`${prefix}/${file.replace(/\.tsx?$/, '')}`, resolve(base, file)])
  )
}

/**
 * Web 端构建 / 开发服务。
 *
 * - `base: '/'`：资产用**绝对**路径引用。前端路由已整体移除 —— 站点永远在根路径
 *   （`/`）上，没有「页面在子路径、资产要跟着解析」这回事，绝对路径最直接。
 *   桌面端不受影响：desktop 有独立的 vite 配置，`file://` 下必须用相对路径
 *   （绝对路径会被解析成文件系统根）；
 * - dev 时 `/api` 代理到本地 server：**这样开发期不需要 CORS**，生产同源托管也不需要；
 * - alias 前缀匹配，`@fizz/contracts` 的子路径必须写在前面（见根 vite.main.mts 的说明）。
 */
export default defineConfig({
  // 固定 root：否则从仓库根执行构建时，vite 会把仓库根当成站点根、找不到这个 index.html
  root: import.meta.dirname,
  base: '/',
  plugins: [react(), tailwindcss(), cleanStaleAssets(resolve(import.meta.dirname, 'dist/assets'))],
  resolve: {
    alias: {
      // `@` 指本 app 的 src：外壳（`src/app/`）就在这里，与 tsconfig 的 paths 一致
      '@': resolve(import.meta.dirname, 'src'),
      // 领域组件包：`features/*` / `shared/*` 两个目录前缀必须排在包名本体之前
      // （alias 是前缀替换，`@fizz/agent-kit` 会吃掉所有 `@fizz/agent-kit/…`）
      '@fizz/agent-kit/features': resolve(
        import.meta.dirname,
        '../../packages/agent-kit/src/features'
      ),
      '@fizz/agent-kit/shared': resolve(import.meta.dirname, '../../packages/agent-kit/src/shared'),
      '@fizz/agent-kit/shell': resolve(import.meta.dirname, '../../packages/agent-kit/src/shell'),
      '@fizz/agent-kit': resolve(import.meta.dirname, '../../packages/agent-kit/src/index.ts'),
      // 无业务原语（逐条展开，见 moduleAliases 的注释：通配写法在这里不生效）
      ...moduleAliases('../../packages/ui/src', '@fizz/ui'),
      '@fizz/ui': resolve(import.meta.dirname, '../../packages/ui/src/index.ts'),
      // 客户端能力层（API + 宿主契约 + 浏览器兜底）
      ...moduleAliases('../../packages/agent-client/src', '@fizz/agent-client'),
      '@fizz/agent-client': resolve(import.meta.dirname, '../../packages/agent-client/src/index.ts'),
      '@fizz/i18n': resolve(import.meta.dirname, '../../packages/i18n/src/index.ts'),
      '@fizz/contracts/types': resolve(import.meta.dirname, '../../packages/contracts/src/types.ts'),
      '@fizz/contracts/workspace-config': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/workspace-config.ts'
      ),
      '@fizz/contracts/agent-api': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/agent-api.ts'
      ),
      '@fizz/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts')
    }
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.FIZZ_SERVER ?? 'http://127.0.0.1:7801',
        changeOrigin: true,
        /*
         * ⚠️ `ws: true` 必须显式写：Vite 对 **http(s) 目标默认不代理 WebSocket 升级**
         * （源码里只有 `opts.ws || target 以 ws:// 开头` 才走 `proxy.ws(...)`，见
         * dist/node 的 proxyMiddleware）。不写的话 `/api/*` 的 WS 全都不被代理 ——
         * `/api/state`（全局状态推送）、`/api/browser`（浏览器画面）、节点工作台、
         * `/api/terminal` 一条都连不上，表现为「HTTP 请求全 200，但服务端 WS 连接数恒为 0」
         * （实测踩过：事件总线 `前端连接数 0`、浏览器面板一直没有画面）。
         */
        ws: true
      }
    }
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    // 不清空（保住 public 拷来的 monaco-editor，见 cleanStaleAssets 的注释）：
    // assets 的过期哈希产物由该插件在构建开始时清掉。
    emptyOutDir: false,
    // 不开 sourcemap：shiki 的语言分包本来就多，加上 .map 会让产物文件数炸到几百个
    sourcemap: false,
    // 拆大依赖到独立 vendor chunk：主 chunk 变小、可并行下载，且 vendor 不随业务变动而失效缓存。
    // 仅改构建配置，零运行时风险。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@xterm')) return 'xterm'
          if (id.includes('monaco-editor')) return 'monaco'
          if (id.includes('react') || id.includes('scheduler')) return 'react-vendor'
          // shiki 走默认拆分：它的语言/主题本就按需动态 import 拆成独立 chunk，
          // 强行合到一个 vendor 会把它压成 10MB 巨块。
          if (id.includes('/shiki') || id.includes('@shikijs')) return undefined
          return 'vendor'
        }
      }
    }
  }
})
