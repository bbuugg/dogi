import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * server 构建：打成单个 ESM 文件（`apps/server/dist/index.js`），`node dist/index.js` 就能跑。
 *
 * 为什么不直接 `node src/index.ts`（Node 24 能剥类型）：@fizz/* 是**源码即入口**的
 * workspace 包，靠 Node 的类型剥离去加载 node_modules 里的 .ts 太脆（不同 Node 版本
 * 对 node_modules 内 .ts 的剥类型策略不一致），打成产物最稳。
 * 第三方依赖保持 external（node_modules 里有真 JS）。
 */
/**
 * 必须**打进产物**（而不是留成 external）的第三方依赖。
 *
 * 判据：CJS 包 + 我们用**具名导入**引用它。产物是 ESM，external 的包由 Node 原生加载，
 * 走 `cjs-module-lexer` 探测具名导出 —— 探测不出来就直接
 * `SyntaxError: Named export 'x' not found`，进程起不来（`cron-parser` 实测如此）。
 * 交给 rollup 内联则由它的 CJS interop 兜住。
 */
const BUNDLED_DEPS = ['cron-parser', 'luxon']

export default defineConfig({
  resolve: {
    /*
     * 服务端业务代码（`src/api/**` + `src/server/**`）是从 Next 版**整棵搬过来**的，
     * 里面写的还是根目录那套 `@/…` 路径。这里把它们映射到本 app 的目录，
     * 于是那 130 多个文件一行 import 都不用改。
     *
     * ⚠️ 前缀匹配：更长的前缀必须写在前面，否则 `@/lib/server/state`
     * 会被 `@/lib` 先吃掉（拼成 `…/lib/server/state` 这种不存在的路径）。
     */
    alias: {
      '@/lib/server': resolve(import.meta.dirname, 'src/server'),
      '@/lib': resolve(import.meta.dirname, 'src/lib'),
      '@/app/api': resolve(import.meta.dirname, 'src/api')
    }
  },
  ssr: {
    /*
     * ⚠️ 光在 `rollupOptions.external` 里对 BUNDLED_DEPS 返回 false **摘不掉**：
     * Vite 的 SSR 构建会自行把所有 node_modules 依赖标为 external，且这个判定与
     * `rollupOptions.external` 是**并集**。必须在这里显式 noExternal 才能覆盖它。
     */
    noExternal: BUNDLED_DEPS
  },
  build: {
    // ⚠️ 必须用绝对路径：vite 的 outDir 相对 **vite root**（= 执行命令时的 CWD）解析，
    // 从仓库根跑会把 server / cli 的产物都倒进根目录的 dist/ 里互相覆盖
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    ssr: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      /*
       * 本地源码参与打包，其余 bare import 全部 external（node_modules 里有真 JS）。
       *
       * ⚠️ `@/…` 必须显式放行：external 判定**先于** alias 解析，裸 specifier
       * `@/lib/server/state` 不匹配 `@fizz` / 相对路径 / 盘符绝对路径任何一条，
       * 不放行就会被留成运行时的 `import '@/lib/…'` —— Node 直接 ERR_MODULE_NOT_FOUND。
       */
      external: (id) =>
        // 例外：这些要内联（见 BUNDLED_DEPS 的说明）
        !BUNDLED_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`)) &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@/') &&
        !id.startsWith('@fizz') &&
        !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
