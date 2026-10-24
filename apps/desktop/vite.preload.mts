import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * desktop preload 构建：CJS 输出 index.cjs（沙箱 preload 仅支持 CJS）。
 *
 * ⚠️ `@fizz/agent-host/preload` 与 `@fizz/agent-host/channels` 必须 alias 到源码
 * 并参与打包：它们是 workspace 包，没有构建产物，运行时 `require` 不到。
 * alias 后是盘符绝对路径，命中下面的 external 排除条件 → 打包进来。
 */
export default defineConfig({
  root: import.meta.dirname,
  // lib 构建：public/（monaco-editor 等渲染端静态资源）不参与，拷进去只会拖慢构建
  publicDir: false,
  resolve: {
    alias: {
      '@fizz/agent-host/preload': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/preload.ts'
      ),
      '@fizz/agent-host/channels': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/channels.ts'
      )
    }
  },
  build: {
    // 绝对路径：相对 outDir 会按 config root 解析，可能覆盖根应用的 out/preload
    outDir: resolve(import.meta.dirname, 'out/preload'),
    emptyOutDir: true,
    minify: false,
    target: 'node24',
    lib: {
      entry: resolve(import.meta.dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs'
    },
    rollupOptions: {
      // ⚠️ `@fizz` 必须排除在外：external 判定发生在 alias 解析**之前**，
      // 否则 `@fizz/agent-host/preload` 会被原样 external 成
      // `require("@fizz/agent-host/preload")`（workspace 包没有产物，运行时必炸）。
      external: (id) =>
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@fizz') &&
        !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
