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
 * 都生成一套新哈希，electron-builder 又把 out 目录整棵收进安装包（files 里的 `out/**`），
 * 实测残留曾累积到 110MB 死重（73 个旧文件：7 个 3.9MB 的旧 vendor、历代 index / shiki chunk…）。
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
 * desktop 渲染端构建 / 开发服务。
 *
 * - `root` = apps/desktop（index.html 在这里，入口指向 src/renderer/main.tsx）；
 * - `base: './'`：产物用相对路径引用，`loadFile` 才能加载到；
 * - 没有 `/api` 代理：请求经 preload 注入的 IPC 桥直连主进程内的 Hono 应用。
 */
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss(), cleanStaleAssets(resolve(import.meta.dirname, 'out/renderer/assets'))],
  resolve: {
    alias: {
      // 无业务原语（逐条展开，见 moduleAliases 的注释：通配写法在这里不生效）
      ...moduleAliases('../../packages/ui/src', '@fizz/ui'),
      '@fizz/ui': resolve(import.meta.dirname, '../../packages/ui/src/index.ts'),
      // 客户端能力层（API + 宿主契约 + 浏览器兜底）
      ...moduleAliases('../../packages/agent-client/src', '@fizz/agent-client'),
      '@fizz/agent-client': resolve(import.meta.dirname, '../../packages/agent-client/src/index.ts'),
      // `@` 指渲染端自己的 src：外壳（`src/renderer/app/`）就在这里，与 tsconfig 的 paths 一致
      '@': resolve(import.meta.dirname, 'src/renderer'),
      // 领域组件包：`features/*` / `shared/*` 两个目录前缀必须排在包名本体之前
      // （alias 是前缀替换，`@fizz/agent-kit` 会吃掉所有 `@fizz/agent-kit/…`）
      '@fizz/agent-kit/features': resolve(
        import.meta.dirname,
        '../../packages/agent-kit/src/features'
      ),
      '@fizz/agent-kit/shared': resolve(import.meta.dirname, '../../packages/agent-kit/src/shared'),
      '@fizz/agent-kit/shell': resolve(import.meta.dirname, '../../packages/agent-kit/src/shell'),
      '@fizz/agent-kit': resolve(import.meta.dirname, '../../packages/agent-kit/src/index.ts'),
      '@fizz/i18n': resolve(import.meta.dirname, '../../packages/i18n/src/index.ts'),
      '@fizz/contracts/types': resolve(import.meta.dirname, '../../packages/contracts/src/types.ts'),
      '@fizz/contracts/agent-api': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/agent-api.ts'
      ),
      '@fizz/contracts/workspace-config': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/workspace-config.ts'
      ),
      '@fizz/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
      // 只用到类型（桥的形状），但 alias 让类型与运行时的解析口径一致
      '@fizz/agent-host/channels': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/channels.ts'
      )
    }
  },
  server: {
    port: 5175,
    strictPort: true
  },
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    // 不清空（保住 public 拷来的 monaco-editor，见 cleanStaleAssets 的注释）：
    // assets 的过期哈希产物由该插件在构建开始时清掉。
    emptyOutDir: false,
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
