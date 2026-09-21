import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * 主进程构建：ESM（package.json type: module，Electron 28+ 原生支持）
 * 所有依赖（node-pty / ssh2 / ai / @modelcontextprotocol/sdk ...）保持 external
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      // npm workspace 包：源码即入口（package.json exports 指向 src），主进程直接打包 TS
      '@opsdesk/ai-agent': resolve(import.meta.dirname, 'packages/ai-agent/src/index.ts')
    }
  },
  build: {
    outDir: 'out/main',
    emptyOutDir: true,
    minify: false,
    target: 'node24',
    lib: {
      entry: resolve(import.meta.dirname, 'src/main/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // 本地模块（相对路径 / 盘符绝对路径 / @shared / @opsdesk workspace 包）参与打包，其余 bare import 全部 external
      external: (id) =>
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@shared') &&
        !id.startsWith('@opsdesk') &&
        !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
