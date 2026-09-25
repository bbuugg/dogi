import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Preload 构建：CJS 输出 index.cjs（沙箱 preload 仅支持 CJS）
 */
export default defineConfig({
  build: {
    outDir: 'out/preload',
    emptyOutDir: true,
    minify: false,
    target: 'node24',
    lib: {
      entry: resolve(import.meta.dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs'
    },
    rollupOptions: {
      external: (id) =>
        !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
