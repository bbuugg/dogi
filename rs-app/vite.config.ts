import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // 渲染进程源码根目录（index.html 所在处）
  root: 'src',
  base: './',
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  // Tauri 会同时启动 vite 与 rust 侧，端口必须固定（strictPort），否则 devUrl 会失效
  clearScreen: false,
  server: {
    port: 5175,
    strictPort: true,
    watch: {
      // 不要把 src-tauri 纳入前端热更新（rust 侧由 tauri cli 自己监听重建）
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    // 把体积大且相对稳定的 vendor 拆成独立 chunk，便于缓存与首屏按需加载
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const i = id.replace(/\\/g, '/')
          if (!i.includes('/node_modules/')) return undefined
          if (i.includes('/react-dom/') || i.includes('/react/')) return 'vendor-react'
          if (
            i.includes('/@ant-design/') ||
            i.includes('/@rc-component/') ||
            i.includes('/antd/') ||
            /\/rc-[^/]+\//.test(i)
          )
            return 'vendor-antd'
          if (i.includes('monaco')) return 'monaco'
          if (i.includes('/@xterm/')) return 'xterm'
          return undefined
        }
      }
    }
  }
})
